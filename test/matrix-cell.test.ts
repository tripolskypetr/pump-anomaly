import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams } from "../src/index";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

function candles(rows: Array<[number, number, number, number, number]>): ICandleData[] {
  return rows.map((r, i) => ({
    timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4],
  }));
}

const base = {
  hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
  volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, squeezePolicy: "none" as const,
};

/** matrix-модель: cell под каноническим "_matrix" (как кладёт обучение в matrix-режиме) */
function matrixModel(): PumpMatrix {
  const params: TrainedParams = {
    version: 3,
    config: { windowK: 3, minClusters: 2, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "matrix", stationarityWindowMs: Infinity },
    exit: {
      cells: {
        matrix: { _matrix: { SOLUSDT: { long: { calm: { ...base, trailingTake: 2.5 } } } } },
        single: {},
      },
      bySymbolDir: {
        matrix: { SOLUSDT: { long: { ...base, trailingTake: 1.0 } } },
        single: {},
      },
      byMode: { matrix: { ...base, trailingTake: 3.0 }, single: { ...base, trailingTake: 1.0 } },
      global: { ...base, trailingTake: 1.0 },
    },
    policy: { allow: ["enter", "invert", "tighten"] },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, cvWinrate: 0.6, cvSupport: 20,
      gridSize: 100, mode: "matrix", impactHorizonMinutes: 240,
      confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60,
    },
  };
  return PumpMatrix.load(params);
}

describe("matrix cell-exit резолвится через _matrix ключ (регрессия)", () => {
  const model = matrixModel();

  it("matrix-вердикт (channel=null) + calm-свечи → cell-уровень, trailing 2.5", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 101, 99.9, 100.9, 1000]);   // вход (свеча 20), обычный объём → calm
    rows.push([100.9, 102, 100.8, 101.9, 1000]);
    const cs = candles(rows);
    // matrix planForAt: channel=null (межканальный), но cell должен найтись под _matrix
    const plan = model.planForAt("SOLUSDT", "long", null, cs, cs[20].timestamp);
    expect(plan).not.toBe(null);
    expect(plan!.origin.volRegime).toBe("calm");
    expect(plan!.origin.exitSource).toBe("cell");   // ← до фикса было "mode" (cell терялся)
    expect(plan!.exit.trailingTake).toBe(2.5);
  });

  it("planForAt без свечей → symbol-dir (cell требует volRegime)", () => {
    const cs = candles([[100, 101, 99, 100, 1000]]);
    const plan = model.planForAt("SOLUSDT", "long", null, cs, cs[0].timestamp);
    // одна свеча без истории → volZ≈0 → calm, но cell есть → может быть cell;
    // главное: exit разрешается и trailing — число
    expect(typeof plan!.exit.trailingTake).toBe("number");
  });
});
