#!/usr/bin/env node
/**
 * Адаптер: архив TradingView-идей → ParserItem[] библиотеки.
 *
 *  - channel = автор, ts = момент публикации (мс), direction LONG/SHORT → long/short;
 *  - NEUTRAL и is_script отсеиваются (не торговые записи);
 *  - символ нормализуется на спот Binance: BTCUSD/BTCUSD.P/BTCUSDT → BTCUSDT,
 *    затем ВАЛИДИРУЕТСЯ по exchangeInfo (кэш data/binance-symbols.json) —
 *    XAUUSD/NAS100 и прочая не-крипта отпадают сами (XAUUSDT на споте нет).
 *
 * CLI: node scripts/tv-items.mjs  → сводка + inspectItems.
 * Модуль: import { loadTvItems } from "./tv-items.mjs"
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { inspectItems } from "../build/index.mjs";

const DATA = new URL("../data/", import.meta.url).pathname;
const SYMBOLS_CACHE = `${DATA}binance-symbols.json`;

/** спотовые TRADING-символы Binance (одноразовый фетч, кэш на диске) */
export async function binanceSymbols() {
  if (existsSync(SYMBOLS_CACHE)) return new Set(JSON.parse(readFileSync(SYMBOLS_CACHE, "utf8")));
  const r = await fetch("https://api.binance.com/api/v3/exchangeInfo", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`exchangeInfo HTTP ${r.status}`);
  const info = await r.json();
  const list = info.symbols.filter((s) => s.status === "TRADING").map((s) => s.symbol);
  writeFileSync(SYMBOLS_CACHE, JSON.stringify(list));
  return new Set(list);
}

/** BTCUSD / BTCUSD.P / BTCUSDT / BTCUSDC → BTCUSDT (кандидат; валидность решает биржа) */
export function toBinanceSymbol(shortName) {
  const s = String(shortName ?? "").toUpperCase().replace(/\.P[S]?$/, "");
  const m = s.match(/^([A-Z0-9]{2,15}?)(USDT|USDC|USD)$/);
  return m ? `${m[1]}USDT` : null;
}

/** архив → ParserItem[]; отчёт о причинах отсева — вторым полем */
export async function loadTvItems() {
  const valid = await binanceSymbols();
  const items = [];
  const dropped = { neutral: 0, script: 0, badSymbol: 0, notOnBinance: 0 };
  const notOnBinance = new Map();
  for (const line of readFileSync(`${DATA}tv-ideas.jsonl`, "utf8").split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.isScript) { dropped.script++; continue; }
    if (r.direction !== "LONG" && r.direction !== "SHORT") { dropped.neutral++; continue; }
    const symbol = toBinanceSymbol(r.symbol);
    if (!symbol) { dropped.badSymbol++; continue; }
    if (!valid.has(symbol)) {
      dropped.notOnBinance++;
      notOnBinance.set(symbol, (notOnBinance.get(symbol) ?? 0) + 1);
      continue;
    }
    items.push({
      channel: r.author, symbol,
      direction: r.direction === "LONG" ? "long" : "short",
      ts: r.ts, id: String(r.id),
    });
  }
  items.sort((a, b) => a.ts - b.ts);
  return { items, dropped, notOnBinance };
}

// ── CLI: сводка ──
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { items, dropped, notOnBinance } = await loadTvItems();
  console.log(`items: ${items.length} | отсев:`, JSON.stringify(dropped));
  const top = [...notOnBinance.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) console.log("не на Binance (топ):", top.map(([s, n]) => `${s}:${n}`).join(" "));
  if (items.length) {
    console.log(`диапазон: ${new Date(items[0].ts).toISOString().slice(0, 10)} → ${new Date(items[items.length - 1].ts).toISOString().slice(0, 10)}`);
    const bySym = new Map();
    const byCh = new Map();
    for (const it of items) {
      bySym.set(it.symbol, (bySym.get(it.symbol) ?? 0) + 1);
      byCh.set(it.channel, (byCh.get(it.channel) ?? 0) + 1);
    }
    console.log(`символов: ${bySym.size}, топ:`, [...bySym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `${s}:${n}`).join(" "));
    console.log(`авторов: ${byCh.size}, топ:`, [...byCh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s}:${n}`).join(" "));
    console.log("\ninspectItems:", JSON.stringify(inspectItems(items), null, 2));
  }
}
