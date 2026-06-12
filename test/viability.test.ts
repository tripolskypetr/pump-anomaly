import { describe, it, expect } from "vitest";
import { predict, assessViability, DEFAULT_VIABILITY, ParserItem } from "../src/index";
import { buildTable } from "../src/core/event-table";
import { jaccardScreen } from "../src/layers/jaccard-screen";
import { lagXCorr } from "../src/layers/lag-xcorr";
import { clusterAuthors } from "../src/layers/cluster-authors";

const MIN = 60_000;
const H = 3600_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

/** хелпер: оценить viability на наборе items */
function viabilityOf(items: ParserItem[], over = {}) {
  const tbl = buildTable(items as any);
  const screened = jaccardScreen(tbl, 30 * MIN, 0.3);
  const directed = lagXCorr(tbl, screened, 0.5, 30 * MIN);
  const authors = clusterAuthors(tbl.channels, directed);
  return assessViability(tbl, directed, authors, { ...DEFAULT_VIABILITY, ...over });
}

describe("viability — два канала с ПЛОХОЙ корреляцией → single", () => {
  it("два независимых канала, случайно пересёкшиеся на 1 событии → НЕ viable", () => {
    // каждый канал постит своё; пересечение по одному тикеру один раз — шум
    const items: ParserItem[] = [
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 },
      { channel: "b", symbol: "SOLUSDT", direction: "long", ts: t0 + 5 * MIN },
      { channel: "a", symbol: "TRXUSDT", direction: "short", ts: t0 + 2 * H },
      { channel: "b", symbol: "NEARUSDT", direction: "long", ts: t0 + 3 * H },
      { channel: "a", symbol: "POLUSDT", direction: "long", ts: t0 + 5 * H },
      { channel: "b", symbol: "HYPEUSDT", direction: "long", ts: t0 + 6 * H },
    ];
    const v = viabilityOf(items);
    expect(v.viable).toBe(false);
    expect(v.maxSharedEvents).toBeLessThan(DEFAULT_VIABILITY.minSharedEvents);
  });

  it("predict auto: шумовая пара каналов откатывается в single", () => {
    const items: ParserItem[] = [
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 },
      { channel: "b", symbol: "SOLUSDT", direction: "long", ts: t0 + 5 * MIN },
      { channel: "a", symbol: "TRXUSDT", direction: "short", ts: t0 + 2 * H },
      { channel: "b", symbol: "NEARUSDT", direction: "long", ts: t0 + 3 * H },
    ];
    const res = predict(items);
    expect(res.usedMode).toBe("single");
    expect(res.viability.viable).toBe(false);
  });

  it("два канала с СИСТЕМАТИЧЕСКИМ совпадением (братья) → viable, matrix", () => {
    // b стабильно повторяет a через ~3 мин по одному тикеру много раз
    const items: ParserItem[] = [];
    for (let d = 0; d < 8; d++) {
      const base = t0 + d * 6 * H;
      items.push({ channel: "a", symbol: "TRXUSDT", direction: "short", ts: base });
      items.push({ channel: "b", symbol: "TRXUSDT", direction: "short", ts: base + 3 * MIN });
    }
    const v = viabilityOf(items);
    expect(v.viable).toBe(true);
    expect(v.strongEdges).toBeGreaterThanOrEqual(1);
    expect(v.maxSharedEvents).toBeGreaterThanOrEqual(DEFAULT_VIABILITY.minSharedEvents);
  });

  it("строгий порог можно ужесточить через override (нужно больше общих событий)", () => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 4; d++) {
      const base = t0 + d * 6 * H;
      items.push({ channel: "a", symbol: "TRXUSDT", direction: "short", ts: base });
      items.push({ channel: "b", symbol: "TRXUSDT", direction: "short", ts: base + 3 * MIN });
    }
    // 4 общих события: проходит дефолт (3), но не ужесточённый (10)
    expect(viabilityOf(items).viable).toBe(true);
    expect(viabilityOf(items, { minSharedEvents: 10 }).viable).toBe(false);
  });

  it("predict с override viability отражается в usedMode", () => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 4; d++) {
      const base = t0 + d * 6 * H;
      items.push({ channel: "a", symbol: "TRXUSDT", direction: "short", ts: base });
      items.push({ channel: "b", symbol: "TRXUSDT", direction: "short", ts: base + 3 * MIN });
    }
    // ужесточаем перекрытие — матрица перестаёт быть жизнеспособной → single
    const strict = predict(items, { viability: { minSharedEvents: 20 } });
    expect(strict.usedMode).toBe("single");
  });

  it("один канал → не viable по числу каналов", () => {
    const items: ParserItem[] = [
      { channel: "solo", symbol: "SOLUSDT", direction: "long", ts: t0 },
      { channel: "solo", symbol: "TRXUSDT", direction: "short", ts: t0 + H },
    ];
    const v = viabilityOf(items);
    expect(v.viable).toBe(false);
    expect(v.reason).toContain("один канал");
  });
});
