import { describe, it, expect } from "vitest";
import { pnlStats, PnlStats } from "../src/index";
import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

describe("pnlStats — устойчивость к выбросам (одна сделка не режет выигрыш)", () => {
  it("median игнорирует одну катастрофу: 19×(+5%)+1×(-50%) → median +5%", () => {
    const s = pnlStats([...Array(19).fill(0.05), -0.50]);
    expect(s.median).toBeCloseTo(0.05, 6);   // робастный центр не сдвинут
    expect(s.mean).toBeLessThan(s.median);    // mean утянут катастрофой
    expect(s.mean).toBeCloseTo(0.0225, 4);
  });

  it("median разоблачает один джекпот: 19×(-2%)+1×(+200%) → median -2%", () => {
    const s = pnlStats([...Array(19).fill(-0.02), 2.0]);
    expect(s.median).toBeCloseTo(-0.02, 6);  // система честно убыточна
    expect(s.mean).toBeGreaterThan(0);        // mean обманчиво положителен
  });

  it("p5 показывает нижний хвост, p95/p99 верхний", () => {
    const pnls = Array(100).fill(0).map((_, i) => (i - 50) / 1000); // -0.05..0.049
    const s = pnlStats(pnls);
    expect(s.p5).toBeLessThan(s.median);
    expect(s.p95).toBeGreaterThan(s.median);
    expect(s.p99).toBeGreaterThanOrEqual(s.p95);
  });

  it("NaN/Infinity отбрасываются", () => {
    const s = pnlStats([0.05, NaN, 0.03, Infinity, 0.04, -Infinity]);
    expect(s.n).toBe(3);
    expect(Number.isFinite(s.median)).toBe(true);
    expect(Number.isFinite(s.p5)).toBe(true);
  });

  it("пустой вход → нули, не NaN", () => {
    const s = pnlStats([]);
    expect(s).toEqual({ mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 });
  });

  it("одна сделка → все статистики = ей", () => {
    const s = pnlStats([0.07]);
    expect(s.mean).toBeCloseTo(0.07, 6);
    expect(s.median).toBeCloseTo(0.07, 6);
    expect(s.p5).toBeCloseTo(0.07, 6);
    expect(s.n).toBe(1);
  });

  it("median робастнее mean: сдвиг одного экстремума не двигает median", () => {
    const base = [0.01, 0.02, 0.03, 0.04, 0.05];
    const a = pnlStats(base);
    const b = pnlStats([...base.slice(0, 4), 100]); // последний → дикий выброс
    expect(b.median).toBeCloseTo(a.median, 6); // median не сдвинулся
    expect(b.mean).toBeGreaterThan(a.mean * 10); // mean взорвался
  });
});

describe("pnl stats — интеграция в модель", () => {
  const DAY = 86_400_000;
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const gc: GetCandles = async (s, i, lim, sd) => {
    const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
    const out: ICandleData[] = [];
    for (let k = 0; k < n; k++) { const p = 100.5 + k * 0.02; out.push({ timestamp: since + k * step, open: p, high: p * 1.003, low: p * 0.999, close: p, volume: 1000 + (k % 7) * 80 }); }
    return out;
  };
  const items: ParserItem[] = [];
  for (let d = 0; d < 12; d++) items.push({ channel: "yoda", symbol: ["SOL", "TRX"][d % 2] + "USDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
    staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
    volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
  };

  it("model.pnl даёт global + per-symbol с median/перцентилями", async () => {
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    expect(m.pnl.global).toHaveProperty("median");
    expect(m.pnl.global).toHaveProperty("p5");
    expect(m.pnl.global).toHaveProperty("p95");
    expect(m.pnl.global).toHaveProperty("p99");
    expect(m.pnl.global.n).toBeGreaterThan(0);
    expect(Object.keys(m.pnl.bySymbol).length).toBeGreaterThan(0);
  });

  it("pnl stats переживают save/load", async () => {
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    const r = PumpMatrix.load(m.save());
    expect(r.pnl.global.median).toBe(m.pnl.global.median);
    expect(r.pnl.global.p95).toBe(m.pnl.global.p95);
  });

  it("старый JSON без pnl → дефолт-нули, не падает", async () => {
    const m = await PumpMatrix.fit(items, gc, { mode: "single", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
    const json = JSON.parse(m.save());
    delete json.pnl; // старый формат
    const r = PumpMatrix.load(json);
    expect(r.pnl.global).toEqual({ mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 });
  });
});
