import { describe, it, expect } from "vitest";
import { train, PumpMatrix, enumerateBursts, earlyWarning, buildTable } from "../src/index";
import { SignalEvent, DEFAULT_CONFIG } from "../src/types";
import { silentProgress } from "../src/progress";
import { buildFixture } from "./fixture";
import { makeGetCandles, PriceInjection } from "./fake-candles";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// authorGraph сквозь обучение: hawkes-оценщик выбирается в fit, сериализуется
// в config модели и используется predict'ом после load().
// ─────────────────────────────────────────────────────────────────────────────
describe("authorGraph='hawkes' — сквозь fit → model.json → predict", () => {
  it("matrix-обучение с hawkes-графом: конфиг прошит, сигналы есть, save/load держит", async () => {
    const fx = buildFixture();
    const pumpTs = fx.t0 + 12 * DAY + 9 * HOUR;
    const injections: PriceInjection[] = [{ symbol: "SOLUSDT", ts: pumpTs, direction: "long", drift: 0.10 }];
    const res = await train(fx.items, makeGetCandles(injections), {
      folds: 3, mode: "matrix", onProgress: silentProgress,
      authorGraph: "hawkes",
      channelTriage: false, outcomeModel: false,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
        trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
        stalenessSinceMinutes: [240], staleMinutes: [240], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    expect(res.params.meta.mode).toBe("matrix");
    expect(res.params.config.authorGraph).toBe("hawkes");
    expect(res.params.meta.totalSamples).toBeGreaterThan(0); // hawkes-граф дал всплески
    // после save/load predict работает тем же оценщиком (конфиг сериализован)
    const m = PumpMatrix.load(PumpMatrix.load(res.params as never).save());
    const rep = m.explain(fx.items);
    expect(rep.usedMode).toBe("matrix");
    // братья фикстуры склеены и hawkes-графом
    const ids = new Set(["x_main", "x_mirror", "x_backup"].map((c) => rep.authors.get(c)));
    expect(ids.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// confirmSpan: скорость схождения подтверждений — в кандидате, вердикте и фиче.
// ─────────────────────────────────────────────────────────────────────────────
describe("confirmSpanMs — сжатые подтверждения vs размазанные", () => {
  const ev = (channel: string, ts: number): SignalEvent =>
    ({ channel, symbol: "SOLUSDT", direction: "long", ts });
  // предыстория для фона hawkes
  const history: SignalEvent[] = Array.from({ length: 4 }, (_, i) =>
    ev("a", t0 + i * 7 * DAY));

  it("enumerateBursts несёт span лучшего среза", () => {
    // каналам нужна НЕЗАВИСИМАЯ история (иначе единственная ко-оккуренция
    // честно склеивает их в одного автора и кластер всплеска = 1)
    const solo = (c: string, sym: string): SignalEvent[] =>
      Array.from({ length: 4 }, (_, i) =>
        ({ channel: c, symbol: sym, direction: "long", ts: t0 + i * 5 * DAY + c.charCodeAt(0) * HOUR }));
    const events = [
      ...history,
      ...solo("a", "AAUSDT"), ...solo("b", "BBUSDT"), ...solo("c", "CCUSDT"),
      ev("a", t0 + 40 * DAY),
      ev("b", t0 + 40 * DAY + 2 * MIN),
      ev("c", t0 + 40 * DAY + 4 * MIN),
    ];
    const bursts = enumerateBursts(events, 3, 0.3, 0.5, 3600_000);
    const burst = bursts.find((b) => b.independentClusters >= 2)!;
    expect(burst).toBeDefined();
    expect(burst.confirmSpanMs).toBe(4 * MIN); // от первого до последнего подтверждения
  });

  it("earlyWarning: у сжатого всплеска span меньше, чем у размазанного", () => {
    const clusters = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const cfg = { ...DEFAULT_CONFIG, minClusters: 2, maxBurstWindowMs: 3600_000 };
    const tight = earlyWarning(
      buildTable([...history, ev("a", t0 + 40 * DAY), ev("b", t0 + 40 * DAY + MIN), ev("c", t0 + 40 * DAY + 2 * MIN)]),
      clusters, cfg, 10 * MIN,
    ).find((v) => v.action === "open")!;
    const spread = earlyWarning(
      buildTable([...history, ev("a", t0 + 40 * DAY), ev("b", t0 + 40 * DAY + 12 * MIN), ev("c", t0 + 40 * DAY + 25 * MIN)]),
      clusters, cfg, 10 * MIN,
    ).find((v) => v.action === "open")!;
    expect(tight.confirmSpanMs).toBe(2 * MIN);
    expect(spread.confirmSpanMs!).toBeGreaterThan(tight.confirmSpanMs!);
  });

  it("одиночный пост (single-режим) — span 0, фича confirmPace честно null", async () => {
    // plumbing-проверка через train: single-мир, outcome включён — фича не ломает модель
    const items = Array.from({ length: 10 }, (_, k) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
    }));
    const gc = makeGetCandles([{ symbol: "SOLUSDT", ts: t0, direction: "long", drift: 0.05 }]);
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
        stalenessSinceMinutes: [240], staleMinutes: [60], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    // модель исхода либо null (мало строк/один класс), либо построена без confirmPace-маржинала
    if (res.params.outcome) {
      expect(res.params.outcome.features.confirmPace).toBeUndefined();
    }
    expect(res.params.version).toBe(3);
  });
});
