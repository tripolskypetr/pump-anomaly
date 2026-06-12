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
    all.push(...chunk);
    remaining -= chunkLimit;
    if (remaining > 0) currentSince = currentSince + chunkLimit * step;
  }

  // дедуп по timestamp (на стыках чанков адаптер может вернуть пограничную свечу дважды)
  const unique = Array.from(
    new Map(all.map((c) => [c.timestamp, c])).values(),
  ).sort((a, b) => a.timestamp - b.timestamp);

  return unique;
}
