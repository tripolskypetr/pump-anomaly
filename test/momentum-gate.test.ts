import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams, ParserItem } from "../src/index";
import { intersectPolicy } from "../src/signal";
import { momentumPct } from "../src/volume";
import { ICandleData, GetCandles } from "../src/candle";
import { ExitParams } from "../src/replay";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

// ЭДЖ ИЗ habr 1041898: сырые посты ≈ нулевая сумма после комиссий; фильтр
// «цена уже двигалась не против сигнала за 24ч ДО поста» поднял winrate 68→100%.
// Здесь этот фильтр — policy.minMomentum24hPct: детерминированные сценарии
// «рос до поста» / «падал до поста», без look-ahead.

const ex = (): ExitParams & Record<string, unknown> => ({
  trailingTake: 50, hardStop: 50, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
  staleMinutes: 30, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20,
  squeezePolicy: "none", cascadeWindowMinutes: 15,
});
const model = (policy: object): PumpMatrix => PumpMatrix.load({
  version: 3,
  config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
  exit: {
    cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} },
    byMode: { single: ex(), matrix: ex() }, global: ex(),
  },
  policy: policy as TrainedParams["policy"],
  riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
  pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
  meta: {
    trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
    gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 30,
    confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
  },
} as TrainedParams);

/** 60 свечей до сигнала с суммарным движением drift%, затем сигнал */
const preTape = (driftPct: number): ICandleData[] => {
  const out: ICandleData[] = [];
  const n = 60;
  for (let i = 0; i < n; i++) {
    const p0 = 100 * (1 + (driftPct / 100) * (i / n));
    const p1 = 100 * (1 + (driftPct / 100) * ((i + 1) / n));
    out.push({
      timestamp: t0 + i * MIN, open: p0, close: p1,
      high: Math.max(p0, p1) * 1.0005, low: Math.min(p0, p1) * 0.9995,
      volume: 1000 + (i % 5) * 100,
    });
  }
  return out;
};
const sigTs = t0 + 60 * MIN;
const item = (direction: "long" | "short"): ParserItem =>
  ({ channel: "ch", symbol: "SOLUSDT", direction, ts: sigTs });
// окно 60м в тестах (в проде дефолт 1440 = 24ч)
const gate = { minMomentum24hPct: -1, momentumWindowMinutes: 60 };

describe("momentumPct — направленное движение строго до сигнала", () => {
  it("считает движение окна и не смотрит вперёд", () => {
    const cs = preTape(3);
    expect(momentumPct(cs, cs.length, 60)!).toBeCloseTo(3, 0);
    expect(momentumPct(cs, 30, 30)!).toBeGreaterThan(0); // полокна — рост первой половины
  });
  it("мало данных → null (не ложный 0)", () => {
    expect(momentumPct(preTape(3), 1, 60)).toBe(null);
    expect(momentumPct([], 0, 60)).toBe(null);
  });
});

describe("momentum-гейт — фильтр «не против движения до поста»", () => {
  it("long после роста +3% → проходит; long после падения −3% → срезан (нож)", () => {
    const m = model({ allow: ["enter"], ...gate });
    expect(m.plan([item("long")], { SOLUSDT: preTape(3) }).length).toBe(1);
    expect(m.plan([item("long")], { SOLUSDT: preTape(-3) }).length).toBe(0);
  });

  it("симметрия short: падение −3% → проходит; рост +3% → срезан (ракета)", () => {
    const m = model({ allow: ["enter"], ...gate });
    expect(m.plan([item("short")], { SOLUSDT: preTape(-3) }).length).toBe(1);
    expect(m.plan([item("short")], { SOLUSDT: preTape(3) }).length).toBe(0);
  });

  it("порог −1 из статьи: слабое движение против (−0.5%) допускается", () => {
    const m = model({ allow: ["enter"], ...gate });
    expect(m.plan([item("long")], { SOLUSDT: preTape(-0.5) }).length).toBe(1);
  });

  it("нет свечей → подтвердить нечем → срезан консервативно", () => {
    const m = model({ allow: ["enter"], ...gate });
    expect(m.signals([item("long")]).length).toBe(0);
    expect(m.plan([item("long")], {}).length).toBe(0);
  });

  it("без гейта поведение прежнее (обратная совместимость)", () => {
    const m = model({ allow: ["enter"] });
    expect(m.plan([item("long")], { SOLUSDT: preTape(-3) }).length).toBe(1);
    expect(m.signals([item("long")]).length).toBe(1);
  });

  it("tighten-only: запрос ужесточает порог, ослабить вшитый нельзя", () => {
    expect(intersectPolicy({ allow: ["enter"], minMomentum24hPct: -1 }, { minMomentum24hPct: -5 }).minMomentum24hPct).toBe(-1);
    expect(intersectPolicy({ allow: ["enter"], minMomentum24hPct: -1 }, { minMomentum24hPct: 0.5 }).minMomentum24hPct).toBe(0.5);
    expect(intersectPolicy({ allow: ["enter"] }, { minMomentum24hPct: -1 }).minMomentum24hPct).toBe(-1);
    expect(intersectPolicy({ allow: ["enter"] }, {}).minMomentum24hPct).toBeUndefined();
  });

  it("policy getter отдаёт momentum-поля (полный аудит)", () => {
    const m = model({ allow: ["enter"], ...gate });
    expect(m.policy.minMomentum24hPct).toBe(-1);
    expect(m.policy.momentumWindowMinutes).toBe(60);
  });

  it("backtest(getCandles) с гейтом: тянет пре-окно, но replay стартует ОТ сигнала", async () => {
    const pre = preTape(3); // рост до сигнала → цена у сигнала ~103
    const requests: Array<{ sDate: number; limit: number }> = [];
    const gc: GetCandles = async (_s, _i, limit, sDate) => {
      requests.push({ sDate: sDate!, limit: limit! });
      const out: ICandleData[] = [];
      for (let i = 0; i < (limit ?? 0); i++) {
        const t = (sDate ?? 0) + i * MIN;
        const fromPre = pre.find((c) => c.timestamp === t);
        if (fromPre) { out.push(fromPre); continue; }
        if (t >= sigTs) {
          const p = 103; // флэт после сигнала
          out.push({ timestamp: t, open: p, high: p + 0.05, low: p - 0.05, close: p, volume: 1000 });
        }
      }
      return out;
    };
    const m = model({ allow: ["enter"], ...gate });
    const sigs = await m.backtest([item("long")], gc);
    expect(sigs.length).toBe(1);
    // запрошено пре-окно (sDate раньше сигнальной минуты)
    expect(requests[0].sDate).toBeLessThan(sigTs);
    // но вход — по цене НА сигнале (~103), а не по предыстории (~100)
    expect(sigs[0].result.entered).toBe(true);
    expect(sigs[0].result.entryPrice).toBeGreaterThan(102.5);
  });
});
