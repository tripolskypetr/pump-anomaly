import { EventTable } from "../core/event-table";
import { DirectedEdge } from "./lag-xcorr";

/**
 * Слой 9 — MULTIVARIATE HAWKES: одна генеративная модель вместо конвейера
 * jaccard-сито → медианный лаг → union-find.
 *
 * Интенсивность канала j:
 *
 *   λ_j(t) = μ_j + Σ_i Σ_{t_ik < t} α_ij · β · exp(−β(t − t_ik)),   β = 1/τ
 *
 * α_ij — среднее число «эхо»-событий канала j, порождаемых ОДНИМ событием
 * канала i. EM-оценка: E-шаг раскладывает каждое событие на «фон» и «потомка
 * конкретного предка» по ответственностям, M-шаг обновляет α = масса потомков /
 * число событий предка и μ = фоновая масса / экспозиция. Диагональ α_ii
 * (самовозбуждение серий постов) оценивается, но в рёбра не идёт — она
 * впитывает внутриканальные очереди, чтобы те не раздували кросс-α.
 *
 * Значимость ребра — та же пуассоновская конвенция, что в viability: масса
 * потомков m_ij должна превысить ожидание случайных коинциденций λ + 2√λ.
 * Так исчезают ТРИ независимых порога конвейера (jaccardThreshold,
 * lagPeakThreshold, peakShare) — их роль берёт на себя правдоподобие.
 *
 * Включается config.authorGraph = "hawkes" (по умолчанию "xcorr" — прежний
 * конвейер, поведение без флага не меняется).
 */

export interface HawkesGraph {
  channels: string[];
  /** α[i][j]: события канала i порождают в среднем α_ij событий канала j */
  alpha: number[][];
  /** фоновые интенсивности μ_j, событий/мс */
  mu: number[];
  /** β = 1/τ экспоненциального ядра */
  beta: number;
  /** значимые направленные рёбра (совместимы со слоями 4/7) */
  edges: DirectedEdge[];
}

const KERNEL_HORIZON = 20; // хвост ядра дальше 20τ пренебрежим (e^-20)
const EM_ITERS = 25;

export function fitHawkesGraph(tbl: EventTable, tau: number): HawkesGraph {
  const channels = tbl.channels;
  const K = channels.length;
  const idx = new Map(channels.map((c, i) => [c, i]));
  const beta = 1 / Math.max(tau, 1);

  // последовательности = группы (symbol,direction); экспозиция каждой ≥ τ
  const seqs: Array<Array<{ t: number; c: number }>> = [];
  let exposure = 0;
  for (const evs of tbl.byKey.values()) {
    seqs.push(evs.map((e) => ({ t: e.ts, c: idx.get(e.channel)! })));
    const span = evs.length > 1 ? evs[evs.length - 1].ts - evs[0].ts : 0;
    exposure += Math.max(span, tau);
  }
  const nOf = new Array(K).fill(0);
  for (const s of seqs) for (const e of s) nOf[e.c]++;
  const totalN = nOf.reduce((a, b) => a + b, 0);

  // init: слабое равномерное возбуждение + фон из средней скорости
  let alpha: number[][] = Array.from({ length: K }, () => new Array(K).fill(0.2));
  let mu: number[] = nOf.map((n) => Math.max((0.5 * n) / Math.max(exposure, 1), 1e-12));

  const horizon = KERNEL_HORIZON * tau;
  const m = Array.from({ length: K }, () => new Array(K).fill(0));
  const bg = new Array(K).fill(0);

  for (let iter = 0; iter < EM_ITERS && totalN > 0; iter++) {
    for (const row of m) row.fill(0);
    bg.fill(0);
    for (const s of seqs) {
      let lo = 0;
      for (let k = 0; k < s.length; k++) {
        const e = s[k];
        while (s[lo].t < e.t - horizon) lo++;
        // веса предков + фон
        let z = mu[e.c];
        for (let l = lo; l < k; l++) {
          const p = s[l];
          z += alpha[p.c][e.c] * beta * Math.exp(-beta * (e.t - p.t));
        }
        if (!(z > 0)) continue;
        bg[e.c] += mu[e.c] / z;
        for (let l = lo; l < k; l++) {
          const p = s[l];
          m[p.c][e.c] += (alpha[p.c][e.c] * beta * Math.exp(-beta * (e.t - p.t))) / z;
        }
      }
    }
    // M-шаг (клампы против вырождения на крошечных данных)
    alpha = m.map((row, i) => row.map((v) => Math.min(v / Math.max(nOf[i], 1), 5)));
    mu = bg.map((v) => Math.max(v / Math.max(exposure, 1), 1e-12));
  }

  // ── рёбра: масса потомков против пуассоновского порога случайности ──
  // λ_ij = Σ_keys n_i(k)·n_j(k)·2τ/span_k — ожидание случайных пар в окне ±τ
  // (та же конвенция, что overlapStats в viability).
  const lambda = Array.from({ length: K }, () => new Array(K).fill(0));
  for (const evs of tbl.byKey.values()) {
    if (evs.length < 2) continue;
    const span = Math.max(evs[evs.length - 1].ts - evs[0].ts, tau);
    const cnt = new Map<number, number>();
    for (const e of evs) {
      const c = idx.get(e.channel)!;
      cnt.set(c, (cnt.get(c) ?? 0) + 1);
    }
    for (const [i, ni] of cnt) {
      for (const [j, nj] of cnt) {
        if (i !== j) lambda[i][j] += ni * nj * Math.min((2 * tau) / span, 1);
      }
    }
  }
  const edges: DirectedEdge[] = [];
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      if (i === j) continue;
      const mass = m[i][j];
      const bound = Math.max(2, lambda[i][j] + 2 * Math.sqrt(lambda[i][j]));
      if (mass <= bound) continue;
      const a = Math.min(alpha[i][j], 1);
      edges.push({
        a: channels[i], b: channels[j],
        jaccard: +a.toFixed(6),
        lag: tau,
        peakShare: +a.toFixed(6),
        leader: channels[i], follower: channels[j],
      });
    }
  }

  return { channels, alpha, mu, beta, edges };
}
