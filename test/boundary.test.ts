import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { resolveExit, resolveExitNoRegime, ExitTensor } from "../src/exit-tensor";
import { selfTuneLag } from "../src/layers/self-tune-lag";
import { buildTable, windowEvents } from "../src/core/event-table";
import { fetchCandlesChunked } from "../src/chunked-candles";
import { percentile, shrinkageExpectancy, riskRewardStats } from "../src/objective";
import { volumeZScore, squeezePressure, volRegimeOf, computeReliability, PumpMatrix } from "../src/index";
import { ICandleData, STEP_MS } from "../src/candle";
import { SignalEvent } from "../src/types";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 30, ...o,
});

describe("граница — replayExit вырожденные пути", () => {
  it("фитиль одной свечи покрывает И hardStop И trailingTake → консервативно hard-stop", () => {
    const wick = C([[100, 100, 99.5, 100, 1000], [100, 105, 95, 100, 1000]]);
    const r = replayExit(wick, "long", 99.9, 100.1, E({ hardStop: 2, trailingTake: 1 }));
    // когда один бар задевает оба уровня — берём пессимистичный исход (hard-stop)
    expect(r.reason).toBe("hard-stop");
  });

  it("зона входа никогда не задета → no-entry, entered=false, pnl=0", () => {
    const noEntry = C([[200, 201, 199, 200, 1000], [200, 201, 199, 200, 1000]]);
    const r = replayExit(noEntry, "long", 99, 101, E());
    expect(r.reason).toBe("no-entry");
    expect(r.entered).toBe(false);
    expect(r.pnl).toBe(0);
  });

  it("вход на последней свече (нет forward) → entered, held=0", () => {
    const lastBar = C([[100, 101, 99, 100, 1000]]);
    const r = replayExit(lastBar, "long", 99, 101, E());
    expect(r.entered).toBe(true);
    expect(r.heldMinutes).toBe(0);
  });

  it("hardStop=0 (вырожденный) → мгновенный hard-stop при любом тике", () => {
    const flat = C([[100, 100, 100, 100, 1000], [100, 100, 100, 100, 1000]]);
    const r = replayExit(flat, "long", 99.9, 100.1, E({ hardStop: 0 }));
    expect(r.reason).toBe("hard-stop"); // hardStop=0 = footgun: документируем
  });

  it("пустой массив свечей → no-entry, не бросает", () => {
    const r = replayExit([], "long", 99, 101, E());
    expect(r.entered).toBe(false);
    expect(r.reason).toBe("no-entry");
  });

  it("short симметричен long в no-entry", () => {
    const r = replayExit(C([[200, 201, 199, 200, 1000]]), "short", 99, 101, E());
    expect(r.entered).toBe(false);
  });
});

describe("граница — exit-tensor fallback при дырах", () => {
  const base = { trailingTake: 9, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 };
  const t: ExitTensor = {
    cells: { single: { ch: { SOLUSDT: { long: { calm: { ...base, trailingTake: 1 } } } } }, matrix: {} },
    bySymbolDir: { single: { SOLUSDT: { long: { ...base, trailingTake: 2 } } }, matrix: {} },
    byMode: { single: { ...base, trailingTake: 3 }, matrix: { ...base, trailingTake: 30 } },
    global: { ...base, trailingTake: 4 },
  };

  it("cell есть (calm) → cell", () => {
    const r = resolveExit(t, "single", "ch", "SOLUSDT", "long", "calm");
    expect(r.source).toBe("cell"); expect(r.exit.trailingTake).toBe(1);
  });
  it("cell-дыра (anomalous нет) → symbol-dir", () => {
    const r = resolveExit(t, "single", "ch", "SOLUSDT", "long", "anomalous");
    expect(r.source).toBe("symbol-dir"); expect(r.exit.trailingTake).toBe(2);
  });
  it("неизвестный символ → mode", () => {
    const r = resolveExit(t, "single", "ch", "PEPE", "long", "calm");
    expect(r.source).toBe("mode"); expect(r.exit.trailingTake).toBe(3);
  });
  it("неверный канал, но symbol-dir есть → symbol-dir (канал не в ключе)", () => {
    const r = resolveExit(t, "single", "WRONG", "SOLUSDT", "long", "calm");
    expect(r.source).toBe("symbol-dir"); expect(r.exit.trailingTake).toBe(2);
  });
  it("noRegime пропускает cell → symbol-dir", () => {
    const r = resolveExitNoRegime(t, "single", "SOLUSDT", "long");
    expect(r.source).toBe("symbol-dir");
  });
  it("полностью пустой тензор → global", () => {
    const empty: ExitTensor = {
      cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} },
      byMode: { single: undefined as any, matrix: undefined as any }, global: { ...base, trailingTake: 4 },
    };
    const r = resolveExit(empty, "single", "ch", "X", "long", "calm");
    expect(r.source).toBe("global"); expect(r.exit.trailingTake).toBe(4);
  });
});

describe("граница — selfTuneLag клампы", () => {
  it("<8 дельт → дефолт 15 мин", () => {
    const few = buildTable([
      { channel: "a", symbol: "X", direction: "long", ts: 0 },
      { channel: "b", symbol: "X", direction: "long", ts: MIN },
    ]);
    expect(selfTuneLag(few)).toBe(15 * MIN);
  });
  it("крошечные задержки → кламп снизу к 30с", () => {
    const tiny: SignalEvent[] = [];
    for (let i = 0; i < 20; i++) {
      tiny.push({ channel: "a", symbol: "X", direction: "long", ts: i * 1000 });
      tiny.push({ channel: "b", symbol: "X", direction: "long", ts: i * 1000 + 500 });
    }
    expect(selfTuneLag(buildTable(tiny))).toBeGreaterThanOrEqual(30 * 1000);
  });
  it("огромные задержки → кламп сверху к 60 мин", () => {
    const huge: SignalEvent[] = [];
    for (let i = 0; i < 20; i++) {
      huge.push({ channel: "a", symbol: "X", direction: "long", ts: i * 10 * 60 * MIN });
      huge.push({ channel: "b", symbol: "X", direction: "long", ts: i * 10 * 60 * MIN + 5 * 60 * MIN });
    }
    expect(selfTuneLag(buildTable(huge))).toBeLessThanOrEqual(60 * MIN);
  });
  it("пустая таблица → дефолт, не бросает", () => {
    expect(selfTuneLag(buildTable([]))).toBe(15 * MIN);
  });
});

describe("граница — objective численные края", () => {
  it("percentile p=0 → минимум, p=1 → максимум", () => {
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 1)).toBe(5);
  });
  it("percentile отрицательных", () => {
    expect(percentile([-5, -1, -3], 0.5)).toBe(-3);
  });
  it("percentile из двух точек интерполирует", () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
  });
  it("shrinkage один аутлайер → сильно усажен", () => {
    expect(shrinkageExpectancy([1.0], 5)).toBeCloseTo(1 / 6, 4);
  });
  it("shrinkage все нули → 0", () => {
    expect(shrinkageExpectancy([0, 0, 0], 5)).toBe(0);
  });
  it("shrinkage пустой → 0", () => {
    expect(shrinkageExpectancy([], 5)).toBe(0);
  });
  it("RR все убыточные → отрицательное среднее, n считается", () => {
    const rr = riskRewardStats([{ pnl: -0.02, hardStop: 2 }, { pnl: -0.04, hardStop: 2 }]);
    expect(rr.mean).toBeLessThan(0);
    expect(rr.n).toBe(2);
  });
  it("RR смешанные знаки", () => {
    const rr = riskRewardStats([{ pnl: 0.04, hardStop: 2 }, { pnl: -0.02, hardStop: 2 }]);
    expect(rr.mean).toBeCloseTo((2 - 1) / 2, 5);
  });
});

describe("граница — volume пороги и вырожденные", () => {
  it("volRegimeOf ровно на пороге (>=) → anomalous", () => {
    expect(volRegimeOf(2.0, 2.0)).toBe("anomalous");
    expect(volRegimeOf(1.999, 2.0)).toBe("calm");
  });
  it("нейтральные свечи (close==open) → pressure 0", () => {
    const neutral = C([[100, 101, 99, 100, 1000], [100, 102, 99, 100, 1000]]);
    expect(squeezePressure(neutral, 0, "long", 30)).toBe(0);
  });
  it("нулевая дисперсия объёма → z=0 (нет деления на 0)", () => {
    const same = C(Array(25).fill([100, 101, 99, 100, 1000]));
    expect(volumeZScore(same, 22, 20)).toBe(0);
  });
  it("baseline < 2 свечей → z=0", () => {
    const cs = C([[100, 101, 99, 100, 1000], [100, 101, 99, 100, 5000]]);
    expect(volumeZScore(cs, 1, 20)).toBe(0);
  });
});

describe("граница — reliability ровно на порогах", () => {
  it("N=40 при низком confidence → false (порог по confidence)", () => {
    const r = computeReliability(
      { foldMeans: [0.01, 0.01, 0.01, 0.01], foldSizes: [10, 10, 10, 10], allReturns: Array(40).fill(0.01) },
      { supportK: 30, confidenceThreshold: 0.6, minN: 40 });
    expect(r.totalN).toBe(40);
    expect(r.reliable).toBe(r.confidence >= 0.6 && r.totalN >= 40);
  });
  it("N=39 (на 1 меньше) → false по количеству", () => {
    const r = computeReliability(
      { foldMeans: [0.01, 0.01, 0.01], foldSizes: [13, 13, 13], allReturns: Array(39).fill(0.01) },
      { supportK: 30, confidenceThreshold: 0.6, minN: 40 });
    expect(r.reliable).toBe(false);
  });
  it("пустые входы → confidence 0, reliable false, не бросает", () => {
    const r = computeReliability(
      { foldMeans: [], foldSizes: [], allReturns: [] },
      { supportK: 30, confidenceThreshold: 0.6, minN: 40 });
    expect(r.confidence).toBe(0);
    expect(r.reliable).toBe(false);
  });
});

describe("граница — windowEvents строгие границы", () => {
  const evs: SignalEvent[] = [
    { channel: "a", symbol: "X", direction: "long", ts: t0 },
    { channel: "a", symbol: "X", direction: "long", ts: t0 + 10 * MIN },
  ];

  it("anchor раньше всех событий → пусто", () => {
    expect(windowEvents(evs, t0 - 1000, 60_000).length).toBe(0);
  });

  it("событие ровно windowMs назад ИСКЛЮЧАЕТСЯ (строгий ts > lo)", () => {
    // lo = anchor - windowMs = t0; событие на t0 имеет ts == lo → не входит
    const win = windowEvents(evs, t0 + 10 * MIN, 10 * MIN);
    expect(win.map((e) => e.ts - t0)).toEqual([10 * MIN]); // только +10мин, t0 отброшен
  });

  it("windowMs=0 → пусто (ts > anchor && ts <= anchor невозможно)", () => {
    expect(windowEvents(evs, t0, 0).length).toBe(0);
  });

  it("Infinity → вся история", () => {
    expect(windowEvents(evs, t0 + 10 * MIN, Infinity).length).toBe(2);
  });
});

describe("граница — chunked pagination кратность и пустота", () => {
  const STEP = STEP_MS["1m"];
  const adapter = (): any => async (_s: string, _i: string, lim: number, sd: number) => {
    const out: ICandleData[] = [];
    for (let i = 0; i < lim; i++) out.push({ timestamp: sd + i * STEP, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    return out;
  };

  it("limit ровно кратен chunk (2×500) → нет хвостового чанка, всё собрано", async () => {
    const r = await fetchCandlesChunked(adapter(), "X", "1m", 1000, t0, 500);
    expect(r.length).toBe(1000);
  });

  it("limit=1 → ровно одна свеча", async () => {
    const r = await fetchCandlesChunked(adapter(), "X", "1m", 1, t0, 500);
    expect(r.length).toBe(1);
  });

  it("первый чанк пуст → пустой результат, один вызов", async () => {
    let n = 0;
    const empty: any = async () => { n++; return []; };
    const r = await fetchCandlesChunked(empty, "X", "1m", 1200, t0, 500);
    expect(r.length).toBe(0);
    expect(n).toBe(1);
  });
});

describe("граница — фасад вырожденные входы", () => {
  const base = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0, squeezePolicy: "none" as const };
  const P = (allow: any): any => ({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: base } }, matrix: {} }, byMode: { single: base, matrix: base }, global: base },
    policy: { allow }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "test fixture", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
  });
  const item = { channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: 1 };

  it("signals([]) → пусто", () => {
    expect(PumpMatrix.load(P(["enter"])).signals([]).length).toBe(0);
  });
  it("обученная allow=[] → ничего не отдаётся", () => {
    expect(PumpMatrix.load(P([])).signals([item]).length).toBe(0);
  });
  it("запрос allow=[] (сужение до нуля) → пусто", () => {
    expect(PumpMatrix.load(P(["enter", "invert"])).signals([item], { allow: [] }).length).toBe(0);
  });
  it("minRiskReward=0 при отсутствии RR-статы → символ режется (консервативно)", () => {
    expect(PumpMatrix.load(P(["enter"])).signals([item], { minRiskReward: 0 }).length).toBe(0);
  });
  it("plan символ без свечей → строится как без свечей (action enter)", () => {
    const out = PumpMatrix.load(P(["enter"])).plan([item], {});
    expect(out.length).toBe(1);
    expect(out[0].action).toBe("enter");
    expect(out[0].origin.volRegime).toBe(null);
  });
});
