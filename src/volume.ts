import { Direction } from "./types";
import { ICandleData } from "./candle";

/**
 * Объёмная математика детектора каскада ликвидаций. ПОЛНОСТЬЮ СИММЕТРИЧНА по
 * направлению — long-trap и short-trap это зеркала одного механизма:
 *
 *   short-squeeze: толпа шортит на плече → стена ликвидаций СВЕРХУ → каскад
 *                  форсированных buy толкает вверх (против short).
 *   long-cascade:  толпа лонгует на плече → стена ликвидаций СНИЗУ → каскад
 *                  форсированных sell толкает вниз (против long).
 *
 * Отличить ловушку от честного движения: при каскаде объём растёт на свечах,
 * где цена идёт ПРОТИВ позиции (ликвидации — форсированные сделки против толпы).
 * При честном движении объём растёт В СТОРОНУ позиции. Знак «против» определяется
 * через направление, поэтому формула одна на оба случая.
 */

export interface VolumeFeatures {
  /** z-score объёма входной свечи против базлайна до входа: накопление плечевого топлива */
  volZ: number;
  /** доля объёма на движениях ПРОТИВ позиции в окне после входа (0..1): сигнатура каскада */
  squeezePressure: number;
}

/**
 * volZ: насколько объём входной свечи аномален против скользящего окна ДО входа.
 * Высокий volZ = синхронный заход толпы в плечо (та самая «синяя свеча» из 1028592).
 * baselineWindow — сколько свечей до входа берём за норму.
 */
export function volumeZScore(
  candles: ICandleData[],
  entryIdx: number,
  baselineWindow: number,
): number {
  const lo = Math.max(0, entryIdx - baselineWindow);
  const base = candles.slice(lo, entryIdx);
  if (base.length < 2) return 0;
  // битый/короткий массив: entryIdx может быть >= длины → candles[entryIdx] undefined.
  const entry = candles[entryIdx];
  if (!entry) return 0;
  const vols = base.map((c) => c.volume);
  const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
  const variance = vols.reduce((s, v) => s + (v - mean) ** 2, 0) / (vols.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (entry.volume - mean) / std;
}

/**
 * squeezePressure: доля объёма в окне после входа, пришедшегося на свечи, где цена
 * двигалась ПРОТИВ позиции. Симметрично: для long «против» = свеча закрылась ниже
 * открытия (давление вниз, каскад sell); для short «против» = выше (каскад buy).
 *
 * Высокое значение → движение питается ликвидациями толпы, а не честным потоком →
 * это ловушка (stop hunt / squeeze), входить опасно либо выходить раньше.
 */
export function squeezePressure(
  candles: ICandleData[],
  entryIdx: number,
  dir: Direction,
  horizon: number,
): number {
  // КЛАМП нижней границы (симметрично squeezePressureBefore): при отрицательном
  // entryIdx (findIndex вернул -1, битый вызов) старт стал бы < 0 и цикл прочитал
  // candles[-1] = undefined → краш на c.close. max(0, ...) этого не допускает.
  const start = Math.max(0, entryIdx + 1);
  const end = Math.min(candles.length, entryIdx + horizon + 1);
  let againstVol = 0;
  let totalVol = 0;
  for (let i = start; i < end; i++) {
    const c = candles[i];
    const delta = c.close - c.open; // знак внутрисвечного движения
    // «против позиции»: long не любит падение (delta<0), short не любит рост (delta>0)
    const against = dir === "long" ? delta < 0 : delta > 0;
    totalVol += c.volume;
    if (against) againstVol += c.volume;
  }
  if (totalVol === 0) return 0;
  return againstVol / totalVol;
}

/**
 * LIVE-вариант squeezePressure: считает давление каскада по свечам СТРОГО ДО входа
 * (никакого look-ahead). В live свечей ПОСЛЕ сигнала ещё нет — поэтому ловушку
 * оцениваем по уже произошедшим свечам перед сигналом: высокая доля объёма на
 * движениях против позиции в недавнем прошлом = рынок уже под давлением каскада.
 *
 * entryIdx — индекс входной свечи; окно [entryIdx-horizon, entryIdx) (НЕ включая
 * саму входную, чтобы не зависеть от её формирования). Симметрия по dir та же.
 */
export function squeezePressureBefore(
  candles: ICandleData[],
  entryIdx: number,
  dir: Direction,
  horizon: number,
): number {
  const start = Math.max(0, entryIdx - horizon);
  // КЛАМП верхней границы: при битом/коротком массиве свечей (флэки-адаптер биржи)
  // entryIdx может оказаться > длины — без клампа цикл прочитает undefined и упадёт.
  const end = Math.min(entryIdx, candles.length);
  let againstVol = 0;
  let totalVol = 0;
  for (let i = start; i < end; i++) {
    const c = candles[i];
    const delta = c.close - c.open;
    const against = dir === "long" ? delta < 0 : delta > 0;
    totalVol += c.volume;
    if (against) againstVol += c.volume;
  }
  if (totalVol === 0) return 0;
  return againstVol / totalVol;
}

/**
 * Momentum цены ДО входа, %: (close_последней / close_первой − 1)·100 по окну
 * [entryIdx − windowMinutes, entryIdx) СТРОГО до сигнальной свечи (без look-ahead).
 *
 * Это ключевой фильтр эджа (habr 1041898): сырые посты ≈ нулевая сумма после
 * комиссий, но посты, перед которыми цена УЖЕ двигалась не против сигнала
 * (приток реального капитала до публикации), статистически отрабатывают.
 * null = данных мало (окно < 2 свечей) — вызывающий решает консервативно.
 */
export function momentumPct(
  candles: ICandleData[],
  entryIdx: number,
  windowMinutes: number,
): number | null {
  const end = Math.min(Math.max(entryIdx, 0), candles.length);
  const start = Math.max(0, end - windowMinutes);
  if (end - start < 2) return null;
  const first = candles[start].close;
  const last = candles[end - 1].close;
  if (!(first > 0) || !Number.isFinite(last)) return null;
  return (last / first - 1) * 100;
}

/**
 * ДИАПАЗОННЫЕ признаки пре-окна (обобщение anti-liquidity-harvesting из habr
 * 1041898: «шорты на активе с мёртвым диапазоном = сбор ликвидности»).
 *
 *  - rangePct: средний минутный диапазон (high−low)/close по пре-окну, %.
 *    Мёртвый флэт → «памп» на нём — ловушка; живой диапазон — честный рынок.
 *  - compression: диапазон ПОСЛЕДНЕЙ ЧЕТВЕРТИ окна против первых трёх четвертей.
 *    Классика: настоящий памп воспламеняется из сжатия (<1 — рынок сжался перед
 *    сигналом), расширение (>1) — движение уже идёт/выдохлось.
 *
 * Окно-относительная конструкция (четверти доступного пре-окна) — без абсолютных
 * констант времени. Меньше 40 свечей → null (квартильные средние шумны).
 */
export function rangeFeatures(
  candles: ICandleData[],
  /** конец пре-окна (эксклюзивно) — свечи СТРОГО до сигнала */
  endIdx: number,
): { rangePct: number | null; compression: number | null } {
  const end = Math.min(Math.max(endIdx, 0), candles.length);
  const pre = candles.slice(0, end);
  if (pre.length < 40) return { rangePct: null, compression: null };
  const r = (c: ICandleData) => (c.close > 0 ? (c.high - c.low) / c.close : 0);
  const mean = (xs: ICandleData[]) => xs.reduce((s, c) => s + r(c), 0) / xs.length;
  const q = Math.floor(pre.length * 0.75);
  const base = mean(pre.slice(0, q));
  const recent = mean(pre.slice(q));
  return {
    rangePct: +(mean(pre) * 100).toFixed(6),
    compression: base > 0 ? +(recent / base).toFixed(6) : null,
  };
}

/**
 * ГЕОМЕТРИЯ ЗОНЫ ВХОДА: где автор поставил зону относительно последней цены,
 * в % и НАПРАВЛЕННО (положительное = «догоняющий» вход по ходу сигнала,
 * отрицательное = откатная лимитка против хода). long с зоной выше рынка и
 * short с зоной ниже — chase; зеркальные — pullback. У этих режимов разная
 * статистика исходов; у ботов размещение зоны механическое (habr 1028592).
 * null = зоны нет или цены нет.
 */
export function zoneOffsetPct(
  entryFromPrice: number | undefined,
  entryToPrice: number | undefined,
  lastClose: number | null,
  postDirection: Direction,
): number | null {
  if (entryFromPrice === undefined || entryToPrice === undefined) return null;
  if (lastClose === null || !(lastClose > 0)) return null;
  const mid = (entryFromPrice + entryToPrice) / 2;
  const raw = ((mid - lastClose) / lastClose) * 100;
  return +(postDirection === "long" ? raw : -raw).toFixed(6);
}

/** Считает оба признака разом для входа на entryIdx. */
export function volumeFeatures(
  candles: ICandleData[],
  entryIdx: number,
  dir: Direction,
  baselineWindow: number,
  horizon: number,
): VolumeFeatures {
  return {
    volZ: volumeZScore(candles, entryIdx, baselineWindow),
    squeezePressure: squeezePressure(candles, entryIdx, dir, horizon),
  };
}

/** Режим объёма по порогу volZ: спокойный или аномальный (топливо накоплено). */
export type VolRegime = "calm" | "anomalous";

export const volRegimeOf = (volZ: number, threshold: number): VolRegime =>
  volZ >= threshold ? "anomalous" : "calm";
