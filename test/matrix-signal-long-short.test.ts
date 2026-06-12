import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../src/index";
import { ParserItem } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

const DAY = 86_400_000;
const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
type Dir = "long" | "short";

const E = (ch: string, sym: string, ts: number, dir: Dir, from: number, to: number): ParserItem =>
  ({ channel: ch, symbol: sym, direction: dir, ts, entryFromPrice: from, entryToPrice: to });

// строит фон ({a,b}→TRX, {c,d}→NEAR) + два схождения на sym1@d1, sym2@d2
function build(dir: Dir, from: number, to: number, sym1: string, sym2: string, d1: number, d2: number, days: number, off2 = 0): ParserItem[] {
  const items: ParserItem[] = [];
  for (let d = 0; d < days; d++) {
    items.push(E("a", "TRXUSDT", t0 + d * DAY + 3600_000, dir, from, to));
    items.push(E("b", "TRXUSDT", t0 + d * DAY + 3600_000 + 60_000, dir, from, to));
    items.push(E("c", "NEARUSDT", t0 + d * DAY + 13 * 3600_000, dir, from, to));
    items.push(E("d", "NEARUSDT", t0 + d * DAY + 13 * 3600_000 + 60_000, dir, from, to));
    if (d === d1) for (const [ch, o] of [["a", 0], ["b", 60_000], ["c", 120_000], ["d", 180_000]] as [string, number][])
      items.push(E(ch, sym1, t0 + d * DAY + 8 * 3600_000 + o, dir, from, to));
    if (d === d2) for (const [ch, o] of [["a", 0], ["b", 60_000], ["c", 120_000], ["d", 180_000]] as [string, number][])
      items.push(E(ch, sym2, t0 + d * DAY + 8 * 3600_000 + off2 + o, dir, from, to));
  }
  return items.sort((a, b) => a.ts - b.ts);
}
const gc = (closeAt: (k: number) => number): GetCandles => async (s, i, lim, sd) => {
  const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = closeAt(k); out.push({ timestamp: since + k * step, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1000 }); }
  return out;
};
const grid = (stale: number) => ({
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
  trailingTake: [50.0], hardStop: [50.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
  staleMinutes: [stale], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
  volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
});
const run = async (items: ParserItem[], close: (k: number) => number, stale: number, s1: string, s2: string) => {
  const m = await PumpMatrix.fit(items, gc(close), { mode: "matrix", onProgress: silentProgress, grid: grid(stale), selection: { nestedOuterFolds: 0 } });
  return m.dump().filter((d) => d.independentClusters >= 2 && (d.symbol === s1 || d.symbol === s2)).sort((a, b) => a.ts - b.ts);
};

describe("LONG matrix-сигналы — разброс цены/тренда/времени", () => {
  it("L1) рост, зона [200,202], stale=8 → entry 201, exit 217, pnl +7.96%", async () => {
    const sigs = await run(build("long", 200, 202, "SOLUSDT", "ARBUSDT", 15, 55, 90), (k) => 201 + k * 2.0, 8, "SOLUSDT", "ARBUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBeCloseTo(201, 6);
      expect(s.exitPrice).toBeCloseTo(217, 6);     // 201 + 8×2
      expect(s.pnl).toBeCloseTo((217 - 201) / 201, 6);
      expect(s.pnl).toBeGreaterThan(0);
      expect(s.heldMinutes).toBe(8);
    }
  });

  it("L2) падение, зона [150,151], stale=6 → entry 150.5, exit 147.5, long в минусе", async () => {
    const sigs = await run(build("long", 150, 151, "HYPEUSDT", "INJUSDT", 20, 60, 90), (k) => 150.5 - k * 0.5, 6, "HYPEUSDT", "INJUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBeCloseTo(150.5, 6);
      expect(s.exitPrice).toBeCloseTo(147.5, 6);   // 150.5 - 6×0.5
      expect(s.pnl).toBeLessThan(0);                // long теряет на падении
      expect(s.pnl).toBeCloseTo((147.5 - 150.5) / 150.5, 6);
    }
  });

  it("L3) нейтрально (плоско), зона [499,501], stale=10 → entry=exit=500, pnl=0", async () => {
    const sigs = await run(build("long", 499, 501, "TIAUSDT", "SEIUSDT", 10, 70, 90), () => 500, 10, "TIAUSDT", "SEIUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBe(500);
      expect(s.exitPrice).toBe(500);
      expect(s.pnl).toBe(0);
      expect(s.heldMinutes).toBe(10);
    }
  });

  it("L4) ДАЛЕКО по времени: рост, два пампа day12 и day170 (~158 дней разрыв)", async () => {
    const sigs = await run(build("long", 100, 101, "SOLUSDT", "ARBUSDT", 12, 170, 180), (k) => 100.5 + k * 1.5, 4, "SOLUSDT", "ARBUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBeCloseTo(100.5, 6);
      expect(s.exitPrice).toBeCloseTo(106.5, 6);   // 100.5 + 4×1.5
      expect(s.heldMinutes).toBeLessThanOrEqual(4); // памп короткий
    }
    expect((sigs[1].ts - sigs[0].ts) / DAY).toBeGreaterThan(150);
  });

  it("L5) БЛИЗКО по времени: рост, два пампа в один день +20 минут", async () => {
    const sigs = await run(build("long", 100, 101, "SOLUSDT", "ARBUSDT", 40, 40, 90, 20 * MIN), (k) => 100.5 + k * 1.0, 5, "SOLUSDT", "ARBUSDT");
    expect(sigs.length).toBe(2);
    expect((sigs[1].ts - sigs[0].ts) / MIN).toBeCloseTo(20, 0);
    for (const s of sigs) expect(s.exitPrice).toBeGreaterThan(s.entryPrice);
  });
});

describe("SHORT matrix-сигналы — разброс цены/тренда/времени", () => {
  it("S1) падение, зона [50,51], stale=6 → entry 50.5, exit 47.5, short в плюсе +5.94%", async () => {
    const sigs = await run(build("short", 50, 51, "HYPEUSDT", "WIFUSDT", 25, 40, 80), (k) => 50.5 - k * 0.5, 6, "HYPEUSDT", "WIFUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBeCloseTo(50.5, 6);
      expect(s.exitPrice).toBeCloseTo(47.5, 6);    // 50.5 - 6×0.5
      expect(s.pnl).toBeGreaterThan(0);            // short зарабатывает на падении
      expect(s.pnl).toBeCloseTo((50.5 - 47.5) / 50.5, 6);
      expect(s.heldMinutes).toBe(6);
    }
  });

  it("S2) рост, зона [80,82], stale=7 → entry 81, exit 88, short в минусе -8.64%", async () => {
    const sigs = await run(build("short", 80, 82, "PUMPUSDT", "FARTUSDT", 30, 60, 90), (k) => 81 + k * 1.0, 7, "PUMPUSDT", "FARTUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBeCloseTo(81, 6);
      expect(s.exitPrice).toBeCloseTo(88, 6);      // 81 + 7×1
      expect(s.pnl).toBeLessThan(0);               // short теряет на росте
      expect(s.pnl).toBeCloseTo((81 - 88) / 81, 6);
    }
  });

  it("S3) нейтрально (плоско), зона [12,13], stale=9 → entry=exit=12.5, pnl=0", async () => {
    const sigs = await run(build("short", 12, 13, "BONKUSDT", "DOGEUSDT", 18, 65, 90), () => 12.5, 9, "BONKUSDT", "DOGEUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBe(12.5);
      expect(s.exitPrice).toBe(12.5);
      expect(s.pnl).toBe(0);
      expect(s.heldMinutes).toBe(9);
    }
  });

  it("S4) ДАЛЕКО по времени: падение, два пампа day8 и day165 (~157 дней разрыв)", async () => {
    const sigs = await run(build("short", 300, 303, "HYPEUSDT", "INJUSDT", 8, 165, 175), (k) => 301.5 - k * 3.0, 5, "HYPEUSDT", "INJUSDT");
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.entryPrice).toBeCloseTo(301.5, 6);
      expect(s.exitPrice).toBeCloseTo(286.5, 6);   // 301.5 - 5×3
      expect(s.pnl).toBeGreaterThan(0);            // short+ на падении
      expect(s.heldMinutes).toBeLessThanOrEqual(5);
    }
    expect((sigs[1].ts - sigs[0].ts) / DAY).toBeGreaterThan(150);
  });

  it("S5) БЛИЗКО по времени: падение, два пампа в один день +15 минут", async () => {
    const sigs = await run(build("short", 30, 31, "BONKUSDT", "DOGEUSDT", 44, 44, 80, 15 * MIN), (k) => 30.5 - k * 0.2, 5, "BONKUSDT", "DOGEUSDT");
    expect(sigs.length).toBe(2);
    expect((sigs[1].ts - sigs[0].ts) / MIN).toBeCloseTo(15, 0);
    for (const s of sigs) {
      expect(s.entryPrice).toBeCloseTo(30.5, 6);
      expect(s.exitPrice).toBeCloseTo(29.5, 6);    // 30.5 - 5×0.2
      expect(s.pnl).toBeGreaterThan(0);
    }
  });
});

describe("LONG vs SHORT — симметрия на одной форме цены", () => {
  it("на ПАДЕНИИ: long теряет, short зарабатывает (зеркально)", async () => {
    const longSigs = await run(build("long", 100, 101, "SOLUSDT", "ARBUSDT", 20, 55, 90), (k) => 100.5 - k * 1.0, 5, "SOLUSDT", "ARBUSDT");
    const shortSigs = await run(build("short", 100, 101, "SOLUSDT", "ARBUSDT", 20, 55, 90), (k) => 100.5 - k * 1.0, 5, "SOLUSDT", "ARBUSDT");
    expect(longSigs[0].pnl).toBeLessThan(0);
    expect(shortSigs[0].pnl).toBeGreaterThan(0);
    // зеркальность: |pnl| совпадает по модулю (та же цена, противоположное направление)
    expect(Math.abs(longSigs[0].pnl)).toBeCloseTo(Math.abs(shortSigs[0].pnl), 6);
  });

  it("на РОСТЕ: long зарабатывает, short теряет (зеркально)", async () => {
    const longSigs = await run(build("long", 100, 101, "HYPEUSDT", "WIFUSDT", 20, 55, 90), (k) => 100.5 + k * 1.0, 5, "HYPEUSDT", "WIFUSDT");
    const shortSigs = await run(build("short", 100, 101, "HYPEUSDT", "WIFUSDT", 20, 55, 90), (k) => 100.5 + k * 1.0, 5, "HYPEUSDT", "WIFUSDT");
    expect(longSigs[0].pnl).toBeGreaterThan(0);
    expect(shortSigs[0].pnl).toBeLessThan(0);
    expect(Math.abs(longSigs[0].pnl)).toBeCloseTo(Math.abs(shortSigs[0].pnl), 6);
  });
});
