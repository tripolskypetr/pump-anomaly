// Дисковый кэш свечей Binance по UTC-дням: data/candle-cache/BTCUSDT-YYYY-MM-DD.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const CACHE = "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/data/candle-cache";
mkdirSync(CACHE, { recursive: true });
const MIN = 60_000;
const DAY = 1440 * MIN;

let requests = 0;
export const requestCount = () => requests;

async function fetchKlines(symbol, startTime, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}&startTime=${startTime}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url);
    requests++;
    if (r.status === 429 || r.status === 418) {
      await new Promise((res) => setTimeout(res, 30_000)); // бан-контроль Binance
      continue;
    }
    if (!r.ok) throw new Error(`binance ${r.status}`);
    return await r.json();
  }
  throw new Error("binance rate-limited после 5 попыток");
}

/** день [dayStart, dayStart+24h) → 1440 компактных свечей [ts,o,h,l,c,v] */
async function loadDay(symbol, dayStart) {
  const key = `${symbol}-${new Date(dayStart).toISOString().slice(0, 10)}`;
  const file = `${CACHE}/${key}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const rows = [];
  for (const [off, lim] of [[0, 1000], [1000 * MIN, 440]]) {
    const part = await fetchKlines(symbol, dayStart + off, lim);
    for (const k of part) {
      if (k[0] >= dayStart && k[0] < dayStart + DAY) {
        rows.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
      }
    }
  }
  writeFileSync(file, JSON.stringify(rows));
  return rows;
}

const mem = new Map(); // in-memory поверх диска
async function dayOf(symbol, dayStart) {
  const key = `${symbol}|${dayStart}`;
  if (!mem.has(key)) mem.set(key, loadDay(symbol, dayStart));
  return mem.get(key);
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
