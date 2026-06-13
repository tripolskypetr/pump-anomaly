import { describe, it, expect } from "vitest";
import {
  normalCdf, normalInv, sharpe, deflatedSharpe, minTrackRecordLength, variance, skewness, kurtosis,
  expectedMaxSharpe, probabilityOfBacktestOverfitting, realityCheckPValue,
  stationaryBootstrapResample, mulberry32, mean, certifyStrategy,
} from "../src/statistics";
import { squeezePressureBefore, volumeZScore } from "../src/volume";
import { ICandleData } from "../src/candle";

const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: i * 60000, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

describe("АТАКА: нормальное распределение точно", () => {
  it("normalCdf против таблиц", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-2.576)).toBeCloseTo(0.005, 3);
  });
  it("normalInv против таблиц", () => {
    expect(normalInv(0.975)).toBeCloseTo(1.96, 2);
    expect(normalInv(0.005)).toBeCloseTo(-2.576, 2);
  });
  it("inv(cdf(z)) == z (взаимная обратность)", () => {
    for (const z of [-3, -1, 0.5, 2]) expect(normalInv(normalCdf(z))).toBeCloseTo(z, 2);
  });
});

describe("АТАКА: sharpe — float-пыль на константном ряде (как баг significanceScore)", () => {
  it("константный ряд 0.005 (std=float-пыль) → Sharpe=0, НЕ астрономический", () => {
    const constR = Array(100).fill(0.005);
    expect(sharpe(constR)).toBe(0); // не 1.4e15
  });
  it("DSR константного ряда НЕ сертифицирует (не 1.0)", () => {
    const constR = Array(100).fill(0.005);
    expect(deflatedSharpe(constR, 100, 0.01)).toBeLessThan(0.5);
  });
});

describe("АТАКА: minTRL при убыточной/нулевой стратегии", () => {
  it("убыточная стратегия (SR<0) → minTRL=Infinity, НЕ маленькое число", () => {
    const loss = Array.from({ length: 300 }, (_, i) => -0.003 + Math.sin(i) * 0.001);
    expect(sharpe(loss)).toBeLessThan(0);
    expect(minTrackRecordLength(loss)).toBe(Infinity);
  });
  it("нулевой Sharpe → minTRL=Infinity", () => {
    expect(minTrackRecordLength(Array(50).fill(0.005))).toBe(Infinity);
  });
});

describe("АТАКА: PBO — ничьи, нечётные фолды, вырождение", () => {
  it("нечётное число фолдов → NaN (НЕ ложный 0.5)", () => {
    const odd = Array.from({ length: 10 }, (_, c) => Array(7).fill(c === 0 ? 1 : 0));
    expect(Number.isNaN(probabilityOfBacktestOverfitting(odd))).toBe(true);
  });
  it("пустая матрица → NaN", () => {
    expect(Number.isNaN(probabilityOfBacktestOverfitting([]))).toBe(true);
  });
  it("один стабильно лучший конфиг → PBO=0", () => {
    const clean = Array.from({ length: 10 }, (_, c) => Array(8).fill(c === 0 ? 1 : 0));
    expect(probabilityOfBacktestOverfitting(clean)).toBe(0);
  });
  it("пилообразный оверфит (IS-топ/OOS-дно) → PBO высокий", () => {
    const overfit = Array.from({ length: 10 }, (_, c) =>
      Array.from({ length: 8 }, (_, f) => (c === 0 ? (f % 2 === 0 ? 1 : -1) : 0)));
    expect(probabilityOfBacktestOverfitting(overfit)).toBeGreaterThan(0.5);
  });
});

describe("АТАКА: SPA калибровка под H0 (должна быть ~uniform)", () => {
  it("чистый шум → p-value > 0.05 в среднем (мало ложных срабатываний)", () => {
    const g = (seed: number) => {
      const r = mulberry32(seed); let sp: number | null = null;
      return () => { if (sp !== null) { const s = sp; sp = null; return s; } let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); const m = Math.sqrt(-2 * Math.log(u)); sp = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v); };
    };
    let below = 0;
    for (let t = 0; t < 40; t++) {
      const gen = g(2000 + t);
      const pool = Array.from({ length: 15 }, () => Array.from({ length: 150 }, () => gen() * 0.01));
      if (realityCheckPValue(pool, { bootstraps: 200, seed: t }) < 0.05) below++;
    }
    expect(below / 40).toBeLessThan(0.20); // ложных срабатываний заметно меньше, чем «всегда»
  });
});

describe("АТАКА: stationary bootstrap инварианты", () => {
  it("сохраняет длину и берёт только из исходного ряда", () => {
    const src = [1, 2, 3, 4, 5];
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const rs = stationaryBootstrapResample(src, 0.2, rng);
      expect(rs.length).toBe(src.length);
      expect(rs.every((x) => src.includes(x))).toBe(true);
    }
  });
  it("пустой ряд → пустой результат", () => {
    expect(stationaryBootstrapResample([], 0.1, mulberry32(1))).toEqual([]);
  });
});

describe("АТАКА: volume — out-of-bounds entryIdx не крашит (битый адаптер биржи)", () => {
  const cs = C([[100, 101, 99, 100.5, 1000], [100.5, 102, 100, 101, 1000]]);
  it("squeezePressureBefore с entryIdx >> length → 0, не краш", () => {
    expect(squeezePressureBefore(cs, 99, "long", 5)).toBe(0);
  });
  it("volumeZScore с entryIdx >> length → 0, не краш", () => {
    expect(volumeZScore(cs, 99, 5)).toBe(0);
  });
  it("squeezePressureBefore: entryIdx=0 (нет прошлого) → 0", () => {
    expect(squeezePressureBefore(cs, 0, "long", 5)).toBe(0);
  });
  it("симметрия long/short: направленные свечи дают сумму давлений 1.0", () => {
    const mixed = C([[100, 101, 99, 98, 5000], [98, 99, 97, 99, 5000], [99, 100, 98, 97, 5000]]);
    const bl = squeezePressureBefore(mixed, 3, "long", 3);
    const bs = squeezePressureBefore(mixed, 3, "short", 3);
    expect(bl + bs).toBeCloseTo(1.0, 9);
  });
});

describe("АТАКА: DSR устойчивость к экстремумам", () => {
  it("экстремальный skew не даёт NaN/комплексное (denom clamp)", () => {
    const skewed = Array.from({ length: 200 }, (_, i) => (i === 0 ? 2.0 : -0.001 + Math.sin(i) * 0.0005));
    expect(Number.isFinite(deflatedSharpe(skewed, 100, 0.01))).toBe(true);
  });
  it("expectedMaxSharpe: N<1 → 0, varSR<0 → clamp, N огромное → finite", () => {
    expect(expectedMaxSharpe(0.01, 0)).toBe(0);
    expect(expectedMaxSharpe(-1, 100)).toBe(0);
    expect(Number.isFinite(expectedMaxSharpe(0.01, 1e9))).toBe(true);
  });
});

describe("АТАКА: float-дыры — переполнение, cancellation, NaN/Inf", () => {
  it("catastrophic cancellation: variance(1e8 ± 0.001) корректна (Welford), не мусор", () => {
    const huge = Array.from({ length: 100 }, (_, i) => 1e8 + (i % 2 ? 0.001 : -0.001));
    const v = variance(huge);
    expect(v).toBeGreaterThan(5e-7);
    expect(v).toBeLessThan(2e-6); // ≈1e-6, не отрицательная и не мусор
  });

  it("variance точна на известных рядах (Welford)", () => {
    expect(variance([1, 2, 3, 4, 5])).toBeCloseTo(2.5, 12);
    expect(variance([10, 20, 30])).toBeCloseTo(100, 10);
  });

  it("ВЫСОКИЙ Sharpe (большой mean, малый std) НЕ убивается dust-гардом", () => {
    const huge = Array.from({ length: 100 }, (_, i) => 1e8 + (i % 2 ? 0.001 : -0.001));
    expect(sharpe(huge)).toBeGreaterThan(1e9); // это легитимно огромный Sharpe, не 0
  });

  it("крошечный РЕАЛЬНЫЙ эдж (1e-6 масштаб) не убивается dust-гардом", () => {
    const tiny = Array.from({ length: 100 }, (_, i) => 1e-6 + (i % 2 ? 2e-6 : -1e-6));
    expect(sharpe(tiny)).toBeGreaterThan(0.5);
  });

  it("константа (истинный dust) → Sharpe 0", () => {
    expect(sharpe(Array(100).fill(0.005))).toBe(0);
  });

  it("Infinity в данных → sharpe 0, variance NaN, НЕ распространяет мусор", () => {
    expect(sharpe([0.01, Infinity, 0.02])).toBe(0);
    expect(Number.isNaN(variance([0.01, Infinity, 0.02]))).toBe(true);
  });

  it("NaN в данных → sharpe 0", () => {
    expect(sharpe([0.01, NaN, 0.02])).toBe(0);
  });

  it("skewness/kurtosis с не-finite → нейтральные (0/3), не NaN", () => {
    expect(skewness([0.01, Infinity, 0.02, 0.03])).toBe(0);
    expect(kurtosis([0.01, Infinity, 0.02, 0.03])).toBe(3);
  });

  it("большие значения (1e150): kurtosis/variance остаются finite", () => {
    const big = Array.from({ length: 100 }, (_, i) => 1e150 + (i % 2 ? 1e140 : -1e140));
    expect(Number.isFinite(kurtosis(big))).toBe(true);
    expect(Number.isFinite(variance(big))).toBe(true);
  });

  it("DSR с Infinity в данных → finite (fail-closed), НЕ NaN", () => {
    const bad = [0.01, 0.02, Infinity, 0.03, 0.04];
    const dsr = deflatedSharpe(bad, 100, 0.01);
    expect(Number.isFinite(dsr)).toBe(true);
    expect(dsr).toBeLessThan(0.95); // не сертифицирует битые данные
  });

  it("certifyStrategy с битыми данными → certified=false с причиной DSR", () => {
    const bad = [0.01, 0.02, Infinity, 0.03, 0.04];
    const cert = certifyStrategy({
      selectedReturns: bad, nTrials: 50, varSRAcrossTrials: 0.01,
      perfMatrix: [[1, 0], [0, 1]], candidateReturns: [bad], nestedScore: 0.003,
    });
    expect(cert.certified).toBe(false);
  });
});
