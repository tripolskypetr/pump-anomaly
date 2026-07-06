import { GetCandles, ICandleData, CandleInterval, STEP_MS, alignTs } from "./candle";

/**
 * Дефолтное терпение к сети: сколько ждать ответа getCandles, прежде чем честно
 * упасть. КОНСТАНТА СРЕДЫ (не влияет на математику при живой сети) — но её
 * ОТСУТСТВИЕ было худшей магической константой из всех: неявная ∞, при которой
 * повисший адаптер = навсегда повисший fit/plan без единого сообщения.
 */
export const DEFAULT_CANDLE_TIMEOUT_MS = 30_000;

/**
 * Дедлайн-обёртка над getCandles: любой вызов либо отвечает за timeoutMs, либо
 * отклоняется с внятной ошибкой. Внутри конвейера отказ пойман штатно:
 * в разметке кандидат станет adapter-error с текстом таймаута в meta.labeling.errors,
 * в plan()/backtest() — сигнал без свечей. Зависание превращается в диагностику.
 */
export function withTimeout(getCandles: GetCandles, timeoutMs: number): GetCandles {
  return (symbol, interval, limit, sDate, eDate) =>
    new Promise<ICandleData[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `getCandles не ответил за ${timeoutMs}мс (${symbol} ${interval} limit=${limit}) — сеть/адаптер завис (таймаут candleTimeoutMs)`,
      )), timeoutMs);
      Promise.resolve(getCandles(symbol, interval, limit, sDate, eDate)).then(
        (r) => { clearTimeout(timer); resolve(r); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
}

/**
 * Кэширующая обёртка над getCandles (ключ = symbol|interval|limit|since).
 *
 *  - PROMISE-DEDUP: конкурентные запросы одного окна (пул разметки) сливаются в
 *    один сетевой вызов — оба ждут общий promise, а не бьют биржу дважды.
 *  - FIFO-кап держит память (окно 1445 свечей ≈ 130КБ; cap 512 ≈ 65МБ worst-case).
 *  - Переживает границы fit: walkForward оборачивает источник ОДИН раз и передаёт
 *    во все срезы — K переобучений не перезапрашивают одну и ту же историю.
 *
 * Запросы с eDate не кэшируются (внутренние пути либы их не используют).
 * Ошибка источника НЕ кэшируется — следующий вызов попробует снова.
 */
export function withCandleCache(getCandles: GetCandles, capacity = 512): GetCandles {
  const cache = new Map<string, Promise<ICandleData[]>>();
  return async (symbol, interval, limit, sDate, eDate) => {
    if (eDate !== undefined) return getCandles(symbol, interval, limit, sDate, eDate);
    const key = `${symbol}|${interval}|${limit}|${sDate}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const p = Promise.resolve(getCandles(symbol, interval, limit, sDate));
    if (cache.size >= capacity) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, p);
    p.catch(() => cache.delete(key)); // ошибку не кэшируем
    return p;
  };
}

/** Максимум свечей в одном чанке (как CC_MAX_CANDLES_PER_REQUEST в проде). */
export const MAX_CANDLES_PER_CHUNK = 500;

/**
 * Chunked-загрузчик свечей. Дублирует логику пагинации из prod-адаптера: если
 * запрошено больше MAX_CANDLES_PER_CHUNK, бьёт на чанки, двигая since вперёд на
 * chunkLimit·step, и склеивает с дедупликацией по timestamp.
 *
 * Зачем внутри либы: labelBurst под длинный импакт-горизонт (staleMinutes до 1440)
 * просит staleMinutes·2+5 ≈ 2885 свечей. Если адаптер пагинацию НЕ делает сам и
 * упирается в лимит биржи, либа должна разрулить это сама, а не зависеть от того,
 * как реализован чужой getCandles.
 *
 * Семантика — forward от since (case sDate+limit): возвращает ровно столько свечей,
 * сколько доступно, начиная с align(since). Если адаптер на каком-то чанке вернул
 * пусто (край истории / дыра) — останавливаемся и отдаём, что собрали.
 */
export async function fetchCandlesChunked(
  getCandles: GetCandles,
  symbol: string,
  interval: CandleInterval,
  limit: number,
  since: number,
  chunkSize: number = MAX_CANDLES_PER_CHUNK,
): Promise<ICandleData[]> {
  const step = STEP_MS[interval];
  const start = alignTs(since, interval);

  // короткий путь: укладывается в один чанк → прямой вызов
  if (limit <= chunkSize) {
    return getCandles(symbol, interval, limit, start);
  }

  const all: ICandleData[] = [];
  let remaining = limit;
  let currentSince = start;

  while (remaining > 0) {
    const chunkLimit = Math.min(remaining, chunkSize);
    const chunk = await getCandles(symbol, interval, chunkLimit, currentSince);
    if (!chunk || chunk.length === 0) break; // край истории / дыра — отдаём собранное
    for (const c of chunk) all.push(c); // НЕ спред: при большом limit чанк переполнит стек

    // ЧАСТИЧНЫЙ чанк (биржа недодала: вернула < chunkLimit, но не пусто) — двигаем
    // since от ФАКТИЧЕСКИ последней свечи (+step), а remaining уменьшаем на реально
    // полученное (chunk.length). Иначе since прыгает на полный chunkLimit·step, минуя
    // недополученный хвост → дыра в склеенном ряду + недосчёт. Свечи могут прийти
    // неотсортированными — берём max(ts), а не последний элемент.
    let maxTs = currentSince;
    for (const c of chunk) if (c.timestamp > maxTs) maxTs = c.timestamp;
    remaining -= chunk.length;
    currentSince = maxTs + step;
  }

  // дедуп по timestamp (на стыках чанков адаптер может вернуть пограничную свечу
  // дважды). Оставляем ПЕРВОЕ вхождение: при forward-пагинации первая свеча с данным
  // ts пришла из более раннего/авторитетного чанка. Last-write мог бы подменить её
  // повторной/битой копией из следующего чанка.
  const seen = new Map<number, ICandleData>();
  for (const c of all) {
    if (!seen.has(c.timestamp)) seen.set(c.timestamp, c);
  }
  const unique = Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);

  return unique;
}
