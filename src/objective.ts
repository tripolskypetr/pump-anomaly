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
 * Перцентиль p (0..1) по выборке методом линейной интерполяции (type-7, как в numpy).
 * percentile([...], 0.95) = P95. Пустая выборка → 0.
 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
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
    if (t.hardStop > 0) rr.push(t.pnl / (t.hardStop / 100)); // hardStop в %, pnl в долях
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
