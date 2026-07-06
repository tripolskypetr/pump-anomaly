import { describe, it, expect } from "vitest";
import { train, ParserItem } from "../src/index";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

/**
 * СИНТЕТИКА ТРЕНИРОВКИ — обучение восстанавливает ЗАЛОЖЕННЫЕ ОПТИМУМЫ.
 *
 * synthetic-truth проверяет вердикты конвейера; здесь проверяется сам ВЫБОР
 * параметров: в мир закладывается форма пампа, при которой оптимальна ровно
 * одна точка оси грида, и утверждается, что CV выбирает именно её:
 *  1) импакт-горизонт: пик на 20-й минуте, к 240-й всё сдуто → staleMinutes=30;
 *  2) стоп-хант: вик −2.5% перед разгоном → hardStop=50 (узкий стоп высаживает
 *     на дне ловушки — ровно механика из habr 1028592);
 *  3) trailing: пик и планомерный откат → trailingTake=1 снимает пик, 50 сидит
 *     до протухшего life-cap.
 * Мир детерминирован (mulberry32), разница метрик заложена на порядок больше SE.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

const mulberry32 = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hashOf = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h | 0;
};

interface Bump { ts: number; pct: number; riseMin: number; decayMin: number; residual: number }

/** сеяная биржа: блуждание σ=0.05%/мин + сумма заложенных бампов в лог-цене */
function exchange(cfg: { seed: number; spanFrom: number; spanTo: number; bumps: Bump[] }): GetCandles {
  const minutes = Math.floor((cfg.spanTo - cfg.spanFrom) / MIN) + 2;
  const paths = new Map<string, Float64Array>();
  const pathOf = (symbol: string): Float64Array => {
    const hit = paths.get(symbol);
    if (hit) return hit;
    const rnd = mulberry32(cfg.seed ^ hashOf(symbol));
    const logp = new Float64Array(minutes);
    logp[0] = Math.log(100);
    for (let m = 1; m < minutes; m++) logp[m] = logp[m - 1] + (rnd() - 0.5) * 2 * 0.0005;
    if (symbol === "SOLUSDT") { // бампы заложены только в торгуемый символ
      for (const b of cfg.bumps) {
        const m0 = Math.floor((b.ts - cfg.spanFrom) / MIN);
        for (let m = Math.max(m0, 0); m < minutes; m++) {
          const d = m - m0;
          logp[m] += d <= b.riseMin
            ? (b.pct * d) / b.riseMin
            : d <= b.riseMin + b.decayMin
              ? b.pct + (b.residual * b.pct - b.pct) * ((d - b.riseMin) / b.decayMin)
              : b.residual * b.pct;
        }
      }
    }
    paths.set(symbol, logp);
    return logp;
  };
  return async (symbol, _i, limit, sDate) => {
    const logp = pathOf(symbol);
    const start = Math.floor((sDate ?? cfg.spanFrom) / MIN) * MIN;
    const out: ICandleData[] = [];
    for (let k = 0; k < (limit ?? 0); k++) {
      const i = Math.floor((start - cfg.spanFrom) / MIN) + k;
      if (i < 0 || i >= minutes - 1) continue;
      const o = Math.exp(logp[i]);
      const c = Math.exp(logp[i + 1]);
      out.push({
        timestamp: cfg.spanFrom + i * MIN, open: o, close: c,
        high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998,
        volume: 900 + (i % 7) * 40,
      });
    }
    return out;
  };
}

const items: ParserItem[] = Array.from({ length: 36 }, (_, k) => ({
  channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
}));
const spanFrom = t0 - 3 * DAY;
const spanTo = t0 + 20 * DAY;

/** грид из одной точки по всем осям, кроме исследуемой */
const gridWith = (over: Record<string, unknown>) => ({
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [50], hardStop: [50], stalenessSinceProfit: [50],
  stalenessSinceMinutes: [500], staleMinutes: [30], volZThreshold: [2.0],
  squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
  cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
  ...over,
});
const opts = (grid: ReturnType<typeof gridWith>) => ({
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  selection: { nestedOuterFolds: 0 }, refineRounds: 0, outcomeModel: false,
  roundTripCostPct: 0.1, grid,
});

describe("синтетика тренировки — CV выбирает заложенный оптимум оси", () => {
  it("импакт-горизонт: пик на 20-й минуте, к 240-й сдуто → staleMinutes=30, не 240", async () => {
    // разгон 20 мин до +3%, спад 40 мин до нуля: life-cap 30 снимает ~+2.2%,
    // life-cap 240 отдаёт всё обратно (residual 0) и платит издержки
    const gc = exchange({
      seed: 11, spanFrom, spanTo,
      bumps: items.map((it) => ({ ts: it.ts, pct: 0.03, riseMin: 20, decayMin: 40, residual: 0 })),
    });
    const res = await train(items, gc, opts(gridWith({ staleMinutes: [30, 240] })));
    expect(res.params.exit.global.staleMinutes).toBe(30);
    expect(res.params.meta.impactHorizonMinutes).toBe(30);
    expect(res.params.pnl.global.median).toBeGreaterThan(0.01);
  }, 120_000);

  it("стоп-хант: вик −2.5% перед разгоном → выбран hardStop=50, узкий стоп проигрывает", async () => {
    // ловушка: сначала прокол вниз (2 мин до −2.5%, откуп за 3), затем памп +4%.
    // hardStop=1 высаживает на дне КАЖДОЙ ловушки (−1% − издержки);
    // hardStop=50 переживает шейкаут и забирает разгон.
    const gc = exchange({
      seed: 12, spanFrom, spanTo,
      bumps: items.flatMap((it) => [
        { ts: it.ts, pct: -0.025, riseMin: 2, decayMin: 3, residual: 0 },
        { ts: it.ts + 5 * MIN, pct: 0.04, riseMin: 20, decayMin: 60, residual: 0.5 },
      ]),
    });
    const res = await train(items, gc, opts(gridWith({ hardStop: [1, 50] })));
    expect(res.params.exit.global.hardStop).toBe(50);
    expect(res.params.pnl.global.median).toBeGreaterThan(0.01);
    // контроль заложенной механики: победивший выход почти не видит стопов
    const stops = (res.params.history ?? []).filter((h) => h.reason === "hard-stop").length;
    expect(stops).toBe(0);
  }, 120_000);

  it("trailing: пик и планомерный откат → выбран trailingTake=1 (снимает пик), не 50", async () => {
    // разгон 20 мин до +4%, спад 40 мин до нуля; life-cap 60: trailing=1 выходит
    // на первом заметном откате (~+3%), trailing=50 досиживает спад до ~0 − издержки
    const gc = exchange({
      seed: 13, spanFrom, spanTo,
      bumps: items.map((it) => ({ ts: it.ts, pct: 0.04, riseMin: 20, decayMin: 40, residual: 0 })),
    });
    const res = await train(items, gc, opts(gridWith({ trailingTake: [1, 50], staleMinutes: [60] })));
    expect(res.params.exit.global.trailingTake).toBe(1);
    expect(res.params.pnl.global.median).toBeGreaterThan(0.015);
    // победивший выход реально работает трейлингом, а не пересиживанием
    const trails = (res.params.history ?? []).filter((h) => h.reason === "trailing-take").length;
    expect(trails).toBeGreaterThan(20);
  }, 120_000);
});
