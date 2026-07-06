import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams, ParserItem, validateGetCandles, inspectItems, assessEdge } from "../src/index";
import { ExitParams } from "../src/replay";
import { GetCandles, ICandleData } from "../src/candle";
import { Certification } from "../src/statistics";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

// ── фикстура модели с настраиваемыми policy/cert/channelPlan ──
const ex = (): ExitParams & Record<string, unknown> => ({
  trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
  staleMinutes: 60, volBaselineWindow: 20, squeezePolicy: "none", cascadeWindowMinutes: 15,
});
const cert = (certified: boolean): Certification => ({
  certified, dsr: certified ? 0.97 : 0.2, pbo: certified ? 0.05 : 0.6,
  spaPValue: certified ? 0.01 : 0.4, minTRL: 30, actualN: certified ? 60 : 10,
  nestedScore: certified ? 0.004 : -0.001,
  reasons: certified ? [] : ["DSR тест", "N тест"],
});
const model = (over: Record<string, unknown> = {}): PumpMatrix => PumpMatrix.load({
  version: 3,
  config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
  exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex(), matrix: ex() }, global: ex() },
  policy: { allow: ["enter", "invert", "tighten"] },
  riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
  pnl: { bySymbol: {}, global: { mean: 0.005, median: 0.004, p5: -0.01, p95: 0.02, p99: 0.03, n: 20 } },
  meta: {
    trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
    gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
    confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 20,
    labeling: { candidates: 20, outcomes: { ok: 20 }, errors: {} },
  },
  ...over,
} as never);
const item = (channel = "ch", symbol = "SOLUSDT"): ParserItem =>
  ({ channel, symbol, direction: "long", ts: t0 + 60 * MIN });
const tape = (drift = 0): ICandleData[] =>
  Array.from({ length: 60 }, (_, i) => {
    const p = 100 * (1 + drift * (i / 60));
    return { timestamp: t0 + i * MIN, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: 1000 + (i % 5) * 100 };
  });

// ─────────────────────────────────────────────────────────────────────────────
// explainSignals: молчание девяти фильтров превращается в конкретную причину.
// ─────────────────────────────────────────────────────────────────────────────
describe("explainSignals — почему сигнал не вышел", () => {
  it("несертифицированная модель: rejectedBy=uncertified-model с подсказкой", () => {
    const m = model({ meta: { ...JSON.parse(model().save()).meta, certification: cert(false) } });
    const [e] = m.explainSignals([item()]);
    expect(e.emitted).toBe(false);
    expect(e.rejectedBy).toBe("uncertified-model");
    expect(e.detail).toContain("acknowledgeUncertified");
  });

  it("momentum-гейт без свечей и с падением — разные читаемые причины", () => {
    const m = model();
    const noCandles = m.explainSignals([item()], undefined, { minMomentum24hPct: -1, momentumWindowMinutes: 30 });
    expect(noCandles[0].rejectedBy).toBe("momentum-gate");
    expect(noCandles[0].detail).toContain("свечей");
    const falling = m.explainSignals([item()], { SOLUSDT: tape(-0.05) }, { minMomentum24hPct: -1, momentumWindowMinutes: 30 });
    expect(falling[0].rejectedBy).toBe("momentum-gate");
    expect(falling[0].detail).toMatch(/momentum .*% < порога/);
    expect(typeof falling[0].values.momentum).toBe("number");
  });

  it("channelPlan drop / ёмкость / скор канала — каждый фильтр называет себя", () => {
    const m1 = model({ channelPlan: { badch: "drop" } });
    expect(m1.explainSignals([item("badch")])[0].rejectedBy).toBe("channel-plan:drop");

    const m2 = model();
    const cap = m2.explainSignals([item()], { SOLUSDT: tape() }, { notionalQuote: 10_000_000 });
    expect(cap[0].rejectedBy).toBe("capacity");
    expect(cap[0].detail).toContain("оборота");

    const m3 = model({ channelScore: { ch: { score: -0.01, median: -0.01, n: 15 } } });
    expect(m3.explainSignals([item()], undefined, { minChannelScore: 0 })[0].rejectedBy).toBe("min-channel-score");
  });

  it("вышедший сигнал: emitted=true, сам сигнал и значения фич приложены", () => {
    const m = model();
    const [e] = m.explainSignals([item()], { SOLUSDT: tape(0.02) });
    expect(e.emitted).toBe(true);
    expect(e.signal!.symbol).toBe("SOLUSDT");
    expect(e.values.volRegime).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// report(): статистика переведена в действия человеческим языком.
// ─────────────────────────────────────────────────────────────────────────────
describe("model.report() — отчёт для не-математика", () => {
  it("красный сертификат → «мало сделок … нужно ≥N» вместо «DSR < 0.95»", () => {
    const m = model({ meta: { ...JSON.parse(model().save()).meta, certification: cert(false) } });
    const r = m.report();
    expect(r).toContain("только бумага");
    expect(r).toContain("мало сделок: есть 10, нужно ≥30");
    expect(r).toContain("неотличим от удачи");
    expect(r).toContain("acknowledgeUncertified");
  });

  it("зелёный сертификат → «можно торговать» и дальнейшие шаги", () => {
    const m = model({ meta: { ...JSON.parse(model().save()).meta, certification: cert(true) } });
    const r = m.report();
    expect(r).toContain("можно торговать");
    expect(r).toContain("cadence");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Доктор: адаптер свечей и санитария данных.
// ─────────────────────────────────────────────────────────────────────────────
describe("validateGetCandles — контракт адаптера проверяется до fit", () => {
  const good: GetCandles = async (_s, _i, limit, sDate) => {
    const start = Math.floor((sDate ?? 0) / MIN) * MIN;
    return Array.from({ length: limit ?? 0 }, (_, k) => ({
      timestamp: start + k * MIN, open: 100, high: 100.2, low: 99.8, close: 100.1, volume: 500,
    }));
  };

  it("корректный адаптер проходит", async () => {
    const r = await validateGetCandles(good, { symbol: "SOLUSDT", ts: t0 });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("невыровненный старт, дубли и битые OHLC — конкретные претензии", async () => {
    const bad: GetCandles = async (_s, _i, limit, sDate) => {
      const out: ICandleData[] = [];
      for (let k = 0; k < (limit ?? 0); k++) {
        out.push({ timestamp: (sDate ?? 0) + k * MIN, open: 100, high: 99, low: 101, close: 100, volume: 500 }); // high<low!
      }
      out.push({ ...out[out.length - 1] }); // дубль последней (d=0)
      return out;
    };
    const r = await validateGetCandles(bad, { symbol: "SOLUSDT", ts: t0 });
    expect(r.ok).toBe(false);
    const all = r.issues.join("\n");
    expect(all).toContain("не выровнен");
    expect(all).toContain("дубли");
    expect(all).toContain("битые OHLCV");
    expect(all).toContain("limit не соблюдён");
  });

  it("бросающий адаптер → внятная ошибка, не краш", async () => {
    const r = await validateGetCandles(async () => { throw new Error("нет такого символа"); });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain("нет такого символа");
  });
});

describe("inspectItems — санитария данных до fit", () => {
  it("считает мусор, дубли, каналы и предупреждает о малой выборке", () => {
    const items = [
      item("a"), item("a"), // дубль
      { channel: "b", symbol: "TRXUSDT", direction: "short", ts: t0 },
      null, { channel: "c", symbol: "X", direction: "LONG", ts: t0 },
    ] as unknown as ParserItem[];
    const r = inspectItems(items);
    expect(r.invalid).toBe(2);
    expect(r.duplicates).toBe(1);
    expect(r.channels).toBe(2);
    expect(r.issues.join("\n")).toContain("дубликатов");
    expect(r.notes.join("\n")).toContain("сертификация");
  });

  it("один канал → предупреждение про single-режим", () => {
    const r = inspectItems([item(), item("ch", "TRXUSDT")]);
    expect(r.notes.join("\n")).toContain("single");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assessEdge.summary — связный человеческий итог.
// ─────────────────────────────────────────────────────────────────────────────
describe("assessEdge — summary и nextSteps", () => {
  it("растущий мир → paper с шагами «копить форвард»", async () => {
    const priceAt = (t: number) => 100 * Math.exp(0.0004 * ((t - t0) / MIN) + 0.003 * Math.sin((t - t0) / MIN / 40));
    const gc: GetCandles = async (_s, _i, limit, sDate) =>
      Array.from({ length: limit ?? 0 }, (_, k) => {
        const t = (sDate ?? 0) + k * MIN;
        const o = priceAt(t); const c = priceAt(t + MIN);
        return { timestamp: t, open: o, close: c, high: Math.max(o, c) * 1.0001, low: Math.min(o, c) * 0.9999, volume: 1000 };
      });
    const items: ParserItem[] = Array.from({ length: 12 }, (_, k) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 + 24 * HOUR + k * 12 * HOUR,
    }));
    const a = await assessEdge(items, gc, {
      walkForward: { slices: 2 },
      trainOptions: {
        folds: 3, mode: "single", onProgress: silentProgress, selection: { nestedOuterFolds: 0 },
        grid: {
          windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
          trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
          stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
          squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
          cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
        },
      },
    });
    expect(a.summary).toContain("БУМАГА");
    expect(a.summary).toContain("на сделку");
    expect(a.nextSteps.length).toBeGreaterThan(0);
    expect(a.nextSteps.join("\n")).toContain("acknowledgeUncertified");
  });
});
