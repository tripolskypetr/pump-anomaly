import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams, ParserItem } from "../src/index";
import { ExitParams } from "../src/replay";
import { ICandleData } from "../src/candle";
import { Certification } from "../src/statistics";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

// ЧЕСТНОСТЬ ПО УМОЛЧАНИЮ для пути fit→load→plan: прикладной кодер не обязан
// запускать walkForward — поэтому вердикт fit'а исполняется рантаймом сам:
// несертифицированная модель live-сигналы отдаёт только под явным
// acknowledgeUncertified (осознанный paper-режим).

const ex = (): ExitParams & Record<string, unknown> => ({
  trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
  staleMinutes: 60, volBaselineWindow: 20, squeezePolicy: "none", cascadeWindowMinutes: 15,
});
const cert = (certified: boolean): Certification => ({
  certified, dsr: certified ? 0.97 : 0.2, pbo: certified ? 0.05 : 0.6,
  spaPValue: certified ? 0.01 : 0.4, minTRL: 30, actualN: certified ? 60 : 10,
  nestedScore: certified ? 0.004 : -0.001,
  reasons: certified ? [] : ["DSR 0.200 < 0.95 — тест", "N=10 < minTRL=30 — тест"],
});
const model = (certification?: Certification, policy?: object): PumpMatrix => {
  const meta: Record<string, unknown> = {
    trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
    gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 60,
    confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
  };
  if (certification) meta.certification = certification;
  return PumpMatrix.load({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: { cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} }, byMode: { single: ex(), matrix: ex() }, global: ex() },
    policy: (policy ?? { allow: ["enter", "invert", "tighten"] }) as TrainedParams["policy"],
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta,
  } as never);
};
const item: ParserItem = { channel: "ch", symbol: "SOLUSDT", direction: "long", ts: t0 };
const rising = (): ICandleData[] =>
  Array.from({ length: 100 }, (_, i) => {
    const p = 100 + i * 0.05;
    return { timestamp: t0 + i * MIN, open: p, high: p + 0.1, low: p - 0.05, close: p + 0.05, volume: 1000 };
  });

describe("несертифицированная модель не торгует молча (fit→load→plan)", () => {
  it("красный сертификат → signals()/plan() пусты по умолчанию", () => {
    const m = model(cert(false));
    expect(m.signals([item]).length).toBe(0);
    expect(m.plan([item], { SOLUSDT: rising() }).length).toBe(0);
    expect(m.planFor("SOLUSDT", "long", "ch", rising())).toBe(null);
  });

  it("deployment объясняет молчание человеку", () => {
    const d = model(cert(false)).deployment;
    expect(d.verdict).toBe("paper");
    expect(d.reasons.join("\n")).toContain("acknowledgeUncertified");
    expect(d.reasons.join("\n")).toContain("DSR");
  });

  it("явное согласие → сигналы идут (осознанный paper-режим)", () => {
    const m = model(cert(false));
    expect(m.signals([item], { acknowledgeUncertified: true }).length).toBe(1);
    expect(m.plan([item], { SOLUSDT: rising() }, { acknowledgeUncertified: true }).length).toBe(1);
  });

  it("согласие можно вшить на fit через opts.policy", () => {
    const m = model(cert(false), { allow: ["enter"], acknowledgeUncertified: true });
    expect(m.signals([item]).length).toBe(1);
    expect(m.policy.acknowledgeUncertified).toBe(true);
  });

  it("backtest()/planForAt() — исследование прошлого, НЕ гейтятся", () => {
    const m = model(cert(false));
    expect(m.backtest([item], { SOLUSDT: rising() }).length).toBe(1);
    const cs = rising();
    expect(m.planForAt("SOLUSDT", "long", "ch", cs, cs[20].timestamp)).not.toBe(null);
  });
});

describe("сертифицированная и legacy модели работают без трения", () => {
  it("зелёный сертификат → live-методы как есть, deployment 'trade'", () => {
    const m = model(cert(true));
    expect(m.signals([item]).length).toBe(1);
    expect(m.deployment.verdict).toBe("trade");
  });

  it("legacy model.json без сертификата → гейт не применяется, deployment 'unknown'", () => {
    const m = model(undefined);
    expect(m.signals([item]).length).toBe(1);
    expect(m.deployment.verdict).toBe("unknown");
  });
});
