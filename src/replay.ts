import { Direction } from "./types";
import { ICandleData } from "./candle";
import { volumeZScore, squeezePressure as squeezePressureFn, volRegimeOf, VolRegime } from "./volume";

/**
 * Точная симуляция prod-выхода по минутным свечам (listenActivePing на закрытии
 * каждой 1m-свечи). Метка обучения = то, что реально снимет твой выход, а не
 * close-to-close. Так stop hunting отсекается: прокол не дотягивает до trailingTake,
 * а откат бьёт hard stop → отрицательная метка, даже если close[t+H] положительный.
 *
 * moonbag (long)  — hard stop НИЖЕ входа.
 * gravebag (short) — hard stop ВЫШЕ входа.
 */

export interface ExitParams {
  /** trailing take: откат от пикового PnL%, при currentProfit ≥ 0 → выход */
  trailingTake: number;
  /** hard stop: фикса % от входа против позиции */
  hardStop: number;
  /** peak staleness: пик должен достичь этого PnL%, чтобы таймер протухания включился */
  stalenessSinceProfit: number;
  /** peak staleness: минут без нового пика → выход */
  stalenessSinceMinutes: number;
  /** потолок жизни позиции в минутных свечах (эмпирически подбираемый импакт-горизонт) */
  staleMinutes: number;
  /** baseline-окно для volZ (свечей до входа); если не задано — volZ не считается */
  volBaselineWindow?: number;
  /** порог volZ для разметки режима calm/anomalous */
  volZThreshold?: number;
  /** политика реакции на каскад: tighten (туже trailing) | veto (не входить) | none */
  squeezePolicy?: "none" | "tighten" | "veto";
  /** порог squeezePressure, выше которого срабатывает policy */
  squeezeThreshold?: number;
  /** множитель ужатия trailing при policy="tighten" (0.5 = вдвое туже) */
  tightenFactor?: number;
}

export type ExitReason =
  | "trailing-take"
  | "hard-stop"
  | "peak-staleness"
  | "life-cap"
  | "cascade-veto"
  | "no-entry";

export interface ReplayResult {
  /** реализованный PnL% (в долях: 0.05 = +5%). При hard-stop — откат к последнему плюсовому пику. */
  pnl: number;
  reason: ExitReason;
  /** пиковый PnL% за жизнь позиции */
  peak: number;
  /** минут от входа до выхода */
  heldMinutes: number;
  entered: boolean;
  /** z-score объёма входной свечи (накопление плечевого топлива) */
  volZ: number;
  /** доля объёма против позиции (сигнатура каскада ликвидаций) */
  squeezePressure: number;
  /** режим объёма на входе: calm | anomalous */
  volRegime: VolRegime;
}

const signed = (entry: number, price: number, dir: Direction): number =>
  dir === "long" ? (price - entry) / entry : (entry - price) / entry;

/**
 * Прогоняет 1m-свечи через prod-выход. candles должны быть отсортированы по ts
 * и покрывать окно от события вперёд (минимум до staleMinutes).
 *
 * entryFrom/entryTo — зона входа: вход на первой свече, чьё [low,high] пересекает зону.
 * Цена входа = кламп середины зоны в диапазон свечи (консервативно — фактическое касание).
 */
export function replayExit(
  candles: ICandleData[],
  dir: Direction,
  entryFrom: number,
  entryTo: number,
  p: ExitParams,
): ReplayResult {
  const lo = Math.min(entryFrom, entryTo);
  const hi = Math.max(entryFrom, entryTo);

  // ── поиск входа: первая свеча, пересёкшая зону ──
  let entryIdx = -1;
  let entryPrice = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.low <= hi && c.high >= lo) {
      // зона задета — входим по точке зоны, ближайшей к open свечи (консервативно)
      const mid = (lo + hi) / 2;
      entryPrice = Math.min(Math.max(mid, c.low), c.high);
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0 || !(entryPrice > 0)) {
    return {
      pnl: 0, reason: "no-entry", peak: 0, heldMinutes: 0, entered: false,
      volZ: 0, squeezePressure: 0, volRegime: "calm",
    };
  }

  // ── объёмные признаки на входе (симметрично для long/short) ──
  const baseWin = p.volBaselineWindow ?? 20;
  const volZThr = p.volZThreshold ?? 2.0;
  const sqHorizon = p.staleMinutes;
  const volZ = volumeZScore(candles, entryIdx, baseWin);
  const sqPressure = squeezePressureFn(candles, entryIdx, dir, sqHorizon);
  const volRegime = volRegimeOf(volZ, volZThr);

  // VETO: высокий squeezePressure при политике veto → не входим вовсе.
  // Симметрично режет и long-каскад, и short-сквиз.
  const sqThr = p.squeezeThreshold ?? 0.6;
  if (p.squeezePolicy === "veto" && sqPressure >= sqThr) {
    return {
      pnl: 0, reason: "cascade-veto", peak: 0, heldMinutes: 0, entered: false,
      volZ, squeezePressure: sqPressure, volRegime,
    };
  }

  // TIGHTEN: при каскаде ужимаем trailing, чтобы выскочить до разворота.
  const tighten = p.squeezePolicy === "tighten" && sqPressure >= sqThr
    ? (p.tightenFactor ?? 0.5) : 1;

  const hardStopFrac = p.hardStop / 100;
  const trailFrac = (p.trailingTake * tighten) / 100;
  const stalenessProfitFrac = p.stalenessSinceProfit / 100;

  let peak = 0;                 // пиковый PnL за жизнь (доли)
  let peakMinute = 0;          // минута достижения пика
  let lastPositivePeak = 0;    // последний плюсовой пик — к нему откатываем при hard-stop

  const lifeCap = Math.min(p.staleMinutes, candles.length - entryIdx - 1);

  for (let k = 0; k <= lifeCap; k++) {
    const c = candles[entryIdx + k];
    const minute = k; // 1m свечи → k минут от входа

    // внутрисвечные экстремумы PnL: для long худшее = low, лучшее = high; для short наоборот
    const pnlAtLow = signed(entryPrice, c.low, dir);
    const pnlAtHigh = signed(entryPrice, c.high, dir);
    const worst = Math.min(pnlAtLow, pnlAtHigh);
    const best = Math.max(pnlAtLow, pnlAtHigh);

    // 1) HARD STOP — внутрисвечной прокол против позиции на hardStop% от входа.
    //    Приоритет стопа над тейком в той же свече (консервативно, как в проде стоп жёсткий).
    if (worst <= -hardStopFrac) {
      // откат метрики к последнему плюсовому trailing-пику (твоё требование)
      return {
        pnl: lastPositivePeak,
        reason: "hard-stop",
        peak,
        heldMinutes: minute,
        entered: true,
        volZ, squeezePressure: sqPressure, volRegime,
      };
    }

    // обновляем пик по лучшему внутрисвечному PnL
    if (best > peak) {
      peak = best;
      peakMinute = minute;
      if (peak > 0) lastPositivePeak = peak;
    }

    // 2) TRAILING TAKE — позиция в плюсе и откат от пика ≥ trailingTake%.
    //    Откат меряем по close свечи (как listenActivePing на закрытии свечи).
    const closePnl = signed(entryPrice, c.close, dir);
    if (closePnl >= 0 && peak - closePnl >= trailFrac && peak > 0) {
      return {
        pnl: peak, // фиксируем по достигнутому пику (последний плюсовой trailingTake)
        reason: "trailing-take",
        peak,
        heldMinutes: minute,
        entered: true,
        volZ, squeezePressure: sqPressure, volRegime,
      };
    }

    // 3) PEAK STALENESS — пик достиг порога прибыли и протух по времени.
    if (peak >= stalenessProfitFrac && minute - peakMinute >= p.stalenessSinceMinutes) {
      return {
        pnl: peak,
        reason: "peak-staleness",
        peak,
        heldMinutes: minute,
        entered: true,
        volZ, squeezePressure: sqPressure, volRegime,
      };
    }
  }

  // 4) LIFE CAP — потолок жизни позиции. Выход по close последней свечи окна,
  //    но не хуже последнего плюсового пика (метрика не опускается ниже зафиксированного).
  const lastIdx = entryIdx + lifeCap;
  const finalPnl = signed(entryPrice, candles[lastIdx].close, dir);
  return {
    pnl: finalPnl,
    reason: "life-cap",
    peak,
    heldMinutes: lifeCap,
    entered: true,
    volZ, squeezePressure: sqPressure, volRegime,
  };
}
