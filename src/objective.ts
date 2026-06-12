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
