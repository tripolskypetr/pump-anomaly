import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { riskRewardStats, percentile } from "../src/objective";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 10, ...o,
});

// Регрессия на БАГ: hard-stop раньше возвращал lastPositivePeak (≥0) вместо честного
// убытка -hardStop%. Это завышало pnl и отравляло RR/CV (стопы выглядели небыточными).
describe("РЕГРЕССИЯ — hard-stop возвращает ЧЕСТНЫЙ убыток, не фиктивный пик", () => {
  it("пик +5%, трейлинг не сработал, обвал → стоп = -hardStop%, НЕ +5%", () => {
    const cs = C([
      [100, 100, 99.95, 100, 1000],
      [100, 105, 100, 104, 1000],   // пик +5% (trailingTake большой → не выходим)
      [104, 104, 90, 91, 1000],     // обвал → hard stop @3%
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 3, trailingTake: 50, staleMinutes: 10 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.03, 9); // честный -3%, НЕ фиктивный +5%
    expect(r.peak).toBeCloseTo(0.05, 9); // пик доступен отдельно для диагностики
  });

  it("RR на серии стоп-хантов ОТРИЦАТЕЛЬНЫЙ (баг давал положительный)", () => {
    // 5 сделок: каждая чуть в плюс, потом стоп. Раньше RR был +0.167 (ложь),
    // теперь честно отрицательный.
    const trades: Array<{ pnl: number; hardStop: number }> = [];
    for (let i = 0; i < 5; i++) {
      const cs = C([[100, 100, 99.95, 100, 1000], [100, 100.5, 100, 100.3, 1000], [100.3, 100.3, 96, 96.5, 1000]]);
      const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 3, trailingTake: 50, staleMinutes: 10 }));
      trades.push({ pnl: r.pnl, hardStop: 3 });
    }
    const rr = riskRewardStats(trades);
    expect(rr.mean).toBeCloseTo(-1.0, 9);  // pnl -3% / hardStop 3% = -1.0 на сделку
    expect(rr.mean).toBeLessThan(0);        // КРИТИЧНО: фильтр minRiskReward теперь увидит риск
  });

  it("стоп БЕЗ предыдущего плюса → честный -hardStop% (раньше было 0)", () => {
    const cs = C([[100, 100, 99.95, 100, 1000], [100, 100, 95, 96, 1000]]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 2, staleMinutes: 5 }));
    expect(r.pnl).toBeCloseTo(-0.02, 9);
  });

  it("прибыльная сделка (trailing/life-cap) НЕ затронута фиксом — pnl честно положительный", () => {
    const cs = C([
      [100, 100.05, 99.95, 100, 1000],
      [100, 102, 100, 102, 1000], [102, 104, 102, 104, 1000],
      [104, 106, 104, 106, 1000], [106, 108, 106, 108, 1000],
      [108, 110, 108, 110, 1000],
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ trailingTake: 50, hardStop: 50, staleMinutes: 5 }));
    expect(r.pnl).toBeCloseTo(0.10, 9); // +10% не сломан
  });

  it("симметрия short: стоп вверх против short → честный -hardStop%", () => {
    const cs = C([[100, 100.05, 100, 100, 1000], [100, 105, 100, 104, 1000]]);
    const r = replayExit(cs, "short", 99.95, 100.05, E({ hardStop: 2, trailingTake: 50, staleMinutes: 5 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.02, 9);
  });

  it("life-cap в минусе → честный отрицательный pnl (не floored к 0)", () => {
    // цена сползает но не пробивает стоп, life-cap по close в минусе
    const cs = C([
      [100, 100.05, 99.95, 100, 1000],
      [100, 100, 99.5, 99.5, 1000], [99.5, 99.6, 99.2, 99.3, 1000],
      [99.3, 99.4, 99.1, 99.2, 1000],
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 5, trailingTake: 50, staleMinutes: 3 }));
    expect(r.reason).toBe("life-cap");
    expect(r.pnl).toBeLessThan(0); // честный минус, не 0
    expect(r.pnl).toBeCloseTo(-0.008, 9); // close 99.2 → -0.8%
  });
});

describe("РЕГРЕССИЯ — инверсия сохраняет настоящий reason выхода", () => {
  const C2 = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
    rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

  it("инверсия в плюс → reason это life-cap/trailing, НЕ затёртый 'invert'", () => {
    // окно каскада=1: чистый сквиз вверх → invert; long-инверсия доходит до life-cap
    const cs = C2([
      [100, 100.05, 99.95, 100, 1000],
      [100, 103, 99.95, 102.9, 9000],   // вверх (против short) pressure 1.0 в окне 1
      [102.9, 103, 100, 100.5, 9000],
    ]);
    const r = replayExit(cs, "short", 99.95, 100.05, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 5, trailingTake: 50, staleMinutes: 2 }));
    expect(r.inverted).toBe(true);                         // флаг инверсии стоит
    expect(r.reason).not.toBe("invert");                  // reason НЕ затёрт
    expect(["trailing-take", "life-cap", "peak-staleness", "hard-stop"]).toContain(r.reason);
  });

  it("инверсия, которая стопается → reason='hard-stop' виден (не скрыт за 'invert')", () => {
    // long-инверсия входит и попадает под обвал → честный hard-stop виден
    const cs = C2([
      [100, 100.05, 99.95, 100, 1000],
      [100, 103, 99.95, 102.9, 9000],   // сквиз вверх → invert, окно 1 → pressure 1.0
      [102.9, 103, 95, 95.5, 9000],     // long-инверсия от ~100: low 95 → -5% → стоп @3%
    ]);
    const r = replayExit(cs, "short", 99.95, 100.05, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 3, trailingTake: 50, staleMinutes: 2 }));
    expect(r.inverted).toBe(true);
    expect(r.reason).toBe("hard-stop");      // настоящий механизм виден
    expect(r.pnl).toBeCloseTo(-0.03, 9);     // и честный убыток
  });
});

describe("РЕГРЕССИЯ — percentile устойчив к NaN/Infinity (битая свеча)", () => {
  it("NaN в выборке отбрасывается, не отравляет результат", () => {
    expect(percentile([1, NaN, 3, 2], 0.5)).toBeCloseTo(2, 9); // NaN убран → [1,2,3]
  });
  it("Infinity отбрасывается", () => {
    expect(percentile([1, Infinity, 2], 0.5)).toBeCloseTo(1.5, 9);
  });
  it("вся выборка NaN → 0 (не NaN)", () => {
    expect(percentile([NaN, NaN], 0.95)).toBe(0);
  });
  it("riskRewardStats с битым pnl не возвращает NaN", () => {
    const rr = riskRewardStats([{ pnl: 0.04, hardStop: 2 }, { pnl: NaN, hardStop: 2 }]);
    expect(Number.isFinite(rr.mean)).toBe(true);
    expect(Number.isFinite(rr.p95)).toBe(true);
  });
});

describe("РЕГРЕССИЯ — facade veto зависит от volRegime (требует baseline с дисперсией)", () => {
  const C3 = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
    rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
  const base = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0 };
  function vetoModel(): any {
    const veto = { ...base, squeezePolicy: "veto" as const };
    return {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: { cells: { single: { ch: { SOLUSDT: { long: { anomalous: veto, calm: { ...base, squeezePolicy: "none" as const } } } } }, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: veto } }, matrix: {} }, byMode: { single: veto, matrix: veto }, global: veto },
      policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
    };
  }

  it("аномальный вход (baseline с дисперсией) + каскад → veto фильтрует (action null)", async () => {
    const { PumpMatrix } = await import("../src/index");
    const m = PumpMatrix.load(vetoModel());
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]); // baseline с разбросом
    rows.push([100, 100.6, 99.9, 100.4, 9000]); // аномальный вход
    rows.push([100.4, 100.5, 98, 98.2, 9000]); rows.push([98.2, 98.3, 96, 96.4, 9000]); // каскад
    const cs = C3(rows);
    const s = m.planForAt("SOLUSDT", "long", "ch", cs, cs[20].timestamp);
    expect(s).toBe(null); // veto сработал — аномальная ячейка с policy=veto
  });
});
