import { GetCandles, ICandleData, CandleInterval, STEP_MS, alignTs } from "./candle";

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
