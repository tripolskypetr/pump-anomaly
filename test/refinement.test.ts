import { describe, it, expect } from "vitest";
import { train } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

/**
 * Мир, где ОПТИМУМ trailingTake ЛЕЖИТ МЕЖДУ УЗЛАМИ сетки [0.5, 2]:
 * каждый памп повторяет паттерн (close относительно входа 100):
 *   м0 +1.0% → м1 +0.4% (откат 0.6) → м2 +2.0% (пик) → м3 +0.9% (откат 1.1) → обвал −3%.
 * Реализация по close свечи-триггера:
 *   trail 0.5 → выходит на первом откате: +0.4%;
 *   trail 1.0 → пропускает первый (0.6 < 1), ловит второй (1.1 ≥ 1): +0.9%  ← оптимум;
 *   trail 2.0 → пропускает оба, обвал → life-cap: −3%.
 * Грубая сетка видит только +0.4% и −3% — узкая прибыльная зона между узлами
 * невидима. Уточняющий брутфорс обязан найти геосередину 1.0.
 */
const CYCLE = 120; // минут между пампами
const closeAt = (t: number): number => {
  const m = Math.floor((t - t0) / MIN) % CYCLE;
  if (m < 0) return 100;
  if (m === 0) return 101;
  if (m === 1) return 100.4;
  if (m === 2) return 102;
  if (m === 3) return 100.9;
  return 97; // обвал и флэт до конца цикла
};
const gc: GetCandles = async (_s, _i, limit, sDate) => {
  const out: ICandleData[] = [];
  for (let i = 0; i < (limit ?? 0); i++) {
    const t = (sDate ?? 0) + i * MIN;
    const m = Math.floor((t - t0) / MIN) % CYCLE;
    const open = m === 0 ? 100 : closeAt(t - MIN);
    const close = closeAt(t);
    out.push({
      timestamp: t, open, close,
      high: Math.max(open, close), low: Math.min(open, close) - 0.01,
      volume: 1000 + (Math.floor(t / MIN) % 5) * 50,
    });
  }
  return out;
};

const items: ParserItem[] = Array.from({ length: 6 }, (_, k) => ({
  channel: "ch", symbol: "SOLUSDT", direction: "long" as const,
  ts: t0 + k * CYCLE * MIN, // пост ровно на границе цикла (свеча торгуема честно)
}));

const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [0.5, 2], // оптимум 1.0 — МЕЖДУ узлами
  hardStop: [50], stalenessSinceProfit: [1], stalenessSinceMinutes: [240],
  staleMinutes: [30], volZThreshold: [2.0], squeezePolicy: ["none" as const],
  squeezeThreshold: [0.6], volBaselineWindow: [20], cascadeWindowMinutes: [15],
  stationarityWindowMs: [Infinity], momentumGatePct: [null],
};
const base = {
  folds: 3, mode: "single" as const, onProgress: silentProgress, grid,
  selection: { nestedOuterFolds: 0 },
};

describe("coarse-to-fine — шаг сетки не прячет эдж между узлами", () => {
  it("без уточнения грубая сетка застревает на +0.4% (trail 0.5)", async () => {
    const res = await train(items, gc, base); // refineRounds дефолт 0 при явном grid
    expect(res.params.exit.global.trailingTake).toBe(0.5);
    expect(res.params.meta.refinement).toBe(null);
  });

  it("refineRounds: 2 находит оптимум 1.0 между узлами [0.5, 2]", async () => {
    const res = await train(items, gc, { ...base, refineRounds: 2 });
    expect(res.params.exit.global.trailingTake).toBe(1); // геосередина √(0.5·2)
    const ref = res.params.meta.refinement!;
    expect(ref.rounds).toBe(2);
    expect(ref.accepted).toBeGreaterThanOrEqual(1);
    expect(ref.evaluated).toBeGreaterThan(0);
    // каждый оценённый вариант — честное испытание: N для DSR вырос
    expect(res.params.meta.innerTrials).toBe(2 + ref.evaluated);
    // и cvScore уточнённого победителя выше грубого (+0.9% > +0.4% на сделку)
    const coarse = await train(items, gc, base);
    expect(res.params.meta.cvScore).toBeGreaterThan(coarse.params.meta.cvScore);
  });

  it("уточнённый exit исполняем: реплей сделки реализует +0.9%, не +0.4%", async () => {
    const res = await train(items, gc, { ...base, refineRounds: 2 });
    // история построена по уточнённому exit
    const pnls = res.params.history!.filter((h) => h.entered).map((h) => h.pnl);
    expect(pnls.length).toBeGreaterThan(0);
    for (const p of pnls) expect(p).toBeCloseTo(0.009, 3);
  });

  it("нет улучшения между узлами → переезды не принимаются (SE-гвард)", async () => {
    // сетка уже содержит оптимум 1.0 → все середины хуже или равны
    const res = await train(items, gc, {
      ...base, refineRounds: 2,
      grid: { ...grid, trailingTake: [0.5, 1, 2] },
    });
    expect(res.params.exit.global.trailingTake).toBe(1);
    expect(res.params.meta.refinement!.accepted).toBe(0);
  });
});
