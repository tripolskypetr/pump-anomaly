/**
 * Достоверность обучения. Отвечает на вопрос «можно ли доверять подобранным
 * порогам», а НЕ «велик ли эдж». На малой выборке confidence низкий и
 * reliable=false (либа работает, но честно предупреждает); по мере роста
 * данных все три оси растут → confidence→1, reliable переключается сам.
 *
 *   confidence = support × stability × significance   (каждое в [0,1])
 *
 * Менять код при росте выборки не нужно — формула пересчитывает доверие.
 */

export interface ReliabilityInput {
  /** per-fold средние forward-return на валидации */
  foldMeans: number[];
  /** per-fold размеры валидационных выборок */
  foldSizes: number[];
  /** все валидационные ретёрны (для значимости против нуля) */
  allReturns: number[];
}

export interface Reliability {
  confidence: number;   // 0..1 — итоговое доверие
  reliable: boolean;    // confidence ≥ thr И N ≥ minN
  support: number;      // 0..1 — достаточность объёма
  stability: number;    // 0..1 — воспроизводимость эджа по фолдам
  significance: number; // 0..1 — отличие от нуля
  totalN: number;
}

export interface ReliabilityConfig {
  /** при N=supportK вклад объёма ≈ 0.5 */
  supportK: number;
  /** порог confidence для reliable=true */
  confidenceThreshold: number;
  /** минимум суммарных сделок для reliable=true */
  minN: number;
}

export const DEFAULT_RELIABILITY: ReliabilityConfig = {
  supportK: 30,
  confidenceThreshold: 0.6,
  minN: 40,
};

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}

/**
 * support: насыщающаяся функция объёма N/(N+k). Растёт от 0 к 1 с числом сделок.
 */
function supportScore(totalN: number, k: number): number {
  return totalN / (totalN + k);
}

/**
 * stability: эдж должен быть положителен в КАЖДОМ фолде, а не в одном жирном.
 * Берём долю фолдов с положительным средним × (1 − нормированный разброс знаков).
 * Один фолд → стабильность недоказуема → 0.5 (нейтрально, не штрафуем и не верим).
 */
function stabilityScore(foldMeans: number[]): number {
  if (foldMeans.length === 0) return 0;
  if (foldMeans.length === 1) return 0.5;
  const posShare = foldMeans.filter((m) => m > 0).length / foldMeans.length;
  const m = mean(foldMeans);
  const s = std(foldMeans);
  // коэффициент вариации знака: малый разброс относительно среднего → стабильно
  const cv = m !== 0 ? Math.min(s / Math.abs(m), 1) : 1;
  return posShare * (1 - cv);
}

/**
 * significance: на сколько стандартных ошибок среднее отстоит от нуля.
 * t = mean / (std/√N). Прогоняем через сглаживающую сигмоиду в [0,1]:
 * t≈0 → 0, t≈2 (≈95%) → ~0.76, t≥3 → ~0.9+.
 */
function significanceScore(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  const m = mean(returns);
  const s = std(returns);
  if (m <= 0) return 0; // неположительный эдж — нулевая значимость «полезности»
  // НУЛЕВАЯ или околонулевая дисперсия (std пренебрежимо мал относительно |mean|):
  // все ретёрны фактически идентичны. Это НЕ бесконечная значимость, а вырожденные
  // данные (один исход N раз = артефакт). Порог относительный — std([0.001]×N) даёт
  // не ровно 0, а ~1e-19 из-за floating point, что без проверки даёт t≈1e16 → sig≈1.
  if (s <= Math.abs(m) * 1e-9) {
    return 1 - Math.exp(-n / 200); // N=40→0.18, N=140→0.5, N=600→0.95
  }
  const t = (m / (s / Math.sqrt(n)));
  if (t <= 0) return 0;
  return 1 - Math.exp(-t / 2); // насыщающаяся: t=2→0.63, t=4→0.86, t=6→0.95
}

export function computeReliability(
  input: ReliabilityInput,
  cfg: ReliabilityConfig = DEFAULT_RELIABILITY,
): Reliability {
  const totalN = input.foldSizes.reduce((s, x) => s + x, 0);
  const support = supportScore(totalN, cfg.supportK);
  const stability = stabilityScore(input.foldMeans);
  const significance = significanceScore(input.allReturns);
  const confidence = +(support * stability * significance).toFixed(6);
  const reliable = confidence >= cfg.confidenceThreshold && totalN >= cfg.minN;
  return {
    confidence,
    reliable,
    support: +support.toFixed(6),
    stability: +stability.toFixed(6),
    significance: +significance.toFixed(6),
    totalN,
  };
}
