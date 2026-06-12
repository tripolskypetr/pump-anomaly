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
  const vols = base.map((c) => c.volume);
  const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
  const variance = vols.reduce((s, v) => s + (v - mean) ** 2, 0) / (vols.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (candles[entryIdx].volume - mean) / std;
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
  const end = Math.min(candles.length, entryIdx + horizon + 1);
  let againstVol = 0;
  let totalVol = 0;
  for (let i = entryIdx + 1; i < end; i++) {
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
