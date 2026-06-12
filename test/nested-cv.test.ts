import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";
import {
  conservatismKey, isMoreConservative, cascadeAggressionOf, CASCADE_AGGRESSION, DEFAULT_SELECTION,
} from "../src/selection";
import { ExitParams } from "../src/replay";

const EX = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, ...o,
});

describe("selection — порядок консервативности (без магических литералов)", () => {
  it("cascadeAggressionOf: none<tighten<veto<invert", () => {
    expect(cascadeAggressionOf("none")).toBe(0);
    expect(cascadeAggressionOf("tighten")).toBe(1);
    expect(cascadeAggressionOf("veto")).toBe(2);
    expect(cascadeAggressionOf("invert")).toBe(3);
  });
  it("cascadeAggressionOf: undefined → none", () => {
    expect(cascadeAggressionOf(undefined)).toBe(CASCADE_AGGRESSION.none);
  });
  it("conservatismKey: [hardStop, staleMinutes, aggression, -score]", () => {
    const k = conservatismKey(EX({ hardStop: 2, staleMinutes: 240, squeezePolicy: "veto" }), 0.05);
    expect(k).toEqual([2, 240, 2, -0.05]);
  });
  it("меньший hardStop → консервативнее", () => {
    const a = { exit: EX({ hardStop: 1 }), cvScore: 0.05 };
    const b = { exit: EX({ hardStop: 3 }), cvScore: 0.05 };
    expect(isMoreConservative(a, b)).toBe(true);
    expect(isMoreConservative(b, a)).toBe(false);
  });
  it("при равном hardStop → короче staleMinutes консервативнее", () => {
    const a = { exit: EX({ hardStop: 2, staleMinutes: 60 }), cvScore: 0.05 };
    const b = { exit: EX({ hardStop: 2, staleMinutes: 1440 }), cvScore: 0.05 };
    expect(isMoreConservative(a, b)).toBe(true);
  });
  it("при равных риске/горизонте → мягче политика каскада", () => {
    const a = { exit: EX({ hardStop: 2, staleMinutes: 240, squeezePolicy: "none" }), cvScore: 0.05 };
    const b = { exit: EX({ hardStop: 2, staleMinutes: 240, squeezePolicy: "invert" }), cvScore: 0.05 };
    expect(isMoreConservative(a, b)).toBe(true);
  });
  it("полное равенство exit → выше score (детерминизм tie-break)", () => {
    const a = { exit: EX(), cvScore: 0.06 };
    const b = { exit: EX(), cvScore: 0.05 };
    expect(isMoreConservative(a, b)).toBe(true); // -0.06 < -0.05
  });
  it("DEFAULT_SELECTION: seMultiplier=1, nestedOuterFolds=4", () => {
    expect(DEFAULT_SELECTION.seMultiplier).toBe(1);
    expect(DEFAULT_SELECTION.nestedOuterFolds).toBe(4);
  });
});

describe("nested CV — несмещённая оценка + прогресс", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const SYMS = ["SOL", "TRX", "NEAR", "POL"];
  const items: ParserItem[] = [];
  for (let d = 0; d < 40; d++) for (let k = 0; k < 3; k++)
    items.push({ channel: "yoda", symbol: SYMS[(d * 3 + k) % SYMS.length] + "USDT", direction: k % 2 ? "long" : "short", ts: t0 + d * 86400_000 + k * 3 * 3600_000, entryFromPrice: 100, entryToPrice: 101 });
  const gc: GetCandles = async (s, i, lim, sd) => {
    const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
    const out: ICandleData[] = [];
    for (let k = 0; k < n; k++) { const p = 100 + k * 0.01; out.push({ timestamp: since + k * step, open: p, high: p * 1.002, low: p * 0.999, close: p * 1.001, volume: 1000 + (k % 7) * 80 }); }
    return out;
  };
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: [0.5, 1.0], hardStop: [1.0, 2.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
    staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
    volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
  };

  it("nestedScore считается и кладётся в meta", async () => {
    const m = await PumpMatrix.fit(items, gc, { mode: "single", grid, onProgress: silentProgress });
    const meta = JSON.parse(m.save()).meta;
    expect(meta.nestedScore).not.toBe(null);
    expect(typeof meta.nestedScore).toBe("number");
  });

  it("прогресс тикает на КАЖДЫЙ внешний фолд (терминал не молчит)", async () => {
    const nestedTicks: Array<{ done: number; total: number }> = [];
    await PumpMatrix.fit(items, gc, { mode: "single", grid, onProgress: (e) => { if (e.phase === "nested") nestedTicks.push({ done: e.done, total: e.total }); } });
    expect(nestedTicks.length).toBe(4); // outer=4 фолда
    expect(nestedTicks.map((t) => t.done)).toEqual([1, 2, 3, 4]);
    expect(nestedTicks.every((t) => t.total === 4)).toBe(true);
  });

  it("nestedOuterFolds=0 → nested не считается (nestedScore null)", async () => {
    const m = await PumpMatrix.fit(items, gc, { mode: "single", grid, onProgress: silentProgress, selection: { nestedOuterFolds: 0 } });
    expect(JSON.parse(m.save()).meta.nestedScore).toBe(null);
  });

  it("nestedScore обычно НИЖЕ cvScore (снят winner's curse)", async () => {
    const m = await PumpMatrix.fit(items, gc, { mode: "single", grid, onProgress: silentProgress });
    const meta = JSON.parse(m.save()).meta;
    // out-of-sample оценка не должна превышать in-sample (иначе нет смысла)
    // допускаем равенство на вырожденных данных, но не выше с заметным отрывом
    expect(meta.nestedScore).toBeLessThanOrEqual(meta.cvScore + 1e-6);
  });

  it("nested не меняет ВЫБОР конфигурации (только оценку)", async () => {
    const withNested = await PumpMatrix.fit(items, gc, { mode: "single", grid, onProgress: silentProgress, selection: { nestedOuterFolds: 4 } });
    const without = await PumpMatrix.fit(items, gc, { mode: "single", grid, onProgress: silentProgress, selection: { nestedOuterFolds: 0 } });
    // выбранный exit одинаков — nested влияет только на meta.nestedScore
    expect(withNested.exit.global.hardStop).toBe(without.exit.global.hardStop);
    expect(withNested.exit.global.trailingTake).toBe(without.exit.global.trailingTake);
  });
});
