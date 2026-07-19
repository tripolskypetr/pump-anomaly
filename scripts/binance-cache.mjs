// Дисковый кэш свечей Binance по UTC-дням: data/candle-cache/BTCUSDT-YYYY-MM-DD.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const CACHE = "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/data/candle-cache";
mkdirSync(CACHE, { recursive: true });
const MIN = 60_000;
const DAY = 1440 * MIN;

let requests = 0;
export const requestCount = () => requests;

// FAIL-FAST при смерти сети: продолжать fit без свечей = молча собрать мусорную
// модель из adapter-error меток. 10 сетевых отказов ПОДРЯД — честно умираем.
let consecutiveFails = 0;
const NET_DEAD_AFTER = 10;

/**
 * ПЕРЕИМЕНОВАННЫЕ ТИКЕРЫ Binance: история до даты ре-листинга живёт под старым
 * символом. Границы и непрерывность цены подтверждены пробами klines:
 *   TONUSDT   …2026-06-30 → GRAMUSDT с 2026-07-02 (1.60 → 1.59)
 *   MATICUSDT …2024-09-10 → POLUSDT  с 2024-09-13 (свап 1:1)
 *   FTMUSDT   …2025-01-13 → SUSDT    с 2025-01-16 (свап 1:1)
 * Дни лага листинга честно пусты (no-candles).
 */
const RENAMES = {
  GRAMUSDT: { before: Date.UTC(2026, 6, 2), was: "TONUSDT" },
  POLUSDT: { before: Date.UTC(2024, 8, 13), was: "MATICUSDT" },
  SUSDT: { before: Date.UTC(2025, 0, 16), was: "FTMUSDT" },
};

async function fetchKlines(symbol, startTime, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}&startTime=${startTime}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      if (++consecutiveFails >= NET_DEAD_AFTER) {
        console.error(`\nСЕТЬ УМЕРЛА (${NET_DEAD_AFTER} отказов подряд) — прерываю прогон, ` +
          "иначе модель молча соберётся из adapter-error меток. Перезапустите после восстановления.");
        process.exit(2);
      }
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
      continue;
    }
    requests++;
    if (r.status === 429 || r.status === 418) {
      await new Promise((res) => setTimeout(res, 30_000)); // бан-контроль Binance
      continue;
    }
    if (!r.ok) throw new Error(`binance ${r.status}`);
    consecutiveFails = 0;
    return await r.json();
  }
  throw new Error("binance rate-limited после 5 попыток");
}

const filePathOf = (symbol, dayStart) =>
  `${CACHE}/${symbol}-${new Date(dayStart).toISOString().slice(0, 10)}.json`;

/** день [dayStart, dayStart+24h) → 1440 компактных свечей [ts,o,h,l,c,v] */
async function loadDay(symbol, dayStart) {
  const file = filePathOf(symbol, dayStart);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  // переименованный тикер: за историей до ре-листинга идём под старым символом
  const ren = RENAMES[symbol];
  const fetchSymbol = ren && dayStart < ren.before ? ren.was : symbol;
  const rows = [];
  for (const [off, lim] of [[0, 1000], [1000 * MIN, 440]]) {
    const part = await fetchKlines(fetchSymbol, dayStart + off, lim);
    for (const k of part) {
      if (k[0] >= dayStart && k[0] < dayStart + DAY) {
        rows.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
      }
    }
  }
  writeFileSync(file, JSON.stringify(rows));
  return rows;
}

// In-memory LRU поверх диска. КАП обязателен: 30-40k (symbol,день)-пар по
// ~150КБ распарсенных свечей — это гигабайты; диск — истина, память — окно.
const MEM_CAP = 2048;
const mem = new Map();
async function dayOf(symbol, dayStart) {
  const key = `${symbol}|${dayStart}`;
  const hit = mem.get(key);
  if (hit) { // LRU: освежить позицию
    mem.delete(key);
    mem.set(key, hit);
    return hit;
  }
  const p = loadDay(symbol, dayStart);
  mem.set(key, p);
  if (mem.size > MEM_CAP) mem.delete(mem.keys().next().value);
  return p;
}

/** только гарантирует файл на диске — БЕЗ удержания свечей в памяти (для префетча) */
async function ensureDay(symbol, dayStart) {
  if (existsSync(filePathOf(symbol, dayStart))) return;
  await loadDay(symbol, dayStart);
}

/**
 * ПРЕФЕТЧ: скачать все (symbol, день)-пары ЗАРАНЕЕ с параллелизмом, чтобы фаза
 * математики не дёргала event loop сетевыми await'ами. Разметка с холодным кэшем
 * перемежает IO и CPU — воркеры ждут сеть по одному запросу, процессор простаивает;
 * префетч насыщает сеть N параллельными загрузками, затем математика идёт без
 * единого сетевого ожидания. Идемпотентен (диск-кэш) — прерванный перезапускается.
 */
export async function prefetchDays(pairs, { concurrency = 12, onProgress } = {}) {
  // дедуп по (symbol, day)
  const uniq = new Map();
  for (const p of pairs) uniq.set(`${p.symbol}|${p.day}`, p);
  const queue = [...uniq.values()];
  let done = 0;
  const failedSymbols = new Set();
  const worker = async () => {
    for (;;) {
      const p = queue.pop();
      if (!p) return;
      try {
        await ensureDay(p.symbol, p.day); // диск наполняется, память не растёт
      } catch (e) {
        // битый символ/день не валит префетч: разметка честно получит ту же
        // ошибку как adapter-error. Смерть сети убивает процесс в fetchKlines.
        if (!failedSymbols.has(p.symbol)) {
          failedSymbols.add(p.symbol);
          console.error(`префетч ${p.symbol}: ${e.message}`);
        }
      }
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, uniq.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  if (onProgress) onProgress(done, uniq.size);
  return { days: uniq.size, failedSymbols: [...failedSymbols] };
}

/** (symbol, ts-диапазон) → список дней для префетча */
export function daysForRange(symbol, fromTs, toTs) {
  const out = [];
  for (let d = Math.floor(fromTs / DAY) * DAY; d <= toTs; d += DAY) {
    out.push({ symbol, day: d });
  }
  return out;
}

/** GetCandles-контракт либы: align вниз, ровно limit свечей от sDate (или меньше у края) */
export const getCandles = async (symbol, _interval, limit, sDate) => {
  const start = Math.floor(sDate / MIN) * MIN;
  const end = start + limit * MIN;
  const d0 = Math.floor(start / DAY) * DAY;
  const out = [];
  for (let d = d0; d < end; d += DAY) {
    for (const [ts, o, h, l, c, v] of await dayOf(symbol, d)) {
      if (ts >= start && ts < end) {
        out.push({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v });
      }
    }
  }
  return out;
};
