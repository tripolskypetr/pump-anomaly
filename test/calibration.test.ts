import { describe, it, expect } from "vitest";
import { calibrateGrid, train, predict, PumpMatrix, ParserItem, assessViability, DEFAULT_VIABILITY, buildTable, SignalEvent } from "../src/index";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

/**
 * Детерминированный источник свечей: цена пилит между 100 и 100·(1+noise%) на
 * каждой свече (|1m-ретёрн| ≈ noise%), история ЗАКАНЧИВАЕТСЯ на endTs.
 */
const mkGc = (noisePct: number, endTs: number): GetCandles => async (_s, _i, limit, sDate) => {
  const out: ICandleData[] = [];
  for (let i = 0; i < (limit ?? 0); i++) {
    const t = (sDate ?? 0) + i * MIN;
    if (t >= endTs) break; // край истории
    const idx = Math.floor(t / MIN);
    const a = 100;
    const b = 100 * (1 + noisePct / 100);
    const open = idx % 2 === 0 ? a : b;
    const close = idx % 2 === 0 ? b : a;
    out.push({
      timestamp: t, open, close,
      high: Math.max(open, close) * 1.0001, low: Math.min(open, close) * 0.9999,
      volume: 1000 + (idx % 5) * 50,
    });
  }
  return out;
};

const items = (n = 4): ParserItem[] =>
  Array.from({ length: n }, (_, i) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + i * 120 * MIN,
  }));

const HORIZONS = { staleMinutes: [60, 240, 720], stalenessSinceMinutes: [60, 120, 240] };

describe("calibrateGrid — размер осей из данных, не из головы", () => {
  it("%-оси масштабируются измеренным шумом: шумный актив → шире стопы", async () => {
    const end = t0 + 10 * 24 * 3600_000;
    const calm = await calibrateGrid(items(), mkGc(0.05, end), HORIZONS);
    const wild = await calibrateGrid(items(), mkGc(0.25, end), HORIZONS);
    expect(calm.noisePct).not.toBe(null);
    expect(wild.noisePct!).toBeGreaterThan(calm.noisePct!);
    // каждый калиброванный стоп шумного актива шире спокойного
    expect(Math.min(...wild.axes.hardStop!)).toBeGreaterThan(Math.min(...calm.axes.hardStop!));
    expect(Math.min(...wild.axes.trailingTake!)).toBeGreaterThan(Math.min(...calm.axes.trailingTake!));
    // спокойный актив (0.05%): hardStop ≈ шум×{20,40,80} ≈ [1, 2, 4]
    expect(calm.axes.hardStop![0]).toBeGreaterThan(0.7);
    expect(calm.axes.hardStop![0]).toBeLessThan(1.3);
  });

  it("клампы вменяемости держат вырожденный шум", async () => {
    const end = t0 + 10 * 24 * 3600_000;
    const insane = await calibrateGrid(items(), mkGc(3.0, end), HORIZONS); // 3% каждую минуту
    expect(Math.max(...insane.axes.hardStop!)).toBeLessThanOrEqual(12);
    expect(Math.max(...insane.axes.trailingTake!)).toBeLessThanOrEqual(6);
  });

  it("горизонты, которые история не может разметить, выброшены из осей", async () => {
    // история кончается через ~300 мин после последнего события → 720 недостижим
    const end = t0 + 3 * 120 * MIN + 300 * MIN;
    const c = await calibrateGrid(items(), mkGc(0.1, end), HORIZONS);
    expect(c.forwardCoverageMinutes).not.toBe(null);
    expect(c.axes.staleMinutes).not.toContain(720);
    expect(c.axes.staleMinutes).toContain(60);
    // staleness-таймер ≥ оставшегося life-cap мёртв → отфильтрован
    const maxLife = Math.max(...c.axes.staleMinutes!);
    for (const m of c.axes.stalenessSinceMinutes!) expect(m).toBeLessThan(maxLife);
  });

  it("нет свечей вовсе → оси не подменяются, reason честно говорит о фолбэке", async () => {
    const c = await calibrateGrid(items(), async () => [], HORIZONS);
    expect(c.noisePct).toBe(null);
    expect(c.axes.hardStop).toBeUndefined();
    expect(c.reason).toContain("дефолт");
  });
});

describe("train — casual-путь с автокалибровкой", () => {
  const end = t0 + 3 * 120 * MIN + 600 * MIN;
  const shrinkGrid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
    volBaselineWindow: [20], cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity],
  };

  it("autoCalibrate: true + частичный grid → калибруются только незаданные оси", async () => {
    const res = await train(items(), mkGc(0.2, end), {
      folds: 3, mode: "single", onProgress: silentProgress, autoCalibrate: true,
      grid: { ...shrinkGrid, hardStop: [9] }, // hardStop задан пользователем
      selection: { nestedOuterFolds: 0 },
    });
    const cal = res.params.meta.calibration!;
    expect(cal).not.toBe(null);
    expect(cal.noisePct).toBeGreaterThan(0.15);
    // пользовательская ось не тронута
    expect(res.params.exit.global.hardStop).toBe(9);
    // а trailingTake — из калибровки (шум 0.2% × {10,20,40} ≈ [2,4,8], не дефолт [0.5,1,2])
    expect(res.params.exit.global.trailingTake).toBeGreaterThanOrEqual(1.5);
  });

  it("явный grid без autoCalibrate → калибровка не запускается (старое поведение)", async () => {
    const res = await train(items(), mkGc(0.2, end), {
      folds: 3, mode: "single", onProgress: silentProgress,
      grid: {
        ...shrinkGrid, hardStop: [2], trailingTake: [1], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [240],
      },
      selection: { nestedOuterFolds: 0 },
    });
    expect(res.params.meta.calibration).toBe(null);
    expect(res.params.exit.global.hardStop).toBe(2);
  });

  it("PumpMatrix.fit БЕЗ грида — чистый casual: калибровка в аудите, оси из данных", async () => {
    const m = await PumpMatrix.fit(items(3), mkGc(0.2, end), {
      folds: 3, mode: "single", onProgress: silentProgress,
      selection: { nestedOuterFolds: 0 },
      // grid НЕ передан → полная автокалибровка размерных осей
    });
    expect(m.calibration).not.toBe(null);
    expect(m.calibration!.noisePct).toBeGreaterThan(0.1);
    expect(m.calibration!.reason).toContain("шум 1m");
    // выбранный hardStop принадлежит калиброванной оси, а не дефолтной [1,2,3]
    expect(m.calibration!.axes.hardStop).toContain(m.exit.global.hardStop);
    // аудит переживает save/load
    const loaded = PumpMatrix.load(m.save());
    expect(loaded.calibration!.noisePct).toBe(m.calibration!.noisePct);
  }, 30_000);
});

describe("viability — порог перекрытия против случайности (Пуассон), не «3»", () => {
  const ev = (channel: string, ts: number): SignalEvent =>
    ({ channel, symbol: "SOLUSDT", direction: "long", ts });

  it("разреженная история → порог остаётся дефолтным (3)", () => {
    const events: SignalEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(ev("a", t0 + i * 5 * 24 * 3600_000));
      events.push(ev("b", t0 + i * 5 * 24 * 3600_000 + 3 * MIN));
    }
    const tbl = buildTable(events);
    const r = assessViability(tbl, [], new Map([["a", 0], ["b", 1]]),
      { ...DEFAULT_VIABILITY, autoOverlap: true }, 30 * MIN);
    expect(r.minSharedEventsUsed).toBe(3);
  });

  it("плотная история → планка поднимается: совпадения на уровне случая не «перекрытие»", () => {
    // два НЕЗАВИСИМЫХ плотных канала: 200+200 событий за 2 дня, окно 1ч —
    // случайных коинциденций ожидается десятки, «≥3 общих» ничего не доказывает
    const events: SignalEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(ev("a", t0 + i * 14 * MIN));
      events.push(ev("b", t0 + i * 14 * MIN + 7 * MIN));
    }
    const tbl = buildTable(events);
    const r = assessViability(tbl, [], new Map([["a", 0], ["b", 1]]),
      { ...DEFAULT_VIABILITY, autoOverlap: true }, 60 * MIN);
    expect(r.minSharedEventsUsed!).toBeGreaterThan(3);
    expect(r.viable).toBe(false);
    expect(r.reason).toContain("шумовое");
  });

  it("явный minSharedEvents пользователя отключает авто-порог (в predict)", () => {
    const items: ParserItem[] = [];
    for (let i = 0; i < 50; i++) {
      items.push({ channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 + i * 30 * MIN });
      items.push({ channel: "b", symbol: "SOLUSDT", direction: "long", ts: t0 + i * 30 * MIN + 2 * MIN });
    }
    const auto = predict(items);
    const fixed = predict(items, { viability: { minSharedEvents: 3 } });
    expect(fixed.viability.minSharedEventsUsed).toBe(3);
    // авто-порог на плотной истории не ниже фиксированного
    expect(auto.viability.minSharedEventsUsed!).toBeGreaterThanOrEqual(3);
  });
});
