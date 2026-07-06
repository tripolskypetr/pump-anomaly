import { describe, it, expect } from "vitest";
import {
  fitOutcomeModel, predictOutcome, OutcomeRow,
  exitProposalsFromPath, selfTuneLagDetail, buildTable, earlyWarning, train, replayExit,
} from "../src/index";
import { SignalEvent, ParserItem, DEFAULT_CONFIG } from "../src/types";
import { ExitParams } from "../src/replay";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// МОДЕЛЬ ИСХОДА: изотонные LLR + OOF-калибровка + informative-гвард.
// ─────────────────────────────────────────────────────────────────────────────
describe("outcome-model — калиброванная P(win|признаки)", () => {
  const mkRows = (n: number, gen: (i: number) => { y: 0 | 1; f: Record<string, number | null> }): OutcomeRow[] =>
    Array.from({ length: n }, (_, i) => {
      const { y, f } = gen(i);
      return { y, pnl: y ? 0.01 : -0.008, ts: t0 + i * HOUR, features: f };
    });

  it("сепарирующий признак → informative, pWin монотонна и калибрована", () => {
    // momentum > 0 → P(win)=0.8; иначе 0.2 (детерминированный чередующийся шум)
    const rows = mkRows(200, (i) => {
      const mom = (i % 2 === 0 ? 1 : -1) * (1 + (i % 5));
      const win = mom > 0 ? i % 10 < 8 : i % 10 < 2;
      return { y: win ? 1 : 0, f: { momentum: mom, noise: (i * 7) % 13 } };
    });
    const m = fitOutcomeModel(rows)!;
    expect(m).not.toBe(null);
    expect(m.informative).toBe(true);
    expect(m.brier).toBeLessThan(m.brierPrior);
    const hi = predictOutcome(m, { momentum: 4, noise: 5 });
    const lo = predictOutcome(m, { momentum: -4, noise: 5 });
    expect(hi.pWin).toBeGreaterThan(0.6);
    expect(lo.pWin).toBeLessThan(0.4);
    // калибровка: E[pnl] согласован с pWin и средними win/loss
    expect(hi.expectedPnl).toBeGreaterThan(lo.expectedPnl);
    // отсутствующий признак — вклад 0, не краш
    const na = predictOutcome(m, { momentum: null, noise: null });
    expect(na.pWin).toBeGreaterThan(0.05);
    expect(na.pWin).toBeLessThan(0.95);
  });

  it("шумовые признаки → informative=false, pWin = prior (без псевдоточности)", () => {
    // исход не зависит от признаков
    const rows = mkRows(200, (i) => ({
      y: (i % 10 < 6 ? 1 : 0) as 0 | 1, // prior 0.6, независим от f
      f: { a: (i * 13) % 7, b: (i * 29) % 11 },
    }));
    const m = fitOutcomeModel(rows)!;
    expect(m).not.toBe(null);
    if (m.informative) {
      // если случайно «побила» prior — разница обязана быть косметической
      expect(m.brierPrior - m.brier).toBeLessThan(0.01);
    } else {
      const p = predictOutcome(m, { a: 3, b: 5 });
      expect(p.pWin).toBeCloseTo(m.prior, 6);
    }
  });

  it("мало данных или один класс → честный null", () => {
    expect(fitOutcomeModel(mkRows(10, () => ({ y: 1, f: { a: 1 } })))).toBe(null);
    expect(fitOutcomeModel(mkRows(50, () => ({ y: 1, f: { a: 1 } })))).toBe(null);
  });

  it("убывающая зависимость обрабатывается (direction −1)", () => {
    const rows = mkRows(160, (i) => {
      const x = i % 8; // больше x → хуже
      const win = x < 4 ? i % 10 < 8 : i % 10 < 2;
      return { y: win ? 1 : 0, f: { risk: x } };
    });
    const m = fitOutcomeModel(rows)!;
    expect(predictOutcome(m, { risk: 0 }).pWin).toBeGreaterThan(predictOutcome(m, { risk: 7 }).pWin);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E: fit строит модель, рантайм отдаёт probability и применяет EV-гейты.
// ─────────────────────────────────────────────────────────────────────────────
describe("outcome-model e2e — probability в сигнале, гейты minPWin/minExpectedPnlPct", () => {
  // GOOD растёт до и после поста; BAD падает до и после — momentum сепарирует исход
  const priceOf = (symbol: string, t: number): number => {
    const m = (t - t0) / MIN;
    const wave = Math.sin(m / 45) * 4; // вариативность pnl (иначе std=0)
    return symbol === "GOODUSDT"
      ? 100 * Math.exp(0.0004 * m + 0.0004 * wave)
      : 200 * Math.exp(-0.0004 * m - 0.0004 * wave);
  };
  const gc: GetCandles = async (symbol, _i, limit, sDate) => {
    const out: ICandleData[] = [];
    for (let i = 0; i < (limit ?? 0); i++) {
      const t = (sDate ?? 0) + i * MIN;
      const o = priceOf(symbol, t);
      const c = priceOf(symbol, t + MIN);
      out.push({
        timestamp: t, open: o, close: c,
        high: Math.max(o, c) * 1.0001, low: Math.min(o, c) * 0.9999,
        volume: 1000 + (Math.floor(t / MIN) % 5) * 50,
      });
    }
    return out;
  };
  const items: ParserItem[] = [];
  for (let k = 0; k < 14; k++) {
    const base = t0 + 24 * HOUR + k * 6 * HOUR;
    items.push({ channel: "ch", symbol: "GOODUSDT", direction: "long", ts: base });
    items.push({ channel: "ch", symbol: "BADUSDT", direction: "long", ts: base + 90 * MIN });
  }
  const opts = {
    folds: 3, mode: "single" as const, onProgress: silentProgress,
    channelTriage: false, momentumFeature: true, momentumWindowMinutes: 60,
    selection: { nestedOuterFolds: 0 },
    grid: {
      windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
      trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
      stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
      squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
      cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
    },
  };

  it("params.outcome обучен и информативен; сигнал несёт probability", async () => {
    const res = await train(items, gc, opts);
    expect(res.params.outcome).not.toBe(null);
    expect(res.params.outcome!.informative).toBe(true);

    const { PumpMatrix } = await import("../src/index");
    const m = PumpMatrix.load(PumpMatrix.load(res.params as never).save()); // переживает save/load
    const freshTs = t0 + 40 * 24 * HOUR;
    const pre = async (sym: string) => ({ [sym]: await gc(sym, "1m", 65, freshTs - 65 * MIN) });
    const goodSig = m.plan([{ channel: "ch", symbol: "GOODUSDT", direction: "long", ts: freshTs }], await pre("GOODUSDT"));
    const badSig = m.plan([{ channel: "ch", symbol: "BADUSDT", direction: "long", ts: freshTs }], await pre("BADUSDT"));
    expect(goodSig[0].probability!.pWin).toBeGreaterThan(badSig[0].probability!.pWin);
    expect(goodSig[0].probability!.expectedPnl).toBeGreaterThan(badSig[0].probability!.expectedPnl);

    // EV-гейты: порог между pWin двух сигналов отрезает плохой
    const thr = (goodSig[0].probability!.pWin + badSig[0].probability!.pWin) / 2;
    const both = [
      { channel: "ch", symbol: "GOODUSDT", direction: "long" as const, ts: freshTs },
      { channel: "ch", symbol: "BADUSDT", direction: "long" as const, ts: freshTs },
    ];
    const dict = { ...(await pre("GOODUSDT")), ...(await pre("BADUSDT")) };
    const gated = m.plan(both, dict, { minPWin: thr });
    expect(gated.map((s) => s.symbol)).toEqual(["GOODUSDT"]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// N_eff: дисбаланс кластеров — дробное число независимых авторов.
// ─────────────────────────────────────────────────────────────────────────────
describe("nEffClusters — participation ratio вместо целых кластеров", () => {
  const mk = (channels: string[]): SignalEvent[] =>
    channels.map((c, i) => ({ channel: c, symbol: "SOLUSDT", direction: "long", ts: t0 + 40 * 24 * HOUR + i * MIN }));
  const history: SignalEvent[] = Array.from({ length: 4 }, (_, i) => ({
    channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 + i * 7 * 24 * HOUR,
  }));
  const clusters = new Map([["a", 0], ["b", 1], ["c", 2]]);
  const cfg = { ...DEFAULT_CONFIG, minClusters: 2 };

  it("сбалансированный {a,a,b,b} → N_eff=2; перекошенный {a,a,a,b} → ≈1.6", () => {
    // срезы ОДИНАКОВОЙ длины: fill равный, разница только в балансе кластеров
    const bal = earlyWarning(buildTable([...history, ...mk(["a", "b", "a", "b"])]), clusters, cfg, 5 * MIN)
      .find((v) => v.action === "open")!;
    expect(bal.nEffClusters!).toBeCloseTo(2, 2);
    const skew = earlyWarning(buildTable([...history, ...mk(["a", "a", "a", "b"])]), clusters, cfg, 5 * MIN)
      .find((v) => v.action === "open")!;
    expect(skew.nEffClusters!).toBeLessThan(1.7);
    expect(skew.nEffClusters!).toBeGreaterThan(1.5);
    // дисбаланс наказан в confidence (та же пара кластеров, тот же fill!)
    expect(skew.confidence).toBeLessThan(bal.confidence);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EM-τ: смесь «пик + фон» точнее модального бина.
// ─────────────────────────────────────────────────────────────────────────────
describe("selfTuneLagDetail — EM-смесь для τ", () => {
  it("острый пик 3 мин на фоне равномерного шума → τ ≈ 3 мин, вес пика заметен", () => {
    const events: SignalEvent[] = [];
    // 30 братских пар с лагом ~3 мин
    for (let i = 0; i < 30; i++) {
      const base = t0 + i * 8 * HOUR;
      events.push({ channel: "x", symbol: "TRXUSDT", direction: "short", ts: base });
      events.push({ channel: "y", symbol: "TRXUSDT", direction: "short", ts: base + 3 * MIN + (i % 3) * 20_000 });
    }
    const d = selfTuneLagDetail(buildTable(events));
    expect(d.tauMs).toBeGreaterThan(1.5 * MIN);
    expect(d.tauMs).toBeLessThan(6 * MIN);
    expect(d.peakWeight).toBeGreaterThan(0.3);
    expect(d.n).toBeGreaterThan(20);
  });

  it("мало данных → дефолт 15 мин, peakWeight 0", () => {
    const d = selfTuneLagDetail(buildTable([]));
    expect(d.tauMs).toBe(15 * MIN);
    expect(d.peakWeight).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAE/MFE: trough в replay и квантильные предложения exit.
// ─────────────────────────────────────────────────────────────────────────────
describe("trough (MAE) и exitProposalsFromPath", () => {
  const C = (rows: Array<[number, number, number, number]>): ICandleData[] =>
    rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: 1000 }));
  const E = (o: Partial<ExitParams> = {}): ExitParams => ({
    trailingTake: 50, hardStop: 50, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 5, ...o,
  });

  it("replay записывает худшую экскурсию пути; при стопе trough = −hardStop%", () => {
    // просадка до −1.5% (low 98.5), потом рост к +2%
    const cs = C([
      [100, 100.05, 99.95, 100],
      [100, 100.1, 98.5, 99],
      [99, 101, 99, 100.5],
      [100.5, 102, 100.4, 102],
      [102, 102.1, 101.8, 102],
      [102, 102.1, 101.9, 102],
    ]);
    const r = replayExit(cs, "long", 99.95, 100.05, E());
    expect(r.trough).toBeCloseTo(-0.015, 3);
    expect(r.pnl).toBeGreaterThan(0); // победитель с просадкой — сырьё для стопа
    const stopped = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 1 }));
    expect(stopped.reason).toBe("hard-stop");
    expect(stopped.trough).toBeCloseTo(-0.01, 9); // реализованная экскурсия ограничена стопом
  });

  it("предложения: стоп = p90|MAE| победителей, мало победителей → пусто", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      pnl: 0.02, peak: 0.03, trough: -0.002 - (i / 19) * 0.008, entered: true, // MAE 0.2%..1%
    }));
    const p = exitProposalsFromPath(rows);
    expect(p.hardStop.length).toBe(2);
    expect(p.hardStop[0]).toBeGreaterThan(0.85); // p90 ≈ 0.92%
    expect(p.hardStop[0]).toBeLessThan(1.0);
    expect(p.trailingTake[0]).toBeCloseTo(1.0, 1); // give-back = peak−pnl = 1% у всех
    expect(exitProposalsFromPath(rows.slice(0, 5)).hardStop.length).toBe(0);
  });

  it("refinement принимает квантильное предложение, когда сетка мимо оптимума", async () => {
    // мир из refinement.test: оптимум trailing ≈1.0..1.1 между узлами [0.5, 2];
    // give-back победителей (peak 2% − close 0.9%) = 1.1% → предложение попадает в зону
    const CYCLE = 120;
    const closeAt = (t: number): number => {
      const m = Math.floor((t - t0) / MIN) % CYCLE;
      if (m < 0) return 100;
      if (m === 0) return 101;
      if (m === 1) return 100.4;
      if (m === 2) return 102;
      if (m === 3) return 100.9;
      return 97;
    };
    const gc: GetCandles = async (_s, _i, limit, sDate) => {
      const out: ICandleData[] = [];
      for (let i = 0; i < (limit ?? 0); i++) {
        const t = (sDate ?? 0) + i * MIN;
        const m = Math.floor((t - t0) / MIN) % CYCLE;
        const open = m === 0 ? 100 : closeAt(t - MIN);
        const close = closeAt(t);
        out.push({ timestamp: t, open, close, high: Math.max(open, close), low: Math.min(open, close) - 0.01, volume: 1000 });
      }
      return out;
    };
    const items: ParserItem[] = Array.from({ length: 12 }, (_, k) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * CYCLE * MIN,
    }));
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress, refineRounds: 1,
      channelTriage: false, outcomeModel: false,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [0.5, 2], hardStop: [50], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    // принят вариант из зоны оптимума (геосередина 1.0 или квантильное 1.1) — не узлы сетки
    expect(res.params.exit.global.trailingTake).toBeGreaterThanOrEqual(0.9);
    expect(res.params.exit.global.trailingTake).toBeLessThanOrEqual(1.2);
    expect(res.params.meta.refinement!.accepted).toBeGreaterThanOrEqual(1);
  });
});
