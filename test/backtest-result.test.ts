import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams, ParserItem } from "../src/index";
import { ICandleData } from "../src/candle";

// backtest() РЕПЛЕИТ позицию вперёд и возвращает realized pnl в result — это его
// главное отличие от plan() (live, позиция ещё не закрыта). plan()/signals() result
// НЕ несут (тип TradeSignal), backtest() несёт (тип-потомок BacktestSignal).

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const candles = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

const ex = (o: Partial<Record<string, number | string>> = {}) => ({
  trailingTake: 50, hardStop: 3, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
  volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, squeezePolicy: "none", cascadeWindowMinutes: 30, ...o,
});
const model = (): PumpMatrix => PumpMatrix.load({
  version: 3,
  config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single" },
  exit: {
    cells: { single: { yoda: { SOLUSDT: { long: { calm: ex(), anomalous: ex() } } } }, matrix: {} },
    bySymbolDir: { single: { SOLUSDT: { long: ex() } }, matrix: {} },
    byMode: { single: ex(), matrix: ex() }, global: ex(),
  },
  policy: { allow: ["enter", "invert", "tighten"] },
  riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
  pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
  meta: {
    trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
    gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 240,
    confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
  },
} as TrainedParams);

const item: ParserItem = { channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + 20 * MIN, entryFromPrice: 99.9, entryToPrice: 100.1 };
// 20 базлайн-свечей + вход + рост на ~3% → life-cap exit с положительным pnl
const rising = () => {
  const rows: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 1000]);
  rows.push([100, 100.1, 99.9, 100, 1000]);                 // вход в зоне [99.9,100.1]
  for (let i = 0; i < 260; i++) { const p = 100 + i * 0.012; rows.push([p, p + 0.1, p - 0.05, p, 1000]); }
  return candles(rows);
};

describe("backtest() возвращает realized pnl в result", () => {
  it("BacktestSignal несёт result с pnl/reason/entryPrice (вошли)", () => {
    const sigs = model().backtest([item], { SOLUSDT: rising() });
    expect(sigs.length).toBe(1);
    const r = sigs[0].result;
    expect(r.entered).toBe(true);
    expect(r.entryPrice).toBeGreaterThan(0);
    expect(r.exitPrice).toBeGreaterThan(0);
    expect(r.pnl).toBeGreaterThan(0);          // цена росла в сторону long → плюс
    expect(typeof r.reason).toBe("string");
    expect(r.heldMinutes).toBeGreaterThan(0);
  });

  it("нет свечей по символу → result.entered=false, pnl 0 (не краш)", () => {
    const sigs = model().backtest([item], {}); // пустой словарь
    expect(sigs.length).toBe(1);
    expect(sigs[0].result.entered).toBe(false);
    expect(sigs[0].result.pnl).toBe(0);
    expect(sigs[0].result.reason).toBe("no-candles");
  });

  it("planForAt тоже возвращает result (точечный backtest)", () => {
    const cs = rising();
    const s = model().planForAt("SOLUSDT", "long", "yoda", cs, cs[20].timestamp);
    expect(s).not.toBe(null);
    expect(s!.result.entered).toBe(true);
    expect(s!.result.pnl).toBeGreaterThan(0);
  });

  it("getCandles-overload: result считается на подгруженных свечах", async () => {
    const cs = rising();
    const gc = async () => cs;
    const sigs = await model().backtest([item], gc);
    expect(sigs[0].result.entered).toBe(true);
    expect(sigs[0].result.pnl).toBeGreaterThan(0);
  });

  it("plan()/signals() result НЕ несут (live — позиция не закрыта)", () => {
    const m = model();
    const plan = m.plan([item], { SOLUSDT: rising() });
    const sig = m.signals([item]);
    // TradeSignal не имеет result; проверяем, что поле не подмешано
    expect("result" in plan[0]).toBe(false);
    expect("result" in sig[0]).toBe(false);
  });
});
