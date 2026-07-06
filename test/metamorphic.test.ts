import { describe, it, expect } from "vitest";
import { train, ParserItem, TrainedParams } from "../src/index";
import { GetCandles } from "../src/candle";
import { silentProgress } from "../src/progress";
import { syntheticExchange, oneShotGrid, HOUR, DAY, mulberry32 } from "./helpers/synthetic-world";

/**
 * МЕТАМОРФНЫЕ ИНВАРИАНТЫ — свойства, а не значения.
 *
 * Проверяем то, что обязано выполняться на ЛЮБЫХ данных:
 *  1) масштаб цены (×1000) не меняет ни выбор параметров, ни pnl — всё
 *     в либе безразмерно (доли), утечка абсолютных цен = баг нормировки;
 *  2) сдвиг всего мира во времени (на 7 дней, сетка часов сохранена) не
 *     меняет результат — абсолютное «когда» не участвует в математике;
 *  3) издержки монотонны: медиана pnl с costs 0.3% ниже медианы с 0 РОВНО
 *     на 0.003 (вычет на сделку), slippage > 0 строго снижает медиану;
 *  4) детерминизм под сетевым джиттером: пул разметки (concurrency 4,
 *     сеяные случайные задержки ответов) даёт БИТ-В-БИТ те же параметры,
 *     что последовательный прогон без задержек.
 */

const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const spanFrom = t0 - 5 * DAY;
const spanTo = t0 + 20 * DAY;

const itemsAt = (base: number): ParserItem[] => Array.from({ length: 30 }, (_, k) => ({
  channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: base + k * 12 * HOUR,
}));
const bumpsFor = (items: ParserItem[]) =>
  items.map((it) => ({ symbol: it.symbol, ts: it.ts, pct: 0.03 }));

const opts = (over: Record<string, unknown> = {}) => ({
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  selection: { nestedOuterFolds: 0 }, refineRounds: 0, outcomeModel: false,
  roundTripCostPct: 0.1, grid: oneShotGrid({ staleMinutes: [30, 60] }),
  ...over,
});

/** семантическое ядро результата: выбор + безразмерная экономика */
const core = (p: TrainedParams) => ({
  exit: p.exit.global,
  config: p.config,
  pnl: p.pnl.global,
  rr: p.riskReward.global,
  totalSamples: p.meta.totalSamples,
  cvScore: p.meta.cvScore,
});

describe("метаморфные инварианты", () => {
  it("масштаб цены ×1000 не меняет ни выбор, ни pnl (всё безразмерно)", async () => {
    const items = itemsAt(t0);
    const a = await train(items, syntheticExchange({ seed: 21, spanFrom, spanTo, bumps: bumpsFor(items) }), opts());
    const b = await train(items, syntheticExchange({
      seed: 21, spanFrom, spanTo, bumps: bumpsFor(items), logScale: Math.log(1000),
    }), opts());
    expect(core(b.params)).toEqual(core(a.params));
  }, 120_000);

  it("сдвиг мира на 7 дней не меняет результат (абсолютное время вне математики)", async () => {
    const shift = 7 * DAY;
    const itemsA = itemsAt(t0);
    const itemsB = itemsAt(t0 + shift);
    const a = await train(itemsA, syntheticExchange({ seed: 22, spanFrom, spanTo, bumps: bumpsFor(itemsA) }), opts());
    const b = await train(itemsB, syntheticExchange({
      seed: 22, spanFrom: spanFrom + shift, spanTo: spanTo + shift, bumps: bumpsFor(itemsB),
    }), opts());
    expect(core(b.params)).toEqual(core(a.params));
  }, 120_000);

  it("издержки монотонны: медиана сдвигается ровно на вычет, slippage строго снижает", async () => {
    const items = itemsAt(t0);
    const world = () => syntheticExchange({ seed: 23, spanFrom, spanTo, bumps: bumpsFor(items) });
    const free = await train(items, world(), opts({ roundTripCostPct: 0 }));
    const costly = await train(items, world(), opts({ roundTripCostPct: 0.3 }));
    // тот же грид/выходы → каждый pnl ниже ровно на 0.003 → медиана тоже
    expect(free.params.pnl.global.median - costly.params.pnl.global.median).toBeCloseTo(0.003, 5);
    const slipped = await train(items, world(), opts({ roundTripCostPct: 0, slippageRangeFrac: 0.5 }));
    expect(slipped.params.pnl.global.median).toBeLessThan(free.params.pnl.global.median);
  }, 120_000);

  it("детерминизм под джиттером сети: пул разметки = последовательный прогон бит-в-бит", async () => {
    const items = itemsAt(t0);
    const world = syntheticExchange({ seed: 24, spanFrom, spanTo, bumps: bumpsFor(items) });
    const jitterRnd = mulberry32(555);
    const jittery: GetCandles = (...args) =>
      new Promise((resolve, reject) => {
        setTimeout(
          () => Promise.resolve(world(...args)).then(resolve, reject),
          Math.floor(jitterRnd() * 4), // 0–3 мс: порядок ответов сети перемешан
        );
      });
    const seq = await train(items, world, opts({ labelConcurrency: 1 }));
    const par = await train(items, jittery, opts({ labelConcurrency: 4 }));
    expect(core(par.params)).toEqual(core(seq.params));
    expect(par.params.history).toEqual(seq.params.history); // вся история, не только агрегаты
  }, 120_000);
});
