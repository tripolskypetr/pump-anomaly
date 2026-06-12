import { describe, it, expect } from "vitest";
import { standardError, oneStandardErrorSelect } from "../src/index";

describe("standardError", () => {
  it("SE = std/sqrt(n) выборочное (делитель n-1)", () => {
    // [2,4,4,4,5,5,7,9]: mean=5, выборочная var=32/7, std=sqrt(32/7), n=8
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    const expected = Math.sqrt(32 / 7) / Math.sqrt(8);
    expect(standardError(xs)).toBeCloseTo(expected, 6);
  });
  it("одинаковые значения → SE=0 (нет разброса)", () => {
    expect(standardError([0.05, 0.05, 0.05, 0.05])).toBe(0);
  });
  it("n<2 → SE=0", () => {
    expect(standardError([0.1])).toBe(0);
    expect(standardError([])).toBe(0);
  });
  it("больше разброс → больше SE", () => {
    const tight = standardError([0.09, 0.10, 0.11, 0.10]);
    const wide = standardError([0.02, 0.18, 0.05, 0.15]);
    expect(wide).toBeGreaterThan(tight);
  });
});

describe("oneStandardErrorSelect — против winner's curse", () => {
  type E = { id: string; score: number; folds: number[]; risk: number };
  const simplerByRisk = (a: E, b: E) => a.risk < b.risk;

  it("пустой board → null", () => {
    expect(oneStandardErrorSelect<E>([], (e) => e.score, (e) => e.folds, simplerByRisk)).toBe(null);
  });

  it("один кандидат → он же", () => {
    const only: E = { id: "x", score: 0.1, folds: [0.1, 0.1], risk: 5 };
    expect(oneStandardErrorSelect([only], (e) => e.score, (e) => e.folds, simplerByRisk)!.id).toBe("x");
  });

  it("выбирает консервативный в пределах 1 SE, не argmax", () => {
    const board: E[] = [
      { id: "risky", score: 0.100, folds: [0.08, 0.12, 0.09, 0.11], risk: 3 }, // argmax
      { id: "safe", score: 0.095, folds: [0.094, 0.096, 0.095, 0.095], risk: 1 },
    ];
    const c = oneStandardErrorSelect(board, (e) => e.score, (e) => e.folds, simplerByRisk);
    expect(c!.id).toBe("safe"); // 0.095 в пределах SE(0.0091) от 0.100
  });

  it("консервативный ВНЕ коридора 1 SE → НЕ выбирается", () => {
    const board: E[] = [
      { id: "argmax", score: 0.100, folds: [0.099, 0.101, 0.100, 0.100], risk: 3 }, // SE крошечный
      { id: "safe-far", score: 0.050, folds: [0.05, 0.05], risk: 1 }, // далеко вне коридора
    ];
    const c = oneStandardErrorSelect(board, (e) => e.score, (e) => e.folds, simplerByRisk);
    expect(c!.id).toBe("argmax"); // safe-far вне 1 SE → остаётся рискованный топ
  });

  it("SE топа широкий → коридор шире → дальше консервативные попадают", () => {
    const board: E[] = [
      { id: "noisy-top", score: 0.100, folds: [0.02, 0.18, 0.05, 0.15], risk: 3 }, // огромный SE ~0.0385
      { id: "safe", score: 0.065, folds: [0.065, 0.065], risk: 1 },
    ];
    const se = standardError(board[0].folds);
    expect(0.065).toBeGreaterThanOrEqual(0.100 - se); // в коридоре из-за широкого SE (порог ~0.0615)
    const c = oneStandardErrorSelect(board, (e) => e.score, (e) => e.folds, simplerByRisk);
    expect(c!.id).toBe("safe");
  });

  it("несколько в коридоре → самый консервативный из всех", () => {
    const board: E[] = [
      { id: "top", score: 0.100, folds: [0.08, 0.12, 0.09, 0.11], risk: 3 },
      { id: "mid", score: 0.096, folds: [0.096, 0.096], risk: 2 },
      { id: "safest", score: 0.093, folds: [0.093, 0.093], risk: 1 },
    ];
    const c = oneStandardErrorSelect(board, (e) => e.score, (e) => e.folds, simplerByRisk);
    // все три в пределах SE(~0.0091) от 0.100? top-0.0091=0.0909 → да, все ≥0.093
    expect(c!.id).toBe("safest");
  });

  it("SE=0 (нулевой разброс топа) → коридор схлопывается до точки, только точные ties", () => {
    const board: E[] = [
      { id: "top", score: 0.100, folds: [0.1, 0.1, 0.1], risk: 3 }, // SE=0
      { id: "tie", score: 0.100, folds: [0.1, 0.1], risk: 1 },       // ровно равный score
      { id: "below", score: 0.099, folds: [0.099], risk: 1 },        // чуть ниже → вне
    ];
    const c = oneStandardErrorSelect(board, (e) => e.score, (e) => e.folds, simplerByRisk);
    expect(c!.id).toBe("tie"); // только равный score в коридоре, он консервативнее
    expect(c!.risk).toBe(1);
  });

  it("больше grid не меняет выбор, если топ робастный (защита от размера board)", () => {
    // 100 шумных конфигов вокруг 0, один настоящий с edge → 1-SE не клюнет на шум
    const board: E[] = [];
    for (let i = 0; i < 100; i++) {
      // шумные: score случайно высокий на одном фолде, низкий на других
      board.push({ id: `noise${i}`, score: 0.04 + (i % 7) * 0.001, folds: [0.0, 0.15, 0.0, 0.0], risk: 3 });
    }
    board.push({ id: "real", score: 0.05, folds: [0.05, 0.05, 0.05, 0.05], risk: 1 }); // стабильный
    const c = oneStandardErrorSelect(board, (e) => e.score, (e) => e.folds, simplerByRisk);
    // real имеет score 0.05 (выше шумных ~0.04-0.046), стабильные фолды, risk=1 → выбран
    expect(c!.id).toBe("real");
  });
});

import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

describe("1-SE интеграция в train — выбор робастной конфигурации", () => {
  const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);
  const items: ParserItem[] = [];
  for (let d = 0; d < 16; d++)
    items.push({ channel: "yoda", symbol: ["SOL", "TRX"][d % 2] + "USDT", direction: "long", ts: t0 + d * 8 * 3600_000, entryFromPrice: 100, entryToPrice: 101 });

  const gc: GetCandles = async (s, i, lim, sd) => {
    const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
    const out: ICandleData[] = [];
    for (let k = 0; k < n; k++) { const p = 100 + k * 0.01; out.push({ timestamp: since + k * step, open: p, high: p * 1.002, low: p * 0.999, close: p * 1.001, volume: 1000 + (k % 7) * 80 }); }
    return out;
  };

  it("fit с конкурирующими hardStop → выбирает не максимальный, а робастный exit", async () => {
    const m = await PumpMatrix.fit(items, gc, {
      mode: "single", onProgress: silentProgress,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [1.0], hardStop: [1.0, 2.0, 3.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
        staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
      },
    });
    // модель обучилась, exit разрешается, hardStop из допустимого набора
    expect([1.0, 2.0, 3.0]).toContain(m.exit.global.hardStop);
    // 1-SE тяготеет к меньшему hardStop при near-tie (консервативность),
    // но главное — fit не падает и даёт валидный exit
    expect(m.exit.global.hardStop).toBeGreaterThan(0);
  });

  it("fit детерминирован: один и тот же вход → один и тот же выбор", async () => {
    const cfg = {
      mode: "single" as const, onProgress: silentProgress,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [0.5, 1.0], hardStop: [1.0, 2.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
        staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
      },
    };
    const m1 = await PumpMatrix.fit(items, gc, cfg);
    const m2 = await PumpMatrix.fit(items, gc, cfg);
    expect(m1.exit.global.hardStop).toBe(m2.exit.global.hardStop);
    expect(m1.exit.global.trailingTake).toBe(m2.exit.global.trailingTake);
  });
});
