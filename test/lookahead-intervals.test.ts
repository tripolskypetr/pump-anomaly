import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams } from "../src/index";
import { ICandleData, STEP_MS, entryStartTs } from "../src/candle";

const STEP = STEP_MS["1m"];
const MIN = 60_000;
const base = Date.UTC(2026, 0, 6, 12, 0, 0);

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

// для сигнала на sigTs: спокойное прошлое + (опц.) каскад вниз в будущем.
// planFor берёт вход = последняя свеча, поэтому "вход" = граница на/после sigTs.
const window = (sigTs: number, withFutureCascade: boolean): ICandleData[] => {
  const start = entryStartTs(sigTs, "1m");
  const cs: ICandleData[] = [];
  // прошлое (включая входную свечу = start) спокойное
  for (let k = 25; k >= 0; k--) cs.push({ timestamp: start - k * STEP, open: 100, high: 100.3, low: 99.7, close: 100, volume: 1000 });
  if (withFutureCascade) for (let k = 1; k <= 10; k++) cs.push({ timestamp: start + k * STEP, open: 100, high: 100.2, low: k <= 5 ? 96 : 99, close: k <= 5 ? 96.5 : 99.5, volume: 9000 });
  return cs;
};

for (const interval of [3, 5, 15]) {
  describe(`LOOK-AHEAD @ интервал ${interval} мин (planFor поштучно)`, () => {
    // 4 сигнала с этим интервалом
    const sigTimes = Array.from({ length: 4 }, (_, i) => base + i * interval * MIN);

    it(`live planFor: каждый из 4 сигналов входит (прошлое спокойно)`, () => {
      const m = PumpMatrix.load(mk("veto"));
      for (const ts of sigTimes) {
        // live окно: только прошлое (без будущего) — planFor вход = последняя свеча
        const r = m.planFor("SOLUSDT", "long", "yoda", window(ts, false));
        expect(r).not.toBe(null);
        expect(r!.action).toBe("enter");
        expect(r!.direction).toBe("long");
      }
    });

    it(`live planFor решает по прошлому: вход даже когда дальше будет каскад`, () => {
      const m = PumpMatrix.load(mk("veto"));
      for (const ts of sigTimes) {
        // live окно — только прошлое (спокойное). Будущий каскад существует, но live его не видит.
        const live = m.planFor("SOLUSDT", "long", "yoda", window(ts, false));
        expect(live).not.toBe(null);
        expect(live!.action).toBe("enter"); // вошёл по спокойному прошлому
      }
    });

    it(`backtest planForAt: тот же сигнал с forward-каскадом → VETO (видит будущее)`, () => {
      const m = PumpMatrix.load(mk("veto"));
      for (const ts of sigTimes) {
        const start = entryStartTs(ts, "1m");
        // backtest: вход на start, forward-свечи каскадные → veto
        const r = m.planForAt("SOLUSDT", "long", "yoda", window(ts, true), start);
        expect(r).toBe(null); // veto по будущему каскаду
      }
    });

    it(`РАСХОЖДЕНИЕ live(enter) vs backtest(veto) на каждом сигнале @ ${interval}мин`, () => {
      const m = PumpMatrix.load(mk("veto"));
      for (const ts of sigTimes) {
        const start = entryStartTs(ts, "1m");
        const live = m.planFor("SOLUSDT", "long", "yoda", window(ts, false));   // только прошлое
        const bt = m.planForAt("SOLUSDT", "long", "yoda", window(ts, true), start); // прошлое+будущее
        expect(live).not.toBe(null);   // live вошёл (будущее не видит)
        expect(bt).toBe(null);          // backtest заветил (видит каскад)
      }
    });

    it(`интервалы выровнены по минутам — entryStartTs не сдвигает (сигналы на границах)`, () => {
      for (const ts of sigTimes) {
        // base и кратные интервалам в минутах → ts уже на минутной границе
        expect(entryStartTs(ts, "1m")).toBe(ts);
      }
    });
  });
}

describe("LOOK-AHEAD: сигналы ВНУТРИ минуты на разных интервалах (3/5/15м + секунды)", () => {
  it("сигнал не на границе → entryStartTs сдвигает вперёд, вход после формирующейся свечи", () => {
    for (const interval of [3, 5, 15]) {
      // сигнал со сдвигом 37 секунд внутрь минуты
      const ts = base + interval * MIN + 37_000;
      const start = entryStartTs(ts, "1m");
      expect(start).toBeGreaterThan(ts);                 // сдвинут вперёд (пропуск формирующейся)
      expect(start % STEP).toBe(0);                       // на границе минуты
      expect(start - (ts - (ts % STEP))).toBe(STEP);      // ровно следующая минута
    }
  });
});
