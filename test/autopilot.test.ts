import { describe, it, expect } from "vitest";
import { train, PumpMatrix, TrainedParams, assessEdge } from "../src/index";
import { intersectPolicy } from "../src/signal";
import { ParserItem } from "../src/types";
import { ExitParams } from "../src/replay";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

const smallGrid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
  stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
  squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
  cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
};
const baseOpts = {
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  grid: smallGrid, selection: { nestedOuterFolds: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// АВТО-ТРИАЖ КАНАЛОВ: «drop убыточных, invert механических» — внутри fit.
// ─────────────────────────────────────────────────────────────────────────────
describe("channelPlan — триаж каналов без участия оператора", () => {
  // Мир: goodhuman лонгует растущий GOODUSDT (+) → follow;
  // botdump сливает КРУПНО (−1.2%/сделку): инверсия отбивает двойные издержки
  // (2×0.2%) → invert — решают ДАННЫЕ, а не порог algoScore;
  // sadhuman сливает МЕЛКО (−0.15% до издержек): убыточен значимо, но инверсия
  // двойных издержек не отбивает → drop.
  const priceOf = (symbol: string, t: number): number => {
    const m = (t - t0) / MIN;
    if (symbol === "GOODUSDT") return 100 * Math.pow(1.0004, m);
    if (symbol === "SADUSDT") return 300 * Math.pow(0.99995, m); // −0.15% за 30м
    return 300 * Math.pow(0.9996, m); // BADUSDT: −1.2% за 30м
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
  for (let i = 0; i < 12; i++) {
    items.push({ channel: "goodhuman", symbol: "GOODUSDT", direction: "long", ts: t0 + 24 * HOUR + i * 25 * HOUR + 137 * MIN });
    items.push({ channel: "botdump", symbol: "BADUSDT", direction: "long", ts: Date.UTC(2026, 0, 7 + i, 14, 0, 0) });
    items.push({ channel: "sadhuman", symbol: "SADUSDT", direction: "long", ts: t0 + 24 * HOUR + i * 23 * HOUR + (i * i * 37) % 900 * MIN });
  }

  const triageOpts = { ...baseOpts, roundTripCostPct: 0.2 }; // издержки участвуют в решении invert

  it("fit строит план: крупный слив → invert (окупает издержки), мелкий → drop", async () => {
    const res = await train(items, gc, triageOpts);
    const plan = res.params.channelPlan!;
    expect(plan.botdump).toBe("invert");   // −pnl − 2×издержки значимо > 0
    expect(plan.sadhuman).toBe("drop");    // значимо убыточен, но инверсия издержки не отбивает
    expect(plan.goodhuman).toBeUndefined(); // follow
  });

  it("рантайм применяет план сам: drop режется, invert разворачивается", async () => {
    const res = await train(items, gc, triageOpts);
    const m = PumpMatrix.load(PumpMatrix.load(res.params as never).save()); // план переживает save/load
    const freshTs = t0 + 60 * 24 * HOUR;
    const sigs = m.signals([
      { channel: "goodhuman", symbol: "GOODUSDT", direction: "long", ts: freshTs },
      { channel: "botdump", symbol: "BADUSDT", direction: "long", ts: freshTs },
      { channel: "sadhuman", symbol: "SADUSDT", direction: "long", ts: freshTs },
    ], { acknowledgeUncertified: true }); // research-модель без сертификата
    expect(sigs.length).toBe(2); // sadhuman выброшен
    const bot = sigs.find((s) => s.origin.channel === "botdump")!;
    expect(bot.action).toBe("invert");
    expect(bot.direction).toBe("short");        // торгуем ПРОТИВ поста
    expect(bot.origin.invertedFrom).toBe("long"); // что говорил канал
    const good = sigs.find((s) => s.origin.channel === "goodhuman")!;
    expect(good.action).toBe("enter");
    expect(good.direction).toBe("long");
  });

  it("инверсия плана уважает allow: без 'invert' канал режется как veto", async () => {
    const res = await train(items, gc, triageOpts);
    const m = PumpMatrix.load(res.params as never);
    const sigs = m.signals(
      [{ channel: "botdump", symbol: "BADUSDT", direction: "long", ts: t0 + 60 * 24 * HOUR }],
      { allow: ["enter"], acknowledgeUncertified: true },
    );
    expect(sigs.length).toBe(0);
  });

  it("channelTriage: false → плана нет, все follow", async () => {
    const res = await train(items, gc, { ...triageOpts, channelTriage: false });
    expect(Object.keys(res.params.channelPlan ?? {}).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ФИЛЬТР ЁМКОСТИ: сверка размера с минутным оборотом — внутри policy.
// ─────────────────────────────────────────────────────────────────────────────
describe("notionalQuote/maxLiquidityShare — ёмкость проверяется автоматически", () => {
  const ex = (): ExitParams & Record<string, unknown> => ({
    trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 60, volBaselineWindow: 20, squeezePolicy: "none", cascadeWindowMinutes: 15,
  });
  const model = (policy: object): PumpMatrix => PumpMatrix.load({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex(), matrix: ex() }, global: ex() },
    policy: policy as TrainedParams["policy"],
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  } as TrainedParams);
  // 30 свечей до сигнала, оборот ≈ 600×100 = 60 000 quote/мин
  const tape = (): ICandleData[] =>
    Array.from({ length: 30 }, (_, i) => ({
      timestamp: t0 + i * MIN, open: 100, high: 100.2, low: 99.8, close: 100,
      volume: 500 + (i % 3) * 100,
    }));
  const item: ParserItem = { channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 + 30 * MIN };

  it("размер в пределах доли оборота → проходит; крупный → режется", () => {
    // liquidityQuote ≈ 60 000; доля 0.1 → потолок 6 000
    const small = model({ allow: ["enter"], notionalQuote: 3_000 });
    expect(small.plan([item], { SOLUSDT: tape() }).length).toBe(1);
    const big = model({ allow: ["enter"], notionalQuote: 50_000 });
    expect(big.plan([item], { SOLUSDT: tape() }).length).toBe(0);
  });

  it("нет свечей → ёмкость не подтверждена → режется консервативно", () => {
    const m = model({ allow: ["enter"], notionalQuote: 1 });
    expect(m.signals([item]).length).toBe(0);
  });

  it("без notionalQuote фильтра нет (обратная совместимость)", () => {
    const m = model({ allow: ["enter"] });
    expect(m.signals([item]).length).toBe(1);
  });

  it("tighten-only: размер только вверх, доля только вниз", () => {
    expect(intersectPolicy({ allow: ["enter"], notionalQuote: 5000 }, { notionalQuote: 1000 }).notionalQuote).toBe(5000);
    expect(intersectPolicy({ allow: ["enter"], maxLiquidityShare: 0.05 }, { maxLiquidityShare: 0.2 }).maxLiquidityShare).toBe(0.05);
    expect(intersectPolicy({ allow: ["enter"] }, { notionalQuote: 700 }).notionalQuote).toBe(700);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assessEdge: чеклист «fit → сертификат → walk-forward → решение» одним вызовом.
// ─────────────────────────────────────────────────────────────────────────────
describe("assessEdge — вердикт trade/paper/no-edge вместо ручного чеклиста", () => {
  // дрейф с медленной волной: pnl сделок РАЗЛИЧАЮТСЯ (иначе std=0 → Sharpe
  // вырожденно 0 и вердикт нечестно падает в no-edge на идеальной синтетике)
  const gcFor = (drift: number): GetCandles => async (_s, _i, limit, sDate) => {
    const priceAt = (t: number): number => {
      const m = (t - t0) / MIN;
      return 100 * Math.exp(drift * m + drift * 8 * Math.sin(m / 40));
    };
    const out: ICandleData[] = [];
    for (let i = 0; i < (limit ?? 0); i++) {
      const t = (sDate ?? 0) + i * MIN;
      const p = priceAt(t);
      const c = priceAt(t + MIN);
      out.push({
        timestamp: t, open: p, close: c,
        high: Math.max(p, c) * 1.0001, low: Math.min(p, c) * 0.9999,
        volume: 1000 + (Math.floor(t / MIN) % 5) * 50,
      });
    }
    return out;
  };
  const items: ParserItem[] = Array.from({ length: 12 }, (_, k) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + 24 * HOUR + k * 12 * HOUR,
  }));

  it("растущий мир: эдж виден, но не доказан → 'paper' с причинами", async () => {
    const a = await assessEdge(items, gcFor(0.0004), {
      trainOptions: baseOpts,
      walkForward: { slices: 2 },
    });
    expect(a.verdict).toBe("paper"); // маленькая синтетика не сертифицируется
    expect(a.oosTrades).toBeGreaterThan(0);
    expect(a.reasons.join("\n")).toContain("эдж виден");
    expect(a.model).toBeInstanceOf(PumpMatrix);
    expect(a.walkForward.slices.length).toBe(2);
  });

  it("падающий мир (лонги в минус): честный 'no-edge'", async () => {
    const a = await assessEdge(items, gcFor(-0.0004), {
      trainOptions: baseOpts,
      walkForward: { slices: 2 },
    });
    expect(a.verdict).toBe("no-edge");
    expect(a.reasons.join("\n")).toMatch(/≤ 0|нет/);
  });
});
