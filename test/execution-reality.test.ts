import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams, ParserItem, train } from "../src/index";
import { replayExit, ExitParams } from "../src/replay";
import { intersectPolicy } from "../src/signal";
import { ICandleData, GetCandles } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

// ─────────────────────────────────────────────────────────────────────────────
// STATE-DEPENDENT SLIPPAGE: доля диапазона свечи-исполнения против позиции.
// Константная издержка недооценивает боль ровно там, где спред взрывается —
// на свече каскада range велик, и стоп там дороже стопа в тишине.
// ─────────────────────────────────────────────────────────────────────────────
describe("slippageRangeFrac — проскальзывание масштабируется свечой исполнения", () => {
  const E = (o: Partial<ExitParams> = {}): ExitParams => ({
    trailingTake: 50, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 5, ...o,
  });

  it("life-cap: нетто = гросс − k·(rangeВхода + rangeВыхода)/entry", () => {
    // вход @100 (range 1), флэт, выход по close последней (range 0.5)
    const cs = C([
      [100, 100.6, 99.6, 100, 1000],            // range 1.0, зона [99.9,100.1] задета
      [100, 100.2, 99.9, 100.1, 1000],
      [100.1, 100.3, 99.9, 100.2, 1000],
      [100.2, 100.4, 100, 100.3, 1000],
      [100.3, 100.4, 100.1, 100.2, 1000],
      [100.2, 100.5, 100, 100.4, 1000],          // range 0.5
    ]);
    const gross = replayExit(cs, "long", 99.9, 100.1, E());
    const net = replayExit(cs, "long", 99.9, 100.1, E({ slippageRangeFrac: 0.1 }));
    expect(gross.reason).toBe("life-cap");
    const expectedSlip = (0.1 * (100.6 - 99.6) + 0.1 * (100.5 - 100)) / gross.entryPrice;
    expect(net.pnl).toBeCloseTo(gross.pnl - expectedSlip, 9);
    expect(net.exitPrice).toBeCloseTo(gross.exitPrice, 9); // цена рынка гросс, издержки в pnl
  });

  it("стоп в ОБВАЛЕ дороже стопа в тишине (range свечи каскада больше)", () => {
    const calmCrash = C([
      [100, 100.1, 99.95, 100, 1000],
      [100, 100.05, 97.8, 97.9, 1000],           // тихое сползание: range ~2.25
    ]);
    const cascade = C([
      [100, 100.1, 99.95, 100, 1000],
      [100, 100.05, 89, 92, 9000],               // каскад: range ~11
    ]);
    const k = 0.1;
    const a = replayExit(calmCrash, "long", 99.9, 100.1, E({ slippageRangeFrac: k }));
    const b = replayExit(cascade, "long", 99.9, 100.1, E({ slippageRangeFrac: k }));
    expect(a.reason).toBe("hard-stop");
    expect(b.reason).toBe("hard-stop");
    expect(b.pnl).toBeLessThan(a.pnl); // тот же -hardStop%, но каскад срезал больше
  });

  it("не вошли — не заплатили; дефолт 0 ничего не меняет", () => {
    const cs = C([[100, 101, 99, 100, 1000]]);
    const r = replayExit(cs, "long", 150, 151, E({ slippageRangeFrac: 0.2 }));
    expect(r.entered).toBe(false);
    expect(r.pnl).toBe(0);
  });

  it("train штампует slippage в тензор (прод реплеит с ним же)", async () => {
    const items: ParserItem[] = Array.from({ length: 4 }, (_, k) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 120 * MIN,
    }));
    const gc: GetCandles = async (_s, _i, limit, sDate) => {
      const out: ICandleData[] = [];
      for (let i = 0; i < (limit ?? 0); i++) {
        const t = (sDate ?? 0) + i * MIN;
        const p = 100 + ((t - t0) / MIN) * 0.001;
        out.push({ timestamp: t, open: p, high: p + 0.1, low: p - 0.1, close: p + 0.05, volume: 1000 + (i % 5) * 50 });
      }
      return out;
    };
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress,
      slippageRangeFrac: 0.15,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    expect(res.params.exit.global.slippageRangeFrac).toBe(0.15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// КАЧЕСТВО АВТОРОВ: channelScore из бэктест-истории + runtime-фильтр.
// Эдж неравномерен по каналам — фильтр отделяет стабильного автора от сливного.
// ─────────────────────────────────────────────────────────────────────────────
describe("channelScore / minChannelScore — фильтр качества автора", () => {
  const ex = (): ExitParams & Record<string, unknown> => ({
    trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 60, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20,
    squeezePolicy: "none", cascadeWindowMinutes: 15,
  });
  const model = (policy: object, channelScore: object): PumpMatrix => PumpMatrix.load({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex(), matrix: ex() }, global: ex() },
    policy: policy as TrainedParams["policy"],
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    channelScore: channelScore as TrainedParams["channelScore"],
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  } as TrainedParams);
  const scores = {
    stable_author: { score: 0.008, median: 0.006, n: 40 },
    dump_channel: { score: -0.012, median: -0.01, n: 35 },
  };
  // разные символы — иначе посты по одному (symbol,direction,ts) схлопнутся в один вход
  const item = (channel: string, symbol = `${channel.toUpperCase()}USDT`): ParserItem =>
    ({ channel, symbol, direction: "long", ts: t0 });

  it("канал ниже порога режется, стабильный проходит", () => {
    const m = model({ allow: ["enter"], minChannelScore: 0 }, scores);
    const sigs = m.signals([item("stable_author"), item("dump_channel")]);
    expect(sigs.map((s) => s.origin.channel)).toEqual(["stable_author"]);
  });

  it("канал БЕЗ статистики режется консервативно (нечем подтвердить)", () => {
    const m = model({ allow: ["enter"], minChannelScore: 0 }, scores);
    expect(m.signals([item("unknown_channel")]).length).toBe(0);
  });

  it("без фильтра проходят все (обратная совместимость)", () => {
    const m = model({ allow: ["enter"] }, scores);
    expect(m.signals([item("stable_author"), item("dump_channel")]).length).toBe(2);
  });

  it("tighten-only: рантайм ужесточает, ослабить вшитый порог нельзя", () => {
    expect(intersectPolicy({ allow: ["enter"], minChannelScore: 0.005 }, { minChannelScore: 0 }).minChannelScore).toBe(0.005);
    expect(intersectPolicy({ allow: ["enter"], minChannelScore: 0 }, { minChannelScore: 0.01 }).minChannelScore).toBe(0.01);
    expect(intersectPolicy({ allow: ["enter"] }, {}).minChannelScore).toBeUndefined();
  });

  it("геттеры: policy отдаёт порог, channelScore — изолированную копию", () => {
    const m = model({ allow: ["enter"], minChannelScore: 0.001 }, scores);
    expect(m.policy.minChannelScore).toBe(0.001);
    const cs = m.channelScore;
    expect(cs.stable_author.n).toBe(40);
    delete (cs as Record<string, unknown>).stable_author;
    expect(m.channelScore.stable_author).toBeDefined(); // оригинал не тронут
  });

  it("train считает скор с усадкой: 2 удачных поста не бьют 30 стабильных", async () => {
    // канал lucky: 2 сделки по +2%; канал steady: 12 сделок по +1%
    const items: ParserItem[] = [];
    for (let k = 0; k < 12; k++) items.push({ channel: "steady", symbol: "AUSDT", direction: "long", ts: t0 + k * 120 * MIN });
    for (let k = 0; k < 2; k++) items.push({ channel: "lucky", symbol: "BUSDT", direction: "long", ts: t0 + (k * 6 + 1) * 120 * MIN });
    const gc: GetCandles = async (symbol, _i, limit, sDate) => {
      const out: ICandleData[] = [];
      const drift = symbol === "AUSDT" ? 1 / 3000 : 2 / 3000; // +1% / +2% за 30 мин
      for (let i = 0; i < (limit ?? 0); i++) {
        const t = (sDate ?? 0) + i * MIN;
        const m = ((t - t0) / MIN) % 120;
        const p = m < 0 ? 100 : 100 * (1 + drift * Math.min(m, 30));
        const pn = 100 * (1 + drift * Math.min((m + 1) % 120 === 0 ? m : m + 1, 30));
        out.push({ timestamp: t, open: p, high: Math.max(p, pn), low: Math.min(p, pn) - 0.01, close: pn, volume: 1000 + (i % 5) * 50 });
      }
      return out;
    };
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    const cs = res.params.channelScore!;
    expect(cs.steady.n).toBeGreaterThan(cs.lucky.n);
    // у lucky средний pnl на сделку выше, но усадка n/(n+k) опускает его скор ниже steady
    expect(cs.steady.score).toBeGreaterThan(cs.lucky.score);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDITY: advisory-ёмкость в origin — прод сравнивает со своим размером.
// ─────────────────────────────────────────────────────────────────────────────
describe("origin.liquidityQuote — advisory-ёмкость сигнала", () => {
  const ex = (): ExitParams & Record<string, unknown> => ({
    trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 60, volBaselineWindow: 20, squeezePolicy: "none", cascadeWindowMinutes: 15,
  });
  const m = (): PumpMatrix => PumpMatrix.load({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex(), matrix: ex() }, global: ex() },
    policy: { allow: ["enter"] },
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  } as TrainedParams);

  it("медианный минутный оборот до сигнала попадает в origin", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 30; i++) rows.push([100, 100.2, 99.8, 100, 500 + (i % 3) * 100]); // объёмы 500/600/700
    const cs = C(rows);
    const item: ParserItem = { channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 + 30 * MIN };
    const sigs = m().plan([item], { SOLUSDT: cs });
    expect(sigs.length).toBe(1);
    // median(500,600,700-цикл) = 600; ×close 100 = 60000
    expect(sigs[0].origin.liquidityQuote).toBeCloseTo(60_000, -2);
  });

  it("без свечей → null (не выдумываем ёмкость)", () => {
    const item: ParserItem = { channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 };
    const sigs = m().signals([item]);
    expect(sigs[0].origin.liquidityQuote ?? null).toBe(null);
  });
});
