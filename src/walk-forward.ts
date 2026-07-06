import { ParserItem } from "./types";
import { GetCandles } from "./candle";
import { TrainOptions } from "./train";
import { SignalPolicy } from "./signal";
import { PnlStats, pnlStats } from "./objective";
import { sharpe } from "./statistics";
import { PumpMatrix } from "./pump-matrix";

/**
 * WALK-FORWARD — единственный честный ответ на «будет ли это зарабатывать».
 *
 * Nested CV оценивает конфиг на перестановках ОДНОЙ выборки; walk-forward
 * воспроизводит реальную жизнь: обучились на прошлом → торговали следующий блок →
 * сдвинулись → переобучились. Ни один тест-сигнал не виден обучению (модель среза
 * строится строго из items с ts ≤ границы), а результат — хронологическая цепочка
 * out-of-sample сделок: кривая капитала, просадка, и отдельный срез «торговали бы
 * только когда сертификат зелёный» — режим, в котором систему и предполагается
 * эксплуатировать.
 */

export interface WalkForwardSlice {
  /** граница обучения: модель видела только items с ts ≤ trainUntil */
  trainUntil: number;
  /** тестовый блок (trainUntil, testTo] */
  testTo: number;
  /** сколько items в обучении / в тесте */
  nTrain: number;
  nTest: number;
  /** сертифицировала ли себя модель этого среза (на своём train-прошлом) */
  certifiedOnTrain: boolean;
  /** confidence/reliable модели среза */
  confidenceOnTrain: number;
  /** OOS-сделки блока: реализованные pnl (доли), хронологически */
  pnls: number[];
  /** сигналов выдано / вошло */
  signals: number;
  entered: number;
}

export interface WalkForwardResult {
  slices: WalkForwardSlice[];
  /** все OOS-pnl хронологически (вошедшие сделки всех блоков) */
  oosPnls: number[];
  /** кумулятивная кривая капитала (аддитивно по долям pnl) */
  equity: number[];
  stats: PnlStats;
  sharpe: number;
  /** максимальная просадка кривой капитала, в долях суммарного pnl-пути */
  maxDrawdown: number;
  /** то же, но сделки берутся ТОЛЬКО из блоков с certifiedOnTrain=true */
  certifiedOnly: {
    oosPnls: number[];
    stats: PnlStats;
    sharpe: number;
    maxDrawdown: number;
    /** сколько блоков были «зелёными» */
    slicesUsed: number;
  };
}

export interface WalkForwardOptions {
  /** число тестовых блоков (история делится на slices+1 частей; первая — только обучение) */
  slices?: number;
  /** опции обучения каждого среза (grid/mode/costs/…); cadence-guard обходится автоматически */
  trainOptions?: TrainOptions;
  /** политика бэктеста тестовых блоков (сужает обученную, как в проде) */
  policy?: Partial<SignalPolicy>;
}

const maxDrawdownOf = (equity: number[]): number => {
  let peak = 0;
  let dd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak - e > dd) dd = peak - e;
  }
  return dd;
};

const summarize = (pnls: number[]) => ({
  stats: pnlStats(pnls),
  sharpe: +sharpe(pnls).toFixed(6),
  equity: pnls.reduce<number[]>((acc, p) => (acc.push((acc[acc.length - 1] ?? 0) + p), acc), []),
});

export async function walkForward(
  items: ParserItem[],
  getCandles: GetCandles,
  opts: WalkForwardOptions = {},
): Promise<WalkForwardResult> {
  const K = Math.max(1, opts.slices ?? 4);
  const sorted = [...items]
    .filter((i) => i && Number.isFinite(i.ts))
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length < K + 1) {
    throw new Error(`walkForward: событий (${sorted.length}) меньше, чем блоков+1 (${K + 1})`);
  }

  // границы блоков по СОБЫТИЯМ (равное число событий на блок, не равное время —
  // иначе тихие месяцы дают пустые блоки, а плотные перегружены)
  const blockSize = Math.floor(sorted.length / (K + 1));
  const slices: WalkForwardSlice[] = [];
  const oosPnls: number[] = [];
  const certPnls: number[] = [];
  let certSlices = 0;

  for (let s = 0; s < K; s++) {
    const trainEndIdx = blockSize * (s + 1);
    const testEndIdx = s === K - 1 ? sorted.length : blockSize * (s + 2);
    const trainItems = sorted.slice(0, trainEndIdx);
    const testItems = sorted.slice(trainEndIdx, testEndIdx);
    const trainUntil = trainItems[trainItems.length - 1].ts;

    // модель среза: видит ТОЛЬКО прошлое. cadence-guard обходим — walk-forward
    // это исследовательская серия fit-ов по построению, не боевой цикл.
    const model = await PumpMatrix.fit(trainItems, getCandles, {
      ...opts.trainOptions,
      ignoreCadence: true,
    });

    // OOS: бэктест ТЕСТОВЫХ сигналов обученной моделью (их обучение не видело)
    const sigs = await model.backtest(testItems, getCandles, opts.policy);
    const entered = sigs
      .filter((x) => x.result.entered)
      .sort((a, b) => a.ts - b.ts);
    const pnls = entered.map((x) => x.result.pnl);

    const certified = model.certification.certified;
    if (certified) {
      certSlices++;
      for (const p of pnls) certPnls.push(p);
    }
    for (const p of pnls) oosPnls.push(p);

    slices.push({
      trainUntil,
      testTo: testItems[testItems.length - 1]?.ts ?? trainUntil,
      nTrain: trainItems.length,
      nTest: testItems.length,
      certifiedOnTrain: certified,
      confidenceOnTrain: model.confidence,
      pnls,
      signals: sigs.length,
      entered: entered.length,
    });
  }

  const all = summarize(oosPnls);
  const cert = summarize(certPnls);
  return {
    slices,
    oosPnls,
    equity: all.equity,
    stats: all.stats,
    sharpe: all.sharpe,
    maxDrawdown: +maxDrawdownOf(all.equity).toFixed(6),
    certifiedOnly: {
      oosPnls: certPnls,
      stats: cert.stats,
      sharpe: cert.sharpe,
      maxDrawdown: +maxDrawdownOf(cert.equity).toFixed(6),
      slicesUsed: certSlices,
    },
  };
}
