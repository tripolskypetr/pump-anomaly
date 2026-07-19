// Парсинг MQL5 positions.csv → нормализованные позиции + сводка по диапазонам.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const DIR = "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/data";
const SYMBOL_MAP = { BTCUSD: "BTCUSDT", "BTCUSD+": "BTCUSDT" }; // XAUUSD/NAS100 — не Binance

// "2026.07.17 02:20:18" → ms КАК ЕСЛИ БЫ это был UTC (сдвиг откалибруем отдельно)
const parseTs = (s) => {
  const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};

const all = [];
const summary = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".positions.csv")).sort()) {
  const channel = f.split(".")[0];
  const text = readFileSync(`${DIR}/${f}`, "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).slice(1);
  let kept = 0, skipped = 0;
  const bySym = new Map();
  for (const line of lines) {
    const c = line.split(";");
    if (c.length < 11) { if (line.trim()) skipped++; continue; }
    const [openTime, type, , symbolRaw, openPrice, , closeTime, closePrice, , , profit] = c;
    const ts = parseTs(openTime.trim());
    const closeTs = parseTs(closeTime.trim());
    const dirRaw = type.trim().toLowerCase();
    const symbol = SYMBOL_MAP[symbolRaw.trim()];
    bySym.set(symbolRaw.trim() || "(empty)", (bySym.get(symbolRaw.trim() || "(empty)") ?? 0) + 1);
    if (!ts || !symbol || (dirRaw !== "buy" && dirRaw !== "sell")) { skipped++; continue; }
    all.push({
      channel, symbol,
      direction: dirRaw === "buy" ? "long" : "short",
      ts, closeTs,
      openPrice: +openPrice, closePrice: +closePrice,
      profit: profit === "" ? null : +profit,
    });
    kept++;
  }
  const chTs = all.filter((x) => x.channel === channel).map((x) => x.ts);
  summary.push({
    channel, kept, skipped,
    from: chTs.length ? new Date(Math.min(...chTs)).toISOString().slice(0, 10) : "-",
    to: chTs.length ? new Date(Math.max(...chTs)).toISOString().slice(0, 10) : "-",
    symbols: [...bySym.entries()].map(([s, n]) => `${s}:${n}`).join(","),
  });
}

all.sort((a, b) => a.ts - b.ts);
writeFileSync(`${DIR}/mql5-positions.json`, JSON.stringify(all));
console.table(summary);
console.log("итого BTCUSDT-позиций:", all.length);
console.log("общий диапазон:", new Date(all[0].ts).toISOString(), "→", new Date(all[all.length - 1].ts).toISOString());
const days = (all[all.length - 1].ts - all[0].ts) / 86400000;
console.log("дней:", days.toFixed(0), "| свечей 1m ≈", Math.round(days * 1440));
// направления и профиты (грубая сводка провайдеров по их же отчёту)
for (const s of summary) {
  const ch = all.filter((x) => x.channel === s.channel);
  const withP = ch.filter((x) => x.profit !== null);
  const sumP = withP.reduce((a, x) => a + x.profit, 0);
  const wins = withP.filter((x) => x.profit > 0).length;
  console.log(`${s.channel}: n=${ch.length} long=${ch.filter((x) => x.direction === "long").length} ` +
    `sumProfit=${sumP.toFixed(0)} winrate=${withP.length ? (wins / withP.length * 100).toFixed(0) : "-"}%`);
}
