/**
 * Objective для подбора порогов: shrinkage-expectancy.
 *
 *   score = mean(returns) · N/(N+k)
 *
 * Средний forward-return отобранных всплесков, усаженный к нулю при малой выборке.
 * Без усадки grid выбрал бы вырожденный порог, ловящий 1 жирный всплеск и
 * рапортующий «идеальный эдж» — ровно ловушка winrate-68%-с-чёрным-лебедем.
 * k — сила усадки (по умолчанию 5): при N=k вклад режется вдвое.
 */
export function shrinkageExpectancy(returns: number[], k = 5): number {
  const n = returns.length;
  if (n === 0) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  return mean * (n / (n + k));
}

/** Доля положительных (winrate) — для отчёта, не для оптимизации. */
export function winrate(returns: number[]): number {
  if (returns.length === 0) return 0;
  return returns.filter((r) => r > 0).length / returns.length;
}

/**
 * Стандартная ошибка среднего по фолдам: SE = std(foldScores) / sqrt(n).
 * std — выборочное (делитель n-1). При n<2 SE=0 (разброс не оценить).
 */
export function standardError(foldScores: number[]): number {
  const n = foldScores.length;
  if (n < 2) return 0;
  const mean = foldScores.reduce((s, x) => s + x, 0) / n;
  const variance = foldScores.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) / Math.sqrt(n);
}

/**
 * One-standard-error rule (Breiman 1984) — против winner's curse при grid-search.
 *
 * Проблема: argmax по CV-score из N конфигураций систематически завышен — максимум
 * шумных оценок смещён вверх на ~sigma·sqrt(2·ln N) даже при истинном edge=0. Чем
 * больше grid, тем сильнее переобучение на шум выборки.
 *
 * Правило: берём НЕ максимум, а самую КОНСЕРВАТИВНУЮ конфигурацию среди тех, чей
 * score в пределах 1 SE от максимума. Разница внутри 1 SE статистически незначима
 * (внутри шума), поэтому вместо счастливого выброса выбираем робастную конфигурацию.
 *
 * @param entries    кандидаты
 * @param scoreOf    извлечь CV-score кандидата
 * @param foldsOf    извлечь fold-scores кандидата (для SE максимума)
 * @param isSimpler  компаратор «a консервативнее b» (true → предпочесть a)
 */
export function oneStandardErrorSelect<T>(
  entries: T[],
  scoreOf: (e: T) => number,
  foldsOf: (e: T) => number[],
  isSimpler: (a: T, b: T) => boolean,
  seMultiplier = 1,
): T | null {
  if (entries.length === 0) return null;
  let best = entries[0];
  for (const e of entries) if (scoreOf(e) > scoreOf(best)) best = e;

  // SE по фолдам ПОБЕДИТЕЛЯ — разброс его собственной оценки. seMultiplier
  // расширяет/сужает коридор (1 = классический Breiman).
  const se = standardError(foldsOf(best)) * seMultiplier;
  const threshold = scoreOf(best) - se;

  let chosen = best;
  for (const e of entries) {
    if (scoreOf(e) < threshold) continue;       // вне коридора SE
    if (isSimpler(e, chosen)) chosen = e;        // консервативнее → берём
  }
  return chosen;
}

/**
 * Перцентиль p (0..1) по выборке методом линейной интерполяции (type-7, как в numpy).
 * percentile([...], 0.95) = P95. Пустая выборка → 0.
 */
export function percentile(xs: number[], p: number): number {
  // отбрасываем NaN/Infinity: одна битая свеча не должна молча отравить перцентиль
  const clean = xs.filter((x) => Number.isFinite(x));
  if (clean.length === 0) return 0;
  if (clean.length === 1) return clean[0];
  const sorted = [...clean].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * КВАНТИЛЬНЫЕ ПРЕДЛОЖЕНИЯ EXIT из статистики пути (MAE/MFE-анализ, Sweeney).
 *
 * Перебор сетки судит конфиги по финальному pnl, выбрасывая информацию о пути.
 * Путь же говорит напрямую: у ПОБЕДИТЕЛЕЙ адверс-экскурсия (|MAE|) компактна, у
 * лузеров — тяжёлый хвост → стоп сразу за p90 |MAE| победителей режет лузеров,
 * почти не задевая винеров. Аналогично trailing: quantиль отката от пика,
 * который победители реально отдавали (peak − pnl). Это оценка ДВУХ квантилей
 * по всем сделкам сразу — на порядок эффективнее по данным, чем независимый
 * скоринг тысяч конфигов.
 *
 * Возвращает КАНДИДАТОВ (в %), а не решение: refinement подаёт их в CV наравне
 * с сеточными вариантами — принимаются только при значимом улучшении (SE-гвард).
 * Мало победителей (< minWinners) → пустые списки: по 5 сделкам квантили — шум.
 */
export interface PathExitProposals {
  hardStop: number[];
  trailingTake: number[];
}
export function exitProposalsFromPath(
  rows: Array<{ pnl: number; peak: number; trough: number; entered: boolean }>,
  minWinners = 10,
): PathExitProposals {
  const winners = rows.filter((r) => r.entered && r.pnl > 0);
  if (winners.length < minWinners) return { hardStop: [], trailingTake: [] };
  const mae = winners.map((r) => Math.abs(Math.min(r.trough, 0)) * 100).filter((v) => v > 0);
  const giveback = winners.map((r) => Math.max(r.peak - r.pnl, 0) * 100).filter((v) => v > 0);
  const q = (xs: number[], ps: number[]) =>
    xs.length >= minWinners ? ps.map((p) => +percentile(xs, p).toFixed(4)) : [];
  return {
    hardStop: q(mae, [0.9, 0.95]),
    trailingTake: q(giveback, [0.75, 0.9]),
  };
}

/** Статистика risk-reward по набору сделок. */
export interface RiskRewardStats {
  /** среднее RR */
  mean: number;
  /** P95 RR (хвост в плюс) */
  p95: number;
  /** P99 RR */
  p99: number;
  /** число сделок в выборке */
  n: number;
}

/**
 * RR на сделку = pnl / hardStop (реализованный в единицах риска — сколько R сняли).
 * Считает mean / P95 / P99 по парам (pnl, hardStop). Сделки с hardStop ≤ 0
 * пропускаются (деление на ноль). Главный исследовательский выход бэктеста.
 */
export function riskRewardStats(
  trades: Array<{ pnl: number; hardStop: number }>,
): RiskRewardStats {
  const rr: number[] = [];
  for (const t of trades) {
    // только конечные значения: битый pnl/hardStop не должен отравить RR
    if (t.hardStop > 0 && Number.isFinite(t.pnl)) rr.push(t.pnl / (t.hardStop / 100));
  }
  if (rr.length === 0) return { mean: 0, p95: 0, p99: 0, n: 0 };
  const mean = rr.reduce((s, x) => s + x, 0) / rr.length;
  return {
    mean: +mean.toFixed(6),
    p95: +percentile(rr, 0.95).toFixed(6),
    p99: +percentile(rr, 0.99).toFixed(6),
    n: rr.length,
  };
}

/**
 * Устойчивая к выбросам статистика реализованного PnL системы (в долях).
 * Дополняет mean процентилями и медианой, чтобы ОДНА плохая (или одна жирная)
 * сделка не определяла оценку выигрыша:
 *   - median — робастный центр, полностью иммунный к выбросам (50-й перцентиль);
 *   - p5     — нижний хвост (насколько плохи худшие 5% сделок);
 *   - p95/p99— верхний хвост (вклад редких крупных выигрышей).
 * mean остаётся для сравнения, но median/перцентили показывают систему без
 * искажения единичными экстремумами. NaN/Infinity отбрасываются.
 */
export interface PnlStats {
  /** среднее PnL (чувствительно к выбросам — для сравнения) */
  mean: number;
  /** медиана PnL (робастный центр, иммунный к выбросам) */
  median: number;
  /** P5 — нижний хвост (худшие сделки) */
  p5: number;
  /** P95 — верхний хвост */
  p95: number;
  /** P99 — крайний верхний хвост */
  p99: number;
  /** число сделок в выборке */
  n: number;
}

export function pnlStats(pnls: number[]): PnlStats {
  const clean = pnls.filter((x) => Number.isFinite(x));
  if (clean.length === 0) return { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 };
  const mean = clean.reduce((s, x) => s + x, 0) / clean.length;
  return {
    mean: +mean.toFixed(6),
    median: +percentile(clean, 0.5).toFixed(6),
    p5: +percentile(clean, 0.05).toFixed(6),
    p95: +percentile(clean, 0.95).toFixed(6),
    p99: +percentile(clean, 0.99).toFixed(6),
    n: clean.length,
  };
}
