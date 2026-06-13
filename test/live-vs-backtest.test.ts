import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams } from "../src/index";
import { GetCandles, ICandleData, STEP_MS, entryStartTs } from "../src/candle";
import { ParserItem } from "../src/types";
import { squeezePressureBefore, squeezePressure } from "../src/volume";

const STEP = STEP_MS["1m"];
const mk = (pol: string): TrainedParams => {
  const ex = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 60, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0, squeezePolicy: pol as any, cascadeWindowMinutes: 5 };
  return {
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: { ch: { SOLUSDT: { long: { anomalous: ex, calm: ex } } } }, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: ex } }, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
    policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 60, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
  } as TrainedParams;
};
const sig = Date.UTC(2026, 0, 6, 12, 0, 0);
const start = entryStartTs(sig, "1m");
// каскад ВНИЗ (против long) в последних 5 свечах ПЕРЕД сигналом
const before = (): ICandleData[] => {
  const out: ICandleData[] = [];
  for (let k = 30; k >= 1; k--) { const ts = start - k * STEP; const down = k <= 5; out.push({ timestamp: ts, open: 100, high: 100.5, low: down ? 97 : 99.5, close: down ? 97.5 : 100, volume: down ? 9000 : 1000 }); }
  return out;
};
const after = (): ICandleData[] => {
  const out: ICandleData[] = [];
  for (let k = 0; k < 30; k++) out.push({ timestamp: start + k * STEP, open: 100, high: 101, low: 99.5, close: 100.2, volume: 1000 });
  return out;
};
const items: ParserItem[] = [{ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: sig, entryFromPrice: 99, entryToPrice: 101 }];

describe("squeezePressureBefore — каскад по свечам ДО входа (no look-ahead)", () => {
  it("видит давление в прошлых свечах, forward-версия — нет (на тех же данных)", () => {
    const cs = before();
    const entryIdx = cs.length; // вход сразу после последней прошлой свечи
    // backward видит каскад вниз (последние 5 свечей против long)
    const back = squeezePressureBefore(cs, entryIdx, "long", 5);
    expect(back).toBeGreaterThanOrEqual(0.6);
    // forward на тех же свечах (нет свечей после entryIdx) → 0
    const fwd = squeezePressure(cs, entryIdx, "long", 5);
    expect(fwd).toBe(0);
  });
});

describe("plan (live) vs backtest — разное окно каскада", () => {
  it("live plan: каскад ДО сигнала → veto (0 сигналов), без свечей будущего", () => {
    const live = PumpMatrix.load(mk("veto")).plan(items, { SOLUSDT: before() });
    expect(live.length).toBe(0); // veto по прошлому каскаду
  });

  it("backtest: forward свечи спокойны → вход (1 сигнал)", () => {
    const bt = PumpMatrix.load(mk("veto")).backtest(items, { SOLUSDT: [...before(), ...after()] });
    expect(bt.length).toBe(1); // forward каскада нет → не veto
  });

  it("live plan async (getCandles) тянет ТОЛЬКО прошлые свечи", async () => {
    const seen: number[] = [];
    const gc: GetCandles = async (s, i, lim, sd) => {
      const out: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) { const ts = sd! + k * STEP; seen.push(ts); out.push({ timestamp: ts, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }); }
      return out;
    };
    await PumpMatrix.load(mk("none")).plan(items, gc);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ts) => ts < start)).toBe(true); // ни одной свечи на/после входа
  });

  it("backtest async (getCandles) тянет свечи ОТ входа вперёд", async () => {
    const seen: number[] = [];
    const gc: GetCandles = async (s, i, lim, sd) => {
      const out: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) { const ts = sd! + k * STEP; seen.push(ts); out.push({ timestamp: ts, open: 100, high: 101, low: 99.5, close: 100.2, volume: 1000 }); }
      return out;
    };
    await PumpMatrix.load(mk("none")).backtest(items, gc);
    expect(seen.every((ts) => ts >= start)).toBe(true); // от входа вперёд
  });
});

describe("lookbackMinutes — окно истории до сигнала", () => {
  const withWin = (bw: number, cw: number): TrainedParams => {
    const ex = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 60, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: bw, trailingTake: 1.0, squeezePolicy: "none" as const, cascadeWindowMinutes: cw };
    return {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
      policy: { allow: ["enter"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 60, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
    } as TrainedParams;
  };

  it("= max(volBaselineWindow, cascadeWindowMinutes) + 5", () => {
    expect(PumpMatrix.load(withWin(20, 15)).lookbackMinutes).toBe(25);
    expect(PumpMatrix.load(withWin(20, 30)).lookbackMinutes).toBe(35);
    expect(PumpMatrix.load(withWin(20, 60)).lookbackMinutes).toBe(65);
    expect(PumpMatrix.load(withWin(50, 30)).lookbackMinutes).toBe(55); // базлайн доминирует
  });

  it("plan(getCandles) запрашивает РОВНО lookbackMinutes свечей", async () => {
    const m = PumpMatrix.load(withWin(20, 60));
    let reqLim = -1;
    const gc: GetCandles = async (s, i, lim, sd) => {
      reqLim = lim ?? 0;
      const out: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) out.push({ timestamp: sd! + k * STEP, open: 100, high: 101, low: 99.5, close: 100, volume: 1000 });
      return out;
    };
    const item: ParserItem = { channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: Date.UTC(2026, 0, 6, 12, 0, 0), entryFromPrice: 99, entryToPrice: 101 };
    await m.plan([item], gc);
    expect(reqLim).toBe(m.lookbackMinutes);
  });

  it("дефолты (нет volBaselineWindow/cascadeWindowMinutes) → 30+5=35? нет: max(20,30)+5", () => {
    const ex: any = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 60, trailingTake: 1.0, squeezePolicy: "none" };
    const p = withWin(20, 30); p.exit.global = ex; // без явных окон → дефолты в геттере (20, 30)
    expect(PumpMatrix.load(p).lookbackMinutes).toBe(35);
  });
});

describe("minClusters / minSharedEvents — пороги детектора из config", () => {
  const mk = (minC: number, mse?: number): TrainedParams => {
    const ex = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 60, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0, squeezePolicy: "none" as const, cascadeWindowMinutes: 30 };
    return {
      version: 3,
      config: { windowK: 3, minClusters: minC, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "matrix", stationarityWindowMs: Infinity, ...(mse !== undefined ? { viability: { minSharedEvents: mse } } : {}) },
      exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
      policy: { allow: ["enter"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "matrix", modeReason: "x", impactHorizonMinutes: 60, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
    } as TrainedParams;
  };

  it("minClusters берётся из config", () => {
    expect(PumpMatrix.load(mk(2)).minClusters).toBe(2);
    expect(PumpMatrix.load(mk(3)).minClusters).toBe(3);
  });

  it("minSharedEvents: дефолт 3 без viability-override", () => {
    expect(PumpMatrix.load(mk(2)).minSharedEvents).toBe(3);
  });

  it("minSharedEvents берётся из config.viability при override", () => {
    expect(PumpMatrix.load(mk(2, 5)).minSharedEvents).toBe(5);
    expect(PumpMatrix.load(mk(2, 1)).minSharedEvents).toBe(1);
  });
});
