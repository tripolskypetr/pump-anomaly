import { EventTable } from "../core/event-table";

const MIN = 60_000;

/**
 * Слой 1 — самооценка характерного лага τ.
 *
 * Строит гистограмму всех попарных положительных задержек между РАЗНЫМИ каналами
 * по совпадающим (symbol,direction). У случайных пар распределение ≈ плоское,
 * у «братских» каналов — острый пик у малого лага. Модальный лог-бин даёт τ.
 *
 * Возвращает τ в мс, зажатый в [30с, 60мин]. Если данных мало — дефолт 15 мин.
 */
export function selfTuneLag(tbl: EventTable): number {
  const deltas: number[] = [];
  const HORIZON = 6 * 60 * MIN; // парные задержки в пределах 6ч

  for (const evs of tbl.byKey.values()) {
    for (let i = 0; i < evs.length; i++) {
      for (let j = i + 1; j < evs.length; j++) {
        const d = evs[j].ts - evs[i].ts;
        if (d <= 0) continue;
        if (d > HORIZON) break; // массив сортирован — дальше только больше
        if (evs[i].channel !== evs[j].channel) deltas.push(d);
      }
    }
  }

  if (deltas.length < 8) return 15 * MIN;
  return selfTuneLagDetailFromDeltas(deltas).tauMs;
}

/** Детальная оценка τ: параметры смеси «пик братских задержек + фон совпадений». */
export interface LagDetail {
  /** τ = мода логнормальной компоненты, зажат в [30с, 60мин] */
  tauMs: number;
  /** ширина пика в лог-пространстве (σ) — «насколько братья пунктуальны» */
  sigmaLog: number;
  /** вес пиковой компоненты (доля задержек, объяснимых братством, 0..1) */
  peakWeight: number;
  /** число задержек в оценке */
  n: number;
}

/**
 * EM для двухкомпонентной смеси в лог-пространстве задержек:
 *   пик братских каналов  ~ Normal(μ, σ²) по log(Δ)  (логнормальные задержки)
 *   фон случайных совпадений ~ Uniform(logMin, logMax)
 *
 * Модальный лог-бин (старый метод) — шумная оценка: соседние бины делят пик, и τ
 * прыгает на ширину бина. EM инициализируется модальным бином и уточняет μ по
 * ВСЕЙ массе пика, а не по одному бину; заодно даёт σ (пунктуальность братьев)
 * и вес пика (есть ли братская структура вообще). При вырождении EM — честный
 * откат к модальному бину.
 */
function selfTuneLagDetailFromDeltas(deltasIn: number[]): LagDetail {
  const deltas = [...deltasIn].sort((a, b) => a - b);
  const logs = deltas.map((d) => Math.log(Math.max(d, 1000)));
  const logMin = logs[0];
  const logMax = logs[logs.length - 1];
  const span = logMax - logMin || 1;

  // инициализация: модальный лог-бин (старый метод)
  const BINS = 24;
  const hist = new Array(BINS).fill(0);
  for (const l of logs) {
    let b = Math.floor(((l - logMin) / span) * BINS);
    if (b >= BINS) b = BINS - 1;
    if (b < 0) b = 0;
    hist[b]++;
  }
  let peak = 0;
  for (let b = 1; b < BINS; b++) if (hist[b] > hist[peak]) peak = b;
  const modalMu = logMin + ((peak + 0.5) / BINS) * span;

  // EM: π·N(μ,σ) + (1−π)·U(logMin,logMax)
  let mu = modalMu;
  let sigma = span / BINS; // стартовая ширина = бин
  let pi = 0.5;
  const uniformDensity = 1 / span;
  const clampSigma = (s: number) => Math.min(Math.max(s, 1e-3), span);
  let degenerate = false;
  for (let iter = 0; iter < 30; iter++) {
    let sumR = 0, sumRl = 0, sumRll = 0;
    for (const l of logs) {
      const z = (l - mu) / sigma;
      const normal = Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
      const r = (pi * normal) / (pi * normal + (1 - pi) * uniformDensity + 1e-300);
      sumR += r;
      sumRl += r * l;
      sumRll += r * l * l;
    }
    if (sumR < 2) { degenerate = true; break; } // пик растворился — фон объясняет всё
    const newMu = sumRl / sumR;
    const newSigma = clampSigma(Math.sqrt(Math.max(sumRll / sumR - newMu * newMu, 0)));
    const newPi = Math.min(Math.max(sumR / logs.length, 0.02), 0.98);
    if (Math.abs(newMu - mu) < 1e-6 && Math.abs(newSigma - sigma) < 1e-6) {
      mu = newMu; sigma = newSigma; pi = newPi;
      break;
    }
    mu = newMu; sigma = newSigma; pi = newPi;
  }
  if (degenerate) { mu = modalMu; sigma = span / BINS; pi = 0; }

  const tau = Math.min(Math.max(Math.exp(mu), 30 * 1000), 60 * MIN);
  return {
    tauMs: tau,
    sigmaLog: +sigma.toFixed(6),
    peakWeight: +pi.toFixed(6),
    n: deltas.length,
  };
}

/** Публичная детальная версия selfTuneLag (τ + ширина пика + вес братской компоненты). */
export function selfTuneLagDetail(tbl: EventTable): LagDetail {
  const deltas: number[] = [];
  const HORIZON = 6 * 60 * MIN;
  for (const evs of tbl.byKey.values()) {
    for (let i = 0; i < evs.length; i++) {
      for (let j = i + 1; j < evs.length; j++) {
        const d = evs[j].ts - evs[i].ts;
        if (d <= 0) continue;
        if (d > HORIZON) break;
        if (evs[i].channel !== evs[j].channel) deltas.push(d);
      }
    }
  }
  if (deltas.length < 8) return { tauMs: 15 * MIN, sigmaLog: 0, peakWeight: 0, n: deltas.length };
  return selfTuneLagDetailFromDeltas(deltas);
}
