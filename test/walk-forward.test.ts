import { describe, it, expect } from "vitest";
import { walkForward } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// растущий мир: каждый long-пост отрабатывает в плюс → OOS-цепочка положительна
const priceOf = (t: number): number => 100 * Math.pow(1.0004, (t - t0) / MIN);
const gc: GetCandles = async (_s, _i, limit, sDate) => {
  const out: ICandleData[] = [];
  for (let i = 0; i < (limit ?? 0); i++) {
    const t = (sDate ?? 0) + i * MIN;
    const o = priceOf(t);
    const c = priceOf(t + MIN);
    out.push({
      timestamp: t, open: o, close: c,
      high: Math.max(o, c) * 1.0001, low: Math.min(o, c) * 0.9999,
      volume: 1000 + (Math.floor(t / MIN) % 5) * 50,
    });
  }
  return out;
};

const items: ParserItem[] = Array.from({ length: 12 }, (_, k) => ({
  channel: "ch", symbol: "SOLUSDT", direction: "long" as const,
  ts: t0 + 24 * 60 * MIN + k * 12 * 60 * MIN,
}));

const trainOptions = {
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  grid: {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
    stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
    squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
    cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity],
  },
  selection: { nestedOuterFolds: 0 },
};

describe("walkForward — rolling fit → OOS-бэктест без утечки", () => {
  it("строит хронологическую OOS-цепочку: train строго до, test строго после", async () => {
    const wf = await walkForward(items, gc, { slices: 2, trainOptions });
    expect(wf.slices.length).toBe(2);
    // блоки не пересекаются и идут вперёд
    expect(wf.slices[0].trainUntil).toBeLessThan(wf.slices[0].testTo);
    expect(wf.slices[0].testTo).toBeLessThanOrEqual(wf.slices[1].trainUntil);
    // объёмы: первый train = 4 события (12 / (2+1)), второй = 8
    expect(wf.slices[0].nTrain).toBe(4);
    expect(wf.slices[1].nTrain).toBe(8);
    // OOS-сделки собраны из тестовых блоков
    const totalEntered = wf.slices.reduce((s, x) => s + x.entered, 0);
    expect(wf.oosPnls.length).toBe(totalEntered);
    expect(wf.equity.length).toBe(wf.oosPnls.length);
  });

  it("в растущем мире OOS-статистика положительна, просадка конечна", async () => {
    const wf = await walkForward(items, gc, { slices: 2, trainOptions });
    expect(wf.oosPnls.length).toBeGreaterThan(0);
    expect(wf.stats.mean).toBeGreaterThan(0);
    expect(wf.stats.median).toBeGreaterThan(0);
    expect(Number.isFinite(wf.sharpe)).toBe(true);
    expect(wf.maxDrawdown).toBeGreaterThanOrEqual(0);
    // срез «только сертифицированные блоки» консистентен
    expect(wf.certifiedOnly.slicesUsed).toBeGreaterThanOrEqual(0);
    expect(wf.certifiedOnly.slicesUsed).toBeLessThanOrEqual(2);
    expect(wf.certifiedOnly.oosPnls.length).toBe(wf.certifiedOnly.stats.n);
  });

  it("политика сужает OOS-бэктест (allow: [] → сделок нет)", async () => {
    const wf = await walkForward(items, gc, {
      slices: 2, trainOptions, policy: { allow: [] },
    });
    expect(wf.oosPnls.length).toBe(0);
    expect(wf.stats.n).toBe(0);
  });

  it("событий меньше, чем блоков+1 → честная ошибка", async () => {
    await expect(walkForward(items.slice(0, 2), gc, { slices: 3, trainOptions }))
      .rejects.toThrow(/walkForward/);
  });
});
