import { describe, it, expect } from "vitest";
import { train, PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

/**
 * Мир с ОБЪЕКТИВНЫМ эджем momentum-фильтра:
 *  - GOODUSDT растёт экспоненциально (+0.05%/мин): до поста momentum > +1%,
 *    после поста long зарабатывает;
 *  - BADUSDT падает (−0.05%/мин): до поста momentum < −1% (нож), long теряет.
 * Посты идут по обоим символам. Гейт −1 отделяет их идеально; без гейта
 * матожидание ≈ 0. CV обязан выбрать гейт и вшить его в policy.
 */
const priceOf = (symbol: string, t: number): number => {
  const minutes = (t - t0) / MIN;
  return symbol === "GOODUSDT"
    ? 100 * Math.pow(1.0005, minutes)
    : 200 * Math.pow(0.9995, minutes);
};
const gc: GetCandles = async (symbol, _i, limit, sDate) => {
  const out: ICandleData[] = [];
  for (let i = 0; i < (limit ?? 0); i++) {
    const t = (sDate ?? 0) + i * MIN;
    const o = priceOf(symbol, t);
    const c = priceOf(symbol, t + MIN);
    out.push({
      timestamp: t, open: o, close: c,
      high: Math.max(o, c) * 1.0001, low: Math.min(o, c) * 0.9999,
      volume: 1000 + (Math.floor(t / MIN) % 5) * 50,
    });
  }
  return out;
};

const items: ParserItem[] = [];
for (let k = 0; k < 6; k++) {
  const base = t0 + 24 * 60 * MIN + k * 6 * 60 * MIN; // старт через сутки (есть пре-история)
  items.push({ channel: "ch", symbol: "GOODUSDT", direction: "long", ts: base });
  items.push({ channel: "ch", symbol: "BADUSDT", direction: "long", ts: base + 60 * MIN });
}

const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
  stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
  squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
  cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity],
  momentumGatePct: [null, -1],
};

describe("ОБУЧАЕМЫЙ momentum-гейт — CV выбирает фильтр и вшивает в policy", () => {
  it("на данных с объективным эджем фильтра выбирается гейт −1 → policy", async () => {
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress, grid,
      momentumWindowMinutes: 60, selection: { nestedOuterFolds: 0 },
    });
    // гейт вшит в сериализуемую политику — runtime применит его сам
    expect(res.params.policy.minMomentum24hPct).toBe(-1);
    expect(res.params.policy.momentumWindowMinutes).toBe(60);
    // ось гейта — реальные испытания: 1 exit-конфиг × 2 варианта гейта
    expect(res.params.meta.innerTrials).toBe(2);
    // тензор/история построены по ГЕЙТНУТОМУ набору: BAD-посты не в истории
    expect(res.params.history!.length).toBeGreaterThan(0);
    expect(res.params.history!.every((h) => h.symbol === "GOODUSDT")).toBe(true);
    // и метрики отражают торгуемый (отфильтрованный) поток: плюс, а не ноль
    expect(res.params.pnl.global.mean).toBeGreaterThan(0);
  });

  it("обученный гейт работает end-to-end после save/load: нож режется, тренд проходит", async () => {
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress, grid,
      momentumWindowMinutes: 60, selection: { nestedOuterFolds: 0 },
    });
    const m = PumpMatrix.load(PumpMatrix.load(res.params as never).save());
    const freshTs = t0 + 80 * 60 * MIN;
    const good: ParserItem = { channel: "ch", symbol: "GOODUSDT", direction: "long", ts: freshTs };
    const bad: ParserItem = { channel: "ch", symbol: "BADUSDT", direction: "long", ts: freshTs };
    const sigs = await m.plan([good, bad], gc, { acknowledgeUncertified: true });
    expect(sigs.map((s) => s.symbol)).toEqual(["GOODUSDT"]); // нож отрезан политикой
    // signals() без свечей при обученном гейте честно пуст (подтвердить нечем)
    expect(m.signals([good], { acknowledgeUncertified: true }).length).toBe(0); // режет именно гейт momentum (нет свечей), не сертификат
  });

  it("ось [null] (дефолт) → фичи не фетчатся, поведение прежнее", async () => {
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress,
      grid: { ...grid, momentumGatePct: [null] },
      selection: { nestedOuterFolds: 0 },
    });
    expect(res.params.policy.minMomentum24hPct).toBeUndefined();
    expect(res.params.meta.innerTrials).toBe(1);
    // без гейта в истории оба символа
    const symbols = new Set(res.params.history!.map((h) => h.symbol));
    expect(symbols.size).toBe(2);
  });

  it("пользовательский строгий порог в opts.policy не ослабляется обученным", async () => {
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress, grid,
      momentumWindowMinutes: 60, selection: { nestedOuterFolds: 0 },
      policy: { allow: ["enter"], minMomentum24hPct: 2 }, // строже, чем −1
    });
    expect(res.params.policy.minMomentum24hPct).toBe(2); // max(2, −1)
  });
});
