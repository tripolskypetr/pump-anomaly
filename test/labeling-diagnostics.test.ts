import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

// Диагностика фазы разметки: пустой fit больше НЕ немой. meta.labeling говорит,
// ПОЧЕМУ нет сделок — adapter-error (getCandles бросает), no-candles (вернул пусто),
// no-entry (свечи есть, входов в зону нет), ok (размечено). Это спасает от часов
// гадания на пустом результате (totalSamples=0) при битом getCandles/символе.

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
  staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
  volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
};
const items = (): ParserItem[] => {
  const out: ParserItem[] = [];
  for (let d = 0; d < 8; d++) out.push({ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
  return out;
};
const goodCandles: GetCandles = async (s, i, lim, sd) => {
  const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = 100.5 + k * 0.05; out.push({ timestamp: since + k * STEP_MS[i], open: p, high: p * 1.005, low: p * 0.999, close: p, volume: 1000 }); }
  return out;
};
const fit = (gc: GetCandles) => PumpMatrix.fit(items(), gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });

describe("meta.labeling — почему fit пустой", () => {
  it("рабочий getCandles → outcomes.ok > 0, candidates учтены", async () => {
    const m = await fit(goodCandles);
    expect(m.labeling.candidates).toBe(8);                 // 8 уникальных всплесков
    expect(m.labeling.outcomes.ok ?? 0).toBeGreaterThan(0); // часть размечена
    expect(m.labeling.outcomes.ok ?? 0).toBeLessThanOrEqual(8);
  });

  it("getCandles возвращает пусто → outcomes['no-candles'] = candidates, нет ok", async () => {
    const empty: GetCandles = async () => [];
    const m = await fit(empty);
    expect(m.labeling.candidates).toBe(8);
    expect(m.labeling.outcomes["no-candles"]).toBe(8);     // все 8 — нет свечей
    expect(m.labeling.outcomes.ok ?? 0).toBe(0);
  });

  it("getCandles бросает → outcomes['adapter-error'] = candidates (битый адаптер виден)", async () => {
    const thrower: GetCandles = async () => { throw new Error("data gap"); };
    const m = await fit(thrower);
    expect(m.labeling.outcomes["adapter-error"]).toBe(8);  // все 8 — ошибка адаптера
    expect(m.labeling.outcomes.ok ?? 0).toBe(0);
    expect(m.reliable).toBe(false);
  });

  it("текст исключения getCandles попадает в labeling.errors со счётчиком (не немой)", async () => {
    const thrower: GetCandles = async () => { throw new Error("ccxt: symbol not found"); };
    const m = await fit(thrower);
    // 8 одинаковых ошибок схлопываются в одну запись со счётчиком 8
    expect(m.labeling.errors["ccxt: symbol not found"]).toBe(8);
  });

  it("не-Error throw тоже захватывается (String(e))", async () => {
    const thrower: GetCandles = async () => { throw "raw string failure"; };
    const m = await fit(thrower);
    expect(m.labeling.errors["raw string failure"]).toBe(8);
  });

  it("успешный fit → errors пустой", async () => {
    const m = await fit(goodCandles);
    expect(Object.keys(m.labeling.errors).length).toBe(0);
  });

  it("счётчик не раздут размером грида (dedup по всплеску)", async () => {
    const wideGrid = { ...grid, hardStop: [1.0, 2.0, 3.0], staleMinutes: [60, 240, 720] };
    const m = await PumpMatrix.fit(items(), async () => [], {
      mode: "single", onProgress: silentProgress, grid: wideGrid, selection: { nestedOuterFolds: 0 },
    });
    // несмотря на грид ×9 по exit, кандидатов всё равно 8 (считаем всплеск раз)
    expect(m.labeling.candidates).toBe(8);
    expect(m.labeling.outcomes["no-candles"]).toBe(8);
  });

  it("сумма исходов = candidates (каждый всплеск посчитан ровно раз)", async () => {
    const m = await fit(goodCandles);
    const sum = Object.values(m.labeling.outcomes).reduce((s, n) => s + n, 0);
    expect(sum).toBe(m.labeling.candidates);
  });
});
