import { describe, it, expect } from "vitest";
import { DEFAULT_GRID } from "../src/train";
import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
const gc: GetCandles = async (s, i, lim, sd) => {
  const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = 100.5 + k * 0.05; out.push({ timestamp: since + k * STEP_MS[i], open: p, high: p * 1.005, low: p * 0.999, close: p, volume: 1000 }); }
  return out;
};

describe("staleness-оси перебираются в DEFAULT_GRID (фикс #1)", () => {
  it("stalenessSinceProfit — несколько значений, не зафиксирован в 1.0", () => {
    expect(DEFAULT_GRID.stalenessSinceProfit.length).toBeGreaterThan(1);
    expect(DEFAULT_GRID.stalenessSinceProfit).toContain(0.5);
    expect(DEFAULT_GRID.stalenessSinceProfit).toContain(2.0);
  });
  it("stalenessSinceMinutes — несколько значений (число минут staleness виден и перебирается)", () => {
    expect(DEFAULT_GRID.stalenessSinceMinutes.length).toBeGreaterThan(1);
    expect(DEFAULT_GRID.stalenessSinceMinutes).toEqual([60, 120, 240]);
  });
});

describe("id протягивается parser-item → dump (фикс #2)", () => {
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
    staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
    volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
  };
  const makeItems = (): ParserItem[] => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 10; d++) items.push({ id: `sig-${d}-abc`, channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
    return items;
  };

  it("каждая dump-запись несёт id, сопоставимый с парсингом", async () => {
    const m = await PumpMatrix.fit(makeItems(), gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    const recs = m.dump();
    expect(recs.length).toBe(10);
    expect(recs.every((r) => typeof r.id === "string" && r.id.startsWith("sig-"))).toBe(true);
    // ids-массив тоже заполнен (1:1 в single)
    expect(recs[0].ids).toEqual([recs[0].id]);
  });

  it("id уникально сопоставляет запись с исходным сигналом по ts", async () => {
    const items = makeItems();
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    for (const r of m.dump()) {
      const src = items.find((it) => it.id === r.id);
      expect(src).toBeDefined();
      expect(src!.ts).toBe(r.ts); // id указывает на правильный исходный пост
    }
  });

  it("id выживает save/load", async () => {
    const m = await PumpMatrix.fit(makeItems(), gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    const reloaded = PumpMatrix.load(m.save());
    const a = m.dump(), b = reloaded.dump();
    expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id));
  });

  it("числовой id приводится к строке (нормализация)", async () => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 5; d++) items.push({ id: 1000 + d, channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 } as any);
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    const recs = m.dump();
    expect(recs.every((r) => typeof r.id === "string")).toBe(true);
    expect(recs.map((r) => r.id)).toContain("1000");
  });

  it("без id — записи валидны, id=undefined (обратная совместимость)", async () => {
    const items: ParserItem[] = [];
    for (let d = 0; d < 5; d++) items.push({ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    const recs = m.dump();
    expect(recs.length).toBe(5);
    expect(recs.every((r) => r.id === undefined)).toBe(true);
  });
});
