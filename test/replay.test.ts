import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

/** строитель 1m-свечей из массива [open,high,low,close] */
function candles(rows: Array<[number, number, number, number]>): ICandleData[] {
  return rows.map((r, i) => ({
    timestamp: t0 + i * MIN,
    open: r[0], high: r[1], low: r[2], close: r[3], volume: 1,
  }));
}

const EXIT = (over: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1.0,
  hardStop: 1.0,
  stalenessSinceProfit: 1.0,
  stalenessSinceMinutes: 240,
  staleMinutes: 1000,
  ...over,
});

describe("replayExit — все последовательности окна (LONG)", () => {
  const entry = 100;

  it("НЕ входит, если зона не задета ценой", () => {
    // цена всё время ниже зоны [110,112]
    const cs = candles([[100, 101, 99, 100], [100, 102, 98, 101]]);
    const r = replayExit(cs, "long", 110, 112, EXIT());
    expect(r.entered).toBe(false);
    expect(r.reason).toBe("no-entry");
    expect(r.pnl).toBe(0);
  });

  it("чистый памп: растёт без отката → выход по life-cap в плюс", () => {
    const cs = candles([
      [100, 100.5, 99.8, 100.2],
      [100.2, 101, 100, 100.8],
      [100.8, 102, 100.7, 101.9],
    ]);
    const r = replayExit(cs, "long", 99, 101, EXIT({ staleMinutes: 2, trailingTake: 5 }));
    expect(r.entered).toBe(true);
    expect(r.pnl).toBeGreaterThan(0);
  });

  it("STOP HUNT: прокол вверх, потом разворот вниз → hard-stop, метка к последнему плюсовому пику", () => {
    // вход ~100, сходили на +0.6% (недостаточно для фикс. пика), потом провал на -1.2% → hard stop
    const cs = candles([
      [100, 100.6, 99.9, 100.5],   // пик +0.6%
      [100.5, 100.5, 98.8, 98.9],  // прокол вниз -1.2% от входа → hard stop @1%
    ]);
    const r = replayExit(cs, "long", 99.5, 100.5, EXIT({ hardStop: 1.0, trailingTake: 1.0 }));
    expect(r.reason).toBe("hard-stop");
    // последний плюсовой пик был ~+0.5..0.6%, метка откатывается к нему (не к -1%)
    expect(r.pnl).toBeGreaterThanOrEqual(0);
    expect(r.pnl).toBeLessThan(0.01);
  });

  it("trailing take: вырос на +3%, откатил на 1% → выход по пику", () => {
    const cs = candles([
      [100, 103, 100, 103],      // пик +3%
      [103, 103, 101.5, 101.9],  // откат: close 101.9 = +1.9%, откат от пика 1.1% ≥ trailingTake
    ]);
    const r = replayExit(cs, "long", 99, 101, EXIT({ trailingTake: 1.0, hardStop: 5 }));
    expect(r.reason).toBe("trailing-take");
    expect(r.pnl).toBeCloseTo(0.03, 2);
  });

  it("цена НЕ двигается к цели вовсе: болтается у входа → life-cap около нуля", () => {
    const cs = candles([
      [100, 100.1, 99.9, 100.0],
      [100, 100.1, 99.95, 100.0],
      [100, 100.05, 99.92, 99.98],
    ]);
    const r = replayExit(cs, "long", 99.8, 100.2, EXIT({ staleMinutes: 2, hardStop: 5, trailingTake: 5 }));
    expect(r.entered).toBe(true);
    expect(r.reason).toBe("life-cap");
    expect(Math.abs(r.pnl)).toBeLessThan(0.005);
  });

  it("peak staleness: достиг +1.2%, дальше плато дольше N минут → выход по пику", () => {
    const rows: Array<[number, number, number, number]> = [[100, 101.2, 100, 101.2]]; // пик +1.2% на минуте 0
    for (let i = 0; i < 6; i++) rows.push([101.0, 101.1, 100.9, 101.0]); // плато, без нового пика
    const cs = candles(rows);
    const r = replayExit(cs, "long", 99, 101, EXIT({
      stalenessSinceProfit: 1.0, stalenessSinceMinutes: 5, trailingTake: 5, hardStop: 5, staleMinutes: 100,
    }));
    expect(r.reason).toBe("peak-staleness");
    expect(r.pnl).toBeCloseTo(0.012, 3);
  });

  it("мгновенный обвал на первой же свече → hard-stop, нет плюсового пика → метка 0", () => {
    const cs = candles([[100, 100.0, 98.5, 98.6]]); // сразу -1.5%
    const r = replayExit(cs, "long", 99.5, 100.5, EXIT({ hardStop: 1.0 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBe(0); // не было плюсового пика — откатывать не к чему
  });
});

describe("replayExit — SHORT (gravebag, стоп ВЫШЕ входа)", () => {
  it("чистый памп вниз: цена падает → прибыль по short", () => {
    const cs = candles([
      [100, 100.1, 99, 99.2],
      [99.2, 99.3, 97, 97.5],
    ]);
    const r = replayExit(cs, "short", 99, 101, EXIT({ staleMinutes: 2, trailingTake: 5, hardStop: 5 }));
    expect(r.entered).toBe(true);
    expect(r.pnl).toBeGreaterThan(0); // short выигрывает на падении
  });

  it("STOP HUNT для short: прокол вниз, разворот вверх → hard-stop", () => {
    // вход ~100, сходили на +0.5% (цена вниз), потом вверх на +1.2% против short → hard stop
    const cs = candles([
      [100, 100.1, 99.5, 99.6],    // +0.4% в пользу short
      [99.6, 101.3, 99.6, 101.2],  // вверх → -1.2% против short → hard stop @1%
    ]);
    const r = replayExit(cs, "short", 99.5, 100.5, EXIT({ hardStop: 1.0, trailingTake: 1.0 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeGreaterThanOrEqual(0);
    expect(r.pnl).toBeLessThan(0.01);
  });

  it("trailing take для short: упало на 3%, откат вверх 1% → выход по пику", () => {
    const cs = candles([
      [100, 100, 97, 97],        // пик +3% (цена упала до 97)
      [97, 98.6, 97, 98.5],      // откат вверх: close 98.5 = +1.5% short, откат 1.5% ≥ trailingTake
    ]);
    const r = replayExit(cs, "short", 99, 101, EXIT({ trailingTake: 1.0, hardStop: 5 }));
    expect(r.reason).toBe("trailing-take");
    expect(r.pnl).toBeCloseTo(0.03, 2);
  });
});

describe("replayExit — приоритеты и края окна", () => {
  it("в одной свече и стоп, и потенциальный тейк → приоритет hard-stop", () => {
    // свеча пробивает и вверх (+2%) и вниз (-1.5%): стоп должен сработать
    const cs = candles([
      [100, 100, 99.9, 100],
      [100, 102, 98.5, 99],   // и high +2%, и low -1.5%
    ]);
    const r = replayExit(cs, "long", 99.5, 100.5, EXIT({ hardStop: 1.0, trailingTake: 1.0 }));
    expect(r.reason).toBe("hard-stop");
  });

  it("life-cap обрезает окно по staleMinutes даже если свечей больше", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 50; i++) rows.push([100 + i * 0.01, 100 + i * 0.01 + 0.05, 100 + i * 0.01 - 0.02, 100 + i * 0.01 + 0.02]);
    const cs = candles(rows);
    const r = replayExit(cs, "long", 99.5, 100.5, EXIT({ staleMinutes: 10, trailingTake: 50, hardStop: 50 }));
    expect(r.reason).toBe("life-cap");
    expect(r.heldMinutes).toBe(10); // не больше staleMinutes
  });

  it("пустой массив свечей → no-entry, не падает", () => {
    const r = replayExit([], "long", 100, 101, EXIT());
    expect(r.entered).toBe(false);
    expect(r.reason).toBe("no-entry");
  });

  it("вход не на первой свече: зона задета только на 3-й", () => {
    const cs = candles([
      [90, 91, 89, 90],     // далеко от зоны [99,101]
      [92, 94, 91, 93],
      [98, 101, 97, 100],   // здесь зона задета
      [100, 102, 99, 101.5],
    ]);
    const r = replayExit(cs, "long", 99, 101, EXIT({ staleMinutes: 5, trailingTake: 50, hardStop: 50 }));
    expect(r.entered).toBe(true);
    // вход на 3-й свече (idx 2), held считается от входа
    expect(r.heldMinutes).toBeLessThanOrEqual(2);
  });
});
