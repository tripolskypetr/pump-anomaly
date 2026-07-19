#!/usr/bin/env node
/**
 * TradingView Ideas scraper (официальный JSON API) — Node.js порт.
 *
 * Извлекает опубликованные идеи по символу, по автору или по поисковому запросу,
 * со связкой:  время публикации (UTC + Unix) + символ + направление (LONG/SHORT)
 * + косвенные метрики популярности (likes/boosts, comments, views).
 *
 * Эндпоинт (внутренний, отдаёт чистый JSON):
 *   https://www.tradingview.com/api/v1/ideas/
 *   params: page, per_page(<=24 стабильно), by=<user>, symbol=<TICKER>, q=<search>, locale
 *
 * Направление (symbol.direction):
 *   1 -> LONG (bullish), 2 -> SHORT (bearish), 0 -> NEUTRAL / без направления.
 *
 * Момент публикации = date_timestamp (Unix). Для look-ahead-bias-free бэктеста
 * используйте именно его как точку появления сигнала.
 *
 * Требования: Node >= 18 (native fetch). Без внешних зависимостей.
 * Запуск:      node tv-ideas.mjs BTCUSD --pages 5 --only SHORT --csv btc.csv
 * Как модуль:  import { ideasBySymbol } from './tv-ideas.mjs'
 */

const API = "https://www.tradingview.com/api/v1/ideas/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const DIRECTION_MAP = { 0: "NEUTRAL", 1: "LONG", 2: "SHORT" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @typedef {{
 *   id:number, datetimeUtc:string, timestamp:number, symbol:string,
 *   shortName:string, direction:string, likes:number, comments:number,
 *   views:number, author:string, authorIsPro:boolean, isScript:boolean,
 *   title:string, url:string
 * }} Idea */

/** Нормализация сырого объекта идеи из API в плоскую запись. */
function ideaFromRaw(o) {
  const sym = o.symbol || {};
  const usr = o.user || {};
  const ts = Number(o.date_timestamp);
  const chart = o.chart_url || "";
  const url = chart.startsWith("http")
    ? chart
    : chart
    ? "https://www.tradingview.com" + chart
    : "";
  return {
    id: Number(o.id),
    datetimeUtc: new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19),
    timestamp: ts,
    symbol: sym.full_name || sym.name || "",
    shortName: sym.short_name || "",
    direction: DIRECTION_MAP[sym.direction] ?? "NEUTRAL",
    likes: Number(o.likes_count || 0),
    comments: Number(o.comments_count || 0),
    views: Number(o.views_count || 0),
    author: usr.username || "",
    authorIsPro: Boolean(usr.is_pro),
    isScript: Boolean(o.is_script),
    title: (o.name || "").trim(),
    url,
  };
}

/**
 * Внутренний генератор: постранично тянет идеи по заданным параметрам.
 * Возвращает async-итератор Idea.
 */
async function* iterIdeas(params, { maxPages = 5, delay = 800 } = {}) {
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      ...params,
      page: String(page),
      per_page: "24",
      locale: "en",
    });
    // Анти-хэнг: у каждого запроса дедлайн (fetch без таймаута = неявная ∞),
    // у ретраев — кап (вечный `page--` при перманентном блоке = вечный цикл).
    let res = null;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(`${API}?${qs}`, {
          headers: {
            "User-Agent": UA,
            Accept: "application/json",
            Referer: "https://www.tradingview.com/",
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        if (attempt >= 5) throw new Error(`сеть не ответила на стр. ${page} после 5 попыток: ${e.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.status === 429) {
        // Cloudflare rate-limit — подождать и повторить, но не вечно
        if (attempt >= 5) throw new Error(`rate-limit на стр. ${page} после 5 попыток`);
        await sleep(5000 * attempt);
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) break;
    for (const o of results) yield ideaFromRaw(o);
    if (!data.next) break;
    await sleep(delay);
  }
}

/** symbol: короткий тикер как в URL, напр. BTCUSD, ETHUSD, XAUUSD, NAS100. */
export function ideasBySymbol(symbol, opts) {
  return iterIdeas({ symbol }, opts);
}

/** Все идеи конкретного автора (мультисимвольная лента). */
export function ideasByAuthor(username, opts) {
  return iterIdeas({ by: username }, opts);
}

/** Свободный поиск по идеям. */
export function ideasBySearch(query, opts) {
  return iterIdeas({ q: query }, opts);
}

/** Собрать async-итератор в массив. */
export async function collect(asyncIter) {
  const out = [];
  for await (const x of asyncIter) out.push(x);
  return out;
}

// --------------------------- CLI ---------------------------

function parseArgs(argv) {
  const a = {
    target: null,
    pages: 3,
    only: null, // LONG | SHORT | DIRECTIONAL
    minLikes: 0,
    noScripts: false,
    csv: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--pages") a.pages = Number(argv[++i]);
    else if (t === "--only") a.only = argv[++i];
    else if (t === "--min-likes") a.minLikes = Number(argv[++i]);
    else if (t === "--no-scripts") a.noScripts = true;
    else if (t === "--csv") a.csv = argv[++i];
    else rest.push(t);
  }
  a.target = rest[0];
  return a;
}

function toCsv(rows) {
  const cols = [
    "id", "datetimeUtc", "timestamp", "symbol", "shortName", "direction",
    "likes", "comments", "views", "author", "authorIsPro", "isScript",
    "title", "url",
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.target) {
    console.error(
      "Использование: node tv-ideas.mjs <BTCUSD | @username | /search> " +
        "[--pages N] [--only LONG|SHORT|DIRECTIONAL] [--min-likes N] " +
        "[--no-scripts] [--csv file.csv]"
    );
    process.exit(1);
  }

  let gen;
  if (a.target.startsWith("@")) gen = ideasByAuthor(a.target.slice(1), { maxPages: a.pages });
  else if (a.target.startsWith("/")) gen = ideasBySearch(a.target.slice(1), { maxPages: a.pages });
  else gen = ideasBySymbol(a.target, { maxPages: a.pages });

  let rows = [];
  for await (const x of gen) {
    if (a.only === "LONG" && x.direction !== "LONG") continue;
    if (a.only === "SHORT" && x.direction !== "SHORT") continue;
    if (a.only === "DIRECTIONAL" && x.direction === "NEUTRAL") continue;
    if (x.likes < a.minLikes) continue;
    if (a.noScripts && x.isScript) continue;
    rows.push(x);
  }

  rows.sort((p, q) => q.timestamp - p.timestamp);

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(
    `${pad("time (UTC)", 19)} ${pad("dir", 7)} ${pad("symbol", 14)} ` +
      `${padL("likes", 5)} ${padL("cmt", 4)}  author: title`
  );
  console.log("-".repeat(108));
  for (const r of rows) {
    console.log(
      `${pad(r.datetimeUtc, 19)} ${pad(r.direction, 7)} ${pad(r.shortName, 14)} ` +
        `${padL(r.likes, 5)} ${padL(r.comments, 4)}  @${r.author}: ${r.title.slice(0, 46)}`
    );
  }
  console.log(`\nВсего: ${rows.length} идей`);

  if (a.csv && rows.length) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(a.csv, toCsv(rows), "utf-8");
    console.log(`Сохранено: ${a.csv}`);
  }
}

// запуск как скрипт (не при импорте)
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("Ошибка:", e.message);
    process.exit(1);
  });
}
