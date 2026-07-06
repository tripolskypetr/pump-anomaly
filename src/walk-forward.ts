import { ParserItem } from "./types";
import { GetCandles } from "./candle";
import { withCandleCache, withTimeout, DEFAULT_CANDLE_TIMEOUT_MS } from "./chunked-candles";
import { TrainOptions, DEFAULT_GRID } from "./train";
import { SignalPolicy } from "./signal";
import { PnlStats, pnlStats } from "./objective";
import { sharpe } from "./statistics";
import { PumpMatrix } from "./pump-matrix";
import { CapitalTrade, CapitalSimResult, simulateCapital } from "./capital";

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
  /** сколько train-items выброшено эмбарго на границе (их метки заглядывали в тест) */
  embargoDropped: number;
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
  /**
   * КАПИТАЛЬНАЯ ОДНОВРЕМЕННОСТЬ: Σpnl выше предполагает бесконечный капитал —
   * пампы кластеризуются, и в плотный час открылось бы больше позиций, чем есть
   * слотов. Здесь та же OOS-цепочка прогнана через жадную очередь слотов
   * (opts.maxConcurrentPositions; без опции лимит=∞ — тогда это чистый замер
   * СПРОСА: demandPeak говорит, сколько параллельных позиций подразумевает Σpnl).
   * sumUnconstrained − sumConstrained = сколько бумажного дохода недоступно
   * при твоём капитале.
   */
  capital: CapitalSimResult;
}

export interface WalkForwardOptions {
  /** число тестовых блоков (история делится на slices+1 частей; первая — только обучение) */
  slices?: number;
  /** опции обучения каждого среза (grid/mode/costs/…); cadence-guard обходится автоматически */
  trainOptions?: TrainOptions;
  /** политика бэктеста тестовых блоков (сужает обученную, как в проде) */
  policy?: Partial<SignalPolicy>;
  /** ёмкость общего кэша свечей на все срезы (окон по ~1445 свечей). Дефолт 1024. */
  cacheCapacity?: number;
  /**
   * Эмбарго на границе train/test, минуты. Метка train-сделки, открытой впритык
   * к границе, считается по свечам УЖЕ ТЕСТОВОГО периода — обучение подсматривало
   * бы в цены, на которых его затем экзаменуют. Такие train-items выбрасываются.
   * По умолчанию = max(staleMinutes грида) — горизонт жизни самой долгой сделки.
   */
  embargoMinutes?: number;
  /**
   * Сколько позиций твой капитал держит ОДНОВРЕМЕННО. Включает честную симуляцию
   * очереди слотов (result.capital): сигнал при заполненных слотах пропускается,
   * при одновременном прибытии первым берётся больший E[pnl] модели исхода.
   * Не задано = ∞ (старое поведение Σpnl), но result.capital.demandPeak всё равно
   * покажет, сколько параллельных позиций эта сумма молча предполагает.
   */
  maxConcurrentPositions?: number;
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
  // ОДИН кэш свечей на все срезы: K переобучений размечают пересекающиеся
  // префиксы истории — без общего кэша каждый срез заново тянет те же окна с биржи.
  const gc = withCandleCache(
    withTimeout(getCandles, opts.trainOptions?.candleTimeoutMs ?? DEFAULT_CANDLE_TIMEOUT_MS),
    opts.cacheCapacity ?? 1024,
  );
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
  const capitalTrades: CapitalTrade[] = [];
  let certSlices = 0;

  // эмбарго = горизонт самой долгой сделки грида (если не переопределён)
  const gridStale = opts.trainOptions?.grid?.staleMinutes ?? DEFAULT_GRID.staleMinutes;
  const embargoMs = (opts.embargoMinutes ?? Math.max(...gridStale)) * 60_000;

  for (let s = 0; s < K; s++) {
    const trainEndIdx = blockSize * (s + 1);
    const testEndIdx = s === K - 1 ? sorted.length : blockSize * (s + 2);
    const trainItemsAll = sorted.slice(0, trainEndIdx);
    const testItems = sorted.slice(trainEndIdx, testEndIdx);
    // PURGE: train-items впритык к test-блоку выбрасываются — их метки считаются
    // по свечам тестового периода (label peeking через границу). Если эмбарго
    // выело всё обучение (вырожденно плотные данные) — честно оставляем как есть.
    const boundaryTs = testItems[0].ts;
    const trainItemsPurged = trainItemsAll.filter((i) => i.ts <= boundaryTs - embargoMs);
    const trainItems = trainItemsPurged.length >= 2 ? trainItemsPurged : trainItemsAll;
    const embargoDropped = trainItemsAll.length - trainItems.length;
    const trainUntil = trainItems[trainItems.length - 1].ts;

    // модель среза: видит ТОЛЬКО прошлое. cadence-guard обходим — walk-forward
    // это исследовательская серия fit-ов по построению, не боевой цикл.
    const model = await PumpMatrix.fit(trainItems, gc, {
      ...opts.trainOptions,
      ignoreCadence: true,
    });

    // OOS: бэктест ТЕСТОВЫХ сигналов обученной моделью (их обучение не видело)
    const sigs = await model.backtest(testItems, gc, opts.policy);
    const entered = sigs
      .filter((x) => x.result.entered)
      .sort((a, b) => a.ts - b.ts);
    const pnls = entered.map((x) => x.result.pnl);
    for (const x of entered) {
      capitalTrades.push({
        ts: x.ts,
        heldMinutes: x.result.heldMinutes,
        pnl: x.result.pnl,
        priority: x.probability?.expectedPnl ?? null,
      });
    }

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
      embargoDropped,
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
    capital: simulateCapital(capitalTrades, opts.maxConcurrentPositions ?? null),
  };
}
