/**
 * МОДЕЛЬ ИСХОДА — калиброванная вероятность P(win|признаки) вместо ступенчатых
 * гейтов и эвристического confidence.
 *
 * Проблема: гейты бинарны (momentum −0.99% проходит, −1.01% режется в ноль), а
 * confidence — произведение ad-hoc весов без вероятностного смысла. Прогноз
 * становится точным, когда сигналу приписывается откалиброванная вероятность.
 *
 * Аппарат подобран под МАЛЫЕ выборки (n ~ 100–300 сделок), где ML-зоопарк —
 * гарантированный оверфит:
 *
 *  1. НАИВНЫЙ БАЙЕС С ИЗОТОННЫМИ МАРЖИНАЛАМИ. Для каждого признака x_i оцениваем
 *     P(win|x_i) изотонной регрессией (PAVA): монотонная, непараметрическая,
 *     не переобучается. Направление монотонности — по знаку корреляции.
 *     Вклад признака = log-likelihood ratio: LLR_i(x) = logit(P(win|x_i)) − logit(prior).
 *     Каждый жёсткий гейт превращается в мягкий вклад в правдоподобие;
 *     отсутствующий признак честно даёт 0.
 *  2. КАЛИБРОВКА НА OUT-OF-FOLD. Сумма LLR наивна (признаки коррелированы,
 *     вклады двоятся) — поэтому сырой скор пере-калибруется изотонной регрессией
 *     на out-of-fold предсказаниях (хронологические фолды): предсказанные 0.7
 *     обязаны выигрывать ~70%. Это одновременно лечит наивность и даёт честную
 *     вероятностную шкалу.
 *  3. INFORMATIVE-ГВАРД. Если OOF-Brier модели НЕ лучше Brier константного prior —
 *     модель ничего не выучила: informative=false, рантайм отдаёт prior, а не
 *     псевдоточные проценты. Модель не имеет права быть увереннее данных.
 *
 * E[pnl|x] = pWin·meanWin + (1−pWin)·meanLoss — решение о входе становится
 * решением об ожидаемой ценности (policy.minExpectedPnlPct), а не о ступеньках.
 */

// ── изотонная регрессия (PAVA, pool adjacent violators) ──

interface StepFn {
  /** правые границы ступеней по x (возрастание) */
  breaks: number[];
  /** значение ступени */
  values: number[];
}

const stepPredict = (f: StepFn, x: number): number => {
  // первая ступень, чья граница ≥ x; за пределами — крайние значения
  for (let i = 0; i < f.breaks.length; i++) {
    if (x <= f.breaks[i]) return f.values[i];
  }
  return f.values[f.values.length - 1];
};

/**
 * PAVA для бинарных исходов: неубывающая ступенчатая оценка P(y=1|x).
 * Сглаживание Лапласа внутри блока — LLR не улетает в ±∞ на чистых блоках.
 */
function pavaIncreasing(xs: number[], ys: number[]): StepFn {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  type Block = { sumY: number; n: number; maxX: number };
  const blocks: Block[] = [];
  for (const i of order) {
    blocks.push({ sumY: ys[i], n: 1, maxX: xs[i] });
    // сливаем, пока нарушена монотонность средних
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sumY / a.n <= b.sumY / b.n) break;
      blocks.pop();
      blocks[blocks.length - 1] = { sumY: a.sumY + b.sumY, n: a.n + b.n, maxX: b.maxX };
    }
  }
  return {
    breaks: blocks.map((b) => b.maxX),
    values: blocks.map((b) => (b.sumY + 1) / (b.n + 2)), // Лаплас
  };
}

// ── типы модели ──

export interface IsotonicLLR {
  /** −1 = признак инвертируется перед применением (убывающая зависимость) */
  direction: 1 | -1;
  fn: StepFn; // ступени по (direction·x) → P(win|x_i)
}

export interface OutcomeModel {
  version: 1;
  /** базовая P(win) по всем сделкам */
  prior: number;
  /** маржиналы по именам признаков */
  features: Record<string, IsotonicLLR>;
  /** калибровка сырого скора (Σ LLR) → вероятность, изотонная по OOF */
  calibration: StepFn;
  /** средний pnl выигрышных / проигрышных сделок (для E[pnl]) */
  meanWin: number;
  meanLoss: number;
  n: number;
  /** OOF-Brier модели и константного prior — качество ЧЕСТНО хуже/лучше базы */
  brier: number;
  brierPrior: number;
  /** false = модель не лучше prior → рантайм отдаёт prior, не псевдоточность */
  informative: boolean;
}

export interface OutcomeRow {
  /** 1 = pnl > 0 */
  y: 0 | 1;
  pnl: number;
  ts: number;
  /** null = признак недоступен для этой сделки (вклад 0) */
  features: Record<string, number | null>;
}

const logit = (p: number): number => Math.log(p / (1 - p));
const MIN_ROWS = 20;

const pearsonSign = (xs: number[], ys: number[]): 1 | -1 => {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (xs[i] - mx) * (ys[i] - my);
  return cov >= 0 ? 1 : -1;
};

/** обучает маржиналы на подмножестве строк */
function fitMarginals(rows: OutcomeRow[], names: string[]): Record<string, IsotonicLLR> {
  const out: Record<string, IsotonicLLR> = {};
  for (const name of names) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of rows) {
      const v = r.features[name];
      if (v !== null && Number.isFinite(v)) { xs.push(v); ys.push(r.y); }
    }
    // признак должен присутствовать и варьироваться хоть как-то
    if (xs.length < MIN_ROWS / 2 || new Set(xs).size < 3) continue;
    const direction = pearsonSign(xs, ys);
    const fn = pavaIncreasing(xs.map((x) => direction * x), ys);
    out[name] = { direction, fn };
  }
  return out;
}

/** сырой скор = logit(prior) + Σ LLR присутствующих признаков */
function rawScore(
  marginals: Record<string, IsotonicLLR>,
  prior: number,
  features: Record<string, number | null | undefined>,
): number {
  let s = logit(prior);
  for (const [name, m] of Object.entries(marginals)) {
    const v = features[name];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const p = stepPredict(m.fn, m.direction * v);
    s += logit(p) - logit(prior);
  }
  return s;
}

/**
 * Обучение модели исхода. null, если данных мало или исход одноклассовый —
 * честное «модели нет», а не мусорная модель.
 */
export function fitOutcomeModel(rowsIn: OutcomeRow[], folds = 4): OutcomeModel | null {
  const rows = [...rowsIn].sort((a, b) => a.ts - b.ts);
  const n = rows.length;
  if (n < MIN_ROWS) return null;
  const wins = rows.filter((r) => r.y === 1);
  const losses = rows.filter((r) => r.y === 0);
  if (wins.length === 0 || losses.length === 0) return null;
  const prior = wins.length / n;
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.features)))];

  // ── OOF: хронологические фолды; маржиналы учатся на остальных ──
  const K = Math.min(folds, Math.floor(n / 5));
  const oof: Array<{ raw: number; y: 0 | 1 }> = [];
  if (K >= 2) {
    const size = Math.floor(n / K);
    for (let f = 0; f < K; f++) {
      const lo = f * size;
      const hi = f === K - 1 ? n : (f + 1) * size;
      const trainRows = [...rows.slice(0, lo), ...rows.slice(hi)];
      const m = fitMarginals(trainRows, names);
      const p0 = trainRows.filter((r) => r.y === 1).length / Math.max(trainRows.length, 1);
      const pr = Math.min(Math.max(p0, 0.05), 0.95);
      for (const r of rows.slice(lo, hi)) oof.push({ raw: rawScore(m, pr, r.features), y: r.y });
    }
  }
  if (oof.length < MIN_ROWS) return null;

  // калибровка сырого скора изотоникой по OOF (лечит наивность суммы LLR)
  const calibration = pavaIncreasing(oof.map((o) => o.raw), oof.map((o) => o.y));

  // качество OOF: Brier модели против Brier константного prior
  let brier = 0;
  let brierPrior = 0;
  for (const o of oof) {
    const p = stepPredict(calibration, o.raw);
    brier += (p - o.y) ** 2;
    brierPrior += (prior - o.y) ** 2;
  }
  brier /= oof.length;
  brierPrior /= oof.length;

  // финальные маржиналы — на всех данных (калибровка остаётся OOF-честной)
  const features = fitMarginals(rows, names);

  return {
    version: 1,
    prior: +prior.toFixed(6),
    features,
    calibration,
    meanWin: +(wins.reduce((s, r) => s + r.pnl, 0) / wins.length).toFixed(6),
    meanLoss: +(losses.reduce((s, r) => s + r.pnl, 0) / losses.length).toFixed(6),
    n,
    brier: +brier.toFixed(6),
    brierPrior: +brierPrior.toFixed(6),
    informative: brier + 1e-9 < brierPrior,
  };
}

export interface OutcomePrediction {
  /** калиброванная P(win); при informative=false = prior */
  pWin: number;
  /** E[pnl|x] = pWin·meanWin + (1−pWin)·meanLoss, доли */
  expectedPnl: number;
  informative: boolean;
}

export function predictOutcome(
  model: OutcomeModel,
  features: Record<string, number | null | undefined>,
): OutcomePrediction {
  // неинформативная модель не имеет права на псевдоточность — отдаём prior
  const pWin = model.informative
    ? stepPredict(model.calibration, rawScore(model.features, model.prior, features))
    : model.prior;
  const expectedPnl = pWin * model.meanWin + (1 - pWin) * model.meanLoss;
  return {
    pWin: +pWin.toFixed(6),
    expectedPnl: +expectedPnl.toFixed(6),
    informative: model.informative,
  };
}
