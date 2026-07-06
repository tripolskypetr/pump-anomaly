import { Direction } from "./types";
import { GetCandles, entryStartTs, ICandleData } from "./candle";
import { fetchCandlesChunked } from "./chunked-candles";
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

/**
 * Исход разметки одного кандидата. Диагностика «немых» пустых fit: пустой результат
 * выглядит одинаково для «нет данных» и «нет входов», а это РАЗНЫЕ проблемы (битый
 * getCandles vs реально не было входов в зону).
 *  - ok           — размечен, есть вход (burst != null);
 *  - adapter-error — getCandles бросил (look-ahead guard / дыра / count-mismatch);
 *  - no-candles    — getCandles вернул пусто (символ/диапазон не дали свечей);
 *  - no-entry      — свечи есть, но ни один exit-набор не вошёл в зону (или все truncated).
 */
export type LabelOutcome = "ok" | "adapter-error" | "no-candles" | "no-entry";

/** Результат labelBurst: типизированный исход + сам размеченный всплеск (null кроме ok). */
export interface LabelResult {
  outcome: LabelOutcome;
  burst: LabeledBurst | null;
  /** текст брошенного getCandles исключения (только при outcome="adapter-error"). */
  error?: string;
}

/** Стабильный строковый ключ exit-набора для кэша/grid. */
export const exitKey = (p: ExitParams): string =>
  `tt${p.trailingTake}|hs${p.hardStop}|sp${p.stalenessSinceProfit}|sm${p.stalenessSinceMinutes}|life${p.staleMinutes}` +
  `|vz${p.volZThreshold ?? "_"}|pol${p.squeezePolicy ?? "none"}|sqt${p.squeezeThreshold ?? "_"}|bw${p.volBaselineWindow ?? "_"}|cw${p.cascadeWindowMinutes ?? "_"}` +
  `|tf${p.tightenFactor ?? "_"}|rc${p.roundTripCostPct ?? "_"}`; // tightenFactor/roundTripCostPct меняют replay — без них разные exit коллизируют в одном ключе

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
): Promise<LabelResult> {
  // НЕ Math.max(...arr.map()): spread-в-аргументы переполняет стек на большом наборе.
  let maxLife = 0;
  for (const e of exitSets) if (e.staleMinutes > maxLife) maxLife = e.staleMinutes;
  // старт = первая полностью сформированная свеча ПОСЛЕ сигнала (без look-ahead):
  // свеча, содержащая сигнал, ещё формируется — её OHLC известны только в конце минуты.
  const since = entryStartTs(ts, "1m");
  const limit = maxLife * 2 + 5; // запас на поиск входа в зону

  // getCandles может бросить (look-ahead guard на хвосте истории, дыры в данных
  // символа — частое у меме-коинов с делистингом/паузами торгов, строгий count-match
  // адаптера). Тогда этот кандидат НЕ размечается и пропускается — но обучение в целом
  // не падает. Один битый символ не должен ронять весь fit.
  let candles: ICandleData[];
  try {
    candles = await fetchCandlesChunked(getCandles, symbol, "1m", limit, since);
  } catch (e) {
    // НЕ глотаем текст: 32 одинаковых adapter-error немы без него. Сообщение
    // (или String(e) для не-Error) уходит в meta.labeling для диагностики.
    const error = e instanceof Error ? e.message : String(e);
    return { outcome: "adapter-error", burst: null, error };
  }
  if (!candles || candles.length === 0) {
    return { outcome: "no-candles", burst: null };
  }

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
  if (byExit.size === 0 || !anyEntered) {
    return { outcome: "no-entry", burst: null };
  }

  return { outcome: "ok", burst: { symbol, direction, ts, byExit } };
}
