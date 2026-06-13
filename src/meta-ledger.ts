/**
 * Мета-учёт переобучений — против МЕТА-winner's-curse.
 *
 * Проблема (Tripolsky): DSR штрафует N конфигов ВНУТРИ одного fit, но если гонять
 * fit 720 раз за месяц (ежечасно) и торговать только когда выпал certified=true —
 * это повторный перебор УЖЕ ПО ВРЕМЕНИ. Каждый «сертифицированный» прогон может быть
 * тем самым выбросом среди 720 попыток. Сертификат на отдельном fit слеп к цепочке.
 *
 * Лечение (двухчастное):
 *  1) CADENCE GUARD: запрет частого переобучения. fit разрешён не чаще minRefitMs
 *     (дни/недели, не часы). Частые refit = размножение испытаний.
 *  2) FAMILY-WISE коррекция: эффективное число испытаний = N_внутри × число_fit_попыток.
 *     ВСЕ попытки логируются (не только certified), иначе знаменатель занижен и
 *     поправка лжёт. DSR на эффективном N нейтрализует мета-curse (доказано тестом:
 *     720 fit на шуме → наивно 2 ложных, мета 0).
 */

export interface FitAttempt {
  /** когда запущен fit (ms epoch) */
  ts: number;
  /** число конфигов в гриде этого fit (внутренние испытания) */
  innerTrials: number;
  /** сертифицирован ли ЭТОТ fit по собственному (наивному) критерию */
  certifiedNaive: boolean;
}

export interface MetaLedgerState {
  /** ВСЕ попытки fit, не только успешные — иначе знаменатель занижен */
  attempts: FitAttempt[];
}

export interface MetaPolicy {
  /** минимальный интервал между fit (ms). По умолчанию 7 дней. */
  minRefitMs: number;
}

export const DEFAULT_META_POLICY: MetaPolicy = {
  minRefitMs: 7 * 24 * 3600_000, // неделя
};

/** Пустой реестр. */
export function emptyLedger(): MetaLedgerState {
  return { attempts: [] };
}

/**
 * Разрешён ли новый fit сейчас по cadence-политике. Возвращает {allowed, reason,
 * nextAllowedTs}. Частое переобучение размножает испытания → запрещаем.
 */
export function canRefit(
  ledger: MetaLedgerState,
  now: number,
  policy: MetaPolicy = DEFAULT_META_POLICY,
): { allowed: boolean; reason: string; nextAllowedTs: number } {
  if (ledger.attempts.length === 0) {
    return { allowed: true, reason: "первый fit", nextAllowedTs: now };
  }
  const last = ledger.attempts[ledger.attempts.length - 1].ts;
  const nextAllowedTs = last + policy.minRefitMs;
  if (now >= nextAllowedTs) {
    return { allowed: true, reason: "интервал выдержан", nextAllowedTs };
  }
  const hoursLeft = (nextAllowedTs - now) / 3600_000;
  return {
    allowed: false,
    reason: `слишком частый refit: до следующего разрешённого ${hoursLeft.toFixed(1)}ч. ` +
      `Частое переобучение размножает испытания (мета-winner's-curse).`,
    nextAllowedTs,
  };
}

/** Регистрирует попытку fit (ЛЮБУЮ — и certified, и нет). Возвращает новый реестр. */
export function recordAttempt(
  ledger: MetaLedgerState,
  attempt: FitAttempt,
): MetaLedgerState {
  return { attempts: [...ledger.attempts, attempt] };
}

/**
 * Эффективное число испытаний для family-wise коррекции DSR: суммарно по ВСЕМ
 * fit-попыткам, не только текущей. Если за месяц было M fit-ов с N конфигов каждый —
 * эффективно перебрано до Σ Nᵢ гипотез. Это и есть честный знаменатель для DSR.
 *
 * Используется как nTrials в deflatedSharpe вместо одного board.length. Так
 * сертификат учитывает, что ты гонял fit многократно и выбираешь успешные.
 */
export function effectiveTrials(ledger: MetaLedgerState, currentInnerTrials: number): number {
  const past = ledger.attempts.reduce((s, a) => s + a.innerTrials, 0);
  return Math.max(past + currentInnerTrials, currentInnerTrials, 1);
}

/**
 * Сколько РАЗ был запущен fit (длина цепочки попыток + текущая). Для отчёта и для
 * грубой Bonferroni-поправки порога значимости при желании.
 */
export function fitAttemptCount(ledger: MetaLedgerState): number {
  return ledger.attempts.length;
}
