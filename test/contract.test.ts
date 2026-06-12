import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams, intersectPolicy, DEFAULT_POLICY } from "../src/index";
import { ICandleData } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const candles = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

const base = {
  hardStop: 1, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 240,
  volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20,
};

function model(policy: TrainedParams["policy"], squeezePolicy: "veto" | "invert" | "tighten" | "none"): PumpMatrix {
  const params: TrainedParams = {
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: {
      cells: { single: { ch: { SOLUSDT: {
        long: { anomalous: { ...base, trailingTake: 1.0, squeezePolicy }, calm: { ...base, trailingTake: 2.0, squeezePolicy: "none" } },
        short: { anomalous: { ...base, trailingTake: 0.7, squeezePolicy: "none" }, calm: { ...base, trailingTake: 0.7, squeezePolicy: "none" } },
      } } }, matrix: {} },
      bySymbolDir: { single: { SOLUSDT: { long: { ...base, trailingTake: 1.5, squeezePolicy: "none" } } }, matrix: {} },
      byMode: { single: { ...base, trailingTake: 1.0 }, matrix: { ...base, trailingTake: 2.0 } },
      global: { ...base, trailingTake: 1.0 },
    },
    policy,
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.05, nestedScore: null, cvWinrate: 0.6, cvSupport: 20,
      gridSize: 100, mode: "single", impactHorizonMinutes: 240,
      confidence: 0.7, reliable: true, support: 0.8, stability: 0.7, significance: 0.8, totalSamples: 60,
    },
  };
  return PumpMatrix.load(params);
}

// каскад вниз против long → high squeezePressure
const trap = () => {
  const rows: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < 20; i++) rows.push([100, 100.5, 99.5, 100, 800 + (i % 5) * 100]);
  rows.push([100, 100.6, 99.9, 100.4, 9000]);
  rows.push([100.4, 100.5, 98, 98.2, 9000]);
  rows.push([98.2, 98.3, 96, 96.4, 9000]);
  return candles(rows);
};

describe("единый контракт TradeSignal", () => {
  it("сигнал — плоская исполняемая часть + origin, без флагов", () => {
    const cs = candles([...Array(22)].map((_, i) => [100, 101, 99.5, 100, 1000] as [number, number, number, number, number]));
    const s = model(DEFAULT_POLICY, "none").planForAt("SOLUSDT", "long", "ch", cs, cs[20].timestamp);
    expect(s).not.toBe(null);
    // исполняемое
    expect(typeof s!.direction).toBe("string");
    expect(typeof s!.exit.trailingTake).toBe("number");
    expect(typeof s!.exit.hardStop).toBe("number");
    expect(typeof s!.exit.impactHorizonMinutes).toBe("number");
    expect(["enter", "invert", "tighten"]).toContain(s!.action);
    // происхождение — в origin, не флагами
    expect(s!.origin).toHaveProperty("detector");
    expect(s!.origin).toHaveProperty("invertedFrom");
    expect(s!.origin).toHaveProperty("exitSource");
    // нет старых флагов
    expect((s as any).inverted).toBeUndefined();
    expect((s as any).recommendation).toBeUndefined();
    expect((s as any).originalDirection).toBeUndefined();
  });

  it("veto НЕ попадает в выдачу (фильтр внутри)", () => {
    const s = model(DEFAULT_POLICY, "veto").planForAt("SOLUSDT", "long", "ch", trap(), trap()[20].timestamp);
    expect(s).toBe(null);
  });

  it("invert → direction развёрнут, invertedFrom хранит исходное", () => {
    const s = model(DEFAULT_POLICY, "invert").planForAt("SOLUSDT", "long", "ch", trap(), trap()[20].timestamp);
    expect(s).not.toBe(null);
    expect(s!.action).toBe("invert");
    expect(s!.direction).toBe("short");        // развёрнут против long
    expect(s!.origin.invertedFrom).toBe("long");
  });
});

describe("allow-политика", () => {
  it("trained allow без invert → invert-каскад не отдаётся", () => {
    const m = model({ allow: ["enter", "tighten"] }, "invert");
    const s = m.planForAt("SOLUSDT", "long", "ch", trap(), trap()[20].timestamp);
    expect(s).toBe(null);
  });

  it("запрос сужает: allow=[enter] глушит invert даже если обучена с ним", () => {
    const m = model({ allow: ["enter", "invert", "tighten"] }, "invert");
    const s = m.planForAt("SOLUSDT", "long", "ch", trap(), trap()[20].timestamp, { allow: ["enter"] });
    expect(s).toBe(null);
  });

  it("policy геттер — readonly-копия зашитой политики", () => {
    const m = model({ allow: ["enter", "invert"] }, "none");
    expect(m.policy.allow).toEqual(["enter", "invert"]);
    m.policy.allow.push("tighten"); // мутация копии
    expect(m.policy.allow).toEqual(["enter", "invert"]); // оригинал не тронут
  });
});

describe("intersectPolicy — readonly-инвариант", () => {
  it("запрос не расширяет обученную политику", () => {
    const trained = { allow: ["enter"] as const };
    const eff = intersectPolicy({ allow: ["enter"] }, { allow: ["enter", "invert", "tighten"] });
    expect(eff.allow).toEqual(["enter"]); // invert/tighten не в обученной → отброшены
  });

  it("без запроса → копия обученной", () => {
    const eff = intersectPolicy({ allow: ["enter", "invert"] });
    expect(eff.allow).toEqual(["enter", "invert"]);
  });

  it("пересечение сохраняет порядок запроса, фильтрует по обученной", () => {
    const eff = intersectPolicy({ allow: ["enter", "tighten"] }, { allow: ["tighten", "invert", "enter"] });
    expect(eff.allow).toEqual(["tighten", "enter"]);
  });
});

describe("обратная совместимость", () => {
  it("params без policy → DEFAULT_POLICY (все исходы)", () => {
    const m = model(undefined as any, "none");
    expect(m.policy.allow).toEqual(DEFAULT_POLICY.allow);
  });
});
