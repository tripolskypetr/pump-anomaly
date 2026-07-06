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
  squeezePolicy?: "none" | "tighten" | "veto" | "invert" | "ignore";
  /** порог squeezePressure, выше которого срабатывает policy */
  squeezeThreshold?: number;
  /** множитель ужатия trailing при policy="tighten" (0.5 = вдвое туже) */
  tightenFactor?: number;
  /**
   * Окно детекции каскада ликвидаций в минутах — НЕЗАВИСИМО от staleMinutes.
   * Сквиз/каскад это БЫСТРОЕ событие (минуты), его нельзя мерить на 24ч-горизонте
   * удержания: длинное окно размывает резкий разворот. Раньше брался staleMinutes,
   * что связывало два несвязанных концерна (жизнь позиции и окно детектора).
   * Если не задано — fallback на staleMinutes (обратная совместимость).
   */
  cascadeWindowMinutes?: number;
  /**
   * Суммарная стоимость round-trip (комиссии тейкера на вход+выход + проскальзывание),
   * % от нотионала. Вычитается из реализованного pnl КАЖДОЙ вошедшей сделки —
   * бэктест без издержек систематически красивее реальности, особенно на
   * низколиквидных памп-коинах. 0 / не задано = идеальное исполнение (старое поведение).
   * Это КОНСТАНТА СРЕДЫ (твоя биржа/тариф), не ось оптимизации grid.
   */
  roundTripCostPct?: number;
  /**
   * STATE-DEPENDENT проскальзывание: доля ДИАПАЗОНА свечи-исполнения, приложенная
   * против позиции на входе И на выходе. Константная издержка занижает боль ровно
   * там, где она максимальна: на сигнальной свече пампа и на свече каскада спред
   * взрывается вместе с range. slip = k·(high−low)/entry на каждой из двух свечей
   * исполнения — стоп в обвале автоматически дороже стопа в тишине.
   * Аппроксимация вычетом из pnl (уровни триггеров не сдвигаются). 0 = выкл.
   * КОНСТАНТА СРЕДЫ (глубина твоего размера в стакане), не ось grid.
   */
  slippageRangeFrac?: number;
}

export type ExitReason =
  | "trailing-take"
  | "hard-stop"
  | "peak-staleness"
  | "life-cap"
  | "cascade-veto"
  | "invert"
  | "no-entry";

export interface ReplayResult {
  /**
   * реализованный НЕТТО PnL% (в долях: 0.05 = +5%), за вычетом roundTripCostPct.
   * hard-stop = -hardStop%; trailing/staleness = close свечи-триггера (НЕ пик —
   * прод выходит маркетом по close, пик нереализуем); life-cap = close последней свечи.
   */
  pnl: number;
  reason: ExitReason;
  /** пиковый PnL% за жизнь позиции (MFE) */
  peak: number;
  /** наихудший PnL% за жизнь позиции (MAE, ≤0; при стопе = −hardStop%) — сырьё для
   *  квантильного подбора стопа: p90 |MAE| победителей режет лузеров, не задевая винеров */
  trough: number;
  /** минут от входа до выхода */
  heldMinutes: number;
  entered: boolean;
  /** цена входа (close в зоне либо clamp midpoint). 0 если не вошли. */
  entryPrice: number;
  /** цена выхода, по которой реализован pnl. 0 если не вошли. */
  exitPrice: number;
  /** z-score объёма входной свечи (накопление плечевого топлива) */
  volZ: number;
  /** доля объёма против позиции (сигнатура каскада ликвидаций) */
  squeezePressure: number;
  /** режим объёма на входе: calm | anomalous */
  volRegime: VolRegime;
  /** была ли позиция инвертирована (policy=invert сработал) */
  inverted: boolean;
  /** замер горизонта неполный: после входа не хватило свечей на полный life-cap */
  truncated: boolean;
}

const signed = (entry: number, price: number, dir: Direction): number =>
  dir === "long" ? (price - entry) / entry : (entry - price) / entry;

/** Обратная к signed: цена выхода по entry, реализованному pnl и направлению. */
const exitPriceOf = (entry: number, pnl: number, dir: Direction): number =>
  dir === "long" ? entry * (1 + pnl) : entry * (1 - pnl);

/**
 * Прогоняет 1m-свечи через prod-выход. candles должны быть отсортированы по ts
 * и покрывать окно от события вперёд (минимум до staleMinutes).
 *
 * entryFrom/entryTo — зона входа: вход на первой свече, чей хвост пересекает зону.
 * entryPrice = close, если он попал в зону, иначе clamp midpoint к [low,high].
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

  // ── поиск входа: первая свеча, пересёкшая зону хвостом ──
  let entryIdx = -1;
  let entryPrice = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.low <= hi && c.high >= lo) {
      // зона задета хвостом. Уточняем цену входа: если close свечи попал В ЗОНУ,
      // берём его (реальное закрытие в зоне — точнее фитиля). Иначе — точка зоны,
      // ближайшая к диапазону свечи (clamp midpoint к [low,high], консервативно).
      if (c.close >= lo && c.close <= hi) {
        entryPrice = c.close;
      } else {
        const mid = (lo + hi) / 2;
        entryPrice = Math.min(Math.max(mid, c.low), c.high);
      }
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0 || !(entryPrice > 0)) {
    return {
      pnl: 0, reason: "no-entry", peak: 0, trough: 0, heldMinutes: 0, entered: false,
      entryPrice: 0, exitPrice: 0,
      volZ: 0, squeezePressure: 0, volRegime: "calm", inverted: false, truncated: false,
    };
  }

  // ── объёмные признаки на входе (симметрично для long/short) ──
  const baseWin = p.volBaselineWindow ?? 20;
  const volZThr = p.volZThreshold ?? 2.0;
  // окно детекции каскада — СВОЁ, не life-cap. Сквиз быстрый: мерить его на всём
  // горизонте удержания неверно (длинное окно размывает резкий разворот).
  const sqHorizon = p.cascadeWindowMinutes ?? p.staleMinutes;
  const volZ = volumeZScore(candles, entryIdx, baseWin);
  const sqPressure = squeezePressureFn(candles, entryIdx, dir, sqHorizon);
  const volRegime = volRegimeOf(volZ, volZThr);

  // VETO: высокий squeezePressure при политике veto → не входим вовсе.
  // Симметрично режет и long-каскад, и short-сквиз.
  const sqThr = p.squeezeThreshold ?? 0.6;
  if (p.squeezePolicy === "veto" && sqPressure >= sqThr) {
    return {
      pnl: 0, reason: "cascade-veto", peak: 0, trough: 0, heldMinutes: 0, entered: false,
      entryPrice, exitPrice: 0,
      volZ, squeezePressure: sqPressure, volRegime, inverted: false, truncated: false,
    };
  }

  // INVERT: каскад уверенно сносит толпу в обратную сторону (stop hunt из 1028592).
  // Вместо защиты — заходим ПРОТИВ поста и снимаем сам сквиз. Метку ставит replay
  // противоположного направления из той же точки; exit берётся из инверс-ячейки тензора.
  if (p.squeezePolicy === "invert" && sqPressure >= sqThr) {
    const opposite: Direction = dir === "long" ? "short" : "long";
    // прогон без повторной инверсии (policy=none), чтобы не зациклиться
    const inv = replayExit(candles, opposite, entryFrom, entryTo, {
      ...p, squeezePolicy: "none",
    });
    return {
      ...inv,
      // reason СОХРАНЯЕТ настоящий механизм выхода инвертированной позиции
      // (hard-stop/trailing-take/life-cap), а факт инверсии несёт флаг inverted.
      // Раньше reason затирался на "invert", что скрывало, КАК закрылась инверсия.
      inverted: inv.entered,
      // объёмные признаки оставляем от исходного входа (они про сам каскад)
      volZ, squeezePressure: sqPressure, volRegime,
    };
  }

  // TIGHTEN: при каскаде ужимаем trailing, чтобы выскочить до разворота.
  const tighten = p.squeezePolicy === "tighten" && sqPressure >= sqThr
    ? (p.tightenFactor ?? 0.5) : 1;

  const hardStopFrac = p.hardStop / 100;
  const trailFrac = (p.trailingTake * tighten) / 100;
  const stalenessProfitFrac = p.stalenessSinceProfit / 100;
  // издержки исполнения: вычитаются из НЕТТО pnl каждой вошедшей сделки.
  // exitPrice остаётся ГРОСС-ценой рынка (по ней сверяют путь), pnl — нетто.
  const costFrac = (p.roundTripCostPct ?? 0) / 100;
  // state-dependent slippage: доля диапазона свечи ИСПОЛНЕНИЯ против позиции;
  // вход платит по своей свече сразу, выход — по свече-триггеру.
  const slipK = p.slippageRangeFrac ?? 0;
  const slipOf = (c: ICandleData): number =>
    slipK > 0 && entryPrice > 0 ? (slipK * (c.high - c.low)) / entryPrice : 0;
  const entrySlip = slipOf(candles[entryIdx]);

  let peak = 0;                 // пиковый PnL за жизнь (доли)
  let peakMinute = 0;          // минута достижения пика
  let trough = 0;              // наихудший PnL за жизнь (MAE, доли, ≤0)

  const forwardAvail = candles.length - entryIdx - 1;
  const lifeCap = Math.min(p.staleMinutes, forwardAvail);
  // Боковик/край данных: если после входа осталось МЕНЬШЕ свечей, чем требует
  // life-cap, замер горизонта неполный. Помечаем — labelBurst отбросит такую метку,
  // чтобы не сравнивать 24ч-горизонт по обрезанному до пары часов пути.
  // Допуск 5% — мелкая нехватка в конце не критична.
  const truncated = forwardAvail < p.staleMinutes * 0.95;

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
      trough = -hardStopFrac; // реализованная адверс-экскурсия ограничена стопом
      // ЧЕСТНЫЙ реализованный PnL: стоп исполняется на уровне -hardStop%, это и есть
      // результат сделки. Раньше возвращался lastPositivePeak (≥0), из-за чего стоп
      // НИКОГДА не показывал убыток — это завышало pnl и отравляло RR/CV-объектив
      // (оптимизатор не видел риск стопов). peak сохраняется отдельно для диагностики.
      return {
        pnl: -hardStopFrac - costFrac - entrySlip - slipOf(c),
        reason: "hard-stop",
        peak, trough,
        heldMinutes: minute,
        entered: true,
        entryPrice, exitPrice: exitPriceOf(entryPrice, -hardStopFrac, dir),
        volZ, squeezePressure: sqPressure, volRegime, inverted: false, truncated,
      };
    }

    if (worst < trough) trough = worst; // MAE по внутрисвечному худшему

    // обновляем пик по лучшему внутрисвечному PnL
    if (best > peak) {
      peak = best;
      peakMinute = minute;

    }

    // 2) TRAILING TAKE — позиция в плюсе и откат от пика ≥ trailingTake%.
    //    Откат меряем по close свечи (как listenActivePing на закрытии свечи).
    const closePnl = signed(entryPrice, c.close, dir);
    if (closePnl >= 0 && peak - closePnl >= trailFrac && peak > 0) {
      // ЧЕСТНАЯ реализация: прод узнаёт об откате на CLOSE свечи и выходит маркетом
      // около этого close — реализуется closePnl, а НЕ пик. Раньше возвращался peak,
      // что систематически завышало каждую трейлинг-сделку на ≥ trailingTake% и
      // отравляло CV/RR/сертификацию (оптимизатор выбирал пороги под несуществующий
      // выход по пику). peak сохраняется отдельно для диагностики.
      return {
        pnl: closePnl - costFrac - entrySlip - slipOf(c),
        reason: "trailing-take",
        peak, trough,
        heldMinutes: minute,
        entered: true,
        entryPrice, exitPrice: c.close,
        volZ, squeezePressure: sqPressure, volRegime, inverted: false, truncated,
      };
    }

    // 3) PEAK STALENESS — пик достиг порога прибыли и протух по времени.
    //    Реализация ЧЕСТНАЯ: выход маркетом по close текущей свечи (closePnl может
    //    быть и ниже порога, и отрицательным — цена могла отдать весь плюс, не задев
    //    hard stop). Раньше возвращался peak — та же оптимистичная ложь, что и в trailing.
    if (peak >= stalenessProfitFrac && minute - peakMinute >= p.stalenessSinceMinutes) {
      return {
        pnl: closePnl - costFrac - entrySlip - slipOf(c),
        reason: "peak-staleness",
        peak, trough,
        heldMinutes: minute,
        entered: true,
        entryPrice, exitPrice: c.close,
        volZ, squeezePressure: sqPressure, volRegime, inverted: false, truncated,
      };
    }
  }

  // 4) LIFE CAP — потолок жизни позиции. Выход по close последней свечи окна.
  //    Честный реализованный PnL (может быть отрицательным, если позиция в минусе).
  const lastIdx = entryIdx + lifeCap;
  const finalPnl = signed(entryPrice, candles[lastIdx].close, dir);
  return {
    pnl: finalPnl - costFrac - entrySlip - slipOf(candles[lastIdx]),
    reason: "life-cap",
    peak, trough,
    heldMinutes: lifeCap,
    entered: true,
    entryPrice, exitPrice: exitPriceOf(entryPrice, finalPnl, dir),
    volZ, squeezePressure: sqPressure, volRegime, inverted: false, truncated,
  };
}
