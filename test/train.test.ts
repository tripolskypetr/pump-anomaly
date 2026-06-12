import { describe, it, expect } from "vitest";
import { train, loadPredict, PumpMatrix, TrainedParams } from "../src/index";
import { shrinkageExpectancy, winrate } from "../src/objective";
import { buildFixture } from "./fixture";
import { makeGetCandles, PriceInjection } from "./fake-candles";

describe("shrinkageExpectancy — objective", () => {
  it("усаживает к нулю при малой выборке", () => {
    const big = new Array(100).fill(0.05);
    const small = [0.05];
    expect(shrinkageExpectancy(small, 5)).toBeLessThan(shrinkageExpectancy(big, 5));
  });
  it("при N=k режет вклад примерно вдвое", () => {
    const r = new Array(5).fill(0.1);
    expect(shrinkageExpectancy(r, 5)).toBeCloseTo(0.05, 6);
  });
  it("пустой вход → 0", () => {
    expect(shrinkageExpectancy([], 5)).toBe(0);
    expect(winrate([])).toBe(0);
  });
});

describe("train (v2) — replay-метка + exit grid", () => {
  const fx = buildFixture();
  const pumpTs = fx.t0 + 12 * 24 * 3600_000 + 9 * 3600_000;
  const injections: PriceInjection[] = [
    { symbol: "SOLUSDT", ts: pumpTs, direction: "long", drift: 0.10 },
  ];
  const getCandles = makeGetCandles(injections);

  const smallGrid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5],
    minClusters: [2], trailingTake: [1.0], hardStop: [2.0],
    stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
    staleMinutes: [240, 720],
  };

  it("возвращает v2 params с подобранным exit и импакт-горизонтом", async () => {
    const res = await train(fx.items, getCandles, { folds: 3, grid: smallGrid });
    expect(res.params.version).toBe(3);
    expect(res.params.exit.global.trailingTake).toBe(1.0);
    expect([240, 720]).toContain(res.params.meta.impactHorizonMinutes);
    expect(typeof res.predict).toBe("function");
    expect(typeof res.reliability.confidence).toBe("number");
    expect(res.params.meta.confidence).toBe(res.reliability.confidence);
  });

  it("params проходят JSON round-trip → тот же predict", async () => {
    const res = await train(fx.items, getCandles, { folds: 3, grid: smallGrid });
    const restored: TrainedParams = JSON.parse(JSON.stringify(res.params));
    const predict2 = loadPredict(restored);
    const a = res.predict(fx.items);
    const b = predict2(fx.items);
    expect(b.signals).toEqual(a.signals);
  });

  it("loadPredict отвергает несовместимую версию", () => {
    const bad = { version: 2 } as unknown as TrainedParams;
    expect(() => loadPredict(bad)).toThrow();
  });
});

describe("PumpMatrix — casual API", () => {
  const fx = buildFixture();
  const pumpTs = fx.t0 + 12 * 24 * 3600_000 + 9 * 3600_000;
  const getCandles = makeGetCandles([{ symbol: "SOLUSDT", ts: pumpTs, direction: "long", drift: 0.10 }]);
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
    trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
    stalenessSinceMinutes: [240], staleMinutes: [240],
  };

  it("fit → save → load → signals: сквозной поток", async () => {
    const model = await PumpMatrix.fit(fx.items, getCandles, { folds: 3, grid });
    const json = model.save();
    expect(typeof json).toBe("string");

    const loaded = PumpMatrix.load(json);
    const plansA = model.signals(fx.items);
    const plansB = loaded.signals(fx.items);
    expect(plansB).toEqual(plansA);
  });

  it("каждый сигнал несёт exit-план (trailing/hardStop/импакт-горизонт)", async () => {
    const model = await PumpMatrix.fit(fx.items, getCandles, { folds: 3, grid });
    const plans = model.signals(fx.items);
    for (const p of plans) {
      expect(p.exit.trailingTake).toBe(1.0);
      expect(p.exit.hardStop).toBe(2.0);
      expect(p.exit.impactHorizonMinutes).toBe(240);
      expect(typeof p.origin.modelReliable).toBe("boolean");
    }
  });

  it("геттеры exit/reliable/confidence/impactHorizon доступны", async () => {
    const model = await PumpMatrix.fit(fx.items, getCandles, { folds: 3, grid });
    expect(model.exit.global.staleMinutes).toBe(240);
    expect(typeof model.reliable).toBe("boolean");
    expect(model.impactHorizonMinutes).toBe(240);
  });
});
