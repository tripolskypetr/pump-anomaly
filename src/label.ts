import { Direction } from "./types";
import { GetCandles, alignTs, ICandleData } from "./candle";
import { ExitParams, replayExit, ReplayResult } from "./replay";

/**
 * Размеченный всплеск: реализованный PnL по prod-выходу для каждого набора
 * exit-параметров. Метку ставит симуляция твоего trailing/hard-stop по 1m-свечам,
 * а не close-to-close — поэтому stop hunting получает отрицательную метку.
 */
export interface LabeledBurst {
  symbol: string;
  direction: Direction;
  ts: number;
  /** ключ exit-набора → результат replay */
  byExit: Map<string, ReplayResult>;
}

/** Стабильный строковый ключ exit-набора для кэша/grid. */
export const exitKey = (p: ExitParams): string =>
  `tt${p.trailingTake}|hs${p.hardStop}|sp${p.stalenessSinceProfit}|sm${p.stalenessSinceMinutes}|life${p.staleMinutes}` +
  `|vz${p.volZThreshold ?? "_"}|pol${p.squeezePolicy ?? "none"}|sqt${p.squeezeThreshold ?? "_"}|bw${p.volBaselineWindow ?? "_"}`;

/**
 * Достаёт 1m-свечи от события вперёд на покрытие максимального life-cap и
 * прогоняет каждый exit-набор через replay. Зона входа берётся из события;
 * если не задана — точка entryFrom=entryTo=open первой свечи.
 */
export async function labelBurst(
  getCandles: GetCandles,
  symbol: string,
  direction: Direction,
  ts: number,
  exitSets: ExitParams[],
  entryFromPrice?: number,
  entryToPrice?: number,
): Promise<LabeledBurst | null> {
  const maxLife = Math.max(...exitSets.map((e) => e.staleMinutes));
  const since = alignTs(ts, "1m");
  const limit = maxLife * 2 + 5; // запас на поиск входа в зону

  // getCandles может бросить (look-ahead guard на хвосте истории, дыры в данных
  // символа — частое у меме-коинов с делистингом/паузами торгов, строгий count-match
  // адаптера). Тогда этот кандидат НЕ размечается и пропускается — но обучение в целом
  // не падает. Один битый символ не должен ронять весь fit.
  let candles: ICandleData[];
  try {
    candles = await getCandles(symbol, "1m", limit, since);
  } catch {
    return null;
  }
  if (!candles || candles.length === 0) return null;

  const from = entryFromPrice ?? candles[0].open;
  const to = entryToPrice ?? candles[0].open;

  const byExit = new Map<string, ReplayResult>();
  for (const ex of exitSets) {
    const r = replayExit(candles, direction, from, to, ex);
    // отбрасываем метку с НЕПОЛНЫМ горизонтом: в боковике вход случился поздно,
    // и после него не хватило свечей на полный life-cap. Иначе 24ч-горизонт
    // сравнивался бы с 1ч-горизонтом по обрезанному до пары часов пути — это
    // прямо корраптит impactHorizonMinutes (главный исследовательский выход).
    // no-entry (entered=false без truncated) сохраняем — это валидная метка «не вошли».
    if (r.truncated && r.entered) continue;
    byExit.set(exitKey(ex), r);
  }

  const anyEntered = [...byExit.values()].some((r) => r.entered);
  if (byExit.size === 0 || !anyEntered) return null;

  return { symbol, direction, ts, byExit };
}
