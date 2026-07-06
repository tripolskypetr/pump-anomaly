import { describe, it, expect } from "vitest";
import {
  simulateCapital, CapitalTrade,
  PaperTrader,
  placeboItems,
  predictOutcome, fitOutcomeModel, OutcomeModel, OutcomeRow,
  walkForward, assessEdge,
  ParserItem, TrainedParams,
} from "../src/index";
import { GetCandles } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// simulateCapital — Σpnl бесконечного капитала vs очередь слотов.
// ─────────────────────────────────────────────────────────────────────────────
describe("simulateCapital — капитальная одновременность", () => {
  const tr = (ts: number, pnl: number, held = 60, priority: number | null = null): CapitalTrade =>
    ({ ts, pnl, heldMinutes: held, priority });

  it("кластер из 3 сигналов в один момент при 1 слоте: взят лучший по priority", () => {
    const r = simulateCapital([
      tr(t0, -0.01, 60, 0.001),
      tr(t0, 0.03, 60, 0.02), // максимальный E[pnl] — модель исхода ранжирует
      tr(t0, 0.01, 60, 0.005),
    ], 1);
    expect(r.taken).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.pnls).toEqual([0.03]);
    expect(r.demandPeak).toBe(3);
    expect(r.sumUnconstrained).toBeCloseTo(0.03, 6);
    expect(r.sumConstrained).toBeCloseTo(0.03, 6);
  });

  it("последовательные сделки не блокируют друг друга: слот освобождается на выходе", () => {
    const r = simulateCapital([
      tr(t0, 0.01, 30),
      tr(t0 + 31 * MIN, 0.02, 30), // первая уже закрылась
    ], 1);
    expect(r.taken).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.demandPeak).toBe(1);
  });

  it("перекрытие при 1 слоте: вторая пропускается, разница сумм видна", () => {
    const r = simulateCapital([
      tr(t0, 0.01, 120),
      tr(t0 + 30 * MIN, 0.05, 60), // прилетела, пока первая держится
    ], 1);
    expect(r.taken).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.sumUnconstrained).toBeCloseTo(0.06, 6);
    expect(r.sumConstrained).toBeCloseTo(0.01, 6); // жадность честна: будущее неизвестно
    expect(r.demandPeak).toBe(2);
  });

  it("без лимита — чистый замер спроса: всё взято, demandPeak показывает бумажную одновременность", () => {
    const r = simulateCapital([
      tr(t0, 0.01), tr(t0 + MIN, 0.01), tr(t0 + 2 * MIN, -0.01), tr(t0 + 5 * HOUR, 0.02),
    ], null);
    expect(r.taken).toBe(4);
    expect(r.skipped).toBe(0);
    expect(r.maxConcurrentPositions).toBe(null);
    expect(r.demandPeak).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PaperTrader — CUSUM/KS замыкают петлю «прогноз → реальность».
// ─────────────────────────────────────────────────────────────────────────────
describe("PaperTrader — монитор дрейфа форварда", () => {
  // baseline: стабильный слабоположительный поток (среднее +0.5%, сд ~0.6%)
  const baseline = Array.from({ length: 60 }, (_, i) => 0.005 + 0.006 * Math.sin(i * 1.7));

  it("форвард из того же распределения — тревоги нет", () => {
    const pt = new PaperTrader(baseline);
    for (let i = 0; i < 20; i++) pt.record({ ts: t0 + i * HOUR, pnl: 0.005 + 0.006 * Math.sin(i * 2.3 + 1) });
    const s = pt.status();
    expect(s.alarm).toBe(false);
    expect(s.cusum.fired).toBe(false);
    expect(s.ks).not.toBe(null);
    expect(s.ks!.fired).toBe(false);
    expect(s.n).toBe(20);
    expect(s.baselineN).toBe(60);
  });

  it("систематический слив → CUSUM пробивает 5σ, рекомендация СТОП", () => {
    const pt = new PaperTrader(baseline);
    for (let i = 0; i < 12; i++) pt.record({ ts: t0 + i * HOUR, pnl: -0.01 });
    const s = pt.status();
    expect(s.cusum.fired).toBe(true);
    expect(s.alarm).toBe(true);
    expect(s.recommendation).toContain("СТОП");
    expect(s.reasons.join(" ")).toContain("ВНИЗ");
  });

  it("изменение ФОРМЫ распределения (та же средняя, дикие хвосты) → ловит KS, не CUSUM", () => {
    const pt = new PaperTrader(baseline);
    // средняя тоже ~+0.5%, но размах ±6% — рынок «не тот»
    for (let i = 0; i < 24; i++) pt.record({ ts: t0 + i * HOUR, pnl: 0.005 + (i % 2 === 0 ? 0.06 : -0.06) });
    const s = pt.status();
    expect(s.ks!.fired).toBe(true);
    expect(s.alarm).toBe(true);
  });

  it("KS честно молчит при малом форварде (< 10 сделок)", () => {
    const pt = new PaperTrader(baseline);
    for (let i = 0; i < 5; i++) pt.record({ ts: t0 + i * HOUR, pnl: 0.005 });
    expect(pt.status().ks).toBe(null);
  });

  it("save/load переживает сессию: журнал восстановлен, статус тот же", () => {
    const pt = new PaperTrader(baseline);
    for (let i = 0; i < 12; i++) pt.record({ ts: t0 + i * HOUR, pnl: -0.01, symbol: "SOLUSDT" });
    const restored = PaperTrader.load(pt.save(), baseline);
    expect(restored.trades.length).toBe(12);
    expect(restored.status().cusum.fired).toBe(true);
  });

  it("baseline из TrainedParams.history — вошедшие сделки обучения", () => {
    const params = {
      history: [
        ...Array.from({ length: 30 }, (_, i) => ({ entered: true, pnl: 0.004 + 0.005 * Math.sin(i) })),
        { entered: false, pnl: 0 }, // не вошедшие не считаются
      ],
    } as unknown as TrainedParams;
    const pt = new PaperTrader(params);
    expect(pt.status().baselineN).toBe(30);
  });

  it("пустой baseline → внятная ошибка, а не молчаливый мусор", () => {
    expect(() => new PaperTrader([])).toThrow(/baseline пуст/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// placeboItems — уничтожение информации постов с сохранением механики.
// ─────────────────────────────────────────────────────────────────────────────
describe("placeboItems — плацебо-сдвиг", () => {
  const items: ParserItem[] = [
    { channel: "alpha", symbol: "SOLUSDT", direction: "long", ts: t0 },
    { channel: "alpha", symbol: "TRXUSDT", direction: "long", ts: t0 + 3 * HOUR },
    { channel: "beta", symbol: "SOLUSDT", direction: "short", ts: t0 + HOUR },
  ];

  it("детерминирован и сдвигает только назад на 3–14 дней", () => {
    const a = placeboItems(items);
    const b = placeboItems(items);
    expect(a).toEqual(b);
    for (let i = 0; i < items.length; i++) {
      const shift = items[i].ts - a[i].ts;
      expect(shift).toBeGreaterThanOrEqual(3 * DAY);
      expect(shift).toBeLessThanOrEqual(15 * DAY);
    }
  });

  it("внутриканальные интервалы сохранены (algo-слои видят ту же механику), каналы сдвинуты по-разному", () => {
    const p = placeboItems(items);
    // один канал — один лаг: интервал между постами alpha не изменился
    expect(p[1].ts - p[0].ts).toBe(items[1].ts - items[0].ts);
    // разные каналы — разные лаги (межканальные совпадения тоже плацебированы)
    const shiftAlpha = items[0].ts - p[0].ts;
    const shiftBeta = items[2].ts - p[2].ts;
    expect(shiftAlpha).not.toBe(shiftBeta);
    // остальные поля не тронуты
    expect(p[0].symbol).toBe("SOLUSDT");
    expect(p[2].direction).toBe("short");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Дробный Келли — sizing перестаёт быть магической константой пользователя.
// ─────────────────────────────────────────────────────────────────────────────
describe("recommendedRiskFrac — четверть-Келли в прогнозе исхода", () => {
  const model = (prior: number, meanWin: number, meanLoss: number): OutcomeModel => ({
    version: 1, prior, features: {}, calibration: { breaks: [0], values: [prior] },
    meanWin, meanLoss, n: 50, brier: 0.2, brierPrior: 0.2, informative: false,
  });

  it("положительный эдж → доля в (0,1], монотонна по pWin", () => {
    // крупные меанWin/|meanLoss|, чтобы четверть-Келли не насыщал кап 1.0
    const lo = predictOutcome(model(0.55, 0.4, -0.3), {});
    const hi = predictOutcome(model(0.65, 0.4, -0.3), {});
    expect(lo.recommendedRiskFrac).toBeGreaterThan(0);
    expect(hi.recommendedRiskFrac).toBeGreaterThan(lo.recommendedRiskFrac);
    expect(hi.recommendedRiskFrac).toBeLessThanOrEqual(1);
  });

  it("E[pnl] ≤ 0 → 0: в минусовую сделку не сайзят", () => {
    const p = predictOutcome(model(0.3, 0.01, -0.02), {});
    expect(p.expectedPnl).toBeLessThan(0);
    expect(p.recommendedRiskFrac).toBe(0);
  });

  it("кап 1.0: советов с плечом не даём даже при экстремальном эдже", () => {
    const p = predictOutcome(model(0.9, 0.05, -0.001), {});
    expect(p.recommendedRiskFrac).toBe(1);
  });

  it("обученная модель отдаёт валидную долю на реальных строках", () => {
    const rows: OutcomeRow[] = Array.from({ length: 40 }, (_, i) => ({
      y: (i % 3 === 0 ? 0 : 1) as 0 | 1,
      pnl: i % 3 === 0 ? -0.01 : 0.012,
      ts: t0 + i * HOUR,
      features: { momentum: (i % 7) - 3, clusters: (i % 4) + 1 },
    }));
    const m = fitOutcomeModel(rows, 4);
    expect(m).not.toBe(null);
    const p = predictOutcome(m!, { momentum: 2, clusters: 3 });
    expect(p.recommendedRiskFrac).toBeGreaterThanOrEqual(0);
    expect(p.recommendedRiskFrac).toBeLessThanOrEqual(1);
    expect(Number.isFinite(p.recommendedRiskFrac)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Интеграция: walkForward.capital и assessEdge.placebo на синтетическом мире.
// ─────────────────────────────────────────────────────────────────────────────
describe("walkForward.capital + assessEdge.placebo (интеграция)", () => {
  // растущий мир с волной — сделки положительные, детерминированный
  const priceAt = (t: number) =>
    100 * Math.exp(0.0004 * ((t - t0) / MIN) / 60 + 0.004 * Math.sin((t - t0) / MIN / 45));
  const gc: GetCandles = async (_s, _i, limit, sDate) =>
    Array.from({ length: limit ?? 0 }, (_, k) => {
      const t = (sDate ?? 0) + k * MIN;
      const o = priceAt(t);
      const c = priceAt(t + MIN);
      return {
        timestamp: t, open: o, close: c,
        high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998,
        volume: 1000 + (Math.floor(t / MIN) % 7) * 100,
      };
    });
  // ДВА события в одну минуту (кластеризация пампов) каждые 12 часов
  const items: ParserItem[] = Array.from({ length: 10 }, (_, k) => k).flatMap((k) => [
    { channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + 3 * DAY + k * 12 * HOUR },
    { channel: "ch", symbol: "TRXUSDT", direction: "long" as const, ts: t0 + 3 * DAY + k * 12 * HOUR },
  ]);
  const trainOptions = {
    folds: 3, mode: "single" as const, onProgress: silentProgress,
    selection: { nestedOuterFolds: 0 }, outcomeModel: false,
    grid: {
      windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
      trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
      stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
      squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
      cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
    },
  };

  it("walkForward с 1 слотом: одновременные сигналы пропускаются, спрос виден", async () => {
    const wf = await walkForward(items, gc, {
      slices: 2, trainOptions, maxConcurrentPositions: 1,
      policy: { acknowledgeUncertified: true },
    });
    expect(wf.capital.maxConcurrentPositions).toBe(1);
    if (wf.oosPnls.length >= 2) {
      // пары сигналов в одну минуту → спрос ≥ 2, при 1 слоте есть пропуски
      expect(wf.capital.demandPeak).toBeGreaterThanOrEqual(2);
      expect(wf.capital.skipped).toBeGreaterThan(0);
      expect(wf.capital.taken + wf.capital.skipped).toBe(wf.oosPnls.length);
    }
  }, 60_000);

  it("assessEdge с плацебо: контроль прогнан, вердикт согласован с ним", async () => {
    const a = await assessEdge(items, gc, {
      walkForward: { slices: 2, policy: { acknowledgeUncertified: true } },
      trainOptions,
      placebo: true,
    });
    expect(a.placebo).not.toBe(null);
    expect(a.placebo!.note.length).toBeGreaterThan(0);
    expect(a.summary).toContain("Плацебо");
    // жёсткий инвариант: если плацебо не проиграло, «trade» невозможен
    if (!a.placebo!.beatsPlacebo) expect(a.verdict).not.toBe("trade");
  }, 120_000);
});
