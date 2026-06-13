/**
 * Контракт источника свечей. Совместим с getCandles из backtest-kit.
 * Тренировка идёт в прошлом (не realtime), поэтому look-ahead-ограничения сняты:
 * свечи можно брать по обе стороны от события.
 */

export type CandleInterval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "8h" | "1d";

export interface ICandleData {
  /** Unix ms, момент ОТКРЫТИЯ свечи. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Длительность одного шага интервала в мс. */
export const STEP_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Выравнивание timestamp вниз к границе свечи интервала. */
export const alignTs = (t: number, interval: CandleInterval): number => {
  const step = STEP_MS[interval];
  return Math.floor(t / step) * step;
};

/**
 * Первая ПОЛНОСТЬЮ сформированная свеча, торгуемая БЕЗ look-ahead: если сигнал
 * пришёл внутри минуты (ts > границы), свеча, СОДЕРЖАЩАЯ сигнал, ещё формируется —
 * её close/high/low станут известны только в КОНЦЕ минуты, ПОСЛЕ сигнала. Входить
 * в неё = заглядывать вперёд. Поэтому старт входа = следующая граница. Если сигнал
 * ровно на границе (ts === aligned) — эта свеча открывается одновременно с сигналом
 * и торгуема честно, не пропускаем.
 */
export const entryStartTs = (t: number, interval: CandleInterval): number => {
  const step = STEP_MS[interval];
  const aligned = Math.floor(t / step) * step;
  return aligned === t ? aligned : aligned + step;
};

/**
 * Источник свечей. Семантика диапазонов (sDate inclusive, eDate exclusive):
 *   (limit)                 → [alignedWhen − limit·step, alignedWhen)
 *   (limit, sDate)          → [align(sDate), align(sDate) + limit·step)
 *   (limit, _, eDate)       → [align(eDate) − limit·step, eDate)
 *   (_, sDate, eDate)       → [align(sDate), eDate), limit из диапазона
 *   (limit, sDate, eDate)   → [align(sDate), …), ровно limit свечей
 */
export type GetCandles = (
  symbol: string,
  interval: CandleInterval,
  limit?: number,
  sDate?: number,
  eDate?: number,
) => Promise<ICandleData[]>;
