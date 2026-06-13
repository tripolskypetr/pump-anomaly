/**
 * Генератор синтетических последовательностей по 500 сигналов с ИЗВЕСТНОЙ истиной.
 * Используется e2e-тестами, проверяющими, что статистический аппарат СЕРТИФИЦИРУЕТ
 * реальный эдж и ОТКАЗЫВАЕТ выбросу/шуму/распаду режима — то, что брутфорс не умеет.
 *
 * Каждый сценарий возвращает ряд per-trade ретёрнов (доли), как их дал бы replay.
 */

import { mulberry32 } from "../../src/statistics";

export interface Scenario {
  name: string;
  /** per-trade ретёрны (500 шт) */
  returns: number[];
  /** заложена ли реальная положительная экспектанси */
  hasEdge: boolean;
}

/** Гауссов шум через Box-Muller на детерминированном ГПСЧ. */
function gaussGen(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

const N = 500;

/** Реальный эдж: устойчивый положительный снос, умеренная волатильность. */
export function edgePresent(seed = 1): Scenario {
  const g = gaussGen(mulberry32(seed));
  const returns = Array.from({ length: N }, () => 0.004 + g() * 0.01); // mean ≈ +0.4σ
  return { name: "edge-present", returns, hasEdge: true };
}

/** Чистый шум: ретёрны независимы от сигнала, истинный эдж = 0. */
export function edgeAbsent(seed = 2): Scenario {
  const g = gaussGen(mulberry32(seed));
  const returns = Array.from({ length: N }, () => g() * 0.01);
  return { name: "edge-absent", returns, hasEdge: false };
}

/** Околонулевой эдж + один гигантский выброс, создающий ложный положительный mean. */
export function edgeWithOutlier(seed = 3): Scenario {
  const g = gaussGen(mulberry32(seed));
  const returns = Array.from({ length: N }, () => g() * 0.01);
  returns[Math.floor(N / 2)] = 0.6; // один «иксовый» памп тащит среднее вверх
  return { name: "edge-with-outlier", returns, hasEdge: false };
}

/** Эдж в первой половине, шум во второй (распад режима). Итоговый эдж ненадёжен. */
export function regimeShift(seed = 4): Scenario {
  const g = gaussGen(mulberry32(seed));
  const returns = Array.from({ length: N }, (_, i) =>
    i < N / 2 ? 0.005 + g() * 0.01 : g() * 0.01);
  return { name: "regime-shift", returns, hasEdge: false }; // edge не устойчив → не сертифицировать целиком
}

/**
 * Матрица perf[config][fold] для PBO. edgeConfig=true → один конфиг РОБАСТНО хорош
 * (стабильно высокий перф с малым разбросом по фолдам — сигнатура настоящего эджа);
 * остальные шумовые. false → все шумовые (оверфит-кейс, PBO→0.5).
 *
 * Ключ: реальный эдж СТАБИЛЕН между фолдами (низкая within-config дисперсия), а не
 * просто имеет высокое среднее. Шумовой конфиг с высоким средним на IS проваливается
 * OOS — это и ловит CSCV.
 */
export function perfMatrix(edgeConfig: boolean, seed = 5, configs = 20, folds = 8): number[][] {
  const g = gaussGen(mulberry32(seed));
  return Array.from({ length: configs }, (_, c) =>
    Array.from({ length: folds }, () =>
      edgeConfig && c === 0 ? 0.006 + g() * 0.0006 : g() * 0.003));
}

/** Набор рядов-кандидатов для SPA: N шумовых, опционально + один с эджем. */
export function candidatePool(withEdge: boolean, seed = 6, pool = 50): number[][] {
  const strats: number[][] = [];
  for (let k = 0; k < pool; k++) {
    const g = gaussGen(mulberry32(seed + k));
    strats.push(Array.from({ length: N }, () => g() * 0.01));
  }
  if (withEdge) {
    const g = gaussGen(mulberry32(seed + 999));
    strats.push(Array.from({ length: N }, () => 0.004 + g() * 0.01));
  }
  return strats;
}
