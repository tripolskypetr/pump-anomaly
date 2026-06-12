import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../src/index";
import { enumerateBursts } from "../src/enumerate";
import { ParserItem, SignalEvent } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

const DAY = 86_400_000;
const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);

const E = (ch: string, sym: string, ts: number): ParserItem =>
  ({ channel: ch, symbol: sym, direction: "long", ts, entryFromPrice: 100, entryToPrice: 101 });

// фон: {a,b}→TRX, {c,d}→NEAR каждый день (устанавливает два почерка-кластера)
function base(days: number): ParserItem[] {
  const items: ParserItem[] = [];
  for (let d = 0; d < days; d++) {
    items.push(E("a", "TRXUSDT", t0 + d * DAY + 3600_000));
    items.push(E("b", "TRXUSDT", t0 + d * DAY + 3600_000 + 60_000));
    items.push(E("c", "NEARUSDT", t0 + d * DAY + 13 * 3600_000));
    items.push(E("d", "NEARUSDT", t0 + d * DAY + 13 * 3600_000 + 60_000));
  }
  return items;
}
function converge(items: ParserItem[], sym: string, ts: number) {
  items.push(E("a", sym, ts)); items.push(E("b", sym, ts + 60_000));
  items.push(E("c", sym, ts + 120_000)); items.push(E("d", sym, ts + 180_000));
}

// рост: вход в зону [100,101] close=100.5, life-cap на 5-й свече close=105.5
const upGc: GetCandles = async (s, i, lim, sd) => {
  const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = 100.5 + k * 1.0; out.push({ timestamp: since + k * step, open: p, high: p + 0.3, low: p - 0.3, close: p, volume: 1000 }); }
  return out;
};
const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
  trailingTake: [50.0], hardStop: [50.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
  staleMinutes: [5], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
  volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
};
const fit = (items: ParserItem[]) =>
  PumpMatrix.fit(items, upGc, { mode: "matrix", onProgress: silentProgress, grid, selection: { nestedOuterFolds: 0 } });
const matrixSignals = (m: PumpMatrix) =>
  m.dump().filter((d) => d.independentClusters >= 2 && (d.symbol === "SOLUSDT" || d.symbol === "ARBUSDT"));

describe("matrix-сигналы — ЭКСТРЕМАЛЬНАЯ временная дистанция МЕЖДУ событиями", () => {
  // ВАЖНО: 177 дней — это разрыв МЕЖДУ двумя ОТДЕЛЬНЫМИ пампами, а НЕ длительность
  // одного. Сам памп всегда короткий (≤ maxBurstWindowMs). Эти тесты проверяют, что
  // два независимых коротких пампа детектируются хоть рядом, хоть далеко по времени.
  it("ЭКСТРЕМАЛЬНО ДАЛЕКО: два ОТДЕЛЬНЫХ пампа SOL@день1 и ARB@день178 (≈177 дней между ними)", async () => {
    const items = base(180);
    converge(items, "SOLUSDT", t0 + 1 * DAY + 8 * 3600_000);
    converge(items, "ARBUSDT", t0 + 178 * DAY + 8 * 3600_000);
    items.sort((a, b) => a.ts - b.ts);
    const m = await fit(items);
    const sigs = matrixSignals(m).sort((a, b) => a.ts - b.ts);
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.independentClusters).toBe(2);
      expect(s.entryPrice).toBeCloseTo(100.5, 6);
      expect(s.exitPrice).toBeCloseTo(105.5, 6);
      // КАЖДЫЙ памп короткий: позиция держится ≤ staleMinutes (тут 5 мин), не дни
      expect(s.heldMinutes).toBeLessThanOrEqual(5);
    }
    // разрыв МЕЖДУ событиями огромный, но это два разных пампа, не один длинный
    expect((sigs[1].ts - sigs[0].ts) / DAY).toBeGreaterThan(150);
  });

  it("КАЖДЫЙ памп внутри короткий: 4 канала растянутые на 5 часов — НЕ памп (burst-окно 1ч)", () => {
    // ключевая проверка: один «памп» НЕ может длиться часами. maxBurstWindowMs=1ч
    // ограничивает сбор событий во всплеск. Растянутые на 5ч события не группируются.
    const stretched = base(90);
    stretched.push(E("a", "SOLUSDT", t0 + 45 * DAY));
    stretched.push(E("b", "SOLUSDT", t0 + 45 * DAY + 1 * 3600_000));
    stretched.push(E("c", "SOLUSDT", t0 + 45 * DAY + 3 * 3600_000));
    stretched.push(E("d", "SOLUSDT", t0 + 45 * DAY + 5 * 3600_000));
    stretched.sort((a, b) => a.ts - b.ts);
    const sol = enumerateBursts(stretched as SignalEvent[], 3, 0.3, 0.5, 3600_000, Infinity)
      .filter((b) => b.symbol === "SOLUSDT");
    // растянутые события НЕ дают matrix-всплеск (independentClusters < 2)
    expect(sol.every((b) => b.independentClusters < 2)).toBe(true);
  });

  it("настоящий памп: 4 канала в 3 минуты → independentClusters=2 (контраст с растянутым)", () => {
    const tight = base(90);
    tight.push(E("a", "SOLUSDT", t0 + 45 * DAY));
    tight.push(E("b", "SOLUSDT", t0 + 45 * DAY + 60_000));
    tight.push(E("c", "SOLUSDT", t0 + 45 * DAY + 120_000));
    tight.push(E("d", "SOLUSDT", t0 + 45 * DAY + 180_000));
    tight.sort((a, b) => a.ts - b.ts);
    const sol = enumerateBursts(tight as SignalEvent[], 3, 0.3, 0.5, 3600_000, Infinity)
      .filter((b) => b.symbol === "SOLUSDT" && b.independentClusters >= 2);
    expect(sol.length).toBe(1); // короткий синхронный памп детектируется
  });

  it("ЭКСТРЕМАЛЬНО БЛИЗКО: два пампа в один день, разрыв ~10 минут → оба детектируются", async () => {
    const items = base(90);
    converge(items, "SOLUSDT", t0 + 45 * DAY + 8 * 3600_000);
    converge(items, "ARBUSDT", t0 + 45 * DAY + 8 * 3600_000 + 10 * MIN);
    items.sort((a, b) => a.ts - b.ts);
    const m = await fit(items);
    const sigs = matrixSignals(m).sort((a, b) => a.ts - b.ts);
    expect(sigs.length).toBe(2);
    for (const s of sigs) {
      expect(s.independentClusters).toBe(2);
      expect(s.entryPrice).toBeCloseTo(100.5, 6);
      expect(s.exitPrice).toBeCloseTo(105.5, 6);
    }
    // разрыв крошечный (< 1 часа)
    const gapMin = (sigs[1].ts - sigs[0].ts) / MIN;
    expect(gapMin).toBeGreaterThan(0);
    expect(gapMin).toBeLessThan(60);
  });

  it("оба разных тикера в обоих случаях (не схлопнулись в один сигнал)", async () => {
    const far = base(180);
    converge(far, "SOLUSDT", t0 + 1 * DAY + 8 * 3600_000);
    converge(far, "ARBUSDT", t0 + 178 * DAY + 8 * 3600_000);
    far.sort((a, b) => a.ts - b.ts);
    const syms = new Set(matrixSignals(await fit(far)).map((s) => s.symbol));
    expect(syms).toEqual(new Set(["SOLUSDT", "ARBUSDT"]));
  });

  it("КОНЕЧНОЕ окно стационарности на ДАЛЁКИХ сигналах: ранний может не пройти cold-start", () => {
    // окно 28д: разрыв 177д >> окна. Ранний сигнал (день1) не имеет истории до себя →
    // кластеры ещё не установлены → cold-start. Поздний (день178) имеет 28д истории.
    // Это КОРРЕКТНО: конечное окно не может подтвердить кластер без накопленной истории.
    const far = base(180);
    converge(far, "SOLUSDT", t0 + 1 * DAY + 8 * 3600_000);
    converge(far, "ARBUSDT", t0 + 178 * DAY + 8 * 3600_000);
    far.sort((a, b) => a.ts - b.ts);
    const infinite = enumerateBursts(far as SignalEvent[], 3, 0.3, 0.5, 3600_000, Infinity)
      .filter((b) => b.independentClusters >= 2);
    const windowed = enumerateBursts(far as SignalEvent[], 3, 0.3, 0.5, 3600_000, 28 * DAY)
      .filter((b) => b.independentClusters >= 2);
    expect(infinite.length).toBe(2);          // вся история → оба
    expect(windowed.length).toBeLessThanOrEqual(2);
    // поздний сигнал (с историей) проходит при конечном окне
    expect(windowed.some((b) => b.symbol === "ARBUSDT")).toBe(true);
  });

  it("ЭКСТРЕМАЛЬНО БЛИЗКО с конечным окном: оба в одном окне → оба детектируются", () => {
    // близкие сигналы в один день — любое разумное окно покрывает оба + историю
    const near = base(90);
    converge(near, "SOLUSDT", t0 + 45 * DAY + 8 * 3600_000);
    converge(near, "ARBUSDT", t0 + 45 * DAY + 8 * 3600_000 + 10 * MIN);
    near.sort((a, b) => a.ts - b.ts);
    const windowed = enumerateBursts(near as SignalEvent[], 3, 0.3, 0.5, 3600_000, 28 * DAY)
      .filter((b) => b.independentClusters >= 2);
    expect(windowed.length).toBe(2); // оба в окне 28д (день 45, история есть)
  });
});
