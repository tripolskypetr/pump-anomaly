/**
 * Математический аппарат для отличия РЕАЛЬНОГО эджа от ВЫБРОСА/оверфита.
 *
 * Брутфорс-grid (argmax по CV из N конфигов) систематически выдаёт ложный эдж:
 * максимум N шумных оценок смещён вверх на ≈ σ·√(2·ln N) даже при истинном эдже 0.
 * Эти функции дают СТАТИСТИЧЕСКИЙ СЕРТИФИКАТ, а не «score повыше».
 *
 * Ссылки: López de Prado (Deflated Sharpe 2014, PBO 2015, minTRL),
 * White (Reality Check 2000), Hansen (SPA 2005), Politis-Romano (stationary
 * bootstrap 1994), Breiman (1-SE 1984).
 *
 * Все функции — чистые над массивами ретёрнов сделок. Без внешних зависимостей.
 */

// ── базовая статистика моментов ──
export function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
export function variance(a: number[]): number {
  if (a.length < 2) return 0;
  if (!a.every(Number.isFinite)) return NaN; // NaN/Inf → честный NaN, не мусор
  // Welford (online): численно устойчивее наивной суммы квадратов при mean >> spread
  // (catastrophic cancellation). Один проход, без хранения (x-m) больших величин.
  let m = 0, m2 = 0, n = 0;
  for (const x of a) {
    n++;
    const d = x - m;
    m += d / n;
    m2 += d * (x - m);
  }
  return m2 / (a.length - 1);
}
export function stdev(a: number[]): number {
  return Math.sqrt(variance(a));
}
/** Выборочный коэффициент асимметрии (Fisher-Pearson). */
export function skewness(a: number[]): number {
  const n = a.length;
  if (n < 3 || !a.every(Number.isFinite)) return 0;
  const m = mean(a);
  const s = stdev(a);
  if (s === 0) return 0;
  const m3 = a.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / n;
  return m3;
}
/** Выборочный куртозис (НЕ excess: нормаль = 3). */
export function kurtosis(a: number[]): number {
  const n = a.length;
  if (n < 4 || !a.every(Number.isFinite)) return 3;
  const m = mean(a);
  const s = stdev(a);
  if (s === 0) return 3;
  return a.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / n;
}

/** Sharpe ratio по ряду ретёрнов (без аннуализации; per-trade). */
export function sharpe(returns: number[]): number {
  if (returns.length === 0 || !returns.every(Number.isFinite)) return 0; // NaN/Inf → 0, не распространяем
  const s = stdev(returns);
  const m = mean(returns);
  // DUST-порог: std — пыль, ТОЛЬКО если на уровне floating-point шума САМИХ значений
  // (масштаб данных × machine epsilon), а НЕ относительно mean. Прошлый порог
  // |mean|·1e-9 ошибочно убивал ВЫСОКИЙ Sharpe (малый std при большом mean — это и
  // есть высокий Sharpe, не пыль). Масштаб = max|x|.
  const scale = Math.max(...returns.map((x) => Math.abs(x)), Math.abs(m));
  const dustFloor = scale * 1e-13; // ~500× machine epsilon (2.2e-16) от масштаба данных
  if (s <= dustFloor) return 0;
  return m / s;
}

// ── нормальное распределение ──
/** CDF стандартной нормали через erf-приближение Abramowitz-Stegun 7.1.26. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
/** Обратная нормаль (quantile) — Acklam 2003. Точность ~1e-9 в [1e-15, 1-1e-15]. */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425, ph = 1 - pl;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= ph) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Ожидаемый МАКСИМАЛЬНЫЙ Sharpe при истинном эдже 0, если перебрано N независимых
 * конфигураций с дисперсией SR-оценок varSR. Это «планка случайности»: насколько
 * высокий Sharpe выскочит из чистого шума просто потому, что мы выбрали лучший из N.
 *
 * E[max] ≈ √varSR · [(1−γ)·Z(1−1/N) + γ·Z(1−1/(N·e))]   (López de Prado 2014)
 */
export function expectedMaxSharpe(varSR: number, nTrials: number): number {
  if (nTrials < 1) return 0;
  const sd = Math.sqrt(Math.max(varSR, 0));
  if (nTrials === 1) return 0;
  const z1 = normalInv(1 - 1 / nTrials);
  const z2 = normalInv(1 - 1 / (nTrials * Math.E));
  return sd * ((1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2);
}

/**
 * Deflated Sharpe Ratio: вероятность, что ИСТИННЫЙ Sharpe > порога случайности,
 * с поправкой на (а) число испытаний N, (б) асимметрию/куртозис ряда, (в) длину T.
 *
 * DSR = Φ( (SR − SR0)·√(T−1) / √(1 − skew·SR + (kurt−1)/4·SR²) )
 *
 * SR — наблюдаемый Sharpe лучшей стратегии; SR0 — expectedMaxSharpe(varSR, N).
 * Возвращает p ∈ [0,1]. p ≥ 0.95 → эдж РЕАЛЕН с учётом перебора. На малой выборке
 * или огромном N → p ≈ 0 (честный отказ вместо ложного «reliable»).
 */
export function deflatedSharpe(
  returns: number[],
  nTrials: number,
  varSRAcrossTrials: number,
): number {
  const T = returns.length;
  if (T < 2) return 0;
  const sr = sharpe(returns);
  const sr0 = expectedMaxSharpe(varSRAcrossTrials, nTrials);
  const sk = skewness(returns);
  const ku = kurtosis(returns);
  const denom = Math.sqrt(Math.max(1 - sk * sr + ((ku - 1) / 4) * sr * sr, 1e-12));
  const z = ((sr - sr0) * Math.sqrt(T - 1)) / denom;
  const result = normalCdf(z);
  return Number.isFinite(result) ? result : 0; // не-finite → 0 (fail-closed, не ложный высокий DSR)
}

/**
 * Минимальная длина ряда (число сделок), при которой наблюдаемый Sharpe значим на
 * уровне α (по умолчанию 0.05). Если фактическое N < minTRL — выборки физически НЕ
 * хватает, любой вывод преждевременен. Это «сколько сделок до доверия».
 *
 * minTRL = 1 + [1 − skew·SR + (kurt−1)/4·SR²]·(Z_α / SR)²   (López de Prado)
 */
export function minTrackRecordLength(
  returns: number[],
  alpha = 0.05,
): number {
  const sr = sharpe(returns);
  // SR ≤ 0: стратегия не прибыльна → значимость положительного эджа недостижима
  // НИКОГДА. Возвращаем Infinity, а не маленькое число (формула (z/SR)² теряет знак
  // при возведении в квадрат и дала бы абсурдно малый minTRL для убыточной стратегии).
  if (sr <= 0) return Infinity;
  const sk = skewness(returns);
  const ku = kurtosis(returns);
  const z = normalInv(1 - alpha);
  return 1 + (1 - sk * sr + ((ku - 1) / 4) * sr * sr) * (z / sr) ** 2;
}

/**
 * Probability of Backtest Overfitting через Combinatorially-Symmetric CV (CSCV).
 *
 * Матрица M[config][fold] (perf каждого конфига на каждом фолде). Делим S фолдов
 * на все C(S, S/2) комбинаций IS/OOS. На каждой: выбираем лучший конфиг по IS,
 * смотрим его РАНГ на OOS. Если IS-лучший систематически плох на OOS — это оверфит.
 *
 * PBO = доля разбиений, где IS-лучший попал в нижнюю половину OOS (logit < 0).
 * PBO → 0.5 = чистый оверфит; PBO → 0 = эдж переносится OOS.
 *
 * @param perf perf[c][f] — метрика конфига c на фолде f (больше = лучше)
 */
export function probabilityOfBacktestOverfitting(perf: number[][]): number {
  const nConfigs = perf.length;
  if (nConfigs === 0) return NaN; // нечего оценивать → НЕ выдаём ложный 0.5
  const S = perf[0].length;
  if (S < 2 || S % 2 !== 0) {
    // CSCV требует чётное число фолдов ≥ 2. Возвращаем NaN (не 0.5!), иначе
    // реальный эдж с нечётным числом фолдов читался бы как «оверфит». Вызывающий
    // обязан проверить Number.isNaN и не пускать модель, а не получить ложный сигнал.
    return NaN;
  }
  const half = S / 2;
  const folds = Array.from({ length: S }, (_, i) => i);
  const combos = chooseCombinations(folds, half);
  let overfit = 0;
  let total = 0;
  for (const isSet of combos) {
    const isIn = new Set(isSet);
    const oosSet = folds.filter((f) => !isIn.has(f));
    const isPerf = perf.map((row) => mean(isSet.map((f) => row[f])));
    const oosPerf = perf.map((row) => mean(oosSet.map((f) => row[f])));
    let bestC = 0;
    for (let c = 1; c < nConfigs; c++) if (isPerf[c] > isPerf[bestC]) bestC = c;
    const oosVal = oosPerf[bestC];
    // MIDRANK для корректной обработки ничьих: строго меньшие + половина равных
    // (минус сам конфиг). Без этого все-равные значения занижают ранг → ложный оверфит.
    const less = oosPerf.filter((v) => v < oosVal).length;
    const eq = oosPerf.filter((v) => v === oosVal).length;
    const rank = less + (eq - 1) / 2;
    const omega = (rank + 0.5) / nConfigs;
    const logit = Math.log(omega / (1 - omega + 1e-12));
    // СТРОГО < 0: ровно медиана (omega=0.5, нет ни эджа ни оверфита) не считается оверфитом
    if (logit < 0) overfit++;
    total++;
  }
  return total ? overfit / total : NaN;
}

/** Все сочетания по k из массива (для CSCV; k=S/2, S обычно ≤ 12). */
function chooseCombinations<T>(arr: T[], k: number): T[][] {
  const res: T[][] = [];
  const combo: T[] = [];
  const rec = (start: number) => {
    if (combo.length === k) { res.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); rec(i + 1); combo.pop(); }
  };
  rec(0);
  return res;
}

/**
 * Stationary bootstrap (Politis-Romano 1994): ресэмпл ряда блоками случайной
 * геометрической длины (средняя 1/p), сохраняя автокорреляцию. Для зависимых рядов
 * сделок обычный i.i.d. бутстрэп даёт оптимистичный результат — блочность чинит это.
 */
export function stationaryBootstrapResample(
  returns: number[],
  pBlock: number,
  rng: () => number,
): number[] {
  const n = returns.length;
  if (n === 0) return [];
  const out: number[] = [];
  let idx = Math.floor(rng() * n);
  for (let i = 0; i < n; i++) {
    out.push(returns[idx]);
    if (rng() < pBlock) idx = Math.floor(rng() * n); // новый блок
    else idx = (idx + 1) % n;                         // продолжаем блок
  }
  return out;
}

/** Детерминированный ГПСЧ (mulberry32) — воспроизводимые бутстрэп-прогоны в тестах. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * White's Reality Check / Hansen SPA через stationary bootstrap.
 * H0: лучшая из N стратегий НЕ лучше бенчмарка 0 (весь эдж — data-snooping).
 *
 * Статистика V = max_k √T · mean(returns_k). Бутстрэпим центрированные ряды,
 * считаем распределение макс-статистики при H0, p-value = доля бутстрэп-V,
 * превысивших наблюдаемый V. p ≤ 0.05 → отвергаем H0 (эдж не объясним перебором).
 *
 * @param strategiesReturns массив рядов (по одному на конфиг-кандидат)
 */
export function realityCheckPValue(
  strategiesReturns: number[][],
  opts: { bootstraps?: number; pBlock?: number; seed?: number } = {},
): number {
  const B = opts.bootstraps ?? 1000;
  const pBlock = opts.pBlock ?? 0.1; // средняя длина блока 10
  const rng = mulberry32(opts.seed ?? 12345);
  const K = strategiesReturns.length;
  if (K === 0) return 1;

  // наблюдаемая макс-статистика
  const stat = (rs: number[], baseMean: number) =>
    Math.sqrt(rs.length) * (mean(rs) - baseMean);
  let observedV = -Infinity;
  for (const rs of strategiesReturns) observedV = Math.max(observedV, stat(rs, 0));

  // бутстрэп под H0: центрируем каждую стратегию на её среднем
  let exceed = 0;
  for (let b = 0; b < B; b++) {
    let vb = -Infinity;
    for (const rs of strategiesReturns) {
      const m = mean(rs);
      const resampled = stationaryBootstrapResample(rs, pBlock, rng);
      // центрированная статистика: √T·(mean(resample) − mean(original))
      vb = Math.max(vb, stat(resampled, m));
    }
    if (vb >= observedV) exceed++;
  }
  return (exceed + 1) / (B + 1); // +1 — несмещённая бутстрэп p-value (Davison-Hinkley)
}

/**
 * Итоговый сертификат: пять барьеров López de Prado / White / Hansen.
 * certified=true ТОЛЬКО если эдж переживает поправку на N испытаний, не оверфит
 * по CSCV, не объясним data-snooping, и выборки достаточно.
 */
export interface CertificationInput {
  /** ретёрны ВЫБРАННОЙ стратегии (по сделкам) */
  selectedReturns: number[];
  /** число перебранных конфигураций (N испытаний) */
  nTrials: number;
  /** дисперсия Sharpe-оценок ПО испытаниям (для DSR planка) */
  varSRAcrossTrials: number;
  /** perf[config][fold] для PBO (CSCV) */
  perfMatrix: number[][];
  /** ретёрны всех конфигов-кандидатов для SPA */
  candidateReturns: number[][];
  /** несмещённый nested-CV OOS score (null если не считался) */
  nestedScore: number | null;
}
export interface Certification {
  certified: boolean;
  dsr: number;            // ≥ 0.95
  pbo: number;            // ≤ 0.10
  spaPValue: number;      // ≤ 0.05
  minTRL: number;         // ≤ N
  actualN: number;
  nestedScore: number | null; // > 0
  reasons: string[];      // почему НЕ сертифицировано
}
export function certifyStrategy(
  inp: CertificationInput,
  thresholds: { dsr?: number; pbo?: number; spa?: number } = {},
): Certification {
  const dsrThr = thresholds.dsr ?? 0.95;
  const pboThr = thresholds.pbo ?? 0.10;
  const spaThr = thresholds.spa ?? 0.05;

  const dsr = deflatedSharpe(inp.selectedReturns, inp.nTrials, inp.varSRAcrossTrials);
  const pbo = probabilityOfBacktestOverfitting(inp.perfMatrix);
  const spaPValue = realityCheckPValue(inp.candidateReturns);
  const minTRL = minTrackRecordLength(inp.selectedReturns);
  const actualN = inp.selectedReturns.length;

  const reasons: string[] = [];
  if (dsr < dsrThr) reasons.push(`DSR ${dsr.toFixed(3)} < ${dsrThr} — эдж не переживает поправку на ${inp.nTrials} испытаний`);
  if (Number.isNaN(pbo)) reasons.push(`PBO не оценить (нужно чётное число фолдов ≥ 2 и ≥1 конфиг) — нельзя сертифицировать вслепую`);
  else if (pbo > pboThr) reasons.push(`PBO ${pbo.toFixed(3)} > ${pboThr} — конфиг оверфитнут (CSCV)`);
  if (spaPValue > spaThr) reasons.push(`SPA p-value ${spaPValue.toFixed(3)} > ${spaThr} — эдж объясним data-snooping`);
  if (actualN < minTRL) reasons.push(`N=${actualN} < minTRL=${minTRL.toFixed(0)} — выборки недостаточно`);
  if (inp.nestedScore !== null && inp.nestedScore <= 0) reasons.push(`nested OOS-score ${inp.nestedScore.toFixed(4)} ≤ 0 — несмещённый прогноз не положителен`);

  return {
    certified: reasons.length === 0,
    dsr, pbo, spaPValue, minTRL, actualN,
    nestedScore: inp.nestedScore, reasons,
  };
}
