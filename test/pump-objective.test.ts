import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 5, ...o,
});

// ── ОБЪЕКТИВНЫЕ ТЕСТЫ PUMP: честный вход вверх, исход вычислим заранее ──
// Зона входа узкая [99.95,100.05] → entryPrice=100 ровно. pnl = (price-100)/100.
describe("PUMP — честный памп вверх (детерминированный исход)", () => {
  it("moonbag: цена едет вверх без отката → life-cap по close = +10%", () => {
    const cs = C([
      [100, 100.05, 99.95, 100, 1000],
      [100, 102, 100, 102, 1000], [102, 104, 102, 104, 1000],
      [104, 106, 104, 106, 1000], [106, 108, 106, 108, 1000],
      [108, 110, 108, 110, 1000], // close 110 → +10%
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ trailingTake: 50, hardStop: 50, staleMinutes: 5 }));
    expect(r.reason).toBe("life-cap");
    expect(r.pnl).toBeCloseTo(0.10, 9); // (110-100)/100
    expect(r.entered).toBe(true);
  });

  it("trailing-take: пик +5%, откат до +3% (≥1% откат) → фикс по пику +5%", () => {
    const cs = C([
      [100, 100.1, 99.9, 100, 1000],
      [100, 103, 99.9, 102, 1000],
      [102, 105, 101, 104.9, 1000], // peak high=105 → +5%
      [104.9, 105, 103, 103, 1000], // close=103 → +3%, откат 2% ≥ trailingTake 1%
      [103, 104, 102, 103, 1000],
    ]);
    const r = replayExit(cs, "long", 99.9, 100.1, E({ trailingTake: 1, hardStop: 10, staleMinutes: 5 }));
    expect(r.reason).toBe("trailing-take");
    expect(r.pnl).toBeCloseTo(0.05, 9); // фикс по пику +5%
    expect(r.peak).toBeCloseTo(0.05, 9);
  });

  it("short-памп вниз (симметрия): цена падает → short life-cap +10%", () => {
    const cs = C([
      [100, 100.05, 99.95, 100, 1000],
      [100, 100, 98, 98, 1000], [98, 98, 96, 96, 1000],
      [96, 96, 94, 94, 1000], [94, 94, 92, 92, 1000],
      [92, 92, 90, 90, 1000], // close 90 → short +10%
    ]);
    const r = replayExit(cs, "short", 99.95, 100.05, E({ trailingTake: 50, hardStop: 50, staleMinutes: 5 }));
    expect(r.reason).toBe("life-cap");
    expect(r.pnl).toBeCloseTo(0.10, 9);
  });

  it("памп с откатом ВНУТРИ trailing → фиксируем достигнутый пик, не финальный close", () => {
    // пик +8%, потом откат к +2% — trailing срабатывает по пику
    const cs = C([
      [100, 100.05, 99.95, 100, 1000],
      [100, 108, 100, 107, 1000],   // peak +8%
      [107, 107, 101, 102, 1000],   // close +2%, откат 6% ≥ 1%
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ trailingTake: 1, hardStop: 20, staleMinutes: 5 }));
    expect(r.reason).toBe("trailing-take");
    expect(r.pnl).toBeCloseTo(0.08, 9); // зафиксирован пик, не +2%
  });

  it("умеренный памп до life-cap без срабатывания trailing (откат < порога)", () => {
    // монотонный рост, trailingTake большой → не срабатывает → life-cap
    const cs = C([
      [100, 100.05, 99.95, 100, 1000],
      [100, 101, 100, 101, 1000], [101, 102, 101, 102, 1000],
      [102, 103, 102, 103, 1000], [103, 104, 103, 104, 1000],
      [104, 105, 104, 105, 1000], // close 105 → +5%
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ trailingTake: 50, hardStop: 50, staleMinutes: 5 }));
    expect(r.reason).toBe("life-cap");
    expect(r.pnl).toBeCloseTo(0.05, 9);
  });

  it("памп объективно прибыльнее боковика (pnl_pump > pnl_flat)", () => {
    const pump = C([[100, 100.05, 99.95, 100, 1000], [100, 103, 100, 103, 1000], [103, 106, 103, 106, 1000], [106, 109, 106, 109, 1000], [109, 112, 109, 112, 1000], [112, 115, 112, 115, 1000]]);
    const flat = C([[100, 100.05, 99.95, 100, 1000], [100, 100.5, 99.5, 100, 1000], [100, 100.5, 99.5, 100, 1000], [100, 100.5, 99.5, 100, 1000], [100, 100.5, 99.5, 100, 1000], [100, 100.5, 99.5, 100, 1000]]);
    const cfg = E({ trailingTake: 50, hardStop: 50, staleMinutes: 5 });
    const rp = replayExit(pump, "long", 99.95, 100.05, cfg);
    const rf = replayExit(flat, "long", 99.95, 100.05, cfg);
    expect(rp.pnl).toBeGreaterThan(rf.pnl);
    expect(rp.pnl).toBeCloseTo(0.15, 9); // +15%
  });
});
