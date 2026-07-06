import { describe, it, expect } from "vitest";
import { train, PumpMatrix, walkForward, withCandleCache, normalizeParserItems } from "../src/index";
import { timeSeriesFolds } from "../src/train";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// PURGED CV: pnl-пути сделок через границу фолда не должны перекрываться —
// иначе fold-статистики коррелированы, SE занижен, stability/PBO завышены.
// ─────────────────────────────────────────────────────────────────────────────
describe("timeSeriesFolds — purge с эмбарго (Лопес де Прадо)", () => {
  it("эмбарго 0 → старое поведение (просто временные срезы)", () => {
    const ts = Array.from({ length: 10 }, (_, i) => t0 + i * MIN);
    const folds = timeSeriesFolds(ts, 4, 0);
    expect(folds).toEqual([
      { valLo: 2, valHi: 4 }, { valLo: 4, valHi: 6 },
      { valLo: 6, valHi: 8 }, { valLo: 8, valHi: 10 },
    ]);
  });

  it("сделки в начале фолда внутри горизонта предыдущего — выброшены", () => {
    // 10 сделок с шагом 10 мин; эмбарго 25 мин → первые 2 сделки каждого
    // следующего фолда перекрываются с последней предыдущего
    const ts = Array.from({ length: 10 }, (_, i) => t0 + i * 10 * MIN);
    const folds = timeSeriesFolds(ts, 4, 25 * MIN);
    for (let f = 1; f < folds.length; f++) {
      const prevEnd = ts[folds[f - 1].valHi - 1];
      expect(ts[folds[f].valLo]).toBeGreaterThanOrEqual(prevEnd + 25 * MIN);
    }
    // что-то реально выброшено (фолды сузились относительно эмбарго-0)
    const total = folds.reduce((s, f) => s + (f.valHi - f.valLo), 0);
    expect(total).toBeLessThan(8);
  });

  it("фолд, целиком съеденный эмбарго, пропускается (не пустой срез)", () => {
    // все сделки в одной минуте → после первого фолда всё внутри эмбарго
    const ts = Array.from({ length: 8 }, (_, i) => t0 + i * 1000);
    const folds = timeSeriesFolds(ts, 4, 60 * MIN);
    expect(folds.length).toBe(1);
    for (const f of folds) expect(f.valLo).toBeLessThan(f.valHi);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withCandleCache: promise-dedup (конкуренты не бьют биржу дважды) + FIFO.
// ─────────────────────────────────────────────────────────────────────────────
describe("withCandleCache — кэш свечей с дедупликацией в полёте", () => {
  const candle = (t: number): ICandleData =>
    ({ timestamp: t, open: 100, high: 101, low: 99, close: 100, volume: 1000 });

  it("конкурентные запросы одного окна → ОДИН вызов источника", async () => {
    let calls = 0;
    const slow: GetCandles = async (_s, _i, limit, sDate) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return Array.from({ length: limit ?? 0 }, (_, k) => candle((sDate ?? 0) + k * MIN));
    };
    const gc = withCandleCache(slow);
    const [a, b, c] = await Promise.all([
      gc("SOLUSDT", "1m", 10, t0), gc("SOLUSDT", "1m", 10, t0), gc("SOLUSDT", "1m", 10, t0),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("разные окна — разные вызовы; повтор — из кэша", async () => {
    let calls = 0;
    const src: GetCandles = async (_s, _i, limit, sDate) => {
      calls++;
      return Array.from({ length: limit ?? 0 }, (_, k) => candle((sDate ?? 0) + k * MIN));
    };
    const gc = withCandleCache(src);
    await gc("SOLUSDT", "1m", 10, t0);
    await gc("SOLUSDT", "1m", 10, t0 + 10 * MIN);
    await gc("TRXUSDT", "1m", 10, t0);
    await gc("SOLUSDT", "1m", 10, t0); // повтор
    expect(calls).toBe(3);
  });

  it("ошибка источника НЕ кэшируется — следующий вызов пробует снова", async () => {
    let calls = 0;
    const flaky: GetCandles = async (_s, _i, limit, sDate) => {
      calls++;
      if (calls === 1) throw new Error("дыра");
      return Array.from({ length: limit ?? 0 }, (_, k) => candle((sDate ?? 0) + k * MIN));
    };
    const gc = withCandleCache(flaky);
    await expect(gc("SOLUSDT", "1m", 5, t0)).rejects.toThrow("дыра");
    const ok = await gc("SOLUSDT", "1m", 5, t0);
    expect(ok.length).toBe(5);
    expect(calls).toBe(2);
  });

  it("FIFO-кап вытесняет старые ключи", async () => {
    let calls = 0;
    const src: GetCandles = async (_s, _i, limit, sDate) => {
      calls++;
      return Array.from({ length: limit ?? 0 }, (_, k) => candle((sDate ?? 0) + k * MIN));
    };
    const gc = withCandleCache(src, 2); // ёмкость 2
    await gc("A", "1m", 5, t0);
    await gc("B", "1m", 5, t0);
    await gc("C", "1m", 5, t0); // вытесняет A
    await gc("A", "1m", 5, t0); // снова к источнику
    expect(calls).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// КОНКУРЕНТНАЯ разметка: результат детерминирован независимо от порядка ответов.
// ─────────────────────────────────────────────────────────────────────────────
describe("labelConcurrency — пул не меняет результат", () => {
  const items: ParserItem[] = Array.from({ length: 8 }, (_, k) => ({
    channel: "ch", symbol: k % 2 ? "AUSDT" : "BUSDT", direction: "long" as const,
    ts: t0 + 24 * 60 * MIN + k * 6 * 60 * MIN,
  }));
  // джиттерный адаптер: ответы приходят в СЛУЧАЙНОМ порядке
  const jittery = (): GetCandles => async (symbol, _i, limit, sDate) => {
    await new Promise((r) => setTimeout(r, (Math.abs((sDate ?? 0) % 7)) + 1));
    const out: ICandleData[] = [];
    const drift = symbol === "AUSDT" ? 0.0004 : -0.0002;
    for (let i = 0; i < (limit ?? 0); i++) {
      const t = (sDate ?? 0) + i * MIN;
      const p = 100 * (1 + drift * ((t - t0) / MIN / 100));
      out.push({ timestamp: t, open: p, high: p * 1.0002, low: p * 0.9998, close: p * 1.0001, volume: 1000 + (i % 5) * 50 });
    }
    return out;
  };
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: [1], hardStop: [2], stalenessSinceProfit: [1],
    stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
    squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
    cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null, -1],
  };

  it("concurrency 1 и 6 дают идентичные params (история, exit, скор)", async () => {
    const opts = {
      folds: 3, mode: "single" as const, onProgress: silentProgress, grid,
      momentumWindowMinutes: 60, selection: { nestedOuterFolds: 0 },
    };
    const seq = await train(items, jittery(), { ...opts, labelConcurrency: 1 });
    const par = await train(items, jittery(), { ...opts, labelConcurrency: 6 });
    expect(JSON.stringify(par.params.history)).toBe(JSON.stringify(seq.params.history));
    expect(par.params.meta.cvScore).toBe(seq.params.meta.cvScore);
    expect(par.params.exit.global).toEqual(seq.params.exit.global);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// НОРМАЛИЗАЦИЯ входа fit + ledger в model.json.
// ─────────────────────────────────────────────────────────────────────────────
describe("fit — нормализация входа и родословная", () => {
  const good: ParserItem[] = Array.from({ length: 4 }, (_, k) => ({
    channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * 60 * MIN,
  }));
  const garbage = [
    null, { channel: "ch" }, { channel: "ch", symbol: "SOLUSDT", direction: "LONG", ts: t0 },
    { channel: "ch", symbol: "SOLUSDT", direction: "long", ts: "не число" },
  ] as unknown as ParserItem[];
  const gc: GetCandles = async (_s, _i, limit, sDate) => {
    const out: ICandleData[] = [];
    for (let i = 0; i < (limit ?? 0); i++) {
      const t = (sDate ?? 0) + i * MIN;
      const p = 100 + ((t - t0) / MIN) * 0.001;
      out.push({ timestamp: t, open: p, high: p + 0.05, low: p - 0.05, close: p + 0.02, volume: 1000 + (i % 5) * 50 });
    }
    return out;
  };
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
    stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
    squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
    cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
  };
  const opts = { folds: 3, mode: "single" as const, onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } };

  it("мусор отброшен и посчитан; результат равен обучению на чистом входе", async () => {
    const dirty = await train([...garbage, ...good], gc, opts);
    const clean = await train(good, gc, opts);
    expect(dirty.params.meta.labeling.invalidItems).toBe(garbage.length);
    expect(clean.params.meta.labeling.invalidItems).toBe(0);
    expect(JSON.stringify(dirty.params.history)).toBe(JSON.stringify(clean.params.history));
  });

  it("normalizeParserItems экспортирован и фильтрует по контракту predict", () => {
    expect(normalizeParserItems([...garbage, ...good]).length).toBe(good.length);
  });

  it("walkForward: эмбарго на границе выбрасывает train-items, метки которых заглядывали в тест", async () => {
    // 12 событий с шагом 2ч; эмбарго 300 мин (5ч) → 2-3 последних train-item у границы выброшены
    const dense: ParserItem[] = Array.from({ length: 12 }, (_, k) => ({
      channel: "ch", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + 24 * 60 * MIN + k * 120 * MIN,
    }));
    const wf = await walkForward(dense, gc, {
      slices: 2, embargoMinutes: 300,
      trainOptions: opts,
    });
    expect(wf.slices.some((s) => s.embargoDropped > 0)).toBe(true);
    // train-граница строго раньше первого test-события минимум на эмбарго
    for (const s of wf.slices) expect(s.trainUntil).toBeLessThan(s.testTo);
  });
});
