import { describe, it, expect } from "vitest";
import { rangeFeatures, zoneOffsetPct, predict, train, PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// СЖАТИЕ ДИАПАЗОНА (обобщение anti-liquidity-harvesting из habr 1041898).
// ─────────────────────────────────────────────────────────────────────────────
describe("rangeFeatures — средний диапазон и сжатие пре-окна", () => {
  const mk = (ranges: number[]): ICandleData[] =>
    ranges.map((r, i) => ({
      timestamp: t0 + i * MIN, open: 100, close: 100,
      high: 100 + r / 2, low: 100 - r / 2, volume: 1000,
    }));

  it("сжатие перед сигналом → compression < 1; расширение → > 1", () => {
    // 60 свечей: первые 45 широкие (1.0), последние 15 узкие (0.2)
    const squeeze = rangeFeatures(mk([...Array(45).fill(1.0), ...Array(15).fill(0.2)]), 60);
    expect(squeeze.compression!).toBeLessThan(0.5);
    const expand = rangeFeatures(mk([...Array(45).fill(0.2), ...Array(15).fill(1.0)]), 60);
    expect(expand.compression!).toBeGreaterThan(2);
    // rangePct — средний минутный диапазон в %
    const flat = rangeFeatures(mk(Array(60).fill(0.5)), 60);
    expect(flat.rangePct!).toBeCloseTo(0.5, 1);
    expect(flat.compression!).toBeCloseTo(1, 1);
  });

  it("мало свечей (<40) → честные null", () => {
    const r = rangeFeatures(mk(Array(30).fill(0.5)), 30);
    expect(r.rangePct).toBe(null);
    expect(r.compression).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ГЕОМЕТРИЯ ЗОНЫ: chase (+) vs pullback (−), направленно к посту.
// ─────────────────────────────────────────────────────────────────────────────
describe("zoneOffsetPct — где автор поставил зону относительно цены", () => {
  it("long с зоной выше рынка = chase (+); ниже = pullback (−); short зеркален", () => {
    expect(zoneOffsetPct(101, 103, 100, "long")!).toBeCloseTo(2, 6);
    expect(zoneOffsetPct(97, 99, 100, "long")!).toBeCloseTo(-2, 6);
    // short: зона НИЖЕ рынка = вход по ходу падения = chase (+)
    expect(zoneOffsetPct(97, 99, 100, "short")!).toBeCloseTo(2, 6);
    expect(zoneOffsetPct(101, 103, 100, "short")!).toBeCloseTo(-2, 6);
  });

  it("нет зоны или цены → null", () => {
    expect(zoneOffsetPct(undefined, 101, 100, "long")).toBe(null);
    expect(zoneOffsetPct(99, 101, null, "long")).toBe(null);
    expect(zoneOffsetPct(99, 101, 0, "long")).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСТАЛОСТЬ СИМВОЛА: gap до предыдущего события вне окна собственного всплеска.
// ─────────────────────────────────────────────────────────────────────────────
describe("symbolGapMs — усталость символа в вердиктах predict", () => {
  it("gap меряется до ПРОШЛОГО всплеска, ко-бёрстовые посты не считаются", () => {
    const DAY = 24 * HOUR;
    const items: ParserItem[] = [
      // прошлый всплеск 3 дня назад
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 },
      // свежий всплеск: два поста в одном окне (co-burst — не «усталость»)
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 + 3 * DAY },
      { channel: "b", symbol: "SOLUSDT", direction: "long", ts: t0 + 3 * DAY + 5 * MIN },
      // другой символ — свой отсчёт
      { channel: "a", symbol: "TRXUSDT", direction: "short", ts: t0 + 3 * DAY },
    ];
    const res = predict(items, { mode: "single" });
    const sol = res.verdicts.find((v) => v.symbol === "SOLUSDT" && v.ts >= t0 + 3 * DAY)!;
    // до прошлого всплеска ~3 дня; сосед в 5 минутах исключён (внутри maxBurstWindowMs)
    expect(sol.symbolGapMs!).toBeGreaterThanOrEqual(3 * DAY - HOUR);
    expect(sol.symbolGapMs!).toBeLessThanOrEqual(3 * DAY);
    const trx = res.verdicts.find((v) => v.symbol === "TRXUSDT")!;
    expect(trx.symbolGapMs).toBe(null); // первый на символе
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E: rangePct как фича исхода — «мёртвый диапазон → ловушка» выучивается.
// ─────────────────────────────────────────────────────────────────────────────
describe("range-фича в модели исхода — anti-harvesting выучен из данных", () => {
  // TIGHTUSDT: живой пре-диапазон (0.6%), после поста растёт → win
  // DEADUSDT:  мёртвый пре-диапазон (0.05%), после поста сливается → loss
  const world = (symbol: string, t: number): { p: number; halfRange: number } => {
    const m = (t - t0) / MIN;
    const cyc = ((m % 720) + 720) % 720; // пост каждые 12ч на минуте 0 цикла
    const dead = symbol === "DEADUSDT";
    const drift = dead ? -0.0006 : 0.0006;
    const inCycle = Math.min(cyc, 40);
    const wave = Math.sin(m / 37) * 3; // вариативность pnl (иначе std=0)
    return {
      p: 100 * Math.exp(drift * (inCycle + 0.2 * wave)),
      halfRange: dead ? 0.025 : 0.3,
    };
  };
  const gc: GetCandles = async (symbol, _i, limit, sDate) => {
    const out: ICandleData[] = [];
    for (let i = 0; i < (limit ?? 0); i++) {
      const t = (sDate ?? 0) + i * MIN;
      const a = world(symbol, t);
      const b = world(symbol, t + MIN);
      out.push({
        timestamp: t, open: a.p, close: b.p,
        high: Math.max(a.p, b.p) + a.halfRange, low: Math.min(a.p, b.p) - a.halfRange,
        volume: 1000 + (i % 5) * 50,
      });
    }
    return out;
  };
  const items: ParserItem[] = [];
  for (let k = 0; k < 12; k++) {
    items.push({ channel: "ch", symbol: "TIGHTUSDT", direction: "long", ts: t0 + 240 * HOUR + k * 12 * HOUR });
    items.push({ channel: "ch", symbol: "DEADUSDT", direction: "long", ts: t0 + 240 * HOUR + k * 12 * HOUR + HOUR });
  }

  it("outcome строит range-маржинал; живой диапазон получает pWin выше мёртвого", async () => {
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress,
      channelTriage: false, momentumFeature: true, momentumWindowMinutes: 60,
      selection: { nestedOuterFolds: 0 },
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
    });
    expect(res.params.outcome).not.toBe(null);
    expect(res.params.outcome!.informative).toBe(true);
    // диапазонный маржинал построен (фича варьируется и несёт сигнал)
    expect(res.params.outcome!.features.range).toBeDefined();

    // рантайм: pWin живого символа выше мёртвого
    const m = PumpMatrix.load(res.params as never);
    const freshTs = t0 + 480 * HOUR;
    const dict = {
      TIGHTUSDT: await gc("TIGHTUSDT", "1m", 65, freshTs - 65 * MIN),
      DEADUSDT: await gc("DEADUSDT", "1m", 65, freshTs - 65 * MIN),
    };
    const sigs = m.plan([
      { channel: "ch", symbol: "TIGHTUSDT", direction: "long", ts: freshTs },
      { channel: "ch", symbol: "DEADUSDT", direction: "long", ts: freshTs },
    ], dict);
    const tight = sigs.find((s) => s.symbol === "TIGHTUSDT")!;
    const dead = sigs.find((s) => s.symbol === "DEADUSDT")!;
    expect(tight.probability!.pWin).toBeGreaterThan(dead.probability!.pWin);
  }, 30_000);
});
