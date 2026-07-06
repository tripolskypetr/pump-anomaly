import { describe, it, expect } from "vitest";
import { calibrateGrid, train } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

/**
 * Мир с ИЗВЕСТНЫМ спредом: истинная цена 100 флэт, сделки прыгают bid/ask —
 * каждая свеча несёт диапазон ≈ спред (плюс лёгкий дрейф, чтобы train жил).
 */
const bounceGc = (spreadPct: number): GetCandles => async (_s, _i, limit, sDate) => {
  const out: ICandleData[] = [];
  const s = spreadPct / 100;
  for (let i = 0; i < (limit ?? 0); i++) {
    const t = (sDate ?? 0) + i * MIN;
    const idx = Math.floor(t / MIN);
    const base = 100 * (1 + 0.00001 * ((t - t0) / MIN)); // лёгкий дрейф
    const bid = base;
    const ask = base * (1 + s);
    const open = idx % 2 === 0 ? bid : ask;
    const close = idx % 2 === 0 ? ask : bid;
    out.push({
      timestamp: t, open, close,
      high: Math.max(open, close), low: Math.min(open, close),
      volume: 1000 + (idx % 5) * 50,
    });
  }
  return out;
};
const items = (n = 4): ParserItem[] =>
  Array.from({ length: n }, (_, k) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + 24 * HOUR + k * 12 * HOUR,
  }));

describe("спред из данных — эстиматор Корвина-Шульца в калибровке", () => {
  it("заложенный спред 0.2% восстанавливается по порядку величины", async () => {
    const c = await calibrateGrid(items(), bounceGc(0.2), {
      staleMinutes: [60, 240], stalenessSinceMinutes: [60],
    });
    expect(c.spreadPct).not.toBe(null);
    expect(c.spreadPct!).toBeGreaterThan(0.2 / 3);
    expect(c.spreadPct!).toBeLessThan(0.2 * 3);
    expect(c.reason).toContain("Корвин-Шульц");
  });

  it("узкий спред < широкого (монотонность оценки)", async () => {
    const narrow = await calibrateGrid(items(), bounceGc(0.05), { staleMinutes: [60], stalenessSinceMinutes: [60] });
    const wide = await calibrateGrid(items(), bounceGc(0.4), { staleMinutes: [60], stalenessSinceMinutes: [60] });
    expect(wide.spreadPct!).toBeGreaterThan(narrow.spreadPct!);
  });
});

describe("roundTripCostPct — авто вместо магического нуля", () => {
  it("casual (без грида и без числа): издержки = 2×тейкер + измеренный спред", async () => {
    const res = await train(items(3), bounceGc(0.2), {
      folds: 3, mode: "single", onProgress: silentProgress,
      selection: { nestedOuterFolds: 0 }, refineRounds: 0,
    });
    const cal = res.params.meta.calibration!;
    const expected = +(2 * 0.05 + cal.spreadPct!).toFixed(4);
    expect(res.params.exit.global.roundTripCostPct).toBe(expected);
    expect(res.params.exit.global.roundTripCostPct!).toBeGreaterThan(0.1); // не «идеальное исполнение»
  }, 30_000);

  it("takerFeePct — табличный тариф аккаунта — учитывается в авто-формуле", async () => {
    const res = await train(items(3), bounceGc(0.2), {
      folds: 3, mode: "single", onProgress: silentProgress, takerFeePct: 0.1,
      selection: { nestedOuterFolds: 0 }, refineRounds: 0,
    });
    const cal = res.params.meta.calibration!;
    expect(res.params.exit.global.roundTripCostPct).toBe(+(2 * 0.1 + cal.spreadPct!).toFixed(4));
  }, 30_000);

  it("явный roundTripCostPct всегда главнее авто", async () => {
    const res = await train(items(3), bounceGc(0.2), {
      folds: 3, mode: "single", onProgress: silentProgress, roundTripCostPct: 0.33,
      selection: { nestedOuterFolds: 0 }, refineRounds: 0,
    });
    expect(res.params.exit.global.roundTripCostPct).toBe(0.33);
  }, 30_000);

  it("явный grid без autoCalibrate → калибровки нет → старое поведение (0)", async () => {
    const res = await train(items(3), bounceGc(0.2), {
      folds: 3, mode: "single", onProgress: silentProgress,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [1], hardStop: [2], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [60], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    expect(res.params.exit.global.roundTripCostPct).toBe(0);
  });
});
