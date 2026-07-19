#!/usr/bin/env node
/**
 * ХАРВЕСТЕР TradingView Ideas — обходит кап «1000 идей на запрос».
 *
 * Кап API делает symbol-ленту BTCUSD глубиной ~месяц. Лечение двухфазное:
 *   A) DISCOVERY: обойти symbol-ленты (кап 1000 у каждой) → пул авторов;
 *   B) АВТОРЫ: у каждого автора СВОЙ кап 1000, а постят они редко —
 *      их ленты глубоки на месяцы/годы. Полная выкачка топ-авторов даёт
 *      длинную мультисимвольную историю.
 *
 * Архив append-only (переживает любые прогоны, дедуп по id):
 *   data/tv-ideas.jsonl  — статика идеи + firstSeen (момент ПЕРВОГО снятия);
 *   data/tv-likes.jsonl  — снапшоты likes/comments/views при КАЖДОМ изменении
 *                          (первый снапшот свежей идеи ≈ состояние при публикации —
 *                          это чинит look-ahead текущих лайков);
 *   data/tv-state.json   — последние счётчики по id (для дельты снапшотов).
 *
 * Инкрементальность: ленты идут от новых к старым — встретив 2 страницы подряд
 * уже известных идей, обход ленты останавливается (хвост уже в архиве).
 * Повторные прогоны (крон) стоят ~1 страницу на ленту.
 *
 * Запуск: node scripts/tv-harvest.mjs
 *         [--symbols BTCUSD,ETHUSD,...] [--max-authors 80] [--no-authors] [--quiet]
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { ideasBySymbol, ideasByAuthor } from "./tv-ideas.mjs";

const DATA = new URL("../data/", import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });
const IDEAS = `${DATA}tv-ideas.jsonl`;
const LIKES = `${DATA}tv-likes.jsonl`;
const STATE = `${DATA}tv-state.json`;

const DEFAULT_SYMBOLS = [
  "BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD",
  "BNBUSD", "ADAUSD", "LINKUSD", "AVAXUSD", "PEPEUSD",
];
/** 2 страницы подряд известных идей → хвост ленты уже в архиве */
const KNOWN_STREAK_STOP = 48;
/** кап API: дальше 42 страниц по 24 лента не отдаёт */
const MAX_PAGES = 42;

// ── аргументы ──
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const symbols = flag("--symbols", DEFAULT_SYMBOLS.join(",")).split(",").filter(Boolean);
const maxAuthors = Number(flag("--max-authors", "80"));
const skipAuthors = argv.includes("--no-authors");
const quiet = argv.includes("--quiet");
const log = (...a) => { if (!quiet) console.log(...a); };

// ── архив ──
const known = new Set();
if (existsSync(IDEAS)) {
  for (const line of readFileSync(IDEAS, "utf8").split("\n")) {
    if (!line) continue;
    try { known.add(JSON.parse(line).id); } catch { /* битая строка не роняет харвест */ }
  }
}
const counts = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
log(`архив: ${known.size} идей`);

let added = 0;
let snapshots = 0;
const seenNow = Date.now();

function record(idea) {
  const isNew = !known.has(idea.id);
  if (isNew) {
    known.add(idea.id);
    appendFileSync(IDEAS, JSON.stringify({
      id: idea.id, ts: idea.timestamp * 1000, symbol: idea.shortName,
      fullName: idea.symbol, direction: idea.direction, author: idea.author,
      authorIsPro: idea.authorIsPro, isScript: idea.isScript,
      title: idea.title, url: idea.url, firstSeen: seenNow,
    }) + "\n");
    added++;
  }
  // снапшот популярности — только при изменении (или первом снятии)
  const key = String(idea.id);
  const cur = `${idea.likes},${idea.comments},${idea.views}`;
  if (counts[key] !== cur) {
    counts[key] = cur;
    appendFileSync(LIKES, JSON.stringify({
      id: idea.id, seenAt: seenNow,
      likes: idea.likes, comments: idea.comments, views: idea.views,
    }) + "\n");
    snapshots++;
  }
  return isNew;
}

/** обход одной ленты с ранней остановкой на известном хвосте */
async function drain(feed, label) {
  let streak = 0;
  let got = 0;
  try {
    for await (const idea of feed) {
      got++;
      if (record(idea)) streak = 0;
      else if (++streak >= KNOWN_STREAK_STOP) break;
    }
  } catch (e) {
    // одна упавшая лента не убивает харвест — честно сообщаем и идём дальше
    console.error(`лента ${label}: ${e.message} (собрано ${got})`);
  }
  return got;
}

// ── фаза A: discovery по символам ──
for (const s of symbols) {
  const got = await drain(ideasBySymbol(s, { maxPages: MAX_PAGES }), `symbol:${s}`);
  log(`symbol ${s}: просмотрено ${got}, всего новых ${added}`);
}

// ── фаза B: полные ленты топ-авторов (по числу направленных идей в архиве) ──
if (!skipAuthors) {
  const byAuthor = new Map();
  for (const line of readFileSync(IDEAS, "utf8").split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.direction === "NEUTRAL" || r.isScript || !r.author) continue;
    byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
  }
  const top = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxAuthors);
  log(`авторов в пуле: ${byAuthor.size}, качаем топ-${top.length}`);
  let i = 0;
  for (const [author, n] of top) {
    const got = await drain(ideasByAuthor(author, { maxPages: MAX_PAGES }), `author:${author}`);
    i++;
    if (i % 10 === 0 || got > 100) log(`[${i}/${top.length}] @${author} (${n} напр.): просмотрено ${got}, всего новых ${added}`);
  }
}

writeFileSync(STATE, JSON.stringify(counts));
console.log(`\nготово: +${added} новых идей, ${snapshots} снапшотов популярности, архив ${known.size} идей`);
