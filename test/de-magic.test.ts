import { describe, it, expect } from "vitest";
import { empiricalPoolK, lagXCorr, buildTable, train } from "../src/index";
import { SignalEvent, ParserItem } from "../src/types";
import { Edge } from "../src/layers/jaccard-screen";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// «k=5» → эмпирический Байес: сила усадки оценивается методом моментов.
// ─────────────────────────────────────────────────────────────────────────────
describe("empiricalPoolK — сила пулинга из данных", () => {
  const noisy = (mean: number, seedBase: number, n = 20): number[] => {
    let seed = seedBase;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    return Array.from({ length: n }, () => mean + (rnd() - 0.5) * 0.02);
  };

  it("однородные группы (различий нет) → максимальный пулинг", () => {
    const k = empiricalPoolK([noisy(0.005, 7), noisy(0.005, 13), noisy(0.005, 29), noisy(0.005, 41)], 5);
    expect(k).toBeGreaterThan(20); // межгрупповая дисперсия ≈ шум → жёсткая усадка
  });

  it("реально различающиеся группы → слабый пулинг (k мал)", () => {
    const k = empiricalPoolK([noisy(0.05, 7), noisy(-0.05, 13), noisy(0.02, 29), noisy(-0.02, 41)], 5);
    expect(k).toBeLessThan(5); // группы отстаивают своё
  });

  it("< 3 групп → честный fallback (межгрупповую дисперсию оценивать нечем)", () => {
    expect(empiricalPoolK([noisy(0.05, 7), noisy(-0.05, 13)], 5)).toBe(5);
    expect(empiricalPoolK([], 5)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// «peakShare ≥ 0.6» → биномиальная значимость против равномерного фона лагов.
// ─────────────────────────────────────────────────────────────────────────────
describe("lagXCorr — порог случайности остроты пика", () => {
  const pair = (lags: number[]): ReturnType<typeof buildTable> => {
    const events: SignalEvent[] = [];
    lags.forEach((lag, i) => {
      const base = t0 + i * 30 * 24 * HOUR; // события раздвинуты: HORIZON не смешивает пары
      events.push({ channel: "a", symbol: "SOLUSDT", direction: "long", ts: base });
      events.push({ channel: "b", symbol: "SOLUSDT", direction: "long", ts: base + lag });
    });
    return buildTable(events);
  };
  const screened: Edge[] = [{ a: "a", b: "b", jaccard: 1 }];
  const peakWindow = 45 * MIN;

  it("разбросанные лаги при НИЗКОМ пользовательском пороге всё равно режутся", () => {
    // 6 пар, лаги размазаны по ±5ч: доля в окне 45м ≈ шанс; порог юзера 0.1
    const tbl = pair([10 * MIN, 2 * HOUR, -3 * HOUR, 4 * HOUR, -5 * HOUR, 5 * HOUR]);
    const edges = lagXCorr(tbl, screened, 0.1, peakWindow);
    expect(edges.length).toBe(0); // биномиальный пол не даёт шуму пройти
  });

  it("острый пик той же выборки проходит и низкий порог", () => {
    const tbl = pair([3 * MIN, 3 * MIN, 4 * MIN, 3 * MIN, 2 * MIN, 3 * MIN]);
    const edges = lagXCorr(tbl, screened, 0.1, peakWindow);
    expect(edges.length).toBe(1);
    expect(edges[0].leader).toBe("a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// «refineRounds = 2» → авто-стоп: раунды кончаются сами, кап — предохранитель.
// ─────────────────────────────────────────────────────────────────────────────
describe("refinement — авто-стоп вместо выбора числа раундов", () => {
  const CYCLE = 120;
  const closeAt = (t: number): number => {
    const m = Math.floor((t - t0) / MIN) % CYCLE;
    if (m < 0) return 100;
    if (m === 0) return 101;
    if (m === 1) return 100.4;
    if (m === 2) return 102;
    if (m === 3) return 100.9;
    return 97;
  };
  const gc: GetCandles = async (_s, _i, limit, sDate) => {
    const out: ICandleData[] = [];
    for (let i = 0; i < (limit ?? 0); i++) {
      const t = (sDate ?? 0) + i * MIN;
      const m = Math.floor((t - t0) / MIN) % CYCLE;
      const open = m === 0 ? 100 : closeAt(t - MIN);
      const close = closeAt(t);
      out.push({ timestamp: t, open, close, high: Math.max(open, close), low: Math.min(open, close) - 0.01, volume: 1000 });
    }
    return out;
  };
  const items: ParserItem[] = Array.from({ length: 12 }, (_, k) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * CYCLE * MIN,
  }));
  const grid = (trailing: number[]) => ({
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: trailing, hardStop: [50], stalenessSinceProfit: [1],
    stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
    squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
    cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
  });
  const base = { folds: 3, mode: "single" as const, onProgress: silentProgress, selection: { nestedOuterFolds: 0 } };

  it("щедрый кап 6 не выжигается: зум останавливается сам после сходимости", async () => {
    const res = await train(items, gc, { ...base, grid: grid([0.5, 2]), refineRounds: 6 });
    const ref = res.params.meta.refinement!;
    expect(ref.accepted).toBeGreaterThanOrEqual(1);          // оптимум между узлами найден
    expect(res.params.exit.global.trailingTake).toBeGreaterThanOrEqual(0.9);
    expect(res.params.exit.global.trailingTake).toBeLessThanOrEqual(1.2);
    expect(ref.rounds).toBeLessThan(6);                      // кап не выжжен — авто-стоп
  });

  it("сетка уже содержит оптимум → стоп после первого же пустого раунда", async () => {
    const res = await train(items, gc, { ...base, grid: grid([0.5, 1, 2]), refineRounds: 6 });
    const ref = res.params.meta.refinement!;
    expect(ref.accepted).toBe(0);
    expect(ref.rounds).toBe(1); // ни одного переезда в раунде 1 → сразу стоп
  });
});
