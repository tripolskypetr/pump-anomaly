import { describe, it, expect } from "vitest";
import { PumpMatrix, TrainedParams, ParserItem, train } from "../src/index";
import { replayExit, ExitParams } from "../src/replay";
import { intersectPolicy } from "../src/signal";
import { ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";
import { buildFixture } from "./fixture";
import { makeGetCandles, PriceInjection } from "./fake-candles";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const C = (rows: Array<[number, number, number, number, number]>): ICandleData[] =>
  rows.map((r, i) => ({ timestamp: t0 + i * MIN, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] }));

// ─────────────────────────────────────────────────────────────────────────────
// ИЗДЕРЖКИ ИСПОЛНЕНИЯ: бэктест без комиссий/проскальзывания систематически
// красивее реальности. roundTripCostPct вычитается из НЕТТО pnl каждой
// ВОШЕДШЕЙ сделки; не вошли — не заплатили.
// ─────────────────────────────────────────────────────────────────────────────
describe("roundTripCostPct — реальная стоимость сделки в каждой метке", () => {
  const E = (o: Partial<ExitParams> = {}): ExitParams => ({
    trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240, staleMinutes: 5, ...o,
  });

  it("trailing-take: нетто = close-реализация минус издержки", () => {
    const cs = C([
      [100, 100.05, 99.95, 100, 1000],
      [100, 103, 100, 103, 1000],       // пик +3%
      [103, 103, 101.5, 101.9, 1000],   // откат: close +1.9% → триггер
    ]);
    const gross = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 5 }));
    const net = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 5, roundTripCostPct: 0.2 }));
    expect(gross.pnl).toBeCloseTo(0.019, 9);
    expect(net.pnl).toBeCloseTo(0.019 - 0.002, 9);
    expect(net.exitPrice).toBeCloseTo(gross.exitPrice, 9); // цена рынка гросс, издержки в pnl
  });

  it("hard-stop: нетто = -hardStop% - издержки (стоп в реальности ещё дороже)", () => {
    const cs = C([[100, 100.05, 99.95, 100, 1000], [100, 100, 95, 96, 1000]]);
    const r = replayExit(cs, "long", 99.95, 100.05, E({ hardStop: 2, roundTripCostPct: 0.2 }));
    expect(r.reason).toBe("hard-stop");
    expect(r.pnl).toBeCloseTo(-0.02 - 0.002, 9);
  });

  it("life-cap: нетто = close минус издержки; боковик из плюса уходит в минус", () => {
    const rows: Array<[number, number, number, number, number]> = [[100, 100.05, 99.95, 100, 1000]];
    for (let i = 0; i < 5; i++) rows.push([100, 100.1, 99.95, 100.05, 1000]); // едва +0.05%
    const r = replayExit(C(rows), "long", 99.95, 100.05, E({ trailingTake: 50, hardStop: 50, roundTripCostPct: 0.2 }));
    expect(r.reason).toBe("life-cap");
    expect(r.pnl).toBeLessThan(0); // +0.05% гросс − 0.2% издержек = минус: боковик не «бесплатен»
  });

  it("no-entry: не вошли — не заплатили (pnl 0)", () => {
    const cs = C([[100, 101, 99, 100, 1000]]);
    const r = replayExit(cs, "long", 150, 151, E({ roundTripCostPct: 0.2 }));
    expect(r.entered).toBe(false);
    expect(r.pnl).toBe(0);
  });

  it("train штампует издержки в каждый exit тензора (прод реплеит с ними же)", async () => {
    const fx = buildFixture();
    const pumpTs = fx.t0 + 12 * 24 * 3600_000 + 9 * 3600_000;
    const injections: PriceInjection[] = [{ symbol: "SOLUSDT", ts: pumpTs, direction: "long", drift: 0.10 }];
    const res = await train(fx.items, makeGetCandles(injections), {
      folds: 3, mode: "single", onProgress: silentProgress,
      roundTripCostPct: 0.25,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
        stalenessSinceMinutes: [240], staleMinutes: [240], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
      },
      selection: { nestedOuterFolds: 0 },
    });
    expect(res.params.exit.global.roundTripCostPct).toBe(0.25);
    expect(res.params.exit.byMode.single.roundTripCostPct).toBe(0.25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ПОДТВЕРЖДЕНИЕ РЫНКОМ (requireVolumeConfirm): пост без аномалии объёма на ленте
// до входа — не памп, а шум. Гейт превращает «математику постов» в
// «посты + подтверждение ленты», строго без look-ahead.
// ─────────────────────────────────────────────────────────────────────────────
describe("requireVolumeConfirm — сигнал только при аномальном объёме на ленте", () => {
  const ex = (): ExitParams & Record<string, unknown> => ({
    trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 240, volZThreshold: 2.0, squeezeThreshold: 0.6, volBaselineWindow: 20,
    squeezePolicy: "none", cascadeWindowMinutes: 30,
  });
  const model = (policy: object): PumpMatrix => PumpMatrix.load({
    version: 3,
    config: { windowK: 3, minClusters: 1, jaccardThreshold: 0.3, lagPeakThreshold: 0.5, maxBurstWindowMs: 3600_000, mode: "single", stationarityWindowMs: Infinity },
    exit: {
      cells: { single: {}, matrix: {} }, bySymbolDir: { single: {}, matrix: {} },
      byMode: { single: ex(), matrix: ex() }, global: ex(),
    },
    policy: policy as TrainedParams["policy"],
    riskReward: { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } },
    pnl: { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } },
    meta: {
      trainedAt: 0, folds: 4, shrinkageK: 5, cvScore: 0.01, nestedScore: null, cvWinrate: 0.6, cvSupport: 10,
      gridSize: 10, mode: "single", modeReason: "x", impactHorizonMinutes: 240,
      confidence: 0.4, reliable: false, support: 0.5, stability: 0.5, significance: 0.5, totalSamples: 10,
    },
  } as TrainedParams);

  // 26 свечей строго ДО сигнала; последняя — с объёмом spike (набор позиции автором)
  const tape = (lastVolume: number): ICandleData[] => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 25; i++) rows.push([100, 100.3, 99.7, 100, 800 + (i % 5) * 100]);
    rows.push([100, 100.5, 99.9, 100.4, lastVolume]);
    return C(rows);
  };
  const sigTs = t0 + 26 * MIN; // сигнал после последней свечи ленты (без look-ahead)
  const item = (symbol = "SOLUSDT"): ParserItem => ({ channel: "ch", symbol, direction: "long", ts: sigTs });

  it("аномальный объём до поста → сигнал проходит", () => {
    const m = model({ allow: ["enter"], requireVolumeConfirm: true });
    const out = m.plan([item()], { SOLUSDT: tape(9000) });
    expect(out.length).toBe(1);
    expect(out[0].origin.volRegime).toBe("anomalous");
  });

  it("спокойная лента (пост без рыночной реакции) → сигнал отрезан", () => {
    const m = model({ allow: ["enter"], requireVolumeConfirm: true });
    expect(m.plan([item()], { SOLUSDT: tape(1000) }).length).toBe(0);
  });

  it("нет свечей → подтвердить нечем → консервативно режем (signals() пуст)", () => {
    const m = model({ allow: ["enter"], requireVolumeConfirm: true });
    expect(m.signals([item()]).length).toBe(0);
    expect(m.plan([item()], {}).length).toBe(0); // пустой словарь — тоже нет ленты
  });

  it("без флага поведение прежнее (обратная совместимость)", () => {
    const m = model({ allow: ["enter"] });
    expect(m.plan([item()], { SOLUSDT: tape(1000) }).length).toBe(1);
    expect(m.signals([item()]).length).toBe(1);
  });

  it("рантайм может ВКЛЮЧИТЬ гейт (ужесточение), но не выключить вшитый", () => {
    const off = model({ allow: ["enter"] });
    // включаем на один вызов
    expect(off.plan([item()], { SOLUSDT: tape(1000) }, { requireVolumeConfirm: true }).length).toBe(0);
    expect(off.plan([item()], { SOLUSDT: tape(9000) }, { requireVolumeConfirm: true }).length).toBe(1);
    // выключить вшитый нельзя
    const on = model({ allow: ["enter"], requireVolumeConfirm: true });
    expect(on.plan([item()], { SOLUSDT: tape(1000) }, { requireVolumeConfirm: false }).length).toBe(0);
  });

  it("intersectPolicy: tighten-only для requireVolumeConfirm", () => {
    expect(intersectPolicy({ allow: ["enter"], requireVolumeConfirm: true }, {}).requireVolumeConfirm).toBe(true);
    expect(intersectPolicy({ allow: ["enter"], requireVolumeConfirm: true }, { requireVolumeConfirm: false }).requireVolumeConfirm).toBe(true);
    expect(intersectPolicy({ allow: ["enter"] }, { requireVolumeConfirm: true }).requireVolumeConfirm).toBe(true);
    expect(intersectPolicy({ allow: ["enter"] }, {}).requireVolumeConfirm).toBeUndefined();
  });

  it("policy getter отдаёт флаг (полный аудит)", () => {
    expect(model({ allow: ["enter"], requireVolumeConfirm: true }).policy.requireVolumeConfirm).toBe(true);
  });

  it("СЦЕНАРИЙ точности: реальный памп проходит, пост-пустышка режется", () => {
    // два одновременных поста: SOL — автор набрал позицию (всплеск объёма до поста),
    // POL — «сигнал» без какой-либо реакции ленты. Гейт оставляет только SOL.
    const m = model({ allow: ["enter"] });
    const items = [item("SOLUSDT"), item("POLUSDT")];
    const out = m.plan(items, { SOLUSDT: tape(9000), POLUSDT: tape(1000) }, { requireVolumeConfirm: true });
    expect(out.map((s) => s.symbol)).toEqual(["SOLUSDT"]);
    // без гейта прошли бы оба — это и есть источник ложных входов
    expect(m.plan(items, { SOLUSDT: tape(9000), POLUSDT: tape(1000) }).length).toBe(2);
  });
});
