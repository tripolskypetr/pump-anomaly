import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams } from "../src/index";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { ParserItem } from "../src/types";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const ex = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0, squeezePolicy: "none" as const, cascadeWindowMinutes: 30 };
const model = (): TrainedParams => ({
  version: 3,
  config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
  exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
  policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
  pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
  meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
} as TrainedParams);

const gc: GetCandles = async (s, i, lim, sd) => {
  const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = 100.5 + k * 0.5; out.push({ timestamp: since + k * STEP_MS[i], open: p, high: p + 0.2, low: p - 0.2, close: p, volume: 1000 }); }
  return out;
};
const items: ParserItem[] = [{ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0, entryFromPrice: 100, entryToPrice: 101 }];

describe("plan(getCandles) — перегрузка: свечи через getCandles, без словаря", () => {
  it("даёт ТОТ ЖЕ результат, что plan(словарь) на тех же свечах", async () => {
    const m = PumpMatrix.load(model());
    // те же свечи = ровно то окно ДО сигнала, которое тянет live-путь (lookbackMinutes)
    const lookback = m.lookbackMinutes;
    const dict = { SOLUSDT: await gc("SOLUSDT", "1m", lookback, alignTs(t0, "1m") - lookback * MIN) };
    const viaDict = m.plan(items, dict);
    const viaLive = await m.plan(items, gc);
    expect(JSON.stringify(viaLive)).toBe(JSON.stringify(viaDict));
  });

  it("использует ту же getCandles, что и fit (один источник свечей)", async () => {
    const m = PumpMatrix.load(model());
    let called = 0;
    const tracked: GetCandles = async (...args) => { called++; return gc(...args); };
    const sigs = await m.plan(items, tracked);
    expect(called).toBeGreaterThan(0);      // свечи реально запрошены через getCandles
    expect(sigs.length).toBe(1);
  });

  it("битый символ (getCandles бросает) → сигнал без свечей, не рушит весь вызов", async () => {
    const m = PumpMatrix.load(model());
    const twoItems: ParserItem[] = [
      { channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0, entryFromPrice: 100, entryToPrice: 101 },
      { channel: "yoda", symbol: "BROKEN", direction: "long", ts: t0, entryFromPrice: 100, entryToPrice: 101 },
    ];
    const flaky: GetCandles = async (s, ...rest) => {
      if (s === "BROKEN") throw new Error("дыра в данных");
      return gc(s, ...rest);
    };
    const sigs = await m.plan(twoItems, flaky);
    // оба отдаются (SOL со свечами, BROKEN — как signals() без свечей), вызов не упал
    expect(sigs.length).toBe(2);
  });

  it("пустой ответ getCandles → сигнал без свечей (как signals())", async () => {
    const m = PumpMatrix.load(model());
    const empty: GetCandles = async () => [];
    const sigs = await m.plan(items, empty);
    expect(sigs.length).toBe(1); // без свечей → нет каскад-детекции, но сигнал есть
  });
});
