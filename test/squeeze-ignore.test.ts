import { describe, it, expect } from "vitest";
import { replayExit, ExitParams } from "../src/replay";
import { PumpMatrix, TrainedParams } from "../src/index";
import { cascadeAggressionOf } from "../src/selection";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));
const E = (o: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 50, hardStop: 50, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 5, ...o,
});

// long + каскад ВНИЗ (объём против long): squeezePressure высокий
const cascadeDown = C([
  [100, 100.05, 99.95, 100, 1000],
  [100, 100, 97, 97.1, 9000],
  [97.1, 97.2, 95, 95.5, 9000],
  [95.5, 96, 94, 94.5, 9000],
]);

describe("squeezePolicy=ignore — replay входит вопреки каскаду и берёт плохой pnl", () => {
  it("ignore входит в исходном направлении, фиксирует sqPressure, реализует убыток", () => {
    const r = replayExit(cascadeDown, "long", 99.95, 100.05,
      E({ squeezePolicy: "ignore", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 50, staleMinutes: 3 }));
    expect(r.entered).toBe(true);            // вошли, не отсеклись
    expect(r.inverted).toBe(false);          // НЕ инвертировались
    expect(r.squeezePressure).toBeGreaterThanOrEqual(0.6); // каскад замечен
    expect(r.pnl).toBeLessThan(0);           // плохой pnl реализован
  });

  it("ignore и none дают ОДИНАКОВЫЙ pnl в replay (оба входят без реакции)", () => {
    const ig = replayExit(cascadeDown, "long", 99.95, 100.05,
      E({ squeezePolicy: "ignore", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 50, staleMinutes: 3 }));
    const no = replayExit(cascadeDown, "long", 99.95, 100.05,
      E({ squeezePolicy: "none", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 50, staleMinutes: 3 }));
    expect(ig.pnl).toBeCloseTo(no.pnl, 9);
    expect(ig.entered).toBe(no.entered);
  });

  it("контраст: veto НЕ входит (pnl=0), ignore входит (pnl<0) на той же ловушке", () => {
    const veto = replayExit(cascadeDown, "long", 99.95, 100.05,
      E({ squeezePolicy: "veto", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 50, staleMinutes: 3 }));
    const ignore = replayExit(cascadeDown, "long", 99.95, 100.05,
      E({ squeezePolicy: "ignore", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 50, staleMinutes: 3 }));
    expect(veto.entered).toBe(false);
    expect(veto.pnl).toBe(0);
    expect(ignore.entered).toBe(true);
    expect(ignore.pnl).toBeLessThan(0);
    expect(ignore.pnl).toBeLessThan(veto.pnl); // ignore хуже veto на ловушке (в этом и смысл — контрфакт)
  });

  it("без каскада ignore ведёт себя как обычный вход (нет ловушки → нормальный pnl)", () => {
    // цена растёт → long в плюсе, каскада нет
    const up = C([[100, 100.05, 99.95, 100, 1000], [100, 105, 100, 105, 1000], [105, 110, 105, 110, 1000], [110, 112, 110, 111, 1000]]);
    const r = replayExit(up, "long", 99.95, 100.05,
      E({ squeezePolicy: "ignore", squeezeThreshold: 0.6, cascadeWindowMinutes: 1, hardStop: 50, staleMinutes: 3 }));
    expect(r.entered).toBe(true);
    expect(r.pnl).toBeGreaterThan(0);
  });
});

describe("squeezePolicy=ignore — фасад НЕ отсекает сигнал (в отличие от veto/invert)", () => {
  const mk = (pol: string): TrainedParams => {
    const ex = { hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20, trailingTake: 1.0, squeezePolicy: pol as any, cascadeWindowMinutes: 1 };
    return {
      version: 3,
      config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
      exit: { cells: { single: { ch: { SOLUSDT: { long: { anomalous: ex, calm: ex } } } }, matrix: {} }, bySymbolDir: { single: { SOLUSDT: { long: ex } }, matrix: {} }, byMode: { single: ex, matrix: ex }, global: ex },
      policy: { allow: ["enter", "invert", "tighten"] }, riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
      pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
      meta: { trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20, gridSize: 100, mode: "single", modeReason: "x", impactHorizonMinutes: 240, confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60 },
    } as TrainedParams;
  };
  const cs = C([[100, 100.05, 99.95, 100, 1000], [100, 100, 97, 97.1, 9000], [97.1, 97.2, 95, 95.5, 9000]]);

  it("ignore → входит в ИСХОДНОМ направлении (action=enter, dir=long)", () => {
    const s = PumpMatrix.load(mk("ignore")).planForAt("SOLUSDT", "long", "ch", cs, cs[0].timestamp);
    expect(s).not.toBe(null);
    expect(s!.action).toBe("enter");
    expect(s!.direction).toBe("long"); // НЕ инвертировано
  });

  it("veto → null, invert → short, ignore → long (три разных исхода на одном каскаде)", () => {
    const veto = PumpMatrix.load(mk("veto")).planForAt("SOLUSDT", "long", "ch", cs, cs[0].timestamp);
    const invert = PumpMatrix.load(mk("invert")).planForAt("SOLUSDT", "long", "ch", cs, cs[0].timestamp);
    const ignore = PumpMatrix.load(mk("ignore")).planForAt("SOLUSDT", "long", "ch", cs, cs[0].timestamp);
    expect(veto).toBe(null);
    expect(invert!.direction).toBe("short");
    expect(ignore!.direction).toBe("long");
  });

  it("ignore входит даже когда allow НЕ содержит invert (не зависит от инверс-разрешения)", () => {
    const p = mk("ignore");
    p.policy = { allow: ["enter"] }; // только enter
    const s = PumpMatrix.load(p).planForAt("SOLUSDT", "long", "ch", cs, cs[0].timestamp);
    expect(s).not.toBe(null);
    expect(s!.action).toBe("enter");
  });
});

describe("squeezePolicy=ignore — ось консервативности", () => {
  it("ignore наименее агрессивна (== none, ниже tighten/veto/invert)", () => {
    expect(cascadeAggressionOf("ignore")).toBe(cascadeAggressionOf("none"));
    expect(cascadeAggressionOf("ignore")).toBeLessThan(cascadeAggressionOf("tighten"));
    expect(cascadeAggressionOf("ignore")).toBeLessThan(cascadeAggressionOf("veto"));
    expect(cascadeAggressionOf("ignore")).toBeLessThan(cascadeAggressionOf("invert"));
  });
});
