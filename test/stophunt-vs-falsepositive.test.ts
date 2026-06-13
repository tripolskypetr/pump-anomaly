import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { PumpMatrix, TrainedParams } from "../src/index";
import { ICandleData, STEP_MS, entryStartTs } from "../src/candle";
import { ParserItem } from "../src/types";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 12, 0, 0);
const STEP = STEP_MS["1m"];
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams =>
  ({ trailingTake: 50, hardStop: 3, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 10, ...o });

// ── КЕЙС 1: STOP HUNTING — каскад реальный, цена реально падает после вышибания стопов ──
const stopHuntFuture = C([
  [100, 100.05, 99.95, 100, 1000], // вход
  [100, 100, 96, 96.5, 9000],      // вышибание стопов вниз
  [96.5, 97, 93, 93.5, 9000],      // продолжение падения (каскад настоящий)
  [93.5, 94, 91, 91.5, 9000],
]);

// ── КЕЙС 2: ОШИБОЧНЫЙ ВЫВОД — каскад ложный, памп НАСТОЯЩИЙ, цена растёт ──
const realPumpFuture = C([
  [100, 100.05, 99.95, 100, 1000], // вход
  [100, 105, 100, 104, 2000],      // памп вверх (настоящий)
  [104, 108, 104, 107, 2000],
  [107, 110, 107, 109, 2000],
]);

describe("КЕЙС 1: stop hunting (каскад реальный) — инверсия СПАСАЕТ", () => {
  it("вход long вопреки каскаду (ignore) → стоп, реальный убыток", () => {
    const r = replayExit(stopHuntFuture, "long", 99, 101, E({ squeezePolicy: "ignore" }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.03, 9); // honest -hardStop%
  });
  it("инверсия в short → профит на падении (правильная реакция на stop-hunt)", () => {
    const r = replayExit(stopHuntFuture, "short", 99, 101, E({ squeezePolicy: "none" }));
    expect(r.pnl).toBeGreaterThan(0); // short заработал на падении
  });
  it("инверсия СТРОГО ЛУЧШЕ входа-вопреки в этом кейсе", () => {
    const ignored = replayExit(stopHuntFuture, "long", 99, 101, E({ squeezePolicy: "ignore" }));
    const inverted = replayExit(stopHuntFuture, "short", 99, 101, E({ squeezePolicy: "none" }));
    expect(inverted.pnl).toBeGreaterThan(ignored.pnl);
  });
});

describe("КЕЙС 2: ошибочный вывод (каскад ложный, памп реальный) — инверсия ВРЕДИТ", () => {
  it("остаться long → профит (памп был настоящий)", () => {
    const r = replayExit(realPumpFuture, "long", 99, 101, E({ squeezePolicy: "none" }));
    expect(r.pnl).toBeGreaterThan(0);
  });
  it("ошибочная инверсия в short → стоп, убыток (зря развернулись)", () => {
    const r = replayExit(realPumpFuture, "short", 99, 101, E({ squeezePolicy: "none" }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.03, 9);
  });
  it("вход-вопреки (ignore) СТРОГО ЛУЧШЕ инверсии в этом кейсе (зеркало кейса 1)", () => {
    const ignored = replayExit(realPumpFuture, "long", 99, 101, E({ squeezePolicy: "ignore" }));
    const inverted = replayExit(realPumpFuture, "short", 99, 101, E({ squeezePolicy: "none" }));
    expect(ignored.pnl).toBeGreaterThan(inverted.pnl);
  });
});

describe("live plan: решение по ПРОШЛОМУ одинаковое, правота — в БУДУЩЕМ", () => {
  const mk = (pol: string): TrainedParams => {
    const ex = { hardStop: 3, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 10, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 50.0, squeezePolicy: pol as any, cascadeWindowMinutes: 5 };
    return {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: { cells: { single: { ch: { SOLUSDT: { long: { anomalous: ex, calm: ex }, short: { anomalous: ex, calm: ex } } } }, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: ex, short: ex } }, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
      policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 10, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
    } as TrainedParams;
  };
  const sig = Date.UTC(2026, 0, 6, 12, 0, 0);
  const start = entryStartTs(sig, "1m");
  // прошлое с каскадом ВНИЗ против long → live plan инвертирует (одинаково для обоих кейсов)
  const pastCascade = (): ICandleData[] => {
    const out: ICandleData[] = [];
    for (let k = 30; k >= 1; k--) { const ts = start - k * STEP; const hot = k <= 5; out.push({ timestamp: ts, open: 100, high: 100.5, low: hot ? 97 : 99.5, close: hot ? 97.5 : 100, volume: hot ? 9000 : 1000 }); }
    return out;
  };
  const item: ParserItem = { channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: sig, entryFromPrice: 99, entryToPrice: 101 };

  it("live plan видит каскад в прошлом → инвертирует в short (решение по доступным данным)", () => {
    const r = PumpMatrix.load(mk("invert")).plan([item], { SOLUSDT: pastCascade() });
    expect(r.length).toBe(1);
    expect(r[0].action).toBe("invert");
    expect(r[0].direction).toBe("short");
    expect(r[0].origin.invertedFrom).toBe("long");
  });

  it("это решение ПРАВИЛЬНО в кейсе 1 (дальше падение) — short зарабатывает", () => {
    // та же инверсия в short, будущее = stop-hunt падение
    const r = replayExit(stopHuntFuture, "short", 99, 101, E({ squeezePolicy: "none" }));
    expect(r.pnl).toBeGreaterThan(0);
  });

  it("это же решение ОШИБОЧНО в кейсе 2 (дальше рост) — short теряет", () => {
    // та же инверсия в short, будущее = настоящий памп вверх
    const r = replayExit(realPumpFuture, "short", 99, 101, E({ squeezePolicy: "none" }));
    expect(r.pnl).toBeLessThan(0);
  });

  it("veto в кейсе 1: forward-каскад вниз → НЕ входим (cascade-veto, pnl=0) — избегаем стопа", () => {
    const r = replayExit(stopHuntFuture, "long", 99, 101, E({ squeezePolicy: "veto", squeezeThreshold: 0.6, cascadeWindowMinutes: 3 }));
    expect(r.entered).toBe(false);
    expect(r.reason).toBe("cascade-veto");
    expect(r.pnl).toBe(0); // 0 лучше, чем -3% стоп от входа-вопреки
  });

  it("veto в кейсе 2: тот же veto УПУСКАЕТ профит настоящего пампа (цена упущенной защиты)", () => {
    // forward здесь — рост, против short это не каскад, но для long-veto forward вверх = не against
    // → veto НЕ срабатывает, long входит и зарабатывает. Показываем что veto не режет реальный памп.
    const r = replayExit(realPumpFuture, "long", 99, 101, E({ squeezePolicy: "veto", squeezeThreshold: 0.6, cascadeWindowMinutes: 3 }));
    expect(r.entered).toBe(true);   // рост не against long → veto не срабатывает
    expect(r.pnl).toBeGreaterThan(0); // памп пойман
  });
});
