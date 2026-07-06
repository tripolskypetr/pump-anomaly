import { describe, it, expect } from "vitest";
import {
  withTimeout, train, PumpMatrix, TrainedParams, ParserItem,
  validateGetCandles, probabilityOfBacktestOverfitting,
} from "../src/index";
import { ExitParams } from "../src/replay";
import { GetCandles } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

/** адаптер, который НИКОГДА не отвечает — главный источник вечных зависаний */
const hung: GetCandles = () => new Promise(() => { /* never */ });

describe("withTimeout — у каждого сетевого вызова есть дедлайн", () => {
  it("повисший адаптер → внятная ошибка за таймаут, не вечное ожидание", async () => {
    const gc = withTimeout(hung, 80);
    const started = Date.now();
    await expect(gc("SOLUSDT", "1m", 10, t0)).rejects.toThrow(/не ответил за 80мс/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("живой адаптер проходит без вмешательства (таймер снимается)", async () => {
    const gc = withTimeout(async () => [{ timestamp: t0, open: 1, high: 1, low: 1, close: 1, volume: 1 }], 5000);
    const r = await gc("SOLUSDT", "1m", 1, t0);
    expect(r.length).toBe(1);
  });

  it("ошибка адаптера пробрасывается как есть (не заменяется таймаутом)", async () => {
    const gc = withTimeout(async () => { throw new Error("дыра в данных"); }, 5000);
    await expect(gc("SOLUSDT", "1m", 1, t0)).rejects.toThrow("дыра в данных");
  });
});

describe("fit не виснет на мёртвой сети", () => {
  it("train с повисшим адаптером завершается; таймауты видны в diagnostics", async () => {
    const items: ParserItem[] = Array.from({ length: 3 }, (_, k) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 + k * 12 * 60 * MIN,
    }));
    const res = await train(items, hung, {
      folds: 3, mode: "single", onProgress: silentProgress,
      candleTimeoutMs: 100, // терпение к сети — короткое для теста
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [1], hardStop: [2], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [60], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    // fit ЗАВЕРШИЛСЯ (пустой, но живой), а причина — в диагностике, не в вечном молчании
    expect(res.params.meta.totalSamples).toBe(0);
    expect(res.params.meta.labeling.outcomes["adapter-error"]).toBe(3);
    expect(Object.keys(res.params.meta.labeling.errors).join(" ")).toContain("не ответил за 100мс");
  }, 15_000);
});

describe("plan()/доктор не виснут на мёртвой сети", () => {
  const ex = (): ExitParams & Record<string, unknown> => ({
    trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 60, volBaselineWindow: 20, squeezePolicy: "none", cascadeWindowMinutes: 15,
  });
  const model = (): PumpMatrix => PumpMatrix.load({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex(), matrix: ex() }, global: ex() },
    policy: { allow: ["enter"] },
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  } as TrainedParams);

  it("plan(повисший getCandles) → сигнал без свечей за таймаут, не вечность", async () => {
    const prev = PumpMatrix.candleTimeoutMs;
    PumpMatrix.candleTimeoutMs = 100;
    try {
      const started = Date.now();
      const sigs = await model().plan(
        [{ channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 }], hung,
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(sigs.length).toBe(1); // как signals(): без свечей, но живой
      expect(sigs[0].origin.volRegime).toBe(null);
    } finally {
      PumpMatrix.candleTimeoutMs = prev;
    }
  }, 15_000);

  it("validateGetCandles(повисший) → issue про таймаут, не зависший доктор", async () => {
    const r = await validateGetCandles(hung, { timeoutMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain("не ответил");
  });
});

describe("CSCV — комбинаторный взрыв закрыт капом", () => {
  it("30 фолдов (наивно 155 млн разбиений) считаются мгновенно и дают конечный PBO", () => {
    // 20 конфигов × 30 фолдов детерминированного «перфа»
    const perf = Array.from({ length: 20 }, (_, c) =>
      Array.from({ length: 30 }, (_, f) => Math.sin(c * 7 + f * 3) * 0.01));
    const started = Date.now();
    const pbo = probabilityOfBacktestOverfitting(perf);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(Number.isFinite(pbo)).toBe(true);
    expect(pbo).toBeGreaterThanOrEqual(0);
    expect(pbo).toBeLessThanOrEqual(1);
  });
});
