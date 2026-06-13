import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams } from "../src/index";
import { GetCandles, ICandleData, STEP_MS, entryStartTs } from "../src/candle";
import { ParserItem } from "../src/types";

const STEP = STEP_MS["1m"];
const sig = Date.UTC(2026, 0, 6, 12, 0, 0);
const start = entryStartTs(sig, "1m");

const mk = (pol: string): TrainedParams => {
  const ex = { hardStop: 3, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 10, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 50.0, squeezePolicy: pol as any, cascadeWindowMinutes: 5 };
  return {
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: { ch: { SOLUSDT: { long: { anomalous: ex, calm: ex }, short: { anomalous: ex, calm: ex } } } }, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: ex, short: ex } }, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
    policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 10, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
  } as TrainedParams;
};
const item: ParserItem = { channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: sig, entryFromPrice: 99, entryToPrice: 101 };

// прошлое ИДЕАЛЬНО спокойное: ни каскада, ни аномалии объёма
const calmPast = (): ICandleData[] => {
  const o: ICandleData[] = [];
  for (let k = 30; k >= 1; k--) o.push({ timestamp: start - k * STEP, open: 100, high: 100.3, low: 99.7, close: 100, volume: 1000 });
  return o;
};
// будущее: резкий каскад ВНИЗ против long (узнать можно ТОЛЬКО подсмотрев свечи после входа)
const crashFuture = (): ICandleData[] => {
  const o: ICandleData[] = [];
  for (let k = 0; k < 10; k++) o.push({ timestamp: start + k * STEP, open: 100, high: 100.2, low: k < 5 ? 96 : 99, close: k < 5 ? 96.5 : 99.5, volume: 9000 });
  return o;
};

describe("LOOK-AHEAD: будущий каскад, прошлое спокойное — угадать можно ТОЛЬКО подсмотрев будущее", () => {
  it("live plan: прошлое спокойно → ВХОДИТ (каскад в будущем не виден) — честно", () => {
    const r = PumpMatrix.load(mk("veto")).plan([item], { SOLUSDT: calmPast() });
    expect(r.length).toBe(1);
    expect(r[0].action).toBe("enter");
    expect(r[0].direction).toBe("long"); // не инвертирован, не veto
  });

  it("backtest на тех же данных + будущее: forward-каскад → VETO (видит будущее)", () => {
    const r = PumpMatrix.load(mk("veto")).backtest([item], { SOLUSDT: [...calmPast(), ...crashFuture()] });
    expect(r.length).toBe(0); // veto по будущему каскаду
  });

  it("РЕШАЮЩИЙ: live и backtest дают РАЗНЫЙ исход на одних данных → live НЕ подсматривает", () => {
    const live = PumpMatrix.load(mk("veto")).plan([item], { SOLUSDT: calmPast() });
    const bt = PumpMatrix.load(mk("veto")).backtest([item], { SOLUSDT: [...calmPast(), ...crashFuture()] });
    expect(live.length).toBe(1);  // live вошёл
    expect(bt.length).toBe(0);    // backtest заветил
    expect(live.length).not.toBe(bt.length); // расхождение = доказательство
  });
});

describe("LOOK-AHEAD: подмена будущего НЕ меняет live-решение (будущее не используется)", () => {
  // getCandles, который ЗЛОНАМЕРЕННО отдаёт и будущее тоже — live не должен его трогать
  const withFuture = (futureShape: (k: number, ts: number) => Partial<ICandleData>): GetCandles =>
    async (s, i, lim, sd) => {
      const o: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) {
        const ts = sd! + k * STEP;
        const base = { timestamp: ts, open: 100, high: 100.3, low: 99.7, close: 100, volume: 1000 };
        o.push(ts >= start ? { ...base, ...futureShape(k, ts) } : base);
      }
      return o;
    };
  const crash = withFuture(() => ({ low: 96, close: 96.5, volume: 9000 }));   // крах вниз
  const pump = withFuture(() => ({ high: 106, close: 105, volume: 9000 }));   // памп вверх

  it("live с 'крахом в будущем' и с 'пампом в будущем' → ИДЕНТИЧНЫЕ решения", async () => {
    const a = await PumpMatrix.load(mk("veto")).plan([item], crash);
    const b = await PumpMatrix.load(mk("veto")).plan([item], pump);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // будущее не повлияло
  });

  it("оба решения = enter long (по спокойному прошлому), независимо от будущего", async () => {
    for (const gc of [crash, pump]) {
      const r = await PumpMatrix.load(mk("veto")).plan([item], gc);
      expect(r.length).toBe(1);
      expect(r[0].action).toBe("enter");
      expect(r[0].direction).toBe("long");
    }
  });

  it("backtest на тех же getCandles РАЗЛИЧАЕТ крах и памп (видит будущее, как и должен)", async () => {
    const aCrash = await PumpMatrix.load(mk("veto")).backtest([item], crash);
    const aPump = await PumpMatrix.load(mk("veto")).backtest([item], pump);
    // крах → veto (0), памп → вход (1): backtest РАЗЛИЧАЕТ будущее
    expect(aCrash.length).toBe(0);
    expect(aPump.length).toBe(1);
  });
});

describe("LOOK-AHEAD: live никогда не запрашивает свечу с ts >= entryStart", () => {
  it("все запрошенные ts строго ДО входной минуты", async () => {
    const seen: number[] = [];
    const gc: GetCandles = async (s, i, lim, sd) => {
      const o: ICandleData[] = [];
      for (let k = 0; k < (lim ?? 0); k++) { const ts = sd! + k * STEP; seen.push(ts); o.push({ timestamp: ts, open: 100, high: 100.3, low: 99.7, close: 100, volume: 1000 }); }
      return o;
    };
    await PumpMatrix.load(mk("none")).plan([item], gc);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ts) => ts < start)).toBe(true); // НИ ОДНОЙ свечи на/после входа
    expect(Math.max(...seen)).toBeLessThan(start);
  });
});
