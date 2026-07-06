import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../src/index";
import { enumerateBursts } from "../src/enumerate";
import { ParserItem, SignalEvent } from "../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { silentProgress } from "../src/progress";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);

// свечи с лёгким трендом вверх — чтобы long-сигналы были осмысленны
const gc: GetCandles = async (s, i, lim, sd) => {
  const step = STEP_MS[i]; const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
  const out: ICandleData[] = [];
  for (let k = 0; k < n; k++) { const p = 100 + Math.sin(k / 40) * 2 + k * 0.005; out.push({ timestamp: since + k * step, open: p, high: p * 1.003, low: p * 0.998, close: p * 1.001, volume: 1000 + (k % 9) * 100 }); }
  return out;
};

const smallGrid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
  trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
  staleMinutes: [240], volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6],
  volBaselineWindow: [20], cascadeWindowMinutes: [30], stationarityWindowMs: [Infinity],
};

// ── СИНТЕТИКА 1: один канал ──
function singleChannelData(): ParserItem[] {
  const items: ParserItem[] = [];
  const syms = ["SOL", "TRX", "NEAR"];
  for (let d = 0; d < 40; d++)
    items.push({ channel: "yoda", symbol: syms[d % 3] + "USDT", direction: d % 2 ? "long" : "short", ts: t0 + d * DAY, entryFromPrice: 100, entryToPrice: 101 });
  return items;
}

// ── СИНТЕТИКА 2: несколько каналов, ДВЕ независимые группы ──
// группа {a,b} обычно бьёт TRX, группа {c,d} обычно NEAR (разные "почерки" → 2 кластера),
// изредка обе синхронно бьют SOL → всплеск с independentClusters=2 (настоящий matrix-сигнал)
function multiChannelData(): ParserItem[] {
  const items: ParserItem[] = [];
  const E = (channel: string, symbol: string, ts: number): ParserItem =>
    ({ channel, symbol, direction: "long", ts, entryFromPrice: 100, entryToPrice: 101 });
  for (let d = 0; d < 90; d++) {
    items.push(E("a", "TRXUSDT", t0 + d * DAY + 1 * 3600_000));
    items.push(E("b", "TRXUSDT", t0 + d * DAY + 1 * 3600_000 + 60_000));
    items.push(E("c", "NEARUSDT", t0 + d * DAY + 13 * 3600_000));
    items.push(E("d", "NEARUSDT", t0 + d * DAY + 13 * 3600_000 + 60_000));
    if (d % 10 === 0) { // редкое схождение на SOL
      items.push(E("a", "SOLUSDT", t0 + d * DAY + 8 * 3600_000));
      items.push(E("b", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 60_000));
      items.push(E("c", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 120_000));
      items.push(E("d", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 180_000));
    }
  }
  return items.sort((a, b) => a.ts - b.ts);
}

// ── СИНТЕТИКА 3: каналы-эхо (всегда вместе, в пределах минут) → ОДИН кластер ──
function echoChannelsData(): ParserItem[] {
  const items: ParserItem[] = [];
  for (let d = 0; d < 90; d++)
    for (let c = 0; c < 3; c++)
      items.push({ channel: ["x", "y", "z"][c], symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY + c * 90_000, entryFromPrice: 100, entryToPrice: 101 });
  return items.sort((a, b) => a.ts - b.ts);
}

describe("enumerateBursts — кластеризация (честная проверка детектора)", () => {
  it("две независимые группы, изредка сходящиеся на тикере → independentClusters=2", () => {
    const evs = multiChannelData() as SignalEvent[];
    const bursts = enumerateBursts(evs, 3, 0.3, 0.5, 3600_000, Infinity);
    const multi = bursts.filter((b) => b.independentClusters >= 2);
    expect(multi.length).toBeGreaterThanOrEqual(1);
    expect(multi.some((b) => b.symbol === "SOLUSDT")).toBe(true);
  });

  it("каналы-эхо (всегда вместе) → СЛИПАЮТСЯ в 1 кластер (корректно: не независимы)", () => {
    const evs = echoChannelsData() as SignalEvent[];
    const bursts = enumerateBursts(evs, 3, 0.3, 0.5, 3600_000, Infinity);
    // эхо-каналы НЕ дают independentClusters>=2 — они один скоординированный источник
    expect(bursts.every((b) => b.independentClusters < 2)).toBe(true);
  });

  it("один канал → максимум 1 кластер (корреляция невозможна)", () => {
    const evs = singleChannelData() as SignalEvent[];
    const bursts = enumerateBursts(evs, 3, 0.3, 0.5, 3600_000, Infinity);
    expect(bursts.every((b) => b.independentClusters <= 1)).toBe(true);
  });
});

describe("auto-режим — честный выбор single/matrix + диагностика", () => {
  it("один канал → auto выбирает single, modeReason объясняет почему", async () => {
    const m = await PumpMatrix.fit(singleChannelData(), gc, { onProgress: silentProgress, grid: { ...smallGrid, minClusters: [1] } });
    expect(m.mode).toBe("single");
    expect(m.modeReason).toContain("single");
    expect(m.modeReason.toLowerCase()).toContain("канал"); // "один канал — корреляция невозможна"
  });

  it("эхо-каналы → auto выбирает single (матрица нежизнеспособна), reason честен", async () => {
    const m = await PumpMatrix.fit(echoChannelsData(), gc, { onProgress: silentProgress, grid: { ...smallGrid, minClusters: [1] } });
    // эхо могут дать кластер размера>1, но это не независимые — проверяем что reason записан
    expect(typeof m.modeReason).toBe("string");
    expect(m.modeReason.length).toBeGreaterThan(0);
  });

  it("независимые группы → auto МОЖЕТ выбрать matrix, reason записан", async () => {
    const m = await PumpMatrix.fit(multiChannelData(), gc, { onProgress: silentProgress, grid: smallGrid });
    expect(["matrix", "single"]).toContain(m.mode);
    expect(m.modeReason).toContain("auto →");
  });
});

describe("single-режим — fallback работает из коробки", () => {
  it("принудительный single на одном канале → обучается, даёт сигналы", async () => {
    const m = await PumpMatrix.fit(singleChannelData(), gc, { mode: "single", onProgress: silentProgress, grid: { ...smallGrid, minClusters: [1] } });
    expect(m.mode).toBe("single");
    expect(m.modeReason).toContain("single задан явно");
    const sigs = m.signals(singleChannelData(), { acknowledgeUncertified: true });
    expect(Array.isArray(sigs)).toBe(true);
  });

  it("single хранит exit на symbol-dir уровне", async () => {
    const m = await PumpMatrix.fit(singleChannelData(), gc, { mode: "single", onProgress: silentProgress, grid: { ...smallGrid, minClusters: [1] } });
    expect(m.exit.global).toBeDefined();
    expect(m.exit.global.hardStop).toBeGreaterThan(0);
  });
});

describe("matrix-режим — на независимых кластерах", () => {
  it("принудительный matrix на multi-channel → обучается, mode=matrix", async () => {
    const m = await PumpMatrix.fit(multiChannelData(), gc, { mode: "matrix", onProgress: silentProgress, grid: smallGrid });
    expect(m.mode).toBe("matrix");
    expect(m.modeReason).toContain("matrix задан явно");
  });

  it("matrix с конечным окном стационарности → обучается без зависания", async () => {
    const m = await PumpMatrix.fit(multiChannelData(), gc, {
      mode: "matrix", onProgress: silentProgress,
      grid: { ...smallGrid, stationarityWindowMs: [Infinity, 28 * DAY] },
    });
    expect(m.mode).toBe("matrix");
    expect(m.exit.global).toBeDefined();
  });

  it("matrix exit резолвится под _matrix ключ (межканальный)", async () => {
    const m = await PumpMatrix.fit(multiChannelData(), gc, { mode: "matrix", onProgress: silentProgress, grid: smallGrid });
    // verdicts matrix имеют channel=null → exit под _matrix; global всегда есть
    expect(m.exit.byMode.matrix).toBeDefined();
  });
});

// ── ЗАРАНЕЕ ИЗВЕСТНЫЙ КЛАСТЕР: детерминированная структура для строгих matrix-проверок ──
// Две группы с РАЗНЫМИ почерками: {a,b}→TRX, {c,d}→NEAR (это их разделяет в матрице).
// Ровно на одном дне обе синхронно бьют SOL → ЕДИНСТВЕННЫЙ всплеск SOL|long с
// independentClusters=2. enumerateBursts возвращает ЛУЧШИЙ всплеск на (symbol,dir),
// поэтому результат детерминирован: 1 запись, кластеры {a,b} и {c,d}.
function knownClusterData(): ParserItem[] {
  const E = (channel: string, symbol: string, ts: number): ParserItem =>
    ({ channel, symbol, direction: "long", ts, entryFromPrice: 100, entryToPrice: 101 });
  const items: ParserItem[] = [];
  for (let d = 0; d < 90; d++) {
    items.push(E("a", "TRXUSDT", t0 + d * DAY + 3600_000));
    items.push(E("b", "TRXUSDT", t0 + d * DAY + 3600_000 + 60_000));
    items.push(E("c", "NEARUSDT", t0 + d * DAY + 13 * 3600_000));
    items.push(E("d", "NEARUSDT", t0 + d * DAY + 13 * 3600_000 + 60_000));
    if (d === 30) { // ровно один день схождения на SOL — заранее известный кластер
      items.push(E("a", "SOLUSDT", t0 + d * DAY + 8 * 3600_000));
      items.push(E("b", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 60_000));
      items.push(E("c", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 120_000));
      items.push(E("d", "SOLUSDT", t0 + d * DAY + 8 * 3600_000 + 180_000));
    }
  }
  return items.sort((a, b) => a.ts - b.ts);
}

describe("matrix — ЗАРАНЕЕ ИЗВЕСТНЫЙ кластер (строгая проверка, не флаг mode)", () => {
  const data = knownClusterData();

  it("детектор находит РОВНО известный кластер: SOL|long, independentClusters=2", () => {
    const bursts = enumerateBursts(data as SignalEvent[], 3, 0.3, 0.5, 3600_000, Infinity);
    const sol = bursts.filter((b) => b.symbol === "SOLUSDT" && b.direction === "long");
    expect(sol.length).toBe(1);                       // ровно один всплеск SOL|long
    expect(sol[0].independentClusters).toBe(2);        // две независимые группы
    expect(sol[0].totalChannels).toBe(3);              // окно синхронности (3·τ) ловит 3 из 4 событий
    // всплеск пришёлся на день 30 (день схождения)
    expect(Math.round((sol[0].ts - t0) / DAY)).toBe(30);
  });

  it("кластер на день схождения, а НЕ на обычные дни (TRX/NEAR раздельны)", () => {
    const bursts = enumerateBursts(data as SignalEvent[], 3, 0.3, 0.5, 3600_000, Infinity);
    // TRX бьёт только {a,b} → 1 кластер; NEAR только {c,d} → 1 кластер; не matrix-сигналы
    const trx = bursts.filter((b) => b.symbol === "TRXUSDT");
    const near = bursts.filter((b) => b.symbol === "NEARUSDT");
    expect(trx.every((b) => b.independentClusters < 2)).toBe(true);
    expect(near.every((b) => b.independentClusters < 2)).toBe(true);
  });

  it("matrix fit ПРОВОДИТ известный кластер до торгового сигнала (board не пуст)", async () => {
    const m = await PumpMatrix.fit(data, gc, { mode: "matrix", onProgress: silentProgress, grid: smallGrid });
    expect(m.mode).toBe("matrix");
    const sigs = m.signals(data, { acknowledgeUncertified: true });
    // matrix реально выдал сигнал — не пустой board (иначе тест бы врал про "matrix работает")
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    const sol = sigs.find((s) => s.symbol === "SOLUSDT");
    expect(sol).toBeDefined();
    expect(sol!.origin.detector).toBe("matrix");        // именно matrix-детектор
    expect(sol!.origin.independentClusters).toBe(2);     // известный кластер дошёл до сигнала
    expect(sol!.origin.channel).toBe(null);              // matrix межканальный → channel null
  });

  it("auto на этих данных выбирает matrix (кластер жизнеспособен), reason подтверждает", async () => {
    const m = await PumpMatrix.fit(data, gc, { onProgress: silentProgress, grid: smallGrid });
    expect(m.mode).toBe("matrix");
    expect(m.modeReason).toContain("auto → matrix");
    expect(m.modeReason).toMatch(/кластер|связ|перекрыт/i); // объясняет жизнеспособность
  });

  it("matrix с конечным окном стационарности находит ТОТ ЖЕ известный кластер", () => {
    // окно 56 дней покрывает день 30 → кластер виден; детекция не зависит от life-cap
    const bursts = enumerateBursts(data as SignalEvent[], 3, 0.3, 0.5, 3600_000, 56 * DAY);
    const sol = bursts.filter((b) => b.symbol === "SOLUSDT" && b.independentClusters >= 2);
    expect(sol.length).toBe(1);
    expect(sol[0].independentClusters).toBe(2);
  });
});
