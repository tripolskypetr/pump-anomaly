/**
 * Слой 6 — САМОВОЗБУЖДЕНИЕ потока событий (Hawkes-интенсивность).
 *
 * Памп — самовозбуждающийся каскад: пост порождает посты (пересылы, братские
 * каналы, реакция других авторов). Голый счёт событий в окне (слой 5) не
 * различает «5 постов за час на тикере, где обычно 5 постов в час» и «5 постов
 * за час на тикере, где пост бывает раз в неделю». Hawkes-мера различает:
 *
 *   возбуждение E(t) = Σ_{tᵢ<t} exp(−(t−tᵢ)/τ)   — экспоненциальное ядро, τ из слоя 1
 *   фон       λ₀·τ  = средняя скорость группы × τ — матожидание E при Пуассоне
 *
 * burstScore = E / (λ₀τ + 2·√(λ₀τ) + ε) — кратность превышения ПОРОГА СЛУЧАЙНОСТИ
 * (та же конвенция λ+2√λ, что в viability). score ≥ 1 — возбуждение статистически
 * не объяснимо фоном; score < 1 — «всплеск» в пределах обычной болтовни тикера.
 *
 * Используется как вес confidence в earlyWarning: разреженный тикер с внезапной
 * пачкой постов ценнее, чем вечно шумный с той же пачкой.
 */

export interface HawkesBurst {
  /** кратность превышения порога случайности (≥1 = значимо) */
  score: number;
  /** сырое возбуждение E(t) на момент события */
  excitation: number;
  /** порог случайности λ₀τ + 2√(λ₀τ) */
  chanceBound: number;
}

export function hawkesBurst(
  /** ts событий группы (symbol,direction), отсортированы по возрастанию */
  groupTs: number[],
  /** индекс события-якоря, на момент которого меряем интенсивность */
  idx: number,
  /** характерный лаг τ, мс (из selfTuneLag) */
  tau: number,
): HawkesBurst {
  const t = groupTs[idx];
  // возбуждение от предыдущих событий; хвост ядра дальше 20τ пренебрежим
  let excitation = 0;
  for (let j = idx - 1; j >= 0; j--) {
    const dt = t - groupTs[j];
    if (dt > 20 * tau) break;
    excitation += Math.exp(-dt / tau);
  }
  // фон: средняя скорость группы за её жизнь. Одиночное событие → фона нет.
  const n = groupTs.length;
  const span = groupTs[n - 1] - groupTs[0];
  const rate = n > 1 && span > 0 ? (n - 1) / span : 0;
  const lambdaTau = rate * tau;
  const chanceBound = lambdaTau + 2 * Math.sqrt(lambdaTau);
  const score = excitation / (chanceBound + 1e-9);
  return { score, excitation, chanceBound };
}

/** Вес для confidence: ниже порога случайности — дисконт, выше — без штрафа. */
export const hawkesWeight = (score: number): number => Math.min(Math.max(score, 0), 1);
