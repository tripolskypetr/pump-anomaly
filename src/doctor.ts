import { GetCandles, alignTs, STEP_MS } from "./candle";
import { withTimeout, DEFAULT_CANDLE_TIMEOUT_MS } from "./chunked-candles";
import { ParserItem } from "./types";
import { normalizeParserItems } from "./index";

/**
 * ДОКТОР — самопроверка интеграции до первого fit.
 *
 * Ловушка №1 при онбординге — контракт getCandles: семантика
 * (limit, sDate) → [align(sDate), align(sDate)+limit·step) нарушается в чужих
 * адаптерах постоянно (не выровнен старт, лимит не соблюдён, несортировано,
 * дубли), и это деградирует МОЛЧА: метки тихо превращаются в no-candles /
 * truncated, модель «просто хуже». Доктор превращает тихую порчу в конкретный
 * список проблем с человеческими формулировками.
 */

export interface AdapterCheck {
  ok: boolean;
  /** конкретные нарушения контракта — чинить обязательно */
  issues: string[];
  /** наблюдения, не являющиеся нарушением (дыры в истории и т.п.) */
  notes: string[];
}

/**
 * Прогоняет адаптер тестовыми запросами и проверяет контракт. Нужна точка, где
 * у биржи ТОЧНО есть данные: symbol + ts (по умолчанию BTCUSDT, двое суток назад).
 */
export async function validateGetCandles(
  getCandles: GetCandles,
  opts: { symbol?: string; ts?: number; timeoutMs?: number } = {},
): Promise<AdapterCheck> {
  // доктор не имеет права зависнуть, диагностируя зависший адаптер
  const gc = withTimeout(getCandles, opts.timeoutMs ?? DEFAULT_CANDLE_TIMEOUT_MS);
  const issues: string[] = [];
  const notes: string[] = [];
  const step = STEP_MS["1m"];
  const symbol = opts.symbol ?? "BTCUSDT";
  const base = alignTs(opts.ts ?? Date.now() - 2 * 24 * 3600_000, "1m");
  // нарочно НЕвыровненный запрос: +37с внутрь минуты
  const ragged = base + 37_000;

  let candles;
  try {
    candles = await gc(symbol, "1m", 50, ragged);
  } catch (e) {
    return {
      ok: false,
      issues: [`адаптер бросил исключение на базовом запросе (${symbol}, limit=50): ${e instanceof Error ? e.message : String(e)}`],
      notes: ["проверьте символ/дату: докторy нужна точка, где у биржи точно есть 1m-данные"],
    };
  }

  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      ok: false,
      issues: [`адаптер вернул пусто на (${symbol}, limit=50, sDate=${new Date(ragged).toISOString()}) — либо контракт сломан, либо нет данных в этой точке`],
      notes: [],
    };
  }

  // 1) выравнивание старта вниз
  if (candles[0].timestamp !== base) {
    issues.push(
      `старт не выровнен: запросил sDate внутри минуты (…:37с), ожидал первую свечу ${new Date(base).toISOString()}, получил ${new Date(candles[0].timestamp).toISOString()} — адаптер обязан выравнивать sDate ВНИЗ к границе минуты`,
    );
  }
  // 2) лимит
  if (candles.length > 50) issues.push(`limit не соблюдён: запросил 50, получил ${candles.length}`);
  if (candles.length < 50) notes.push(`получено ${candles.length}/50 свечей — допустимо только у края истории/дыры`);
  // 3) сортировка/дубли/шаг
  let unsorted = 0;
  let dups = 0;
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].timestamp - candles[i - 1].timestamp;
    if (d < 0) unsorted++;
    else if (d === 0) dups++;
    else if (d !== step) gaps++;
  }
  if (unsorted) issues.push(`свечи не отсортированы по времени (${unsorted} инверсий)`);
  if (dups) issues.push(`дубли timestamp (${dups} шт.) — на стыках чанков адаптер отдаёт границу дважды`);
  if (gaps) notes.push(`дыры в ряду (${gaps} разрывов ≠ 1м) — терпимо для неликвида, но проверьте источник`);
  // 4) санитария OHLCV
  let badOhlc = 0;
  for (const c of candles) {
    const ok = Number.isFinite(c.open) && Number.isFinite(c.close) && Number.isFinite(c.volume)
      && c.high >= Math.max(c.open, c.close) - 1e-9 && c.low <= Math.min(c.open, c.close) + 1e-9
      && c.volume >= 0;
    if (!ok) badOhlc++;
  }
  if (badOhlc) issues.push(`битые OHLCV: ${badOhlc} свечей (high < max(open,close), low > min(open,close), NaN или отрицательный объём)`);
  // 5) малый лимит соблюдается
  try {
    const five = await gc(symbol, "1m", 5, base);
    if (Array.isArray(five) && five.length > 5) issues.push(`limit=5 не соблюдён: получено ${five.length}`);
  } catch { notes.push("повторный запрос (limit=5) бросил — нестабильный адаптер?"); }

  return { ok: issues.length === 0, issues, notes };
}

export interface ItemsReport {
  total: number;
  valid: number;
  /** отброшено нормализацией (null, нечисловой ts, кривое направление) */
  invalid: number;
  channels: number;
  symbols: number;
  spanDays: number;
  /** точные дубликаты (channel|symbol|direction|ts) */
  duplicates: number;
  issues: string[];
  notes: string[];
}

/** Санитария parser-items ДО fit: что за данные и хватит ли их. */
export function inspectItems(items: ParserItem[]): ItemsReport {
  const clean = normalizeParserItems(items);
  const issues: string[] = [];
  const notes: string[] = [];
  const invalid = items.length - clean.length;
  if (invalid > 0) issues.push(`${invalid} записей отброшено нормализацией — проверьте источник (ts числом в мс, direction "long"/"short")`);

  const seen = new Set<string>();
  let duplicates = 0;
  for (const e of clean) {
    const k = `${e.channel}|${e.symbol}|${e.direction}|${e.ts}`;
    if (seen.has(k)) duplicates++;
    else seen.add(k);
  }
  if (duplicates > 0) issues.push(`${duplicates} точных дубликатов — парсер пишет одно событие дважды?`);

  const channels = new Set(clean.map((e) => e.channel)).size;
  const symbols = new Set(clean.map((e) => e.symbol)).size;
  const ts = clean.map((e) => e.ts).sort((a, b) => a - b);
  const spanDays = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / 86_400_000 : 0;

  if (channels === 1) notes.push("один канал — матрица авторства невозможна, будет single-режим (каждый пост = кандидат)");
  if (spanDays < 14 && clean.length > 0) notes.push(`история короткая (${spanDays.toFixed(0)} дн.) — walk-forward срезам будет тесно`);
  if (clean.length < 50) notes.push(`${clean.length} событий — сертификация обычно требует десятков СДЕЛОК; ждите вердикт "paper" и копите форвард`);

  return {
    total: items.length, valid: clean.length, invalid,
    channels, symbols, spanDays: +spanDays.toFixed(1), duplicates,
    issues, notes,
  };
}
