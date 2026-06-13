import { describe, it, expect } from "vitest";
import { entryStartTs, alignTs, STEP_MS, GetCandles, ICandleData } from "../src/candle";
import { labelBurst } from "../src/label";
import { PumpMatrix, TrainedParams } from "../src/index";
import { ParserItem } from "../src/types";

const STEP = STEP_MS["1m"];
const E = (o: Partial<import("../src/replay").ExitParams> = {}): import("../src/replay").ExitParams =>
  ({ trailingTake: 50, hardStop: 50, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 5, ...o });

describe("entryStartTs — исключение формирующейся свечи сигнала", () => {
  it("сигнал ВНУТРИ минуты → старт со СЛЕДУЮЩЕЙ границы (свеча сигнала пропущена)", () => {
    const sig = Date.UTC(2026, 0, 6, 16, 59, 51, 652);
    expect(entryStartTs(sig, "1m")).toBe(alignTs(sig, "1m") + STEP);
    expect(entryStartTs(sig, "1m")).toBeGreaterThan(sig); // строго после сигнала
  });

  it("сигнал РОВНО на границе → та же свеча (открывается с сигналом, честно торгуема)", () => {
    const sig = Date.UTC(2026, 0, 6, 17, 0, 0);
    expect(entryStartTs(sig, "1m")).toBe(sig);
    expect(entryStartTs(sig, "1m")).toBe(alignTs(sig, "1m"));
  });

  it("на 1мс позже границы → уже следующая свеча", () => {
    const sig = Date.UTC(2026, 0, 6, 17, 0, 0) + 1;
    expect(entryStartTs(sig, "1m")).toBe(Date.UTC(2026, 0, 6, 17, 1, 0));
  });
});

describe("fit (labelBurst) — свечи запрашиваются СТРОГО без look-ahead", () => {
  it("для сигнала внутри минуты getCandles НЕ получает свечу, содержащую сигнал", async () => {
    const sig = Date.UTC(2026, 0, 6, 16, 59, 51, 652);
    let firstSince = -1;
    const gc: GetCandles = async (s, i, lim, sd) => {
      if (firstSince < 0) firstSince = sd!;
      const out: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) out.push({ timestamp: sd! + k * STEP, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1000 });
      return out;
    };
    await labelBurst(gc, "X", "long", sig, [E()], 100, 101);
    // запрошено строго с границы ПОСЛЕ сигнала — формирующаяся свеча не попадает
    expect(firstSince).toBe(entryStartTs(sig, "1m"));
    expect(firstSince).toBeGreaterThan(alignTs(sig, "1m"));
  });

  it("все запрошенные свечи имеют ts >= entryStartTs (ни одной до/на сигнале)", async () => {
    const sig = Date.UTC(2026, 0, 6, 12, 30, 17);
    const seen: number[] = [];
    const gc: GetCandles = async (s, i, lim, sd) => {
      const out: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) { const ts = sd! + k * STEP; seen.push(ts); out.push({ timestamp: ts, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1000 }); }
      return out;
    };
    await labelBurst(gc, "X", "long", sig, [E()], 100, 101);
    const start = entryStartTs(sig, "1m");
    expect(seen.every((ts) => ts >= start)).toBe(true);
    expect(seen.every((ts) => ts > alignTs(sig, "1m") || alignTs(sig, "1m") === sig)).toBe(true);
  });
});

describe("plan (live) — свечи запрашиваются СТРОГО без look-ahead", () => {
  const ex = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0, squeezePolicy: "none" as const, cascadeWindowMinutes: 30 };
  const P: TrainedParams = {
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
    policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
  } as TrainedParams;

  it("plan (live) для сигнала внутри минуты тянет ТОЛЬКО свечи ДО сигнала (no look-ahead)", async () => {
    const sig = Date.UTC(2026, 0, 6, 16, 59, 51, 652);
    const seen: number[] = [];
    const gc: GetCandles = async (s, i, lim, sd) => {
      const out: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) { const ts = sd! + k * STEP; seen.push(ts); out.push({ timestamp: ts, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1000 }); }
      return out;
    };
    const items: ParserItem[] = [{ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: sig, entryFromPrice: 100, entryToPrice: 101 }];
    await PumpMatrix.load(P).plan(items, gc);
    const start = entryStartTs(sig, "1m");
    // live: НИ ОДНОЙ свечи на/после входной минуты — только прошлое
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ts) => ts < start)).toBe(true);
  });
});
