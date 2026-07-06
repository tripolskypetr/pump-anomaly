import { TrainedParams } from "./train";
import { PumpMatrix } from "./pump-matrix";
import { minTrackRecordLength } from "./statistics";

/**
 * PAPER TRADER — замыкание петли «прогноз → реальность».
 *
 * Сертификат говорит про прошлое; каналы умирают, боты меняют расписание, и
 * модель протухает МОЛЧА — форвард-результаты медленно расходятся с обученным
 * распределением, а глазами это видно только после серии убытков. Этот модуль
 * копит форвардные сделки (бумага или реальные) и непрерывно сравнивает их с
 * baseline-распределением pnl из обучения (params.history — реализованные
 * сделки выбранной конфигурации, сериализуются в model.json):
 *
 *  1. CUSUM на стандартизованном pnl — детектор СДВИГА СРЕДНЕЙ вниз. Замечает
 *     деградацию задолго до того, как она видна в скользящей средней: каждая
 *     сделка хуже ожидания добавляет в кумулятивную сумму, серия слабых сделок
 *     пробивает порог. Константы k=0.5σ (allowance) и h=5σ (порог) — СТАНДАРТ
 *     SPC-теста (ARL₀ ≈ 465 сделок между ложными тревогами), конвенция уровня
 *     «1.96 для 95%», не подгоночный параметр.
 *  2. Двухвыборочный тест Колмогорова–Смирнова: форвард-распределение против
 *     train-распределения ЦЕЛИКОМ (не только средняя — хвосты, дисперсия,
 *     асимметрия). p < 0.05 = «рынок уже не тот, на котором обучались».
 *
 * Это же замыкает cadence-гарду петлёй: не «прошло N дней — переобучись», а
 * «дрейф обнаружен — переобучись СЕЙЧАС» / «дрейфа нет — модель живёт».
 */

export interface ForwardTrade {
  /** время сделки, мс */
  ts: number;
  /** реализованный НЕТТО pnl, доли (как в бэктесте: издержки вычтены) */
  pnl: number;
  symbol?: string;
  channel?: string;
}

export interface DriftReport {
  /** форвардных сделок записано */
  n: number;
  /** сделок в baseline (история обучения) */
  baselineN: number;
  /** сработал хотя бы один детектор — модель торговать нельзя, переобучение */
  alarm: boolean;
  reasons: string[];
  /** CUSUM сдвига средней вниз: stat в σ-единицах, порог h=5σ */
  cusum: { stat: number; threshold: number; fired: boolean };
  /** KS форвард vs baseline; null = форварда мало для теста */
  ks: { stat: number; pValue: number; fired: boolean } | null;
  meanForward: number;
  meanBaseline: number;
  /** сколько ещё сделок нужно до статистической значимости форвард-цепочки
   *  (minTRL по самой форвард-цепочке); 0 = уже достаточно; null = SR ≤ 0 */
  tradesToSignificance: number | null;
  /** что делать — человеческим языком */
  recommendation: string;
}

/** SPC-конвенции CUSUM (не подгоночные параметры): allowance и порог в σ. */
const CUSUM_ALLOWANCE_SIGMA = 0.5;
const CUSUM_THRESHOLD_SIGMA = 5;
/** ниже этого форварда KS-асимптотика недостоверна — тест честно молчит */
const KS_MIN_N = 10;
/** конвенция значимости KS (уровень «0.05», как в SPA) */
const KS_ALPHA = 0.05;

/** асимптотический p-value двухвыборочного KS (ряд Колмогорова) */
function ksTwoSample(a: number[], b: number[]): { stat: number; pValue: number } {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    const diff = Math.abs(i / x.length - j / y.length);
    if (diff > d) d = diff;
  }
  const ne = (x.length * y.length) / (x.length + y.length);
  const lambda = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * d;
  let p = 0;
  for (let k = 1; k <= 100; k++) {
    p += 2 * (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda);
  }
  return { stat: +d.toFixed(6), pValue: +Math.min(Math.max(p, 0), 1).toFixed(6) };
}

/** baseline из модели: реализованные pnl вошедших сделок истории обучения */
function baselineOf(src: number[] | TrainedParams | PumpMatrix): number[] {
  if (Array.isArray(src)) return src.filter((p) => Number.isFinite(p));
  const history = src instanceof PumpMatrix
    ? src.dump()
    : src.history ?? [];
  return history.filter((h) => h.entered).map((h) => h.pnl);
}

export class PaperTrader {
  private readonly baseline: number[];
  private forward: ForwardTrade[] = [];

  /**
   * @param baseline модель (PumpMatrix/TrainedParams — возьмётся history вошедших
   *   сделок) или готовый массив pnl (доли) train-распределения
   */
  constructor(baseline: number[] | TrainedParams | PumpMatrix) {
    this.baseline = baselineOf(baseline);
    if (this.baseline.length < 2) {
      throw new Error(
        "PaperTrader: baseline пуст — модель без history (загружена без истории?) не даёт распределения для сравнения",
      );
    }
  }

  /** записать форвардную сделку (бумага или реальная), pnl НЕТТО в долях */
  record(trade: ForwardTrade): void {
    if (!Number.isFinite(trade.pnl) || !Number.isFinite(trade.ts)) return;
    this.forward.push({ ...trade });
    this.forward.sort((a, b) => a.ts - b.ts);
  }

  get trades(): ForwardTrade[] {
    return this.forward.map((t) => ({ ...t }));
  }

  /** сериализация форвард-журнала (baseline живёт в model.json, его не дублируем) */
  save(): string {
    return JSON.stringify({ version: 1, forward: this.forward });
  }

  static load(json: string, baseline: number[] | TrainedParams | PumpMatrix): PaperTrader {
    const raw = JSON.parse(json) as { forward?: ForwardTrade[] };
    const pt = new PaperTrader(baseline);
    for (const t of raw.forward ?? []) pt.record(t);
    return pt;
  }

  /** текущий вердикт дрейфа: CUSUM (сдвиг средней) + KS (форма распределения) */
  status(): DriftReport {
    const base = this.baseline;
    const fwd = this.forward.map((t) => t.pnl);
    const n = fwd.length;
    const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / Math.max(xs.length, 1);
    const mu0 = mean(base);
    const sd0 = Math.sqrt(base.reduce((s, v) => s + (v - mu0) ** 2, 0) / Math.max(base.length - 1, 1));
    const sigma = sd0 > 0 ? sd0 : 1e-9;

    // CUSUM вниз: серия сделок хуже ожидания накапливается; сброс на нуле
    let s = 0;
    let peak = 0;
    for (const p of fwd) {
      s = Math.max(0, s + (mu0 - p) / sigma - CUSUM_ALLOWANCE_SIGMA);
      if (s > peak) peak = s;
    }
    const cusumFired = peak >= CUSUM_THRESHOLD_SIGMA;

    const ks = n >= KS_MIN_N
      ? (() => {
          const t = ksTwoSample(fwd, base);
          return { ...t, fired: t.pValue < KS_ALPHA };
        })()
      : null;

    const alarm = cusumFired || (ks?.fired ?? false);
    const reasons: string[] = [];
    if (cusumFired) {
      reasons.push(`CUSUM ${peak.toFixed(1)}σ ≥ ${CUSUM_THRESHOLD_SIGMA}σ — средний результат форварда сместился ВНИЗ относительно обучения`);
    }
    if (ks?.fired) {
      reasons.push(`KS p=${ks.pValue.toFixed(4)} < ${KS_ALPHA} — распределение форвард-pnl НЕ похоже на train (рынок изменился)`);
    }
    if (!alarm) {
      reasons.push(n === 0
        ? "форвардных сделок ещё нет"
        : `дрейфа не видно: CUSUM ${peak.toFixed(1)}σ/${CUSUM_THRESHOLD_SIGMA}σ${ks ? `, KS p=${ks.pValue.toFixed(3)}` : `, KS ждёт ≥${KS_MIN_N} сделок`}`);
    }

    // сколько ещё копить до значимости самой форвард-цепочки
    const trl = n > 1 ? minTrackRecordLength(fwd) : Infinity;
    const tradesToSignificance = Number.isFinite(trl) ? Math.max(0, Math.ceil(trl - n)) : null;

    const recommendation = alarm
      ? "СТОП: не торговать этой моделью; переобучить на истории, включающей форвард-период (train + новые сделки), и заново пройти assessEdge"
      : n === 0
        ? "записывайте каждую форвардную сделку (record) — монитор начнёт работать с первой"
        : tradesToSignificance === 0
          ? "дрейфа нет и форвард-цепочка статистически значима — модель подтверждена вне обучения"
          : tradesToSignificance !== null
            ? `дрейфа нет — продолжать бумагу/микро, до значимости форварда ещё ~${tradesToSignificance} сделок`
            : "дрейфа нет, но форвард пока не в плюсе — продолжать бумагу, живыми деньгами не торговать";

    return {
      n,
      baselineN: base.length,
      alarm,
      reasons,
      cusum: { stat: +peak.toFixed(4), threshold: CUSUM_THRESHOLD_SIGMA, fired: cusumFired },
      ks,
      meanForward: +mean(fwd).toFixed(6),
      meanBaseline: +mu0.toFixed(6),
      tradesToSignificance,
      recommendation,
    };
  }
}
