import { describe, it, expect } from "vitest";
import {
  fitOutcomeModel, predictOutcome, OutcomeModel, OutcomeRow,
  train, PumpMatrix, TrainedParams, ParserItem,
} from "../src/index";
import { ExitParams } from "../src/replay";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0); // 09:00 UTC

// ─────────────────────────────────────────────────────────────────────────────
// Категориальные LLR-маржиналы: сезонность без предположения монотонности.
// ─────────────────────────────────────────────────────────────────────────────
describe("категориальные маржиналы — сезонность", () => {
  it("час суток определяет исход → модель выучивает и различает часы", () => {
    // час "10" выигрывает 80%, час "22" — 20%; числовой признак-пустышка
    const rows: OutcomeRow[] = Array.from({ length: 60 }, (_, i) => {
      const hour = i % 2 === 0 ? "10" : "22";
      const win = hour === "10" ? i % 10 !== 0 : i % 10 === 1;
      return {
        y: (win ? 1 : 0) as 0 | 1,
        pnl: win ? 0.01 : -0.008,
        ts: t0 + i * HOUR,
        features: { hourOfDay: hour, dummy: (i % 5) as number },
      };
    });
    const m = fitOutcomeModel(rows, 4);
    expect(m).not.toBe(null);
    expect(m!.categoricals?.hourOfDay).toBeDefined();
    const p10 = predictOutcome(m!, { hourOfDay: "10" });
    const p22 = predictOutcome(m!, { hourOfDay: "22" });
    expect(p10.pWin).toBeGreaterThan(p22.pWin);
  });

  it("однородные категории → признак не проходит AUC-гейт (несуществующая сезонность молчит)", () => {
    // каждый час выигрывает с ОДИНАКОВОЙ долей 4/6 → ранжирующей силы у часа нет
    const rows: OutcomeRow[] = [];
    for (const hour of ["1", "2", "3", "4"]) {
      for (let k = 0; k < 6; k++) {
        rows.push({
          y: (k < 4 ? 1 : 0) as 0 | 1,
          pnl: k < 4 ? 0.01 : -0.01,
          ts: t0 + rows.length * HOUR,
          features: { hourOfDay: hour },
        });
      }
    }
    const m = fitOutcomeModel(rows, 4);
    expect(m).not.toBe(null);
    // по-признаковый OOF-гейт выбросил бессигнальную сезонность целиком
    expect(m!.categoricals?.hourOfDay).toBeUndefined();
    // предикт с любым часом честно отдаёт prior-уровень, не выдуманную сезонность
    const p1 = predictOutcome(m!, { hourOfDay: "1" });
    const p4 = predictOutcome(m!, { hourOfDay: "4" });
    expect(p1.pWin).toBeCloseTo(p4.pWin, 6);
  });

  it("незнакомая категория на предикте → вклад 0, не краш", () => {
    const rows: OutcomeRow[] = Array.from({ length: 40 }, (_, i) => ({
      y: (i % 2) as 0 | 1,
      pnl: i % 2 ? 0.01 : -0.01,
      ts: t0 + i * HOUR,
      features: { hourOfDay: i % 2 === 0 ? "10" : "22" },
    }));
    const m = fitOutcomeModel(rows, 4);
    expect(m).not.toBe(null);
    const p = predictOutcome(m!, { hourOfDay: "3" }); // такого часа в обучении не было
    expect(p.pWin).toBeGreaterThanOrEqual(0);
    expect(p.pWin).toBeLessThanOrEqual(1);
  });

  it("старая модель без categoricals (legacy JSON) — предикт работает", () => {
    const legacy = {
      version: 1, prior: 0.55, features: {}, calibration: { breaks: [0], values: [0.55] },
      meanWin: 0.01, meanLoss: -0.008, n: 40, brier: 0.2, brierPrior: 0.2, informative: false,
    } as OutcomeModel; // categoricals отсутствует, как в сериализованных до апгрейда
    const p = predictOutcome(legacy, { hourOfDay: "10" });
    expect(p.pWin).toBeCloseTo(0.55, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Train: prequential channelWinRate, meta.marketSymbol, фон-запросы BTCUSDT.
// ─────────────────────────────────────────────────────────────────────────────
describe("вторая волна признаков в fit", () => {
  const priceAt = (t: number) =>
    100 * Math.exp(0.0004 * ((t - t0) / MIN) / 60 + 0.004 * Math.sin((t - t0) / MIN / 45));
  const gcRecording = (seen: Set<string>): GetCandles => async (symbol, _i, limit, sDate) => {
    seen.add(symbol);
    return Array.from({ length: limit ?? 0 }, (_, k) => {
      const t = (sDate ?? 0) + k * MIN;
      const o = priceAt(t);
      const c = priceAt(t + MIN);
      return {
        timestamp: t, open: o, close: c,
        high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998,
        volume: 1000 + (Math.floor(t / MIN) % 7) * 100,
      };
    });
  };
  const items: ParserItem[] = Array.from({ length: 24 }, (_, k) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + 3 * 24 * HOUR + k * 12 * HOUR,
  }));
  const opts = {
    folds: 3, mode: "single" as const, onProgress: silentProgress,
    selection: { nestedOuterFolds: 0 },
    grid: {
      windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
      trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
      stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
      squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
      cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
    },
  };

  it("fit: channelScore.winRate записан, meta.marketSymbol=BTCUSDT, фон реально запрошен", async () => {
    const seen = new Set<string>();
    const res = await train(items, gcRecording(seen), opts);
    expect(res.params.meta.totalSamples).toBeGreaterThan(0);
    const cs = res.params.channelScore!["ch"];
    expect(cs.winRate).toBeGreaterThan(0);
    expect(cs.winRate).toBeLessThan(1);
    expect(res.params.meta.marketSymbol).toBe("BTCUSDT");
    expect(seen.has("BTCUSDT")).toBe(true); // фон-фичи считались по бенчмарку
  }, 60_000);

  it("marketSymbol: null → фон выключен, лишних запросов нет", async () => {
    const seen = new Set<string>();
    const res = await train(items, gcRecording(seen), { ...opts, marketSymbol: null });
    expect(res.params.meta.totalSamples).toBeGreaterThan(0);
    expect(res.params.meta.marketSymbol).toBeUndefined();
    expect(seen.has("BTCUSDT")).toBe(false);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime: сезонность в pWin сигнала; фон-фетч только когда маржинал выучен.
// ─────────────────────────────────────────────────────────────────────────────
describe("вторая волна признаков в runtime", () => {
  const ex = (): ExitParams & Record<string, unknown> => ({
    trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 60, volBaselineWindow: 20, squeezePolicy: "none", cascadeWindowMinutes: 15,
  });
  const baseParams = (outcome: OutcomeModel | null, marketSymbol?: string): TrainedParams => ({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex(), matrix: ex() }, global: ex() },
    policy: { allow: ["enter"] },
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    outcome,
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
      ...(marketSymbol ? { marketSymbol } : {}),
    },
  } as unknown as TrainedParams);

  it("час суток двигает pWin сигнала (категориальный маржинал в проде)", () => {
    // калибровка-ступенька: raw ≤ 0 → 0.3, raw > 0 → 0.7
    const outcome: OutcomeModel = {
      version: 1, prior: 0.5, features: {},
      categoricals: { hourOfDay: { probs: { "9": 0.9, "22": 0.1 } } },
      calibration: { breaks: [0, 1e9], values: [0.3, 0.7] },
      meanWin: 0.02, meanLoss: -0.01, n: 60, brier: 0.15, brierPrior: 0.25, informative: true,
    };
    const model = PumpMatrix.load(baseParams(outcome));
    const at9 = model.plan([{ channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 }], {});
    const at22 = model.plan([{ channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 + 13 * HOUR }], {});
    expect(at9[0].probability!.pWin).toBeCloseTo(0.7, 6);
    expect(at22[0].probability!.pWin).toBeCloseTo(0.3, 6);
    // Келли согласован: выгодный час сайзится, невыгодный — нет
    expect(at9[0].probability!.recommendedRiskFrac).toBeGreaterThan(0);
    expect(at22[0].probability!.recommendedRiskFrac).toBe(0); // E[pnl] < 0
  });

  it("фон-фетч бенчмарка идёт ТОЛЬКО когда маржинал market выучен", async () => {
    const flat: GetCandles = async (symbol, _i, limit, sDate) => {
      seen.add(symbol);
      return Array.from({ length: limit ?? 0 }, (_, k) => ({
        timestamp: (sDate ?? 0) + k * MIN, open: 100, high: 100.1, low: 99.9, close: 100, volume: 500,
      }));
    };
    const seen = new Set<string>();
    const item: ParserItem = { channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 };

    // 1) модель БЕЗ market-маржинала → BTCUSDT не запрашивается (ноль лишнего IO)
    const noMarket = PumpMatrix.load(baseParams(null, "BTCUSDT"));
    await noMarket.plan([item], flat);
    expect(seen.has("BTCUSDT")).toBe(false);

    // 2) модель С market-маржиналом → бенчмарк тянется на getCandles-пути
    seen.clear();
    const outcome: OutcomeModel = {
      version: 1, prior: 0.5,
      features: { market: { direction: 1, fn: { breaks: [0], values: [0.6] } } },
      categoricals: {},
      calibration: { breaks: [0, 1e9], values: [0.4, 0.6] },
      meanWin: 0.02, meanLoss: -0.01, n: 60, brier: 0.15, brierPrior: 0.25, informative: true,
    };
    const withMarket = PumpMatrix.load(baseParams(outcome, "BTCUSDT"));
    const sigs = await withMarket.plan([item], flat);
    expect(seen.has("BTCUSDT")).toBe(true);
    expect(sigs.length).toBe(1);
    expect(sigs[0].probability).not.toBe(null);
  });
});
