import { describe, it, expect } from "vitest";
import { percentile, riskRewardStats, PumpMatrix, TrainedParams } from "../src/index";
import { ICandleData } from "../src/candle";

describe("percentile", () => {
  it("P50 медиана", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
  it("P95/P99 на хвосте", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(xs, 0.95)).toBeCloseTo(95.05, 1);
    expect(percentile(xs, 0.99)).toBeCloseTo(99.01, 1);
  });
  it("пустая → 0, одиночка → сама", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
  });
});

describe("riskRewardStats — RR = pnl / hardStop", () => {
  it("считает mean/p95/p99 в единицах риска", () => {
    // pnl в долях, hardStop в % → RR = pnl / (hardStop/100)
    // pnl=0.04 (4%), hardStop=2% → RR = 2
    const trades = [
      { pnl: 0.04, hardStop: 2 },  // RR 2
      { pnl: 0.02, hardStop: 2 },  // RR 1
      { pnl: -0.02, hardStop: 2 }, // RR -1
      { pnl: 0.06, hardStop: 2 },  // RR 3
    ];
    const rr = riskRewardStats(trades);
    expect(rr.n).toBe(4);
    expect(rr.mean).toBeCloseTo((2 + 1 - 1 + 3) / 4, 5); // 1.25
    expect(rr.p99).toBeGreaterThanOrEqual(rr.mean);
  });
  it("hardStop ≤ 0 пропускается (нет деления на ноль)", () => {
    const rr = riskRewardStats([{ pnl: 0.05, hardStop: 0 }, { pnl: 0.04, hardStop: 2 }]);
    expect(rr.n).toBe(1);
  });
  it("пустая выборка → нули", () => {
    expect(riskRewardStats([])).toEqual({ mean: 0, p95: 0, p99: 0, n: 0 });
  });
});

// модель с RR-статистикой по символам для runtime-фильтра
function rrModel(): PumpMatrix {
  const base = {
    hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
    volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, squeezePolicy: "none" as const,
    trailingTake: 1.0,
  };
  const params: TrainedParams = {
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: {
      cells: { single: {}, matrix: {} },
      bySymbolDir: { single: {
        SOLUSDT: { long: base }, FARTCOINUSDT: { long: base },
      }, matrix: {} },
      byMode: { single: base, matrix: base },
      global: base,
    },
    policy: { allow: ["enter", "invert", "tighten"] },
    riskReward: {
      bySymbol: {
        SOLUSDT: { mean: 2.5, p95: 5.0, p99: 7.0, n: 40 },      // хороший RR
        FARTCOINUSDT: { mean: 0.3, p95: 1.0, p99: 1.2, n: 15 }, // плохой RR
      },
      global: { mean: 1.4, p95: 3.0, p99: 5.0, n: 55 },
    },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20,
      gridSize: 100, mode: "single", modeReason: "test fixture", impactHorizonMinutes: 240,
      confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 55,
    },
  };
  return PumpMatrix.load(params);
}

describe("runtime RR-фильтр — readonly паттерн", () => {
  const model = rrModel();
  const items = [
    { channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: 1 },
    { channel: "ch", symbol: "FARTCOINUSDT", direction: "long" as const, ts: 2 },
  ];

  it("без фильтра → оба символа", () => {
    const out = model.signals(items);
    const syms = new Set(out.map((s) => s.symbol));
    expect(syms.has("SOLUSDT")).toBe(true);
    expect(syms.has("FARTCOINUSDT")).toBe(true);
  });

  it("minRiskReward=1.0 (mean) → режет FARTCOIN (RR 0.3), оставляет SOL (2.5)", () => {
    const out = model.signals(items, { minRiskReward: 1.0 });
    const syms = new Set(out.map((s) => s.symbol));
    expect(syms.has("SOLUSDT")).toBe(true);
    expect(syms.has("FARTCOINUSDT")).toBe(false);
  });

  it("rrMetric=p99 сравнивает хвост, не среднее", () => {
    // порог 6.0 по p99: SOL p99=7.0 проходит, FARTCOIN p99=1.2 нет
    const out = model.signals(items, { minRiskReward: 6.0, rrMetric: "p99" });
    const syms = new Set(out.map((s) => s.symbol));
    expect(syms.has("SOLUSDT")).toBe(true);
    expect(syms.has("FARTCOINUSDT")).toBe(false);
  });

  it("символ без RR-статистики → режется консервативно", () => {
    const unknown = [{ channel: "ch", symbol: "PEPEUSDT", direction: "long" as const, ts: 3 }];
    const out = model.signals(unknown, { minRiskReward: 0.1 });
    expect(out.length).toBe(0);
  });

  it("RR-статистика доступна через геттер", () => {
    expect(model.riskReward.bySymbol.SOLUSDT.mean).toBe(2.5);
    expect(model.riskReward.global.n).toBe(55);
  });
});
