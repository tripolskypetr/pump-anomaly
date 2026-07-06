import { describe, it, expect } from "vitest";
import { predict, PumpMatrix, TrainedParams, ParserItem } from "../src/index";
import { exitKey } from "../src/label";
import { ExitParams } from "../src/replay";
import { ICandleData } from "../src/candle";
import { buildFixture } from "./fixture";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

// ─────────────────────────────────────────────────────────────────────────────
// БАГ 1: predict() брал anchor окна стационарности из ПОСЛЕДНЕГО ЭЛЕМЕНТА
// несортированного входа. Parser-items приходят в произвольном порядке; если
// последним в массиве оказалось старое событие, окно якорилось в прошлом и
// свежие события молча выпадали из детекции.
// ─────────────────────────────────────────────────────────────────────────────
describe("РЕГРЕССИЯ — predict инвариантен к порядку parser-items (anchor стационарности)", () => {
  it("shuffle входа не меняет результат при конечном stationarityWindowMs", () => {
    const { items } = buildFixture();
    const cfg = { stationarityWindowMs: 28 * 24 * 3600_000 };

    const sortedAsc = [...items].sort((a, b) => a.ts - b.ts);
    const sortedDesc = [...items].sort((a, b) => b.ts - a.ts); // самое СТАРОЕ — последним
    const refer = predict(sortedAsc, cfg);
    const shuffled = predict(sortedDesc, cfg);

    expect(shuffled.usedMode).toBe(refer.usedMode);
    expect(shuffled.tauMs).toBe(refer.tauMs);
    expect(shuffled.signals.map((s) => `${s.symbol}|${s.direction}|${s.ts}`).sort())
      .toEqual(refer.signals.map((s) => `${s.symbol}|${s.direction}|${s.ts}`).sort());
  });

  it("свежие события НЕ выпадают, когда старое событие стоит последним в массиве", () => {
    // 3 независимых канала бьют по SOL в одно окно СЕЙЧАС; одинокое событие
    // годовой давности стоит ПОСЛЕДНИМ в массиве. Окно 7 дней.
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const items: ParserItem[] = [
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: now },
      { channel: "b", symbol: "SOLUSDT", direction: "long", ts: now + 2 * MIN },
      { channel: "c", symbol: "SOLUSDT", direction: "long", ts: now + 4 * MIN },
      // прочая история для tau/каналов
      { channel: "a", symbol: "TRXUSDT", direction: "short", ts: now - 24 * 3600_000 },
      { channel: "b", symbol: "TRXUSDT", direction: "short", ts: now - 24 * 3600_000 + 3 * MIN },
      // СТАРОЕ событие — последним (несортированный вход из БД)
      { channel: "z", symbol: "POLUSDT", direction: "long", ts: now - 365 * 24 * 3600_000 },
    ];
    const res = predict(items, { mode: "single", stationarityWindowMs: 7 * 24 * 3600_000 });
    // при правильном anchor (max ts) свежие SOL-посты в окне и дают входы
    const sol = res.signals.filter((s) => s.symbol === "SOLUSDT");
    expect(sol.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// БАГ 2: replayResult (backtest()/planForAt со словарём свечей) искал вход с
// candles[0], игнорируя ts сигнала. Если серия несёт историю ДО сигнала (а она
// нужна для volZ/каскада), реплей «входил» в прошлом и pnl считался по чужому
// пути — классический look-ahead наизнанку.
// ─────────────────────────────────────────────────────────────────────────────
describe("РЕГРЕССИЯ — backtest/planForAt не входят раньше сигнала", () => {
  const ex = (): ExitParams & Record<string, unknown> => ({
    trailingTake: 50, hardStop: 50, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 5,
    squeezePolicy: "none", cascadeWindowMinutes: 30,
  });
  const model = (): PumpMatrix => PumpMatrix.load({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: {
      cells: { single: {}, matrix: {} },
      bySymbolDir: { single: {}, matrix: {} },
      byMode: { single: ex(), matrix: ex() }, global: ex(),
    },
    policy: { allow: ["enter", "invert", "tighten"] },
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 240,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  } as TrainedParams);

  // свечи: 10 флэт @100 → ралли 100→120 (до сигнала!) → сигнал на свече 20 → флэт @120
  const historyThenFlat = (): ICandleData[] => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 10; i++) rows.push([100, 100.2, 99.8, 100, 1000]);
    for (let i = 0; i < 10; i++) { const p = 100 + (i + 1) * 2; rows.push([p - 2, p + 0.1, p - 2.1, p, 1000]); }
    for (let i = 0; i < 20; i++) rows.push([120, 120.2, 119.8, 120, 1000]);
    return C(rows);
  };

  it("planForAt: вход по цене НА сигнале (~120), а не по предыстории (~100)", () => {
    const cs = historyThenFlat();
    const s = model().planForAt("SOLUSDT", "long", "ch", cs, cs[20].timestamp);
    expect(s).not.toBe(null);
    expect(s!.result.entered).toBe(true);
    // до фикса: вход @~100 на свече 0 и pnl ~ +20% на чужом ралли
    expect(s!.result.entryPrice).toBeGreaterThan(119);
    expect(Math.abs(s!.result.pnl)).toBeLessThan(0.02); // после сигнала флэт → pnl ≈ 0
  });

  it("backtest(словарь): зона, задетая ТОЛЬКО до сигнала → entered=false", () => {
    const cs = historyThenFlat();
    // зона [99.9, 100.1] касалась цены лишь ДО сигнала; после сигнала цена 120
    const item: ParserItem = {
      channel: "ch", symbol: "SOLUSDT", direction: "long",
      ts: cs[20].timestamp, entryFromPrice: 99.9, entryToPrice: 100.1,
    };
    const sigs = model().backtest([item], { SOLUSDT: cs });
    expect(sigs.length).toBe(1);
    expect(sigs[0].result.entered).toBe(false); // до фикса: вход на свече 0 в прошлом
  });

  it("все свечи словаря СТАРШЕ сигнала → no-candles, не вход в прошлом", () => {
    const cs = historyThenFlat();
    const item: ParserItem = {
      channel: "ch", symbol: "SOLUSDT", direction: "long",
      ts: cs[cs.length - 1].timestamp + 60 * MIN, // сигнал позже всей серии
    };
    const sigs = model().backtest([item], { SOLUSDT: cs });
    expect(sigs.length).toBe(1);
    expect(sigs[0].result.entered).toBe(false);
    expect(sigs[0].result.reason).toBe("no-candles");
  });

  it("серия, начинающаяся ровно с сигнальной минуты, работает как раньше", () => {
    // candles с t0, сигнал t0 → срез no-op (обратная совместимость c getCandles-путём)
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 30; i++) { const p = 100 + i * 0.1; rows.push([p, p + 0.15, p - 0.05, p + 0.1, 1000]); }
    const cs = C(rows);
    const item: ParserItem = {
      channel: "ch", symbol: "SOLUSDT", direction: "long",
      ts: t0, entryFromPrice: 99.9, entryToPrice: 100.1,
    };
    const sigs = model().backtest([item], { SOLUSDT: cs });
    expect(sigs[0].result.entered).toBe(true);
    expect(sigs[0].result.pnl).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// БАГ 3: геттер policy возвращал только allow и терял minRiskReward/rrMetric —
// аудит видел урезанную политику (обученный RR-фильтр «исчезал»).
// ─────────────────────────────────────────────────────────────────────────────
describe("РЕГРЕССИЯ — policy getter отдаёт ПОЛНУЮ политику", () => {
  const base = (policy: object): TrainedParams => ({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: {
      cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} },
      byMode: {
        single: { trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 60 },
        matrix: { trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 60 },
      },
      global: { trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 60 },
    },
    policy: policy as TrainedParams["policy"],
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0, nestedScore: null, cvWinrate: 0, cvSupport: 0,
      gridSize: 0, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
      confidence: 0, reliable: false, support: 0, stability: 0, significance: 0, totalSamples: 0,
    },
  } as TrainedParams);

  it("minRiskReward и rrMetric не теряются", () => {
    const m = PumpMatrix.load(base({ allow: ["enter"], minRiskReward: 1.5, rrMetric: "p95" }));
    expect(m.policy.allow).toEqual(["enter"]);
    expect(m.policy.minRiskReward).toBe(1.5);
    expect(m.policy.rrMetric).toBe("p95");
  });

  it("копия остаётся изолированной (мутация не трогает оригинал)", () => {
    const m = PumpMatrix.load(base({ allow: ["enter", "invert"], minRiskReward: 2 }));
    const p = m.policy;
    p.allow.push("tighten");
    p.minRiskReward = 0;
    expect(m.policy.allow).toEqual(["enter", "invert"]);
    expect(m.policy.minRiskReward).toBe(2);
  });

  it("политика без RR-фильтра → поля undefined, allow на месте", () => {
    const m = PumpMatrix.load(base({ allow: ["enter", "invert", "tighten"] }));
    expect(m.policy.allow).toEqual(["enter", "invert", "tighten"]);
    expect(m.policy.minRiskReward).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// БАГ 4: exitKey не включал tightenFactor. Два exit-набора, отличающиеся только
// им, дают РАЗНЫЙ replay при policy=tighten, но схлопывались в один ключ кэша
// byExit → метки одного набора молча перезаписывались другим.
// ─────────────────────────────────────────────────────────────────────────────
describe("РЕГРЕССИЯ — exitKey различает tightenFactor", () => {
  const base: ExitParams = {
    trailingTake: 2, hardStop: 3, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 240, squeezePolicy: "tighten", squeezeThreshold: 0.6,
  };

  it("разный tightenFactor → разные ключи", () => {
    expect(exitKey({ ...base, tightenFactor: 0.5 }))
      .not.toBe(exitKey({ ...base, tightenFactor: 0.25 }));
  });

  it("одинаковые наборы → одинаковый ключ (стабильность кэша)", () => {
    expect(exitKey({ ...base, tightenFactor: 0.5 })).toBe(exitKey({ ...base, tightenFactor: 0.5 }));
    expect(exitKey(base)).toBe(exitKey({ ...base }));
  });
});
