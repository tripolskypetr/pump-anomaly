import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const gc: GetCandles = async (s, i, lim, sd) => {
  const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = 100.5 + k * 0.02; out.push({ timestamp: since + k * step, open: p, high: p * 1.003, low: p * 0.999, close: p, volume: 1000 + (k % 7) * 80 }); }
  return out;
};
const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
  staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
  volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
};
function data(n = 12): ParserItem[] {
  const items: ParserItem[] = [];
  for (let d = 0; d < n; d++) items.push({ channel: "yoda", symbol: ["SOL", "TRX"][d % 2] + "USDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
  return items;
}
const fit = () => PumpMatrix.fit(data(), gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });

describe("dump() — экспорт истории сигналов", () => {
  it("возвращает массив записей с ценами входа/выхода", async () => {
    const m = await fit();
    const d = m.dump();
    expect(Array.isArray(d)).toBe(true);
    expect(d.length).toBe(m.historySize);
    expect(d.length).toBeGreaterThan(0);
    const r = d[0];
    expect(r).toHaveProperty("entryPrice");
    expect(r).toHaveProperty("exitPrice");
    expect(r).toHaveProperty("pnl");
    expect(r).toHaveProperty("reason");
    expect(r).toHaveProperty("heldMinutes");
    expect(r).toHaveProperty("ts");
    expect(r).toHaveProperty("symbol");
  });

  it("exitPrice согласован с entryPrice и pnl (long: entry·(1+pnl))", async () => {
    const m = await fit();
    for (const r of m.dump().filter((x) => x.entered)) {
      expect(r.entryPrice).toBeGreaterThan(0);
      expect(r.exitPrice).toBeCloseTo(r.entryPrice * (1 + r.pnl), 6);
    }
  });

  it("entryPrice = close в зоне [100,101] (вариант 2 уточнения входа)", async () => {
    const m = await fit();
    const entered = m.dump().filter((x) => x.entered);
    // свечи стартуют с close=100.5 в зоне [100,101] → entryPrice=100.5
    expect(entered.every((r) => r.entryPrice >= 100 && r.entryPrice <= 101)).toBe(true);
  });

  it("dump(true) → JSON-строка, парсится в тот же массив", async () => {
    const m = await fit();
    const str = m.dump(true);
    expect(typeof str).toBe("string");
    expect(JSON.parse(str).length).toBe(m.historySize);
  });

  it("история сохраняется через save()/load()", async () => {
    const m = await fit();
    const reloaded = PumpMatrix.load(m.save());
    expect(reloaded.historySize).toBe(m.historySize);
    expect(reloaded.dump().length).toBe(m.dump().length);
    expect(reloaded.dump()[0].entryPrice).toBe(m.dump()[0].entryPrice);
  });

  it("записи отсортированы по ts", async () => {
    const m = await fit();
    const d = m.dump();
    for (let i = 1; i < d.length; i++) expect(d[i].ts).toBeGreaterThanOrEqual(d[i - 1].ts);
  });

  it("dump() возвращает КОПИИ (мутация не трогает модель)", async () => {
    const m = await fit();
    const d = m.dump();
    const before = m.dump()[0].entryPrice;
    d[0].entryPrice = -999;
    expect(m.dump()[0].entryPrice).toBe(before); // не изменилось
  });

  it("модель без истории (load из старого JSON) → dump пустой, не падает", () => {
    const bare = {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: { trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 }, matrix: { trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 } }, global: { trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 } },
      policy: { allow: ["enter"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0, nestedScore: null, cvWinrate: 0, cvSupport: 0, gridSize: 0, mode: "single", modeReason: "x", impactHorizonMinutes: 240, confidence: 0, reliable: false, support: 0, stability: 0, significance: 0, totalSamples: 0 },
    };
    const m = PumpMatrix.load(bare as any);
    expect(m.historySize).toBe(0);
    expect(m.dump()).toEqual([]);
    expect(m.dump(true)).toBe("[]");
  });
});
