import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { PumpMatrix, TrainedParams } from "../src/index";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

function candles(rows: Array<[number, number, number, number, number]>): ICandleData[] {
  return rows.map((r, i) => ({
    timestamp: t0 + i * MIN,
    open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4],
  }));
}

const EXIT = (over: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1,
  stalenessSinceMinutes: 240, staleMinutes: 30, ...over,
});

describe("replayExit — invert (stop hunt → разворот)", () => {
  // short-сигнал, который на деле сквиз вверх: входим short, цену гонят вверх (каскад).
  // Инверсия = войти long из той же точки и снять рост.
  const shortTrap = candles([
    [100, 100.1, 99.4, 99.5, 1000],    // вход
    [99.5, 102, 99.4, 101.8, 4000],    // вверх, объём ↑ (против short)
    [101.8, 104, 101.7, 103.9, 5000],  // вверх ↑
    [103.9, 106, 103.8, 105.8, 6000],  // вверх ↑
  ]);

  it("policy=invert на short-ловушке → инвертированная long-позиция в плюсе", () => {
    const r = replayExit(shortTrap, "short", 99.5, 100.5,
      EXIT({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 50, trailingTake: 50, staleMinutes: 5 }));
    expect(r.reason).toBe("invert");
    expect(r.inverted).toBe(true);
    expect(r.pnl).toBeGreaterThan(0); // long снял рост, который убил бы short
  });

  it("для контраста: policy=none на той же ловушке → short ловит стоп", () => {
    const r = replayExit(shortTrap, "short", 99.5, 100.5,
      EXIT({ squeezePolicy: "none", hardStop: 1 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.inverted).toBe(false);
  });

  it("симметрия: long-ловушка (каскад вниз) → инверсия в short, плюс", () => {
    const longTrap = candles([
      [100, 100.6, 99.9, 100.5, 1000],
      [100.5, 100.6, 98, 98.2, 4000],   // вниз против long
      [98.2, 98.3, 96, 96.4, 5000],
      [96.4, 96.5, 94, 94.3, 6000],
    ]);
    const r = replayExit(longTrap, "long", 99.5, 100.5,
      EXIT({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 50, trailingTake: 50, staleMinutes: 5 }));
    expect(r.reason).toBe("invert");
    expect(r.pnl).toBeGreaterThan(0); // short снял падение
  });

  it("нет каскада → invert не срабатывает, обычный вход", () => {
    const honest = candles([
      [100, 100.1, 99.9, 100, 1000],
      [100, 100.1, 98, 98.1, 1000],     // честное падение в сторону short
      [98.1, 98.2, 96, 96.2, 1000],
    ]);
    const r = replayExit(honest, "short", 99.5, 100.5,
      EXIT({ squeezePolicy: "invert", squeezeThreshold: 0.6, staleMinutes: 5, hardStop: 50, trailingTake: 50 }));
    expect(r.inverted).toBe(false);
    expect(r.pnl).toBeGreaterThan(0); // обычный short на честном падении
  });
});

/** модель с policy=invert в short-anomalous ячейке + инверс-ячейкой long */
function invertModel(): PumpMatrix {
  const base = {
    hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20,
  };
  const params: TrainedParams = {
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single" },
    exit: {
      cells: {
        single: {
          ch: {
            SOLUSDT: {
              short: { anomalous: { ...base, trailingTake: 1.0, squeezePolicy: "invert" } },
              long: { anomalous: { ...base, trailingTake: 0.7, squeezePolicy: "none" } }, // инверс-ячейка
            },
          },
        },
        matrix: {},
      },
      bySymbolDir: { single: {}, matrix: {} },
      byMode: { single: { ...base, trailingTake: 1.0 }, matrix: { ...base, trailingTake: 2.0 } },
      global: { ...base, trailingTake: 1.0 },
    },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.02, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 50, mode: "single", impactHorizonMinutes: 240,
      confidence: 0.5, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  };
  return PumpMatrix.load(params);
}

describe("signals/plan — инверсия прозрачна для прода", () => {
  const model = invertModel();

  it("short-сигнал + каскад → plan отдаёт РАЗВЁРНУТЫЙ long, exit из инверс-ячейки", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 100.6, 99.9, 100.4, 9000]);    // вход свеча 20: аномальный объём
    rows.push([100.4, 102, 100.3, 101.9, 9000]);    // каскад ВВЕРХ против short
    rows.push([101.9, 104, 101.8, 103.9, 9000]);
    const cs = candles(rows);

    const plan = model.planForAt("SOLUSDT", "short", "ch", cs, cs[20].timestamp);
    expect(plan.recommendation).toBe("invert");
    expect(plan.inverted).toBe(true);
    expect(plan.originalDirection).toBe("short"); // что сказал канал
    expect(plan.direction).toBe("long");          // что исполнять (развёрнуто)
    expect(plan.trailingTake).toBe(0.7);          // exit из инверс-ячейки long-anomalous
  });

  it("прод НЕ думает: просто открывает plan.direction", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 100.6, 99.9, 100.4, 9000]);
    rows.push([100.4, 102, 100.3, 101.9, 9000]);
    rows.push([101.9, 104, 101.8, 103.9, 9000]);
    const cs = candles(rows);
    const plan = model.planForAt("SOLUSDT", "short", "ch", cs, cs[20].timestamp);
    // приложение просто исполняет plan.direction — здесь long, без единого if
    expect(["long", "short"]).toContain(plan.direction);
    expect(plan.direction).toBe("long");
  });
});

describe("RuntimeOptions — выключение инверсии без переобучения", () => {
  const model = invertModel();
  const trapCandles = () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 100.6, 99.9, 100.4, 9000]);
    rows.push([100.4, 102, 100.3, 101.9, 9000]);
    rows.push([101.9, 104, 101.8, 103.9, 9000]);
    return candles(rows);
  };

  it("disableInvert → инверсия глушится в veto (не разворачиваем)", () => {
    const cs = trapCandles();
    const plan = model.planForAt("SOLUSDT", "short", "ch", cs, cs[20].timestamp, { disableInvert: true });
    expect(plan.recommendation).toBe("veto");
    expect(plan.inverted).toBe(false);
    expect(plan.direction).toBe("short"); // НЕ развёрнут
  });

  it("без флага та же ловушка → invert (для контраста)", () => {
    const cs = trapCandles();
    const plan = model.planForAt("SOLUSDT", "short", "ch", cs, cs[20].timestamp);
    expect(plan.recommendation).toBe("invert");
    expect(plan.direction).toBe("long");
  });

  it("disableSqueeze → вся каскад-логика выключена, обычный enter", () => {
    const cs = trapCandles();
    const plan = model.planForAt("SOLUSDT", "short", "ch", cs, cs[20].timestamp, { disableSqueeze: true });
    expect(plan.recommendation).toBe("enter");
    expect(plan.inverted).toBe(false);
    expect(plan.direction).toBe("short");
  });
});
