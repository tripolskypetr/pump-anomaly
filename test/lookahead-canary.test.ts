import { describe, it, expect } from "vitest";
import { train, PumpMatrix, ParserItem, TrainedParams } from "../src/index";
import { silentProgress } from "../src/progress";
import { syntheticExchange, oneShotGrid, MIN, HOUR, DAY } from "./helpers/synthetic-world";

/**
 * КАНАРЕЙКА LOOK-AHEAD — один тест против целого класса будущих регрессий.
 *
 * Два мира БИТ-В-БИТ одинаковы до отсечки и чудовищно различаются после
 * (лог-цена +3 ≈ ×20): если ЛЮБОЙ путь fit (разметка, скоринг, сертификация)
 * или live-plan когда-нибудь подсмотрит за свой законный горизонт — параметры/
 * сигналы двух миров разойдутся и канарейка умрёт. Ловит не конкретный баг,
 * а само СВОЙСТВО «обучение не видит будущего».
 */

const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const spanFrom = t0 - 20 * DAY;
const spanTo = t0 + 40 * DAY;

const items: ParserItem[] = Array.from({ length: 36 }, (_, k) => ({
  channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
}));
const bumps = items.map((it) => ({ symbol: it.symbol, ts: it.ts, pct: 0.03 }));

const opts = {
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  selection: { nestedOuterFolds: 0 }, refineRounds: 0, outcomeModel: false,
  roundTripCostPct: 0.1, grid: oneShotGrid({ staleMinutes: [30, 60] }),
};

/** параметры без несемантических полей (время фита/реестр) */
const comparable = (p: TrainedParams): unknown => {
  const c = JSON.parse(JSON.stringify(p)) as Record<string, { trainedAt?: number; ledger?: unknown }>;
  delete c.meta.trainedAt;
  delete c.meta.ledger;
  return c;
};

describe("канарейка look-ahead", () => {
  it("fit: отрава сразу за горизонтом последней метки не меняет НИ ОДНОГО параметра", async () => {
    // законный горизонт fit: последняя метка живёт ≤ max(staleMinutes)·2+5 свечей вперёд
    const cutoff = items[items.length - 1].ts + (60 * 2 + 5 + 3) * MIN;
    const clean = syntheticExchange({ seed: 5, spanFrom, spanTo, bumps });
    const poisoned = syntheticExchange({
      seed: 5, spanFrom, spanTo, bumps, poisonFromTs: cutoff, poisonBoost: 3,
    });
    const a = await train(items, clean, opts);
    const b = await train(items, poisoned, opts);
    expect(a.params.meta.totalSamples).toBeGreaterThan(20); // канарейка живая, не пустая
    expect(comparable(b.params)).toEqual(comparable(a.params));
  }, 120_000);

  it("plan (live): отрава с сигнальной минуты не меняет сигнал — будущее не читается", async () => {
    const clean = syntheticExchange({ seed: 5, spanFrom, spanTo, bumps });
    const res = await train(items, clean, opts);
    const model = PumpMatrix.load(PumpMatrix.load(res.params).save());
    const freshTs = t0 + 30 * DAY;
    const poisonedNow = syntheticExchange({
      seed: 5, spanFrom, spanTo, bumps, poisonFromTs: freshTs, poisonBoost: 3,
    });
    const fresh: ParserItem[] = [{ channel: "ch", symbol: "SOLUSDT", direction: "long", ts: freshTs }];
    const sigA = await model.plan(fresh, clean, { acknowledgeUncertified: true });
    const sigB = await model.plan(fresh, poisonedNow, { acknowledgeUncertified: true });
    expect(sigA.length).toBe(1);
    expect(JSON.parse(JSON.stringify(sigB))).toEqual(JSON.parse(JSON.stringify(sigA)));
  }, 120_000);
});
