// Калибровка серверного времени MQL5: сдвиг, при котором цена открытия позиции
// совпадает со свечой Binance. Сдвиг ищем помесячно (брокеры живут в EET c DST).
import { readFileSync } from "node:fs";
import { getCandles, requestCount } from "./binance-cache.mjs";

const MIN = 60_000;
const HOUR = 3600_000;
const all = JSON.parse(readFileSync("/Users/tripolskypetr/Documents/GitHub/pump-anomaly/data/mql5-positions.json", "utf8"));

// сэмпл: до 8 событий на месяц, равномерно по всем каналам
const byMonth = new Map();
for (const p of all) {
  const mk = new Date(p.ts).toISOString().slice(0, 7);
  (byMonth.get(mk) ?? byMonth.set(mk, []).get(mk)).push(p);
}
const OFFSETS = [];
for (let h = -12; h <= 12; h++) OFFSETS.push(h * HOUR);

const monthly = [];
for (const [month, ps] of [...byMonth.entries()].sort()) {
  const step = Math.max(1, Math.floor(ps.length / 8));
  const sample = ps.filter((_, i) => i % step === 0).slice(0, 8);
  const scores = new Map(OFFSETS.map((o) => [o, []]));
  for (const p of sample) {
    // окно ±13ч вокруг события (день-кэш сам разрулит фетчи)
    const from = p.ts - 13 * HOUR;
    const candles = await getCandles("BTCUSDT", "1m", 26 * 60, from);
    const byTs = new Map(candles.map((c) => [c.timestamp, c]));
    for (const off of OFFSETS) {
      // серверное время = UTC + off → UTC = ts − off
      const c = byTs.get(Math.floor((p.ts - off) / MIN) * MIN);
      if (!c) continue;
      scores.get(off).push(Math.abs(p.openPrice - c.close) / c.close);
    }
  }
  let best = null;
  for (const [off, errs] of scores) {
    if (errs.length < sample.length * 0.7) continue;
    const med = [...errs].sort((a, b) => a - b)[Math.floor(errs.length / 2)];
    if (!best || med < best.med) best = { off, med };
  }
  monthly.push({ month, n: sample.length, offH: best ? best.off / HOUR : null, medErrPct: best ? +(best.med * 100).toFixed(4) : null });
}
console.table(monthly);
console.log("запросов к Binance:", requestCount());
