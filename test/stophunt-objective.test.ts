import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { squeezePressure } from "../src/volume";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 5, ...o,
});

// ── ОБЪЕКТИВНЫЕ ТЕСТЫ STOP HUNTING: вход, затем прокол/каскад против позиции ──
describe("STOP HUNTING — прокол против позиции (детерминированный стоп)", () => {
  it("чистый стоп: прокол вниз -3% при hardStop 2% → ЧЕСТНЫЙ убыток -2%", () => {
    const cs = C([
      [100, 100, 99.95, 100, 1000],  // вход
      [100, 100, 97, 98, 5000],      // low=97 → -3% ≤ -2% hardStop → стоп на -2%
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 2, trailingTake: 5, staleMinutes: 5 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.02, 9); // стоп исполнен на -hardStop%, честный убыток
    expect(r.heldMinutes).toBe(1);
  });

  it("стоп ПОСЛЕ пика +1%: pnl = честный убыток -2%, peak=+1% отдельно (не реализован)", () => {
    const cs = C([
      [100, 101, 99.95, 100.5, 1000], // high=101 → peak +1% (НЕ зафиксирован трейлингом)
      [100.5, 100.5, 97, 98, 5000],   // прокол low=97 → -3% ≤ -2% стоп
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 2, trailingTake: 50, staleMinutes: 5 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.02, 9); // ЧЕСТНО: стоп на -2%, пик не реализован
    expect(r.peak).toBeCloseTo(0.01, 9); // peak сохранён для диагностики, но не в pnl
  });

  it("стоп приоритетнее тейка в одной свече (консервативно)", () => {
    // свеча и пробивает стоп (low), и могла бы дать тейк (high) — берём стоп
    const cs = C([
      [100, 100, 99.95, 100, 1000],
      [100, 105, 97, 98, 5000], // high=105 (тейк) И low=97 (стоп) → стоп выигрывает
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 2, trailingTake: 1, staleMinutes: 5 }));
    expect(r.reason).toBe("hard-stop");
  });

  it("short stop-hunt: цена прокалывает ВВЕРХ против short → стоп", () => {
    const cs = C([
      [100, 100.05, 100, 100, 1000],  // вход short, low=100 → не в плюсе
      [100, 103, 100, 102, 5000],     // high=103 → short -3% ≤ -2% → стоп
    ]);
    const r = replayExit(cs, "short", 99.95, 100.05, E({ hardStop: 2, trailingTake: 5, staleMinutes: 5 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.02, 9); // честный убыток short -hardStop%
  });
});

describe("STOP HUNTING — каскад ликвидаций (squeeze) и реакция политики", () => {
  // каскад против long: вход без плюса (high=entry), затем объёмные свечи вниз
  const cascade = () => C([
    [100, 100, 99.95, 100, 1000],     // вход, high=100 → НИКОГДА не в плюсе
    [100, 100, 98, 98.2, 9000],       // вниз, объём (против long)
    [98.2, 98.3, 96, 96.4, 9000],     // вниз
    [96.4, 96.5, 94, 94.6, 9000],     // вниз
  ]);

  it("squeezePressure объективно высок: весь объём против long → pressure 1.0", () => {
    const cs = cascade();
    expect(squeezePressure(cs, 0, "long", 3)).toBeCloseTo(1.0, 9);
  });

  it("policy=veto на каскаде → не входим (cascade-veto, pnl 0)", () => {
    const r = replayExit(cascade(), "long", 99.95, 100.05, E({ squeezePolicy: "veto", squeezeThreshold: 0.6, cascadeWindowMinutes: 3, hardStop: 50 }));
    expect(r.reason).toBe("cascade-veto");
    expect(r.entered).toBe(false);
    expect(r.pnl).toBe(0);
  });

  it("policy=none на том же каскаде → входим и ловим стоп (для контраста)", () => {
    const r = replayExit(cascade(), "long", 99.95, 100.05, E({ squeezePolicy: "none", hardStop: 2, cascadeWindowMinutes: 3, staleMinutes: 3 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.entered).toBe(true);
  });

  it("veto объективно ЛУЧШЕ none: veto=0 (не вошли) > none=-2% (вошли и стопнулись)", () => {
    const cs = cascade();
    const veto = replayExit(cs, "long", 99.95, 100.05, E({ squeezePolicy: "veto", squeezeThreshold: 0.6, cascadeWindowMinutes: 3, hardStop: 2, staleMinutes: 3 }));
    const none = replayExit(cs, "long", 99.95, 100.05, E({ squeezePolicy: "none", hardStop: 2, cascadeWindowMinutes: 3, staleMinutes: 3 }));
    expect(veto.pnl).toBe(0);                 // не вошли → 0
    expect(none.pnl).toBeCloseTo(-0.02, 9);   // вошли и стопнулись → честный -2%
    expect(veto.pnl).toBeGreaterThan(none.pnl); // ТЕПЕРЬ veto строго лучше (раньше оба были 0)
    expect(none.reason).toBe("hard-stop");
    expect(veto.reason).toBe("cascade-veto");
  });
});

describe("STOP HUNTING — инверсия (stop hunt → разворот, стратегия 1028592)", () => {
  // short вход, цена гонится ВВЕРХ против short (сквиз) → инверсия в long снимает рост
  const squeezeUp = () => C([
    [100, 100.05, 99.95, 100, 1000],  // вход short
    [100, 103, 99.95, 102.9, 9000],   // вверх против short (close>open)
    [102.9, 106, 102.8, 105.9, 9000], // вверх
    [105.9, 108, 105.8, 107.9, 9000], // вверх → long-инверсия в плюсе
  ]);

  it("squeezePressure против short высок (рост) → ≥ порога", () => {
    const cs = squeezeUp();
    expect(squeezePressure(cs, 0, "short", 3)).toBeCloseTo(1.0, 9); // весь рост против short
  });

  it("policy=invert → разворот в long, объективно ловит рост (pnl>0, inverted)", () => {
    const r = replayExit(squeezeUp(), "short", 99.95, 100.05, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, cascadeWindowMinutes: 3, hardStop: 20, trailingTake: 50, staleMinutes: 3 }));
    expect(r.inverted).toBe(true);              // факт инверсии — флаг
    expect(["trailing-take", "life-cap", "peak-staleness"]).toContain(r.reason); // реальный выход не затёрт
    expect(r.pnl).toBeGreaterThan(0); // long-инверсия сняла сквиз вверх
  });

  it("invert объективно ЛУЧШЕ none на ловушке (short бы поймал стоп вверх)", () => {
    const cs = squeezeUp();
    const inv = replayExit(cs, "short", 99.95, 100.05, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, cascadeWindowMinutes: 3, hardStop: 20, trailingTake: 50, staleMinutes: 3 }));
    const none = replayExit(cs, "short", 99.95, 100.05, E({ squeezePolicy: "none", hardStop: 2, cascadeWindowMinutes: 3, staleMinutes: 3 }));
    expect(inv.pnl).toBeGreaterThan(none.pnl); // развернуться выгоднее, чем стопнуться
  });
});
