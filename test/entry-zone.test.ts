import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 50, hardStop: 50, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 3, ...o,
});

describe("entryPrice — close в зоне уточняет цену входа (вариант 2)", () => {
  it("close ПОПАЛ в зону → entryPrice = close (точнее фитиля)", () => {
    // зона [99,101], свеча close=100 в зоне → вход по 100, рост до ~111
    const cs = C([[98, 102, 97, 100, 1000], [100, 110, 100, 110, 1000], [110, 112, 110, 111, 1000], [111, 112, 110, 111, 1000]]);
    const r = replayExit(cs, "long", 99, 101, E());
    expect(r.entered).toBe(true);
    expect(r.pnl).toBeCloseTo((111 - 100) / 100, 6); // entryPrice=100
  });

  it("close ВНЕ зоны (только хвост пересёк) → entryPrice = clamp midpoint", () => {
    // зона [99,101], low=99.5 в зоне, но close=105 ВЫШЕ → midpoint 100
    const cs = C([[103, 106, 99.5, 105, 1000], [105, 110, 105, 110, 1000], [110, 112, 110, 111, 1000], [111, 112, 110, 111, 1000]]);
    const r = replayExit(cs, "long", 99, 101, E());
    expect(r.entered).toBe(true);
    expect(r.pnl).toBeCloseTo((111 - 100) / 100, 6); // midpoint 100, не close 105
  });

  it("close на ВЕРХНЕЙ границе зоны (close==hi) → считается в зоне (inclusive)", () => {
    const cs = C([[98, 102, 97, 101, 1000], [101, 110, 101, 110, 1000], [110, 112, 110, 111, 1000], [111, 112, 110, 111, 1000]]);
    const r = replayExit(cs, "long", 99, 101, E());
    expect(r.pnl).toBeCloseTo((111 - 101) / 101, 6); // entryPrice=101 (граница включена)
  });

  it("close на НИЖНЕЙ границе зоны (close==lo) → в зоне", () => {
    const cs = C([[98, 102, 97, 99, 1000], [99, 110, 99, 110, 1000], [110, 112, 110, 111, 1000], [111, 112, 110, 111, 1000]]);
    const r = replayExit(cs, "long", 99, 101, E());
    expect(r.pnl).toBeCloseTo((111 - 99) / 99, 6); // entryPrice=99
  });

  it("close чуть ВЫШЕ верхней границы → НЕ в зоне → midpoint", () => {
    // close=101.5 > hi=101 → clamp midpoint
    const cs = C([[100, 103, 99.5, 101.5, 1000], [101.5, 110, 101.5, 110, 1000], [110, 112, 110, 111, 1000], [111, 112, 110, 111, 1000]]);
    const r = replayExit(cs, "long", 99, 101, E());
    expect(r.pnl).toBeCloseTo((111 - 100) / 100, 6); // midpoint 100, не close 101.5
  });

  it("short: close в зоне → entryPrice = close (симметрия)", () => {
    // зона [99,101], close=100 в зоне, цена падает → short профит
    const cs = C([[102, 103, 98, 100, 1000], [100, 100, 90, 90, 1000], [90, 90, 88, 89, 1000], [89, 90, 88, 89, 1000]]);
    const r = replayExit(cs, "short", 99, 101, E());
    expect(r.entered).toBe(true);
    expect(r.pnl).toBeCloseTo((100 - 89) / 100, 6); // short от entryPrice 100
  });

  it("default-зона (from==to==open) при заданном open всё ещё входит", () => {
    // когда entryFrom==entryTo (точка), хвост её пересекает, close может не совпасть
    const cs = C([[100, 101, 99, 100.5, 1000], [100.5, 105, 100.5, 105, 1000], [105, 106, 104, 105, 1000], [105, 106, 104, 105, 1000]]);
    const r = replayExit(cs, "long", 100, 100, E());
    expect(r.entered).toBe(true); // точка 100 пересечена хвостом [99,101]
  });

  it("зона не пересечена вовсе → no-entry (close-уточнение не влияет на гейт)", () => {
    const cs = C([[105, 106, 104, 105.5, 1000], [105, 106, 104, 105, 1000]]);
    const r = replayExit(cs, "long", 99, 101, E());
    expect(r.entered).toBe(false);
    expect(r.reason).toBe("no-entry");
  });
});
