import { describe, it, expect } from "vitest";
import { train, PaperTrader, ParserItem } from "../src/index";
import { silentProgress } from "../src/progress";
import { syntheticExchange, oneShotGrid, HOUR, DAY, mulberry32 } from "./helpers/synthetic-world";

/**
 * МОНТЕ-КАРЛО НУЛЕВОЙ ГИПОТЕЗЫ — частотные свойства защит, а не один сид.
 *
 * Главное обещание сертификата — «шум не сертифицируется»; главное обещание
 * монитора дрейфа — «редкие ложные тревоги». Оба обещания — про ЧАСТОТЫ,
 * и проверяются только серией независимых сеяных миров:
 *  1) 20 шумовых миров (постов никто не слышит) → certified=true допустим
 *     как редкое исключение (≤ 2 из 20 ≈ номинальный α);
 *  2) 50 форвард-потоков ИЗ ТОГО ЖЕ распределения, что baseline → тревоги
 *     PaperTrader редки (CUSUM h=5σ: ARL₀≈465 → P(за 30 сделок)≈6%; KS α=5%).
 * Всё детерминировано сидами — тест не флакает, частоты фиксированы.
 */

const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

describe("Монте-Карло H0", () => {
  it("20 шумовых миров: шум почти никогда не сертифицируется (≤ 2/20)", async () => {
    let certified = 0;
    for (let seed = 100; seed < 120; seed++) {
      const items: ParserItem[] = Array.from({ length: 40 }, (_, k) => ({
        channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
      }));
      const gc = syntheticExchange({
        seed, spanFrom: t0 - 5 * DAY, spanTo: t0 + 22 * DAY, // БЕЗ bumps: чистое блуждание
      });
      const res = await train(items, gc, {
        folds: 3, mode: "single", onProgress: silentProgress,
        selection: { nestedOuterFolds: 0 }, refineRounds: 0, outcomeModel: false,
        roundTripCostPct: 0.2, grid: oneShotGrid(),
      });
      if (res.params.meta.certification.certified) certified++;
    }
    expect(certified).toBeLessThanOrEqual(2);
  }, 300_000);

  it("50 честных форвард-потоков: тревоги PaperTrader редки (≤ 10/50)", () => {
    // baseline и форвард — одно распределение: pnl ~ 0.2% ± равномерный шум 0.8%
    const draw = (rnd: () => number) => 0.002 + (rnd() - 0.5) * 0.016;
    const baseRnd = mulberry32(9000);
    const baseline = Array.from({ length: 120 }, () => draw(baseRnd));
    let alarms = 0;
    for (let s = 0; s < 50; s++) {
      const rnd = mulberry32(9100 + s);
      const pt = new PaperTrader(baseline);
      for (let i = 0; i < 30; i++) pt.record({ ts: t0 + i * HOUR, pnl: draw(rnd) });
      if (pt.status().alarm) alarms++;
    }
    expect(alarms).toBeLessThanOrEqual(10);
  });
});
