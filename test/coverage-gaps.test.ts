import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams } from "../src/index";
import { resolveExitNoRegime, ExitTensor } from "../src/exit-tensor";
import { volumeFeatures } from "../src/volume";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

const base = {
  hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
  volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 2.0, tightenFactor: 0.5,
};

function modelWith(longCellPolicy: "none" | "tighten" | "invert", opts: { allow?: any } = {}): PumpMatrix {
  const params: TrainedParams = {
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: {
      cells: { single: { ch: { SOLUSDT: {
        long: { anomalous: { ...base, squeezePolicy: longCellPolicy }, calm: { ...base, squeezePolicy: "none" } },
        short: { anomalous: { ...base, trailingTake: 0.7, squeezePolicy: "none" }, calm: { ...base, trailingTake: 0.7, squeezePolicy: "none" } },
      } } }, matrix: {} },
      bySymbolDir: { single: { SOLUSDT: { long: { ...base, squeezePolicy: "none" }, short: { ...base, trailingTake: 0.7, squeezePolicy: "none" } } }, matrix: {} },
      byMode: { single: base, matrix: base }, global: base,
    },
    policy: { allow: opts.allow ?? ["enter", "invert", "tighten"] },
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "test fixture", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
  };
  return PumpMatrix.load(params);
}

// каскад против long: объёмный обвал вниз
const longTrap = () => {
  const rows: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
  rows.push([100, 100.6, 99.9, 100.4, 9000]);
  rows.push([100.4, 100.5, 98, 98.2, 9000]);
  rows.push([98.2, 98.3, 96, 96.4, 9000]);
  return C(rows);
};

describe("coverage — exit-tensor resolveExitNoRegime fallback", () => {
  const baseEx = { trailingTake: 9, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240 };
  it("symbol-dir отсутствует → mode", () => {
    const t: ExitTensor = { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: { ...baseEx, trailingTake: 3 }, matrix: baseEx }, global: { ...baseEx, trailingTake: 4 } };
    const r = resolveExitNoRegime(t, "single", "X", "long");
    expect(r.source).toBe("mode");
    expect(r.exit.trailingTake).toBe(3);
  });
  it("symbol-dir и mode отсутствуют → global", () => {
    const t: ExitTensor = { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: undefined as any, matrix: undefined as any }, global: { ...baseEx, trailingTake: 4 } };
    const r = resolveExitNoRegime(t, "single", "X", "long");
    expect(r.source).toBe("global");
    expect(r.exit.trailingTake).toBe(4);
  });
});

describe("coverage — volume volumeFeatures (комбинированный хелпер)", () => {
  it("возвращает оба признака разом", () => {
    const cs: ICandleData[] = [];
    for (let i = 0; i < 25; i++) cs.push({ timestamp: i * MIN, open: 100, high: 101, low: 99, close: 100, volume: 1000 + (i === 22 ? 5000 : 0) });
    const f = volumeFeatures(cs, 22, "long", 20, 10);
    expect(f).toHaveProperty("volZ");
    expect(f).toHaveProperty("squeezePressure");
    expect(typeof f.volZ).toBe("number");
    expect(typeof f.squeezePressure).toBe("number");
  });
  it("аномальный объём входа vs базлайн → volZ > 0", () => {
    const cs: ICandleData[] = [];
    // базлайн с разбросом (std>0), вход — резкий всплеск
    for (let i = 0; i < 25; i++) cs.push({ timestamp: i * MIN, open: 100, high: 101, low: 99, close: 100, volume: 1000 + (i % 5) * 100 });
    cs[22] = { ...cs[22], volume: 9000 }; // вход на 22 — аномалия
    const f = volumeFeatures(cs, 22, "long", 20, 5);
    expect(f.volZ).toBeGreaterThan(0);
  });
});

describe("coverage — фасад геттеры и методы", () => {
  const m = modelWith("none");
  it("confidence геттер", () => {
    expect(m.confidence).toBe(0.7);
  });
  it("explain возвращает полный отчёт", () => {
    const r = m.explain([{ channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 }]);
    expect(r).toHaveProperty("signals");
    expect(r).toHaveProperty("usedMode");
  });
});

describe("coverage — planFor (live: вход = последняя свеча)", () => {
  const m = modelWith("none");
  it("planFor выводит entryTs из последней свечи", () => {
    const cs = C([[100, 101, 99, 100, 1000], [100, 101, 99, 100, 1000], [100, 101, 99, 100, 1000]]);
    const s = m.planFor("SOLUSDT", "long", "ch", cs);
    expect(s).not.toBe(null);
    expect(s!.ts).toBe(cs[cs.length - 1].timestamp); // вход на последней свече
  });
  it("planFor пустые свечи → entryTs=0, не падает", () => {
    const s = m.planFor("SOLUSDT", "long", "ch", []);
    // без свечей volRegime null, action enter
    expect(s).not.toBe(null);
    expect(s!.action).toBe("enter");
  });
});

describe("coverage — facade tighten путь", () => {
  it("каскад + policy=tighten → action tighten, trailing ужат", () => {
    const m = modelWith("tighten");
    const s = m.planForAt("SOLUSDT", "long", "ch", longTrap(), longTrap()[20].timestamp);
    expect(s).not.toBe(null);
    expect(s!.action).toBe("tighten");
    expect(s!.exit.trailingTake).toBe(1.0); // base 2.0 × tightenFactor 0.5
  });
  it("tighten запрещён политикой → сигнал не отдаётся", () => {
    const m = modelWith("tighten", { allow: ["enter", "invert"] });
    const s = m.planForAt("SOLUSDT", "long", "ch", longTrap(), longTrap()[20].timestamp);
    expect(s).toBe(null);
  });
  it("invert без свечей (resolveNoRegime в инверс-ветке) — не падает", () => {
    // invert требует свечей для каскада; без свечей каскад не сработает → enter
    const m = modelWith("invert");
    const s = m.signals([{ channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 }]);
    expect(Array.isArray(s)).toBe(true);
  });
});

describe("coverage — branch: ?? дефолты exit-полей", () => {
  // exit БЕЗ volBaselineWindow / squeezeThreshold / tightenFactor → берутся ?? дефолты
  const bareExit = {
    hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
    trailingTake: 2.0, volZThreshold: 2.0, squeezePolicy: "tighten" as const,
  };
  function bareModel(): PumpMatrix {
    const params: TrainedParams = {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: {
        cells: { single: { ch: { SOLUSDT: { long: { anomalous: bareExit, calm: bareExit } } } }, matrix: {} },
        bySymbolDir: { single: { SOLUSDT: { long: bareExit } }, matrix: {} },
        byMode: { single: bareExit, matrix: bareExit }, global: bareExit,
      },
      policy: { allow: ["enter", "invert", "tighten"] },
      riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "test fixture", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
    };
    return PumpMatrix.load(params);
  }

  it("exit без volBaselineWindow/squeezeThreshold/tightenFactor → ?? дефолты, tighten работает", () => {
    const m = bareModel();
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 100.6, 99.9, 100.4, 9000]); rows.push([100.4, 100.5, 98, 98.2, 9000]); rows.push([98.2, 98.3, 96, 96.4, 9000]);
    const s = m.planForAt("SOLUSDT", "long", "ch", C(rows), C(rows)[20].timestamp);
    expect(s).not.toBe(null);
    expect(s!.action).toBe("tighten");
    expect(s!.exit.trailingTake).toBe(1.0); // 2.0 × tightenFactor-default(0.5)
  });

  it("entryIdx<0 (ts позже всех свечей) → fallback на последнюю свечу, не падает", () => {
    const m = bareModel();
    const past = C([[100, 101, 99, 100, 1000], [100, 101, 99, 100, 1000]]);
    const s = m.planForAt("SOLUSDT", "long", "ch", past, t0 + 999 * MIN); // ts далеко после
    expect(s).not.toBe(null); // не бросает, entryIdx схлопывается к length-1
  });
});

describe("coverage — branch: RR-фильтр без rrMetric + exit без volZThreshold", () => {
  function rrModel(withVolZThr: boolean): PumpMatrix {
    const ex: any = {
      hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
      trailingTake: 1.0, squeezePolicy: "none", volBaselineWindow: 20, squeezeThreshold: 0.6,
    };
    if (withVolZThr) ex.volZThreshold = 2.0; // иначе ?? 2.0 дефолт
    const params: TrainedParams = {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: ex } }, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
      policy: { allow: ["enter", "invert", "tighten"] },
      riskReward: { bySymbol: { SOLUSDT: { mean: 2.5, p95: 5, p99: 7, n: 40 } }, global: { mean: 2.5, p95: 5, p99: 7, n: 40 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "test fixture", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 40 },
    };
    return PumpMatrix.load(params);
  }
  const item = { channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 };

  it("minRiskReward без rrMetric → дефолт 'mean' (?? branch)", () => {
    const m = rrModel(true);
    // mean=2.5 ≥ порог 1.0 → проходит, метрика по умолчанию mean
    const out = m.signals([item], { minRiskReward: 1.0 });
    expect(out.length).toBe(1);
    // тот же фильтр выше mean → режется
    expect(m.signals([item], { minRiskReward: 3.0 }).length).toBe(0);
  });

  it("exit без volZThreshold + свечи → ?? 2.0 дефолт, volRegime считается", () => {
    const m = rrModel(false);
    const cs = C([[100, 101, 99, 100, 1000], [100, 101, 99, 100, 1000], [100, 101, 99, 100, 5000]]);
    const out = m.plan([item], { SOLUSDT: cs });
    expect(out.length).toBe(1);
    expect(out[0].origin.volRegime).not.toBe(null); // режим посчитан с дефолтным порогом
  });
});

describe("coverage — branch: rrMetric задан явно (другая ветка ??)", () => {
  function m(): PumpMatrix {
    const ex: any = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, trailingTake: 1.0, squeezePolicy: "none", volBaselineWindow: 20, squeezeThreshold: 0.6, volZThreshold: 2.0 };
    const params: TrainedParams = {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: ex } }, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
      policy: { allow: ["enter", "invert", "tighten"] },
      riskReward: { bySymbol: { SOLUSDT: { mean: 2.5, p95: 5, p99: 7, n: 40 } }, global: { mean: 2.5, p95: 5, p99: 7, n: 40 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "test fixture", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 40 },
    };
    return PumpMatrix.load(params);
  }
  const item = { channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 };

  it("rrMetric='p99' явно → сравнение по p99, не mean", () => {
    // p99=7: порог 6 проходит, порог 8 режет (по mean=2.5 оба бы резали)
    expect(m().signals([item], { minRiskReward: 6, rrMetric: "p99" }).length).toBe(1);
    expect(m().signals([item], { minRiskReward: 8, rrMetric: "p99" }).length).toBe(0);
  });
  it("rrMetric='p95' явно", () => {
    expect(m().signals([item], { minRiskReward: 4, rrMetric: "p95" }).length).toBe(1); // p95=5
  });
});
