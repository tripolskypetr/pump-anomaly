import { GetCandles } from "./candle";
import { entryStartTs, STEP_MS } from "./candle";
import { fetchCandlesChunked } from "./chunked-candles";
import { ParserItem } from "./types";

/**
 * АВТОКАЛИБРОВКА ГРИДА — casual-режим без магических констант.
 *
 * Проблема размерных констант: hardStop «2%» ничего не значит сам по себе —
 * на ликвидной паре это широченный стоп, на мем-коине — внутри минутного шума
 * (стоп-хант гарантирован). То же с горизонтами: ось 720 минут мертва, если
 * история не покрывает столько свечей после событий (все метки truncated).
 *
 * Решение: РАЗМЕР берём из данных, в коде остаются только БЕЗРАЗМЕРНЫЕ величины:
 *  - масштаб шума = медианный |1m-ретёрн| по свечам ДО событий (медиана двойная:
 *    по свечам события и по событиям — устойчива к пампам и выбросам);
 *  - оси процентов = шум × безразмерные множители (сколько «минутных шумов»
 *    должен пережить стоп/трейлинг), с клампами вменяемости;
 *  - оси горизонтов = только те значения, которые история физически может
 *    разметить (замер доступного форвард-покрытия от событий);
 *  - staleness-минуты ≥ life-cap отбрасываются (никогда не сработают — мёртвая ось).
 *
 * Финальный выбор внутри осей остаётся за CV-перебором train — калибровка лишь
 * ставит сетку в правильный масштаб и убирает заведомо мёртвые значения.
 */

export interface CalibrationAxes {
  hardStop?: number[];
  trailingTake?: number[];
  stalenessSinceProfit?: number[];
  staleMinutes?: number[];
  stalenessSinceMinutes?: number[];
  /** меню порогов обучаемого momentum-гейта (null = без гейта — всегда в меню) */
  momentumGatePct?: Array<number | null>;
}

export interface Calibration {
  /** медианный |1m-ретёрн| в %, масштаб шума данных; null = свечи не удалось получить */
  noisePct: number | null;
  /** p25 доступного форвард-покрытия от событий, минут; null = не измерено */
  forwardCoverageMinutes: number | null;
  /** сколько (symbol, ts)-точек реально просэмплировано */
  sampledEvents: number;
  /** какие оси заменены и на что (только заменённые) */
  axes: CalibrationAxes;
  /** человекочитаемое объяснение, что и почему выбрано */
  reason: string;
}

// ── единственные константы калибровки: БЕЗРАЗМЕРНЫЕ множители и клампы ──
// Множитель = «сколько единиц минутного шума». Экскурсия случайного блуждания за
// H минут ~ шум·√H: стоп на 20-80 шумов переживает нормальный путь, трейлинг на
// 10-40 шумов не срабатывает на каждой свече. Клампы отсекают вырожденные данные.
const SAMPLE_EVENTS = 8;          // точек замера по истории (равномерно + разные символы)
const NOISE_WINDOW_MIN = 240;     // свечей ДО события для оценки шума (4ч)
const HARDSTOP_NOISE_MULT = [20, 40, 80];
const TRAIL_NOISE_MULT = [10, 20, 40];
const STALE_PROFIT_NOISE_MULT = [10, 20];
const HARDSTOP_CLAMP: [number, number] = [0.5, 12];
const TRAIL_CLAMP: [number, number] = [0.3, 6];
const STALE_PROFIT_CLAMP: [number, number] = [0.3, 4];
/**
 * Меню порогов momentum-гейта в единицах σ ЗА ОКНО ГЕЙТА: σ_окна ≈ шум·√N_минут
 * (случайное блуждание). Пороги ±0.5σ и 0 воспроизводят «−1%/24ч» исследования
 * на активе с шумом ~0.056% (0.5·0.056·√1440 ≈ 1.07%). null = «без гейта» —
 * всегда в меню: CV сам решает, помогает ли фильтр на этих данных.
 */
const MOMENTUM_GATE_SIGMA_MULT = [-0.5, 0, 0.5];
const MOMENTUM_WINDOW_FOR_MENU = 1440;
/** горизонт годен, если покрытие p25 закрывает его с запасом (вход бывает не первой свечой) */
const COVERAGE_SAFETY = 0.9;

const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(Math.max(x, lo), hi);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile25 = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * 0.25)];
};

/** равномерная выборка событий по истории, с приоритетом разных символов */
function sampleEvents(items: ParserItem[]): Array<{ symbol: string; ts: number }> {
  const valid = items
    .filter((i) => i && typeof i.symbol === "string" && Number.isFinite(i.ts))
    .sort((a, b) => a.ts - b.ts);
  if (valid.length === 0) return [];
  const picked: Array<{ symbol: string; ts: number }> = [];
  const seenSymbols = new Set<string>();
  const step = Math.max(1, Math.floor(valid.length / SAMPLE_EVENTS));
  for (let i = 0; i < valid.length && picked.length < SAMPLE_EVENTS; i += step) {
    // внутри шага предпочитаем ещё не виденный символ (шум меряем по разным активам)
    let choice = valid[i];
    for (let j = i; j < Math.min(i + step, valid.length); j++) {
      if (!seenSymbols.has(valid[j].symbol)) { choice = valid[j]; break; }
    }
    picked.push({ symbol: choice.symbol, ts: choice.ts });
    seenSymbols.add(choice.symbol);
  }
  return picked;
}

/**
 * Калибрует оси грида по данным. Ошибки getCandles на отдельных точках не роняют
 * калибровку (точка пропускается); если не измерилось ничего — оси не заменяются,
 * reason честно говорит о фолбэке на дефолт.
 */
export async function calibrateGrid(
  items: ParserItem[],
  getCandles: GetCandles,
  baseHorizons: { staleMinutes: number[]; stalenessSinceMinutes: number[] },
): Promise<Calibration> {
  const samples = sampleEvents(items);
  const step = STEP_MS["1m"];
  const maxLife = Math.max(...baseHorizons.staleMinutes);
  const forwardProbe = Math.ceil(maxLife * 1.1) + 5;

  const perEventNoise: number[] = [];
  const coverage: number[] = [];

  for (const s of samples) {
    const start = entryStartTs(s.ts, "1m");
    // шум: свечи СТРОГО ДО события (памп после поста не должен раздувать «норму»)
    try {
      const before = await fetchCandlesChunked(getCandles, s.symbol, "1m", NOISE_WINDOW_MIN, start - NOISE_WINDOW_MIN * step);
      const rets: number[] = [];
      for (let i = 1; i < before.length; i++) {
        const prev = before[i - 1].close;
        if (prev > 0 && Number.isFinite(before[i].close)) rets.push(Math.abs(before[i].close / prev - 1) * 100);
      }
      const m = median(rets);
      if (m !== null && m > 0) perEventNoise.push(m);
    } catch { /* точка пропущена */ }
    // покрытие: сколько свечей история реально отдаёт вперёд от события
    try {
      const fwd = await fetchCandlesChunked(getCandles, s.symbol, "1m", forwardProbe, start);
      coverage.push(fwd.length);
    } catch { coverage.push(0); }
  }

  const noisePct = median(perEventNoise);
  const coverageP25 = percentile25(coverage);

  const axes: CalibrationAxes = {};
  const notes: string[] = [];

  if (noisePct !== null) {
    const scale = (mults: number[], cl: [number, number]) =>
      [...new Set(mults.map((k) => +clamp(noisePct * k, cl).toFixed(2)))];
    axes.hardStop = scale(HARDSTOP_NOISE_MULT, HARDSTOP_CLAMP);
    axes.trailingTake = scale(TRAIL_NOISE_MULT, TRAIL_CLAMP);
    axes.stalenessSinceProfit = scale(STALE_PROFIT_NOISE_MULT, STALE_PROFIT_CLAMP);
    // меню обучаемого momentum-гейта: пороги в масштабе σ за окно гейта + «без гейта»
    const sigmaWindow = noisePct * Math.sqrt(MOMENTUM_WINDOW_FOR_MENU);
    axes.momentumGatePct = [
      null,
      ...MOMENTUM_GATE_SIGMA_MULT.map((k) => +(k * sigmaWindow).toFixed(2)),
    ];
    notes.push(`шум 1m = ${noisePct.toFixed(4)}% → hardStop [${axes.hardStop}], trailing [${axes.trailingTake}], momentum-гейт [${axes.momentumGatePct}]`);
  } else {
    notes.push("шум не измерился (нет свечей до событий) — %-оси остаются дефолтными");
  }

  if (coverageP25 !== null && coverageP25 > 0) {
    const feasible = baseHorizons.staleMinutes.filter((L) => L <= coverageP25 * COVERAGE_SAFETY);
    axes.staleMinutes = feasible.length ? feasible : [Math.min(...baseHorizons.staleMinutes)];
    const maxLifeKept = Math.max(...axes.staleMinutes);
    // staleness-таймер длиннее life-cap не сработает никогда — мёртвая ось
    const sm = baseHorizons.stalenessSinceMinutes.filter((m) => m < maxLifeKept);
    axes.stalenessSinceMinutes = sm.length ? sm : [Math.min(...baseHorizons.stalenessSinceMinutes)];
    notes.push(`покрытие p25 = ${coverageP25}м → staleMinutes [${axes.staleMinutes}], staleness [${axes.stalenessSinceMinutes}]`);
  } else {
    notes.push("покрытие не измерилось — оси горизонтов остаются дефолтными");
  }

  return {
    noisePct,
    forwardCoverageMinutes: coverageP25,
    sampledEvents: samples.length,
    axes,
    reason: notes.join("; "),
  };
}
