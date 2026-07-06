import { describe, it, expect } from "vitest";
import { train, walkForward, PumpMatrix, PaperTrader, ParserItem } from "../src/index";
import { GetCandles } from "../src/candle";
import { silentProgress } from "../src/progress";
import { syntheticExchange, oneShotGrid, MIN, HOUR, DAY } from "./helpers/synthetic-world";

/**
 * ГРАНИ ЭДЖА — сценарии, где инструмент обязан сказать правду, а не приятное:
 *  1) флэш-фитиль: «эдж», существующий только в пике свечи, нереализуем;
 *  2) часовой пояс: рассинхронизированный парсер не превращается в ложный эдж;
 *  3) ёмкость: эдж существует, но не для вашего размера;
 *  4) адаптивный охотник: статичный стоп проигрывает гонку вооружений,
 *     петля переобучения выигрывает;
 *  5) один настоящий канал среди десяти шумовых: селективность в толпе.
 */

const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const spanFrom = t0 - 5 * DAY;
const spanTo = t0 + 30 * DAY;
const alignMin = (ts: number) => Math.floor(ts / MIN) * MIN;

const opts = (over: Record<string, unknown> = {}) => ({
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  selection: { nestedOuterFolds: 0 }, refineRounds: 0, outcomeModel: false,
  roundTripCostPct: 0.2, grid: oneShotGrid(),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe("флэш-фитиль — эдж, который существует только в пике", () => {
  it("peak видит +5%, честная реализация видит ноль минус издержки → no-edge", async () => {
    const items: ParserItem[] = Array.from({ length: 30 }, (_, k) => ({
      channel: "wick_channel", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
    }));
    const base = syntheticExchange({ seed: 41, spanFrom, spanTo }); // блуждание БЕЗ пампов
    // «памп» канала — прокол +5% фитилём на 1–2-й минуте, close возвращается:
    // ровно то, что показывают на скринах VIP-каналы
    const wicked = new Set(items.flatMap((it) => [alignMin(it.ts) + MIN, alignMin(it.ts) + 2 * MIN]));
    const gc: GetCandles = async (...a) =>
      (await base(...a)).map((c) => (wicked.has(c.timestamp) ? { ...c, high: c.open * 1.05 } : c));

    const res = await train(items, gc, opts());
    const entered = (res.params.history ?? []).filter((h) => h.entered);
    expect(entered.length).toBeGreaterThan(25);
    // MFE честно записан: пики «как на скринах» есть...
    const meanPeak = entered.reduce((s, h) => s + h.peak, 0) / entered.length;
    expect(meanPeak).toBeGreaterThan(0.03);
    // ...но реализованная медиана — ноль минус издержки: пик не торгуется
    expect(res.params.pnl.global.median).toBeLessThanOrEqual(0);

    const wf = await walkForward(items, gc, {
      slices: 2, trainOptions: opts(), policy: { acknowledgeUncertified: true },
    });
    expect(wf.stats.median).toBeLessThanOrEqual(0); // и вне обучения чуда нет
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("часовой пояс — мусор на входе не превращается в ложный эдж", () => {
  it("парсер записал МСК вместо UTC (−3ч): инструмент говорит «нет эджа», а не выдумывает", async () => {
    const trueTs = Array.from({ length: 30 }, (_, k) => t0 + k * 12 * HOUR);
    const gc = syntheticExchange({
      seed: 42, spanFrom, spanTo,
      bumps: trueTs.map((ts) => ({ symbol: "SOLUSDT", ts, pct: 0.03 })), // пампы НАСТОЯЩИЕ
    });
    const mk = (shift: number): ParserItem[] => trueTs.map((ts) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long", ts: ts + shift,
    }));

    // правильные ts: эдж реальный и виден
    const correct = await train(mk(0), gc, opts());
    expect(correct.params.pnl.global.median).toBeGreaterThan(0.015);

    // ts со сдвигом −3ч: окно сделки закрывается ДО пампа — эджа в таких данных нет,
    // и инструмент обязан сказать именно это (не сертифицировать шум)
    const shifted = await train(mk(-3 * HOUR), gc, opts());
    expect(shifted.params.pnl.global.median).toBeLessThanOrEqual(0);
    expect(shifted.params.meta.certification.certified).toBe(false);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ёмкость — эдж существует, но не для вашего размера", () => {
  it("оборот $500/мин: $5000-ордер режется capacity, $30 проходит", async () => {
    const items: ParserItem[] = Array.from({ length: 30 }, (_, k) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
    }));
    const base = syntheticExchange({
      seed: 43, spanFrom, spanTo,
      bumps: items.map((it) => ({ symbol: it.symbol, ts: it.ts, pct: 0.04 })),
    });
    // неликвид: объём ÷200 → минутный оборот ~ $500 (цена ~100 × объём ~5)
    const gc: GetCandles = async (...a) =>
      (await base(...a)).map((c) => ({ ...c, volume: c.volume / 200 }));

    const res = await train(items, gc, opts({ roundTripCostPct: 0.1 }));
    expect(res.params.pnl.global.median).toBeGreaterThan(0.02); // эдж настоящий
    const model = PumpMatrix.load(PumpMatrix.load(res.params).save());

    const fresh: ParserItem = { channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 + 28 * DAY };
    // без политики размера — сигнал идёт, advisory-оборот честно крошечный
    const open = await model.plan([fresh], gc, { acknowledgeUncertified: true });
    expect(open.length).toBe(1);
    expect(open[0].origin.liquidityQuote!).toBeLessThan(2000);
    // ваш размер $5000 > 10% оборота → сами себе памп, сигнал режется
    const big = await model.plan([fresh], gc, { acknowledgeUncertified: true, notionalQuote: 5000 });
    expect(big.length).toBe(0);
    // трассировка называет фильтр по имени и с числами
    const dict = { SOLUSDT: await gc("SOLUSDT", "1m", 600, fresh.ts - 600 * MIN) };
    const [ex] = model.explainSignals([fresh], dict, { acknowledgeUncertified: true, notionalQuote: 5000 });
    expect(ex.rejectedBy).toBe("capacity");
    // а $30 в тот же стакан — проходит: эдж есть ДЛЯ ЭТОГО размера
    const small = await model.plan([fresh], gc, { acknowledgeUncertified: true, notionalQuote: 30 });
    expect(small.length).toBe(1);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("адаптивный охотник — гонка вооружений стопов", () => {
  const era1: ParserItem[] = Array.from({ length: 20 }, (_, k) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
  }));
  const era2: ParserItem[] = Array.from({ length: 20 }, (_, k) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + (20 + k) * 12 * HOUR,
  }));
  // эра 1: вик −1.5% и разгон +4%; эра 2: охотник адаптировался — вик −2.5%,
  // ровно под стоп, выученный на эре 1
  const gc = syntheticExchange({
    seed: 44, spanFrom, spanTo,
    bumps: [...era1, ...era2].flatMap((it, i) => [
      { symbol: it.symbol, ts: it.ts, pct: i < 20 ? -0.015 : -0.025, riseMin: 2, decayMin: 3, residual: 0 },
      { symbol: it.symbol, ts: it.ts + 5 * MIN, pct: 0.04, riseMin: 20, decayMin: 60, residual: 0.5 },
    ]),
  });
  const withStop = (hardStop: number[]) =>
    opts({ roundTripCostPct: 0.1, grid: oneShotGrid({ hardStop }) });

  it("статичная модель эры 1 в эре 2 выбита стопами; refit возвращает эдж", async () => {
    // эра 1: стоп 2% переживает вик −1.5% и забирает разгон
    const fit1 = await train(era1, gc, withStop([2]));
    expect(fit1.params.pnl.global.median).toBeGreaterThan(0.02);
    const model1 = PumpMatrix.load(PumpMatrix.load(fit1.params).save());

    // эра 2: вик −2.5% высаживает модель на дне КАЖДОЙ ловушки
    const bt2 = (await model1.backtest(era2, gc)).filter((s) => s.result.entered);
    expect(bt2.length).toBeGreaterThan(15);
    expect(bt2.filter((s) => s.result.reason === "hard-stop").length).toBeGreaterThan(15);
    const median2 = [...bt2.map((s) => s.result.pnl)].sort((a, b) => a - b)[Math.floor(bt2.length / 2)];
    expect(median2).toBeLessThan(-0.015);

    // монитор дрейфа стопит торговлю ДО того, как охотник соберёт всю эру
    const pt = new PaperTrader(model1);
    for (const s of bt2) pt.record({ ts: s.ts, pnl: s.result.pnl });
    expect(pt.status().alarm).toBe(true);
    expect(pt.status().recommendation).toContain("СТОП");

    // петля переобучения: refit на свежей эре выбирает широкий стоп — эдж вернулся
    const fit2 = await train(era2, gc, withStop([2, 50]));
    expect(fit2.params.exit.global.hardStop).toBe(50);
    expect(fit2.params.pnl.global.median).toBeGreaterThan(0.02);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("селективность — один настоящий канал среди десяти шумовых", () => {
  it("channelScore находит настоящего, триаж дропает сливателей, план чист", async () => {
    const channels = ["alpha", ...Array.from({ length: 10 }, (_, i) => `noise${i}`)];
    const symbolOf = (ch: string) => (ch === "alpha" ? "SOLUSDT" : `${ch.toUpperCase()}USDT`);
    const items: ParserItem[] = channels.flatMap((ch) =>
      Array.from({ length: 12 }, (_, k) => ({
        channel: ch, symbol: symbolOf(ch), direction: "long" as const, ts: t0 + k * 12 * HOUR,
      })));
    // пампы заложены ТОЛЬКО за постами alpha
    const gc = syntheticExchange({
      seed: 45, spanFrom, spanTo,
      bumps: items.filter((it) => it.channel === "alpha")
        .map((it) => ({ symbol: it.symbol, ts: it.ts, pct: 0.03 })),
    });
    const res = await train(items, gc, opts({ roundTripCostPct: 0.3 }));

    // скор: настоящий канал — на вершине
    const ranked = Object.entries(res.params.channelScore!).sort((a, b) => b[1].score - a[1].score);
    expect(ranked[0][0]).toBe("alpha");
    expect(ranked[0][1].score).toBeGreaterThan(0);
    // триаж: значимые сливатели (шум − 0.3% издержек) отключены, невиновный — нет
    const plan = res.params.channelPlan ?? {};
    expect(plan.alpha).toBeUndefined();
    expect(Object.values(plan).filter((x) => x === "drop").length).toBeGreaterThanOrEqual(5);

    // прод-план: из 11 свежих постов исполняются только сигналы настоящего канала
    const model = PumpMatrix.load(PumpMatrix.load(res.params).save());
    const fresh: ParserItem[] = channels.map((ch) => ({
      channel: ch, symbol: symbolOf(ch), direction: "long", ts: t0 + 28 * DAY,
    }));
    const sigs = await model.plan(fresh, gc, { acknowledgeUncertified: true });
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) expect(s.origin.channel).toBe("alpha");
  }, 180_000);
});
