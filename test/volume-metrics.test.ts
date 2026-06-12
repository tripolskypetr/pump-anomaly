import { describe, it, expect } from "vitest";
import { volumeZScore, squeezePressure, volRegimeOf } from "../src/index";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const S25 = Math.sqrt(2.5); // std симметричного базлайна [b-2k,b-k,b,b+k,b+2k] = k·√2.5

const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

// базлайн с известными mean=b, std=k·√2.5; вход — последняя свеча с объёмом V.
// volZ = (V - b) / (k·√2.5) — вычислимо вручную.
const buildVZ = (b: number, k: number, entryVol: number): ICandleData[] => {
  const baseVols = [b - 2 * k, b - k, b, b + k, b + 2 * k];
  const rows: Array<[number, number, number, number, number]> = baseVols.map((v) => [100, 101, 99, 100, v]);
  rows.push([100, 101, 99, 100, entryVol]); // вход на индексе 5
  return C(rows);
};

// 15 детерминированных кейсов: [символ, baseMean b, шаг k, входной объём V]
// разные базлайны (300..10000) → один и тот же volZ требует РАЗНЫХ абсолютных объёмов
const CASES: Array<{ sym: string; b: number; k: number; V: number; expZ: number }> = [
  { sym: "SOLUSDT", b: 1000, k: 100, V: 1500, expZ: (1500 - 1000) / (100 * S25) },
  { sym: "TRXUSDT", b: 5000, k: 500, V: 7000, expZ: (7000 - 5000) / (500 * S25) },
  { sym: "NEARUSDT", b: 2000, k: 200, V: 2000, expZ: 0 },                       // z=0
  { sym: "POLUSDT", b: 800, k: 50, V: 650, expZ: (650 - 800) / (50 * S25) },     // отрицательный
  { sym: "ARBUSDT", b: 10000, k: 1000, V: 14000, expZ: (14000 - 10000) / (1000 * S25) },
  { sym: "HYPEUSDT", b: 300, k: 30, V: 420, expZ: (420 - 300) / (30 * S25) },
  { sym: "PUMPUSDT", b: 1500, k: 250, V: 2750, expZ: (2750 - 1500) / (250 * S25) },
  { sym: "FARTUSDT", b: 600, k: 60, V: 600, expZ: 0 },                           // z=0
  { sym: "WIFUSDT", b: 4000, k: 400, V: 3200, expZ: (3200 - 4000) / (400 * S25) },// отрицательный
  { sym: "BONKUSDT", b: 2500, k: 125, V: 2875, expZ: (2875 - 2500) / (125 * S25) },
  { sym: "DOGEUSDT", b: 900, k: 90, V: 1260, expZ: (1260 - 900) / (90 * S25) },
  { sym: "PEPEUSDT", b: 7000, k: 700, V: 5600, expZ: (5600 - 7000) / (700 * S25) },// отрицательный
  { sym: "INJUSDT", b: 1200, k: 100, V: 1600, expZ: (1600 - 1200) / (100 * S25) },
  { sym: "TIAUSDT", b: 350, k: 35, V: 490, expZ: (490 - 350) / (35 * S25) },
  { sym: "SEIUSDT", b: 1800, k: 150, V: 2250, expZ: (2250 - 1800) / (150 * S25) },
];

describe("15 метрик volZ — разный baseline объёма по символам (детерминированно)", () => {
  for (const { sym, b, k, V, expZ } of CASES) {
    it(`${sym}: baseline mean ${b} → volZ = ${expZ.toFixed(4)}`, () => {
      const cs = buildVZ(b, k, V);
      const z = volumeZScore(cs, 5, 5);
      expect(z).toBeCloseTo(expZ, 9); // точное совпадение с ручной формулой
    });
  }

  it("один и тот же volZ при РАЗНЫХ абсолютных объёмах (baseline-нормировка работает)", () => {
    // SOL (base 1000, V 1500) и PUMP (base 1500, V 2750) дают одинаковый z=√10
    const zSol = volumeZScore(buildVZ(1000, 100, 1500), 5, 5);
    const zPump = volumeZScore(buildVZ(1500, 250, 2750), 5, 5);
    expect(zSol).toBeCloseTo(zPump, 9);
    expect(zSol).toBeCloseTo(Math.sqrt(10), 9); // 500/(100√2.5)=5/√2.5=√10
  });
});

describe("режим объёма по volZ (граница порога deterministic)", () => {
  // порог 2.5: z≥2.5 → anomalous. Из 15 кейсов знаем точные z.
  const thr = 2.5;
  const expected: Array<[string, "calm" | "anomalous"]> = CASES.map(({ sym, expZ }) =>
    [sym, expZ >= thr ? "anomalous" : "calm"]);

  for (let i = 0; i < CASES.length; i++) {
    const { sym, b, k, V, expZ } = CASES[i];
    it(`${sym}: volZ ${expZ.toFixed(3)} @порог ${thr} → ${expected[i][1]}`, () => {
      const z = volumeZScore(buildVZ(b, k, V), 5, 5);
      expect(volRegimeOf(z, thr)).toBe(expected[i][1]);
    });
  }
});

describe("squeezePressure — детерминированные доли против позиции", () => {
  // после входа: каждая свеча либо против (close<open для long), либо за. Доля = against/total.
  it("long: 2 свечи против (vol 1000) + 1 за (vol 1000) → 2/3", () => {
    const cs = C([[100, 101, 99, 100, 500], [100, 100, 98, 98, 1000], [98, 99, 96, 96, 1000], [96, 98, 95, 97, 1000]]);
    expect(squeezePressure(cs, 0, "long", 3)).toBeCloseTo(2 / 3, 9);
  });
  it("long: взвешено по объёму — против 3000 из 4000 → 0.75", () => {
    const cs = C([[100, 101, 99, 100, 500], [100, 100, 98, 98, 3000], [98, 99, 97, 99, 1000]]);
    expect(squeezePressure(cs, 0, "long", 2)).toBeCloseTo(0.75, 9);
  });
  it("short: симметрично — против = рост (close>open)", () => {
    const cs = C([[100, 101, 99, 100, 500], [100, 102, 100, 101, 1000], [101, 103, 101, 102, 1000]]);
    expect(squeezePressure(cs, 0, "short", 2)).toBeCloseTo(1.0, 9); // оба роста против short
  });
});
