import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams } from "../src/index";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

function candles(rows: Array<[number, number, number, number, number]>): ICandleData[] {
  return rows.map((r, i) => ({
    timestamp: t0 + i * MIN,
    open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4],
  }));
}

/** ручной v3-params с разными cell-exit под calm/anomalous, чтобы проверить резолв из свечей */
function makeModel(): PumpMatrix {
  const params: TrainedParams = {
    version: 3,
    config: {
      windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5,
      maxBurstWindowMs: 3600_000, mode: "single",
    },
    exit: {
      cells: {
        single: {
          crypto_yoda: {
            SOLUSDT: {
              long: {
                calm: { trailingTake: 2.0, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, squeezePolicy: "none" },
                anomalous: { trailingTake: 0.5, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, squeezePolicy: "veto" },
              },
            },
          },
        },
        matrix: {},
      },
      bySymbolDir: {
        single: { SOLUSDT: { long: { trailingTake: 1.0, hardStop: 1.5, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, squeezePolicy: "none" } } },
        matrix: {},
      },
      byMode: {
        single: { trailingTake: 1.0, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 },
        matrix: { trailingTake: 3.0, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 },
      },
      global: { trailingTake: 1.0, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 },
    },
    policy: { allow: ["enter", "invert", "tighten"] },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 100, mode: "single", impactHorizonMinutes: 240,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  };
  return PumpMatrix.load(params);
}

describe("planFor — свечи на вход, готовый план на выход", () => {
  const model = makeModel();

  it("спокойный объём → cell calm, trailing 2.0, recommendation enter", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]); // базлайн ~1000±std
    rows.push([100, 101, 99.9, 100.9, 1000]);     // вход (свеча 20), обычный объём → calm
    rows.push([100.9, 102, 100.8, 101.9, 1000]);  // forward: рост в сторону long
    const cs = candles(rows);
    const plan = model.planForAt("SOLUSDT", "long", "crypto_yoda", cs, cs[20].timestamp);
    expect(plan).not.toBe(null);
    expect(plan!.origin.volRegime).toBe("calm");
    expect(plan!.origin.exitSource).toBe("cell");
    expect(plan!.exit.trailingTake).toBe(2.0);
    expect(plan!.action).toBe("enter");
  });

  it("аномальный объём + каскад против long → cell anomalous, veto", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 100.6, 99.9, 100.4, 9000]);   // вход (свеча 20): аномальный объём
    rows.push([100.4, 100.5, 98, 98.2, 9000]);     // каскад вниз против long
    rows.push([98.2, 98.3, 96, 96.4, 9000]);
    const cs = candles(rows);
    const plan = model.planForAt("SOLUSDT", "long", "crypto_yoda", cs, cs[20].timestamp);
    // veto → сигнал НЕ возвращается (фильтр внутри), исполнять нечего
    expect(plan).toBe(null);
  });
});

describe("plan — батч сигналов + словарь свечей", () => {
  const model = makeModel();

  it("резолвит план per-symbol из переданных свечей", () => {
    const items = [
      { channel: "crypto_yoda", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + 20 * MIN },
    ];
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 101, 99.9, 100.9, 1000]);
    rows.push([100.9, 102, 100.8, 101.9, 1000]);
    const plans = model.plan(items, { SOLUSDT: candles(rows) });
    expect(plans.length).toBe(1);
    expect(plans[0].origin.volRegime).toBe("calm");
    expect(plans[0].origin.exitSource).toBe("cell");
  });

  it("символ без свечей → fallback на symbol-dir, recommendation enter, volRegime null", () => {
    const items = [
      { channel: "crypto_yoda", symbol: "SOLUSDT", direction: "long" as const, ts: t0 },
    ];
    const plans = model.plan(items, {}); // свечей нет
    expect(plans[0].origin.volRegime).toBe(null);
    expect(plans[0].action).toBe("enter");
    expect(plans[0].origin.exitSource).toBe("symbol-dir");
    expect(plans[0].exit.trailingTake).toBe(1.0); // symbol-dir exit
  });
});

describe("signals — без свечей остаётся рабочим", () => {
  it("volRegime/squeezePressure null, recommendation enter", () => {
    const model = makeModel();
    const items = [{ channel: "crypto_yoda", symbol: "SOLUSDT", direction: "long" as const, ts: t0 }];
    const plans = model.signals(items);
    expect(plans[0].origin.volRegime).toBe(null);
    expect(plans[0].action).toBe("enter");
  });
});
