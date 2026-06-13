import { describe, it, expect } from "vitest";
import { enumerateBursts, enumeratePosts, predict, PumpMatrix, TrainedParams } from "../src/index";
import { ParserItem } from "../src/types";
import { ICandleData, STEP_MS, entryStartTs } from "../src/candle";

const MIN = 60_000, HOUR = 3_600_000, t0 = Date.UTC(2026, 0, 6, 12, 0, 0);
const STEP = STEP_MS["1m"];
const E = (id: string, ch: string, ts: number, sym = "SOL"): ParserItem =>
  ({ id, channel: ch, symbol: sym, direction: "long", ts, entryFromPrice: 99, entryToPrice: 101 });

describe("АТАКА id: разнесённые всплески не теряются (best-per-symbol баг)", () => {
  it("два пампа на одном символе с разрывом >окна → ДВА всплеска, все id покрыты", () => {
    const items = [E("A1", "ch1", t0), E("A2", "ch2", t0 + MIN), E("B1", "ch1", t0 + 5 * HOUR), E("B2", "ch2", t0 + 5 * HOUR + MIN)];
    const bursts = enumerateBursts(items, 3, 0.3, 0.5, HOUR);
    expect(bursts.length).toBe(2);
    const cov = new Set(bursts.flatMap((b) => b.ids ?? []));
    expect(["A1", "A2", "B1", "B2"].every((x) => cov.has(x))).toBe(true);
  });
});

describe("АТАКА id: схлопнутые посты сохраняют id (enumeratePosts)", () => {
  it("A2 близко к A1 → схлопнут, но его id в ids первого всплеска", () => {
    const items = [E("A1", "ch1", t0), E("A2", "ch1", t0 + 2 * MIN), E("B1", "ch1", t0 + 5 * HOUR)];
    const posts = enumeratePosts(items, 3, HOUR);
    const first = posts.find((p) => p.id === "A1");
    expect(first).toBeDefined();
    expect(first!.ids).toContain("A2"); // схлопнутый id НЕ потерян
  });
});

describe("АТАКА id: схлопнутые посты сохраняют id (singleChannelSignals via predict)", () => {
  it("predict single: близкие посты схлопнуты, но id всех в verdict.ids", () => {
    const items = [E("X1", "ch1", t0), E("X2", "ch1", t0 + 2 * MIN)];
    const r = predict(items, { mode: "single", maxBurstWindowMs: HOUR, stationarityWindowMs: Infinity });
    expect(r.signals.length).toBe(1);
    expect(r.signals[0].ids).toEqual(expect.arrayContaining(["X1", "X2"]));
  });
});

describe("АТАКА id: id доходит до LIVE plan-сигнала (не только dump)", () => {
  const ex = { hardStop: 3, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 10, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 50.0, squeezePolicy: "none" as const, cascadeWindowMinutes: 5 };
  const P: TrainedParams = {
    version: 3, config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: { ch: { SOLUSDT: { long: { anomalous: ex, calm: ex } } } }, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: ex } }, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
    policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 10, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
  } as TrainedParams;
  const sig = t0; const start = entryStartTs(sig, "1m");
  const past = (): ICandleData[] => { const o: ICandleData[] = []; for (let k = 30; k >= 1; k--) o.push({ timestamp: start - k * STEP, open: 100, high: 100.3, low: 99.7, close: 100, volume: 1000 }); return o; };

  it("plan: origin.id = исходный id поста", () => {
    const item: ParserItem = { id: "LIVE-7", channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: sig, entryFromPrice: 99, entryToPrice: 101 };
    const r = PumpMatrix.load(P).plan([item], { SOLUSDT: past() });
    expect(r.length).toBe(1);
    expect(r[0].origin.id).toBe("LIVE-7");
    expect(r[0].origin.ids).toEqual(["LIVE-7"]);
  });

  it("plan: числовой id приводится к строке", () => {
    const item = { id: 777, channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: sig, entryFromPrice: 99, entryToPrice: 101 } as any;
    const r = PumpMatrix.load(P).plan([item], { SOLUSDT: past() });
    expect(r[0].origin.id).toBe("777");
  });

  it("plan: без id → origin.id undefined (обратная совместимость)", () => {
    const item: ParserItem = { channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: sig, entryFromPrice: 99, entryToPrice: 101 };
    const r = PumpMatrix.load(P).plan([item], { SOLUSDT: past() });
    expect(r[0].origin.id).toBeUndefined();
  });
});
