import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);

// ── детерминированная синтетика: ДВА независимых matrix-сигнала ──
// {a,b} обычно бьют TRX, {c,d} обычно NEAR (разные почерки → 2 кластера).
// Сходятся на SOL (день 20) и на ARB (день 50) → ровно два matrix-всплеска
// с independentClusters=2 на разных тикерах.
const E = (ch: string, sym: string, ts: number): ParserItem =>
  ({ channel: ch, symbol: sym, direction: "long", ts, entryFromPrice: 100, entryToPrice: 101 });
function twoSignalData(): ParserItem[] {
  const items: ParserItem[] = [];
  for (let d = 0; d < 90; d++) {
    items.push(E("a", "TRXUSDT", t0 + d * DAY + 3600_000));
    items.push(E("b", "TRXUSDT", t0 + d * DAY + 3600_000 + 60_000));
    items.push(E("c", "NEARUSDT", t0 + d * DAY + 13 * 3600_000));
    items.push(E("d", "NEARUSDT", t0 + d * DAY + 13 * 3600_000 + 60_000));
    if (d === 20) { // схождение на SOL
      items.push(E("a", "SOLUSDT", t0 + d * DAY + 8 * 3600_000));
      items.push(E("b", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 60_000));
      items.push(E("c", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 120_000));
      items.push(E("d", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 180_000));
    }
    if (d === 50) { // схождение на ARB
      items.push(E("a", "ARBUSDT", t0 + d * DAY + 8 * 3600_000));
      items.push(E("b", "ARBUSDT", t0 + d * DAY + 8 * 3600_000 + 60_000));
      items.push(E("c", "ARBUSDT", t0 + d * DAY + 8 * 3600_000 + 120_000));
      items.push(E("d", "ARBUSDT", t0 + d * DAY + 8 * 3600_000 + 180_000));
    }
  }
  return items.sort((a, b) => a.ts - b.ts);
}

// staleMinutes=5, trailing/hardStop большие → выход всегда life-cap по close на 5-й свече.
// Это делает exit детерминированным: зависит только от ФОРМЫ цены.
const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
  trailingTake: [50.0], hardStop: [50.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
  staleMinutes: [5], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
  volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
};

const fit = (gc: GetCandles) =>
  PumpMatrix.fit(twoSignalData(), gc, { mode: "matrix", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
const matrixSignals = (m: PumpMatrix) =>
  m.dump().filter((d) => d.independentClusters >= 2 && (d.symbol === "SOLUSDT" || d.symbol === "ARBUSDT"));

// общий построитель свечей: close(k) задаётся функцией формы
const candleGc = (closeAt: (k: number) => number): GetCandles =>
  async (s, i, lim, sd) => {
    const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
    const out: ICandleData[] = [];
    for (let k = 0; k < n; k++) {
      const p = closeAt(k);
      out.push({ timestamp: since + k * step, open: p, high: p + 0.3, low: p - 0.3, close: p, volume: 1000 });
    }
    return out;
  };

describe("matrix-сигналы — объективные исходы по форме цены", () => {
  it("1) ДВА сигнала, цена ТОЛЬКО РОСЛА → exit > entry, оба в плюсе на разных уровнях", async () => {
    // close: 100.5, 101.5, 102.5, ... — монотонный рост. life-cap на 5-й свече close=105.5
    const m = await fit(candleGc((k) => 100.5 + k * 1.0));
    const sigs = matrixSignals(m);
    expect(sigs.length).toBe(2); // ровно два matrix-сигнала
    for (const s of sigs) {
      expect(s.entered).toBe(true);
      expect(s.independentClusters).toBe(2);
      expect(s.entryPrice).toBeCloseTo(100.5, 6); // close в зоне [100,101]
      expect(s.exitPrice).toBeCloseTo(105.5, 6);  // 5 свечей роста
      expect(s.exitPrice).toBeGreaterThan(s.entryPrice); // exit ВЫШЕ entry
      expect(s.pnl).toBeGreaterThan(0);
      expect(s.pnl).toBeCloseTo((105.5 - 100.5) / 100.5, 6);
    }
    // entry и exit на ЯВНО разных уровнях
    expect(sigs[0].exitPrice - sigs[0].entryPrice).toBeCloseTo(5.0, 6);
  });

  it("2) ДВА сигнала, цена БОКОВИК → exit ≈ entry, pnl близко к нулю", async () => {
    // close колеблется вокруг 100.5 синусом ±0.2, возвращается близко к старту
    const m = await fit(candleGc((k) => 100.5 + Math.sin(k / 3) * 0.2));
    const sigs = matrixSignals(m);
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entered).toBe(true);
      expect(s.entryPrice).toBeCloseTo(100.5, 6);
      // exit близко к entry (боковик): |exit - entry| мал
      expect(Math.abs(s.exitPrice - s.entryPrice)).toBeLessThan(0.5);
      expect(Math.abs(s.pnl)).toBeLessThan(0.005); // pnl близок к нулю
    }
  });

  it("2b) ДВА сигнала, НЕЙТРАЛЬНЫЙ ТРЕНД (плоско) → exit РОВНО == entry, pnl == 0", async () => {
    // close ровно 100.5 на всех свечах: тренд строго нулевой, без колебаний.
    // Это чище боковика — entry и exit ИДЕНТИЧНЫ, наклон цены = 0.
    const m = await fit(candleGc(() => 100.5));
    const sigs = matrixSignals(m);
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entered).toBe(true);
      expect(s.independentClusters).toBe(2);
      expect(s.entryPrice).toBe(100.5);
      expect(s.exitPrice).toBe(100.5);            // РОВНО равно entry
      expect(s.exitPrice).toBe(s.entryPrice);     // никакого расхождения
      expect(s.pnl).toBe(0);                       // pnl ровно ноль на нейтральном тренде
    }
  });

  it("3) ДВА сигнала, цена НЕ РОСЛА (падение) → exit < entry, оба в минусе", async () => {
    // close: 100.5, 99.5, 98.5, ... — монотонное падение. life-cap close=95.5
    const m = await fit(candleGc((k) => 100.5 - k * 1.0));
    const sigs = matrixSignals(m);
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entered).toBe(true);
      expect(s.independentClusters).toBe(2);
      expect(s.entryPrice).toBeCloseTo(100.5, 6);
      expect(s.exitPrice).toBeCloseTo(95.5, 6);   // 5 свечей падения
      expect(s.exitPrice).toBeLessThan(s.entryPrice); // exit НИЖЕ entry
      expect(s.pnl).toBeLessThan(0);                // long в минусе
      expect(s.pnl).toBeCloseTo((95.5 - 100.5) / 100.5, 6);
    }
  });

  it("сравнение трёх форм: pnl(рост) > pnl(боковик) > pnl(падение)", async () => {
    const up = matrixSignals(await fit(candleGc((k) => 100.5 + k * 1.0)));
    const flat = matrixSignals(await fit(candleGc((k) => 100.5 + Math.sin(k / 3) * 0.2)));
    const down = matrixSignals(await fit(candleGc((k) => 100.5 - k * 1.0)));
    expect(up[0].pnl).toBeGreaterThan(flat[0].pnl);
    expect(flat[0].pnl).toBeGreaterThan(down[0].pnl);
    // mode matrix во всех
    expect(up.every((s) => s.symbol === "SOLUSDT" || s.symbol === "ARBUSDT")).toBe(true);
  });
});
