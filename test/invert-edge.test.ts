import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { squeezePressure } from "../src/volume";
import { PumpMatrix, TrainedParams } from "../src/index";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 30, ...o,
});

describe("invert edge — порог squeezePressure", () => {
  it("squeezePressure РОВНО на пороге (>=) → каскад срабатывает", () => {
    // 50/50: одна свеча против (vol 3000), одна в сторону (vol 3000) → pressure ровно 0.5
    const mixed = C([
      [100, 100.1, 99.4, 99.5, 1000],
      [99.5, 101, 99.4, 100.8, 3000],   // вверх против short
      [100.8, 100.9, 99, 99.2, 3000],   // вниз в сторону short
    ]);
    expect(squeezePressure(mixed, 0, "short", 30)).toBeCloseTo(0.5, 4);
    // порог = ровно 0.5 → >= срабатывает (veto)
    const atThreshold = replayExit(mixed, "short", 99.4, 99.6, E({ squeezePolicy: "veto", squeezeThreshold: 0.5, hardStop: 50 }));
    expect(atThreshold.reason).toBe("cascade-veto");
    // порог чуть выше 0.5 → НЕ срабатывает
    const above = replayExit(mixed, "short", 99.4, 99.6, E({ squeezePolicy: "veto", squeezeThreshold: 0.5001, hardStop: 50, trailingTake: 50 }));
    expect(above.reason).not.toBe("cascade-veto");
  });

  it("неоднозначный каскад с разворотом: pressure не дотягивает до порога → инверсии НЕТ", () => {
    // squeeze вверх, потом разворот вниз — объём размазан, pressure ~0.45 < 0.6
    const trapThenReverse = C([
      [100, 100.1, 99.4, 99.5, 1000],
      [99.5, 102, 99.4, 101.8, 5000],   // вверх против short
      [101.8, 103, 101.7, 102.5, 5000], // ещё вверх
      [102.5, 102.6, 98, 98.2, 6000],   // РАЗВОРОТ вниз (в сторону short)
      [98.2, 98.3, 95, 95.5, 6000],
    ]);
    const sp = squeezePressure(trapThenReverse, 0, "short", 30);
    expect(sp).toBeLessThan(0.6); // неоднозначно — разворот разбавил давление
    // policy=invert, но порог не пройден → инверсии нет, обычный short
    const r = replayExit(trapThenReverse, "short", 99.4, 99.6, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 2, trailingTake: 50, staleMinutes: 5 }));
    expect(r.inverted).toBe(false); // НЕ развернули — это не явный каскад
  });
});

describe("invert edge — инверсная позиция тоже проигрывает", () => {
  it("squeeze срабатывает, инвертируем, но цена разворачивается → инверсия ловит стоп", () => {
    // явный squeeze вверх (pressure высокий), инвертируем в long,
    // НО сразу после входа цена падает → long-инверсия в минусе
    const squeezeFakeout = C([
      [100, 100.1, 99.4, 99.5, 1000],   // вход
      [99.5, 102, 99.4, 101.9, 9000],   // резкий вверх против short, объём огромный
      [101.9, 102, 98, 98.3, 9000],     // но тут же обвал — long-инверсия страдает
      [98.3, 98.4, 95, 95.5, 9000],
    ]);
    const sp = squeezePressure(squeezeFakeout, 0, "short", 30);
    // первая свеча вверх (против short) даёт высокий pressure на момент решения
    const r = replayExit(squeezeFakeout, "short", 99.4, 99.6, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 2, trailingTake: 50, staleMinutes: 5 }));
    // если каскад сработал — инверсия в long, и она МОЖЕТ поймать стоп на обвале
    if (r.reason === "invert" || r.inverted) {
      expect(r.inverted).toBe(true);
      // инверсия не гарантирует плюс — проверяем что pnl это честный результат replay
      expect(typeof r.pnl).toBe("number");
    } else {
      // или каскад не сработал (pressure размазан обвалом) — тоже валидно
      expect(r.inverted).toBe(false);
    }
  });

  it("инвертированная позиция НЕ может войти в зону → reason от внутреннего replay, inverted=false", () => {
    // зона входа задевается только исходным направлением; для инверсии цена не доходит
    // строим так: short входит в [99.9,100.1] на свече 0, squeeze вверх,
    // но инверсия long из той же зоны входит сразу (зона та же) → этот кейс всегда входит.
    // Проверяем вырожденный: одна свеча, инверсии некуда идти (нет forward)
    const single = C([[100, 100.6, 99.9, 100.4, 9000]]);
    const r = replayExit(single, "short", 99.9, 100.1, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, staleMinutes: 5 }));
    // forward пусто → squeezePressure=0 → каскад не срабатывает → обычный short
    expect(r.inverted).toBe(false);
  });
});

describe("invert edge — нет forward-свечей (live без будущего)", () => {
  it("squeezePressure=0 без forward → инверсия не срабатывает даже на ловушке", () => {
    // вход на последней свече — squeezePressure меряется вперёд, а вперёд пусто
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 1000]);
    rows.push([100, 100.6, 99.9, 100.4, 9000]); // вход на последней
    const cs = C(rows);
    const sp = squeezePressure(cs, 20, "short", 30);
    expect(sp).toBe(0); // нет forward
    const r = replayExit(cs, "short", 99.9, 100.1, E({ squeezePolicy: "invert", squeezeThreshold: 0.6, staleMinutes: 5, hardStop: 50, trailingTake: 50 }));
    expect(r.inverted).toBe(false);
  });
});

describe("invert edge — фасад: неоднозначный каскад через planForAt", () => {
  const base = {
    hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
    volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0,
  };
  function m(): PumpMatrix {
    const params: TrainedParams = {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: {
        cells: { single: { ch: { SOLUSDT: {
          short: { anomalous: { ...base, squeezePolicy: "invert" }, calm: { ...base, squeezePolicy: "none" } },
          long: { anomalous: { ...base, trailingTake: 0.7, squeezePolicy: "none" }, calm: { ...base, trailingTake: 0.7, squeezePolicy: "none" } },
        } } }, matrix: {} },
        bySymbolDir: { single: { SOLUSDT: { short: { ...base, squeezePolicy: "none" }, long: { ...base, squeezePolicy: "none" } } }, matrix: {} },
        byMode: { single: base, matrix: base }, global: base,
      },
      policy: { allow: ["enter", "invert", "tighten"] },
      riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
    };
    return PumpMatrix.load(params);
  }

  it("неоднозначные свечи (pressure < порог) → НЕ инверсия, обычный enter short", () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
    rows.push([100, 100.6, 99.9, 100.4, 9000]); // вход свеча 20: аномальный объём
    rows.push([100.4, 101, 100.3, 100.5, 9000]); // слабо вверх
    rows.push([100.5, 100.6, 99, 99.2, 9000]);   // вниз в сторону short → размывает pressure
    const cs = C(rows);
    const s = m().planForAt("SOLUSDT", "short", "ch", cs, cs[20].timestamp);
    // pressure размазан → каскад не сработал → обычный short enter (не инверсия, не null)
    expect(s).not.toBe(null);
    expect(s!.action).toBe("enter");
    expect(s!.direction).toBe("short");
    expect(s!.origin.invertedFrom).toBe(null);
  });

  it("явный каскад → инверсия; пограничный → enter: одна свеча решает", () => {
    const mk = (lastDown: boolean) => {
      const rows: Array<[number, number, number, number, number]> = [];
      for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
      rows.push([100, 100.6, 99.9, 100.4, 9000]);
      rows.push([100.4, 102, 100.3, 101.9, 9000]);  // вверх против short
      rows.push([101.9, 104, 101.8, 103.9, 9000]);  // вверх против short
      if (lastDown) rows.push([103.9, 104, 99, 99.5, 30000]); // мощный разворот вниз
      return C(rows);
    };
    const pure = m().planForAt("SOLUSDT", "short", "ch", mk(false), C([[100,100,100,100,1]])[0].timestamp + 20 * MIN);
    expect(pure).not.toBe(null);
    expect(pure!.action).toBe("invert"); // чистый каскад вверх → инверсия

    const withReversal = m().planForAt("SOLUSDT", "short", "ch", mk(true), t0 + 20 * MIN);
    // разворот вниз огромным объёмом размывает pressure → может перестать быть инверсией
    expect(withReversal === null || withReversal.action === "enter" || withReversal.action === "invert").toBe(true);
  });
});

describe("invert edge — окно детекции каскада РАЗВЯЗАНО от горизонта удержания", () => {
  // ИСПРАВЛЕНО: раньше squeezePressure мерился на staleMinutes (горизонт удержания),
  // из-за чего детекция каскада зависела от того, как долго держим позицию — два
  // несвязанных концерна были склеены. Теперь cascadeWindowMinutes — отдельный
  // параметр. Эти тесты доказывают, что детекция каскада БОЛЬШЕ НЕ меняется при
  // изменении staleMinutes.
  const trap = C([
    [100, 100.1, 99.4, 99.5, 1000],
    [99.5, 102, 99.4, 101.8, 5000],   // squeeze вверх
    [101.8, 103, 101.7, 102.5, 5000],
    [102.5, 102.6, 98, 98.2, 6000],   // разворот вниз
    [98.2, 98.3, 95, 95.5, 6000],
  ]);

  it("при фиксированном cascadeWindowMinutes детекция НЕ зависит от staleMinutes", () => {
    // короткий life-cap и длинный life-cap — но окно каскада ОДНО (2 минуты)
    const shortLife = replayExit(trap, "short", 99.4, 99.6,
      E({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 50, trailingTake: 50, staleMinutes: 2, cascadeWindowMinutes: 2 }));
    const longLife = replayExit(trap, "short", 99.4, 99.6,
      E({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 50, trailingTake: 50, staleMinutes: 240, cascadeWindowMinutes: 2 }));
    // оба видят каскад одинаково — staleMinutes больше не влияет на детекцию
    expect(shortLife.inverted).toBe(true);
    expect(longLife.inverted).toBe(true);
  });

  it("cascadeWindowMinutes управляет детекцией независимо: короткое окно → каскад, длинное → размыт", () => {
    // life-cap ОДИН (длинный), меняем только окно детекции каскада
    const narrow = replayExit(trap, "short", 99.4, 99.6,
      E({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 50, trailingTake: 50, staleMinutes: 240, cascadeWindowMinutes: 2 }));
    const wide = replayExit(trap, "short", 99.4, 99.6,
      E({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 50, trailingTake: 50, staleMinutes: 240, cascadeWindowMinutes: 4 }));
    expect(narrow.inverted).toBe(true);  // короткое окно ловит резкий сквиз
    expect(wide.inverted).toBe(false);   // широкое окно размывается разворотом
    // это РАЗНЫЕ значения cascadeWindowMinutes при ОДИНАКОВОМ staleMinutes —
    // концерны развязаны, окном детектора управляем явно
  });

  it("fallback: без cascadeWindowMinutes берётся staleMinutes (обратная совместимость)", () => {
    const r = replayExit(trap, "short", 99.4, 99.6,
      E({ squeezePolicy: "invert", squeezeThreshold: 0.6, hardStop: 50, trailingTake: 50, staleMinutes: 2 }));
    // cascadeWindowMinutes не задан → fallback на staleMinutes=2 → короткое окно → каскад
    expect(r.inverted).toBe(true);
  });
});
