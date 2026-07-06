import { describe, it, expect } from "vitest";
import { train, walkForward, PumpMatrix, PaperTrader, ParserItem } from "../src/index";
import { silentProgress } from "../src/progress";
import { syntheticExchange, oneShotGrid, HOUR, DAY } from "./helpers/synthetic-world";

/**
 * СМЕРТЬ ЭДЖА ПОСРЕДИ ИСТОРИИ — самый частый способ слить депозит в реальности.
 *
 * Канал полгода двигал рынок, потом умер (ботов забанили, автор продал канал,
 * толпа выгорела) — посты продолжают идти, а реакции больше нет. Заложенная
 * истина: первые 20 постов → пампы +3%, последние 20 → рынок глух.
 *
 * Три утверждения — три линии обороны:
 *  1) ЛОВУШКА: наивный fit по всей истории видит ПОЛОЖИТЕЛЬНУЮ медиану —
 *     усреднение маскирует смерть, «канал проверенный» по цифрам;
 *  2) walk-forward смерть ВСКРЫВАЕТ: хронологические OOS-срезы живой эры
 *     положительны, мёртвой — нет; правда видна ДО деплоя;
 *  3) PaperTrader ловит смерть ВЖИВУЮ: модель, обученная на живой эре,
 *     торгует мёртвую → CUSUM пробивает порог за считанные сделки — стоп
 *     приходит раньше, чем депозит замечает разницу.
 */

const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const spanFrom = t0 - 5 * DAY;
const spanTo = t0 + 25 * DAY;

const items: ParserItem[] = Array.from({ length: 40 }, (_, k) => ({
  channel: "vip_signals", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
}));
const aliveItems = items.slice(0, 20);
const deadItems = items.slice(20);
// пампы заложены ТОЛЬКО за постами живой эры
const gc = syntheticExchange({
  seed: 31, spanFrom, spanTo,
  bumps: aliveItems.map((it) => ({ symbol: it.symbol, ts: it.ts, pct: 0.03 })),
});
const opts = {
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  selection: { nestedOuterFolds: 0 }, refineRounds: 0, outcomeModel: false,
  roundTripCostPct: 0.2, grid: oneShotGrid(),
};

describe("смерть эджа посреди истории", () => {
  it("ловушка усреднения: fit по всей истории всё ещё в плюсе; walk-forward смерть вскрывает", async () => {
    // 1) наивная медиана положительна — «по цифрам канал проверенный»
    const naive = await train(items, gc, opts);
    expect(naive.params.pnl.global.median).toBeGreaterThan(0);

    // 2) хронология говорит правду: живой OOS-срез в плюсе, мёртвые — нет
    const wf = await walkForward(items, gc, {
      slices: 3, trainOptions: opts, policy: { acknowledgeUncertified: true },
    });
    const medianOf = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const first = wf.slices[0];   // тест = посты 10–20 (эдж жив)
    const last = wf.slices[wf.slices.length - 1]; // тест = посты 30–40 (эдж мёртв)
    expect(first.pnls.length).toBeGreaterThan(3);
    expect(last.pnls.length).toBeGreaterThan(3);
    expect(medianOf(first.pnls)).toBeGreaterThan(0.01);  // живая эра платит
    expect(medianOf(last.pnls)).toBeLessThanOrEqual(0);  // мёртвая — нет
    expect(medianOf(last.pnls)).toBeLessThan(medianOf(first.pnls));
  }, 120_000);

  it("PaperTrader ловит смерть вживую: CUSUM стопит за считанные сделки мёртвой эры", async () => {
    // модель обучена на ЖИВОЙ эре — как в жизни: эдж был настоящим
    const res = await train(aliveItems, gc, opts);
    const model = PumpMatrix.load(PumpMatrix.load(res.params).save());
    expect(res.params.pnl.global.median).toBeGreaterThan(0.015); // эдж был реальным

    // форвард: те же сигналы канала, но рынок уже глух — реплеим мёртвую эру
    const forward = (await model.backtest(deadItems, gc)).filter((s) => s.result.entered);
    expect(forward.length).toBeGreaterThan(15);

    const pt = new PaperTrader(model); // baseline = history живой эры из model.json
    let stoppedAfter: number | null = null;
    for (let i = 0; i < forward.length; i++) {
      pt.record({ ts: forward[i].ts, pnl: forward[i].result.pnl, symbol: forward[i].symbol });
      if (stoppedAfter === null && pt.status().alarm) stoppedAfter = i + 1;
    }
    const s = pt.status();
    expect(s.alarm).toBe(true);
    expect(s.cusum.fired).toBe(true);
    expect(s.recommendation).toContain("СТОП");
    // смерть поймана раньше, чем канал «отработал» половину мёртвой эры:
    // депозит теряет считанные сделки, а не месяцы веры в мёртвый канал
    expect(stoppedAfter).not.toBe(null);
    expect(stoppedAfter!).toBeLessThanOrEqual(10);
  }, 120_000);
});
