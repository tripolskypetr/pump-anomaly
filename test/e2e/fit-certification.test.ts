import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../../src/index";
import { ParserItem } from "../../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../../src/candle";
import { silentProgress } from "../../src/progress";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const gc: GetCandles = async (s, i, lim, sd) => {
  const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = 100.5 + k * 0.02; out.push({ timestamp: since + k * STEP_MS[i], open: p, high: p * 1.003, low: p * 0.999, close: p, volume: 1000 + (k % 7) * 80 }); }
  return out;
};
const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [0.5, 1.0, 2.0], hardStop: [1.0, 2.0, 3.0], stalenessSinceProfit: [1.0],
  stalenessSinceMinutes: [240], staleMinutes: [60, 240], volZThreshold: [2.0],
  squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
  cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
};

describe("E2E: fit прикрепляет статистический сертификат", () => {
  it("малая выборка (17 сделок) → certified=false с причинами (честный отказ)", async () => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 17; d++) items.push({ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 3 } });
    const c = m.certification;
    expect(c).toBeDefined();
    expect(c!.certified).toBe(false);            // на 17 сделках НЕ сертифицирует
    expect(c!.reasons.length).toBeGreaterThan(0); // и объясняет почему
    expect(c!.actualN).toBeLessThan(c!.minTRL);   // выборки недостаточно
  });

  it("сертификат сохраняется через save/load", async () => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 17; d++) items.push({ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    const reloaded = PumpMatrix.load(m.save());
    expect(reloaded.certification?.certified).toBe(m.certification?.certified);
    expect(reloaded.certification?.dsr).toBeCloseTo(m.certification?.dsr ?? -1, 9);
  });

  it("модель без certification (старый формат) → getter возвращает undefined, load не падает", () => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 5; d++) items.push({ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
    // эмулируем старую модель: соберём через fit и удалим certification из JSON
    return PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } }).then((m) => {
      const json = JSON.parse(m.save());
      delete json.meta.certification;
      const reloaded = PumpMatrix.load(JSON.stringify(json));
      expect(reloaded.certification).toBeUndefined(); // не падает, просто нет сертификата
    });
  });
});
