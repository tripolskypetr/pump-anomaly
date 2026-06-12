import { describe, it, expect } from "vitest";
import { volumeZScore, squeezePressure, volRegimeOf } from "../src/volume";
import { replayExit, ExitParams } from "../src/replay";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

function candles(rows: Array<[number, number, number, number, number]>): ICandleData[] {
  // [open, high, low, close, volume]
  return rows.map((r, i) => ({
    timestamp: t0 + i * MIN,
    open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4],
  }));
}

const EXIT = (over: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1,
  stalenessSinceMinutes: 240, staleMinutes: 30, ...over,
});

describe("volumeZScore", () => {
  it("ловит аномальный объём входной свечи против базлайна", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.1, 99.9, 100, 1000 + (i % 4) * 30]); // базлайн с дисперсией
    rows.push([100, 100.1, 99.9, 100, 5000]); // аномальный всплеск объёма на входе
    const cs = candles(rows);
    const z = volumeZScore(cs, 20, 20);
    expect(z).toBeGreaterThan(3); // явная аномалия
  });

  it("спокойный объём → низкий z", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 21; i++) rows.push([100, 100.1, 99.9, 100, 1000 + (i % 3) * 10]);
    const z = volumeZScore(candles(rows), 20, 20);
    expect(Math.abs(z)).toBeLessThan(2);
  });
});

describe("squeezePressure — СИММЕТРИЯ long/short", () => {
  it("LONG: каскад вниз на объёме → высокий pressure (форсированные sell)", () => {
    // вход long, затем свечи валятся вниз на растущем объёме
    const rows: Array<[number, number, number, number, number]> = [
      [100, 100.1, 99.9, 100, 1000],     // вход
      [100, 100.1, 98, 98.2, 3000],      // вниз, объём ↑ (против long)
      [98, 98.1, 96, 96.5, 4000],        // вниз, объём ↑
      [96, 96.2, 95, 95.2, 5000],        // вниз, объём ↑
    ];
    const p = squeezePressure(candles(rows), 0, "long", 30);
    expect(p).toBeGreaterThan(0.9); // почти весь объём против позиции
  });

  it("SHORT: каскад вверх на объёме → высокий pressure (форсированные buy)", () => {
    // зеркало: вход short, цена сквизит вверх на растущем объёме
    const rows: Array<[number, number, number, number, number]> = [
      [100, 100.1, 99.9, 100, 1000],     // вход
      [100, 102, 99.9, 101.8, 3000],     // вверх, объём ↑ (против short)
      [101.8, 104, 101.7, 103.9, 4000],  // вверх, объём ↑
      [103.9, 106, 103.8, 105.8, 5000],  // вверх, объём ↑
    ];
    const p = squeezePressure(candles(rows), 0, "short", 30);
    expect(p).toBeGreaterThan(0.9);
  });

  it("честный LONG-памп вверх → низкий pressure (объём в сторону позиции)", () => {
    const rows: Array<[number, number, number, number, number]> = [
      [100, 100.1, 99.9, 100, 1000],
      [100, 102, 99.9, 101.9, 3000],     // вверх (в сторону long)
      [101.9, 104, 101.8, 103.9, 4000],
    ];
    const p = squeezePressure(candles(rows), 0, "long", 30);
    expect(p).toBeLessThan(0.1);
  });
});

describe("replayExit — каскад veto/tighten СИММЕТРИЧНО", () => {
  // long, который ловушка: приманка вверх, потом каскад вниз на объёме
  const longTrap = candles([
    [100, 100.6, 99.9, 100.5, 1000],   // вход, лёгкая приманка вверх
    [100.5, 100.6, 98, 98.2, 4000],    // каскад вниз, объём ↑ (против long)
    [98.2, 98.3, 96, 96.5, 5000],
  ]);
  // short-ловушка: зеркало
  const shortTrap = candles([
    [100, 100.1, 99.4, 99.5, 1000],    // вход, приманка вниз
    [99.5, 102, 99.4, 101.8, 4000],    // каскад вверх, объём ↑ (против short)
    [101.8, 104, 101.7, 103.9, 5000],
  ]);

  it("VETO режет LONG-каскад (не входим)", () => {
    const r = replayExit(longTrap, "long", 99.5, 100.5,
      EXIT({ squeezePolicy: "veto", squeezeThreshold: 0.6, hardStop: 5 }));
    expect(r.reason).toBe("cascade-veto");
    expect(r.entered).toBe(false);
    expect(r.squeezePressure).toBeGreaterThan(0.6);
  });

  it("VETO режет SHORT-каскад (симметрично)", () => {
    const r = replayExit(shortTrap, "short", 99.5, 100.5,
      EXIT({ squeezePolicy: "veto", squeezeThreshold: 0.6, hardStop: 5 }));
    expect(r.reason).toBe("cascade-veto");
    expect(r.entered).toBe(false);
  });

  it("policy=none: тот же LONG-каскад → входим и ловим стоп (для контраста)", () => {
    const r = replayExit(longTrap, "long", 99.5, 100.5,
      EXIT({ squeezePolicy: "none", hardStop: 1 }));
    expect(r.entered).toBe(true);
    expect(r.reason).toBe("hard-stop");
  });

  it("replay возвращает volRegime по volZ-порогу", () => {
    // базлайн ниже зоны входа [104,106], чтобы вход случился на свече 20, а не раньше
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 1000 + (i % 4) * 30]);
    rows.push([105, 105.1, 104.9, 105, 6000]); // вход в зону [104,106] + аномальный объём
    rows.push([105, 106, 104.9, 105.9, 1000]);
    const cs = candles(rows);
    const r = replayExit(cs, "long", 104, 106,
      EXIT({ volZThreshold: 2.0, volBaselineWindow: 20, staleMinutes: 5, trailingTake: 50, hardStop: 50 }));
    expect(r.volRegime).toBe("anomalous");
    expect(r.volZ).toBeGreaterThan(2);
  });
});

describe("volRegimeOf", () => {
  it("порог разделяет calm/anomalous", () => {
    expect(volRegimeOf(1.0, 2.0)).toBe("calm");
    expect(volRegimeOf(2.5, 2.0)).toBe("anomalous");
  });
});
