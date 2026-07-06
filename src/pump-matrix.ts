import { ParserItem, PumpVerdict, Direction } from "./types";
import { GetCandles, ICandleData, entryStartTs, STEP_MS } from "./candle";
import { fetchCandlesChunked } from "./chunked-candles";
import { resolveExit, resolveExitNoRegime, ExitTensor } from "./exit-tensor";
import { volumeZScore, squeezePressure, squeezePressureBefore, volRegimeOf, momentumPct, VolRegime } from "./volume";
import { replayExit } from "./replay";
import { RiskRewardStats, PnlStats } from "./objective";
import { DEFAULT_VIABILITY } from "./viability";
import {
  TradeSignal, BacktestSignal, BacktestResult, SignalAction, SignalPolicy, ExitPlan, SignalOrigin,
  intersectPolicy, DEFAULT_POLICY,
} from "./signal";
import {
  train,
  loadPredict,
  TrainedParams,
  SignalRecord,
  TrainOptions,
  TrainResult,
} from "./train";
import { Certification } from "./statistics";
import { MetaLedgerState } from "./meta-ledger";
import { Calibration } from "./calibrate";

/**
 * Casual-фасад с ЕДИНЫМ стабильным контрактом ввода-вывода.
 *
 *   const model = await PumpMatrix.fit(history, getCandles); // обучить
 *   const json  = model.save();                              // сохранить (string)
 *   const model = PumpMatrix.load(json);                     // в проде, без обучения
 *
 *   for (const s of model.signals(liveItems))                // УЖЕ отфильтровано
 *     openPosition(s.symbol, s.direction, s.exit);           // прод не думает
 *
 * signals() возвращает ТОЛЬКО исполняемое: veto (каскад ликвидаций) не попадает в
 * выдачу вообще — фильтр внутри. Разрешённые исходы задаются вторым аргументом
 * (allow-список), но не шире, чем зашито в обученную модель (readonly-инвариант).
 */
export class PumpMatrix {
  private constructor(
    private readonly params: TrainedParams,
    private readonly _predict: (items: ParserItem[]) => ReturnType<TrainResult["predict"]>,
    private readonly _ledger: MetaLedgerState | null = null,
  ) {}

  /** Обучить модель на истории сигналов. */
  static async fit(
    history: ParserItem[],
    getCandles: GetCandles,
    opts?: TrainOptions,
  ): Promise<PumpMatrix> {
    const res = await train(history, getCandles, opts);
    return new PumpMatrix(res.params, res.predict, res.ledger);
  }

  /**
   * Мета-реестр попыток fit С ЗАПИСАННОЙ текущей. Сериализуется в model.json
   * (meta.ledger) — цепочка переживает save()/load(): передай его в
   * opts.metaLedger следующего fit, и cadence-guard + family-wise DSR видят всю
   * историю переобучений. null только у моделей без родословной (старый формат).
   */
  get ledgerAfterFit(): MetaLedgerState | null {
    return this._ledger ?? this.params.meta.ledger ?? null;
  }

  /** Восстановить модель из сохранённого JSON (в проде, без обучения). */
  static load(json: string | TrainedParams): PumpMatrix {
    const params: TrainedParams = typeof json === "string" ? JSON.parse(json) : json;
    if (!params.policy) params.policy = DEFAULT_POLICY; // обратная совместимость
    if (!params.riskReward) params.riskReward = { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } };
    if (!params.pnl) params.pnl = { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } };
    if (!params.channelScore) params.channelScore = {}; // обратная совместимость
    if (!params.channelPlan) params.channelPlan = {};
    return new PumpMatrix(params, loadPredict(params));
  }

  /** Сериализовать модель в JSON-строку (включая policy). */
  save(): string {
    return JSON.stringify(this.params);
  }

  /**
   * Экспорт истории сигналов выбранной конфигурации для внешней аналитики.
   * Возвращает плоский массив записей (цена входа/выхода, pnl, причина выхода,
   * длительность и т.д.) — посчитать метрики можно отдельным скриптом.
   *
   * Включает и НЕ вошедшие сигналы (no-entry / cascade-veto) с entered=false,
   * чтобы аналитика видела пропуски, а не только реализованные сделки.
   * Доступно после fit() и сохраняется в save()/load().
   *
   * @param asString true → JSON-строка; иначе массив объектов (по умолчанию массив)
   */
  dump(asString: true): string;
  dump(asString?: false): SignalRecord[];
  dump(asString = false): string | SignalRecord[] {
    const history = this.params.history ?? [];
    return asString ? JSON.stringify(history) : history.map((h) => ({ ...h }));
  }

  /** Число записей в истории сигналов (0 если модель загружена без истории). */
  get historySize(): number {
    return this.params.history?.length ?? 0;
  }

  /** Полный exit-tensor (для аудита). */
  get exit(): ExitTensor {
    return this.params.exit;
  }

  /** Политика разрешённых исходов, зашитая в модель (readonly-копия). */
  get policy(): SignalPolicy {
    // ПОЛНАЯ копия: помимо allow политика несёт RR-фильтр (minRiskReward/rrMetric),
    // гейт объёма, momentum-фильтр и порог качества автора — терять их нельзя.
    const {
      allow, minRiskReward, rrMetric, requireVolumeConfirm,
      minMomentum24hPct, momentumWindowMinutes, minChannelScore,
      notionalQuote, maxLiquidityShare,
    } = this.params.policy;
    return {
      allow: [...allow], minRiskReward, rrMetric, requireVolumeConfirm,
      minMomentum24hPct, momentumWindowMinutes, minChannelScore,
      notionalQuote, maxLiquidityShare,
    };
  }

  /**
   * Скор авторов по бэктест-истории: channel → { score, median, n }.
   * score = shrinkage-expectancy (усажен к нулю при малом n). Основа для
   * runtime-фильтра policy.minChannelScore и для ручного аудита каналов.
   */
  get channelScore(): Record<string, { score: number; median: number; n: number; algoScore?: number }> {
    return { ...(this.params.channelScore ?? {}) };
  }

  /**
   * Авто-триаж каналов, принятый на fit: channel → "drop" (значимо убыточен,
   * сигналы режутся) | "invert" (механический стоп-хант канал, сигналы
   * разворачиваются). Отсутствие записи = follow. Применяется рантаймом сам.
   */
  get channelPlan(): Record<string, "invert" | "drop"> {
    return { ...(this.params.channelPlan ?? {}) };
  }

  /** Надёжна ли модель (хватило ли данных при обучении). */
  get reliable(): boolean {
    return this.params.meta.reliable;
  }

  /** Доверие к модели 0..1. */
  get confidence(): number {
    return this.params.meta.confidence;
  }

  /**
   * Эффективное число испытаний с family-wise поправкой на цепочку fit (мета-curse).
   * Если fit гнали многократно — это Σ конфигов по всем попыткам, а не текущий грид.
   */
  get effectiveTrials(): number {
    return this.params.meta.effectiveTrials;
  }

  /** Число конфигов в гриде текущего fit (внутренние испытания). */
  get innerTrials(): number {
    return this.params.meta.innerTrials;
  }

  /** Сколько раз всего запускался fit (прозрачность мета-перебора). */
  get fitAttempts(): number {
    return this.params.meta.fitAttempts;
  }

  /**
   * Диагностика фазы разметки: { candidates, outcomes, errors }. Если модель пустая
   * (totalSamples=0), причина в outcomes по LabelOutcome: "adapter-error" (getCandles
   * бросает), "no-candles" (вернул пусто — символ/диапазон), "no-entry" (свечи есть,
   * входов в зону нет), "ok" (размечено). errors — уникальные тексты исключений
   * getCandles со счётчиком (чтобы adapter-error не был немым).
   */
  get labeling() {
    return this.params.meta.labeling;
  }

  /**
   * Статистический сертификат: прошёл ли эдж пять барьеров (DSR ≥ 0.95, PBO ≤ 0.10,
   * SPA p ≤ 0.05, N ≥ minTRL, nested OOS > 0). certified=false с reasons, если эдж
   * не доказан — тогда модель торговать НЕ должна.
   */
  get certification(): Certification {
    return this.params.meta.certification;
  }

  /**
   * Аудит автокалибровки casual-режима: измеренный шум 1m-свечей, доступное
   * форвард-покрытие, и какие оси грида были выведены из данных (с объяснением).
   * null = fit шёл с явным grid (калибровка не запускалась) или модель из load()
   * старого формата.
   */
  get calibration(): Calibration | null {
    return this.params.meta.calibration ?? null;
  }

  /** Эмпирический импакт-горизонт поста в минутах (global-уровень). */
  get impactHorizonMinutes(): number {
    return this.params.meta.impactHorizonMinutes;
  }

  /**
   * Сколько минут истории СВЕЧЕЙ ДО сигнала нужно live-вызову plan() для каждого
   * сигнала: max(volBaselineWindow, cascadeWindowMinutes) + запас 5 свечей. Столько
   * 1m-свечей plan() запрашивает у getCandles (строго в прошлое, без look-ahead).
   * В проде держи доступной историю минимум на это окно для каждого свежего сигнала.
   */
  get lookbackMinutes(): number {
    const baseWin = this.params.exit.global.volBaselineWindow ?? 20;
    // фолбэк тот же, что в buildSignalCore (horizon = cascadeWindowMinutes ?? staleMinutes):
    // раньше здесь стояло «?? 30», и для моделей без cascadeWindowMinutes live-plan
    // качал 35 свечей, а каскад считался по окну staleMinutes — молча на урезанной ленте.
    const casWin = this.params.exit.global.cascadeWindowMinutes ?? this.params.exit.global.staleMinutes;
    return Math.max(baseWin, casWin) + 5;
  }

  /**
   * Минимальное число НЕЗАВИСИМЫХ кластеров авторства, которые должны сойтись на
   * тикере, чтобы matrix-всплеск считался сигналом. Из config (по умолчанию 2).
   * В single-режиме не применяется (там всегда 1 кластер).
   */
  get minClusters(): number {
    return this.params.config.minClusters;
  }

  /**
   * Минимальное число ОБЩИХ событий между каналами, при котором author-матрица
   * считается жизнеспособной (не шумовое совпадение) — порог перекрытия для
   * auto-режима. Из config.viability (по умолчанию DEFAULT_VIABILITY.minSharedEvents).
   * Грубо: сколько раз кластеры должны совпасть, чтобы их связь была не случайной.
   */
  get minSharedEvents(): number {
    return this.params.config.viability?.minSharedEvents ?? DEFAULT_VIABILITY.minSharedEvents;
  }

  /** Режим, которым обучена модель: matrix (корреляция) | single (fallback). */
  get mode(): "matrix" | "single" {
    return this.params.meta.mode;
  }

  /** Честная диагностика: ПОЧЕМУ выбран этот режим (auto-критерий или явный выбор). */
  get modeReason(): string {
    return this.params.meta.modeReason ?? "(не записано)";
  }

  /**
   * Risk-reward по бэктесту: per-symbol + global. Главный исследовательский выход.
   * RR = pnl/hardStop в единицах риска (сколько R снято). bySymbol используется
   * runtime-фильтром minRiskReward.
   */
  get riskReward(): { bySymbol: Record<string, RiskRewardStats>; global: RiskRewardStats } {
    return this.params.riskReward;
  }

  /**
   * Устойчивая к выбросам статистика реализованного PnL: median + перцентили
   * (p5/p95/p99) per-symbol и global. median/перцентили показывают выигрыш
   * системы без искажения единичной плохой или жирной сделкой.
   */
  get pnl(): { bySymbol: Record<string, PnlStats>; global: PnlStats } {
    return this.params.pnl;
  }

  /**
   * Главный prod-вызов БЕЗ свечей. Возвращает ТОЛЬКО исполняемые сигналы — veto
   * уже отфильтрован. Без свечей каскад не оценивается → все исходы "enter".
   * Второй аргумент — allow-список, сужающий разрешённые исходы (не шире обученной).
   */
  signals(items: ParserItem[], policy?: Partial<SignalPolicy>): TradeSignal[] {
    return this.collect(items, () => null, policy);
  }

  /**
   * LIVE-решение об открытии позиции — БЕЗ look-ahead. Возвращает только
   * исполняемые сигналы (veto/инверс-запрет отфильтрованы). Использует свечи
   * СТРОГО ДО сигнала: volZ-режим по базлайну до входа и каскад-давление по
   * прошлым свечам (squeezePressureBefore). НИКОГДА не тянет свечи из будущего —
   * в live их не существует. Это решение «входить ли сейчас и с какими exit».
   *
   * Источник свечей:
   *  1) getCandles — та же, что в fit(): подгружает историю ДО сигнала. Async.
   *     Бросок по символу (дыра в данных) → сигнал без свечей (как signals()),
   *     не роняя весь вызов.
   *  2) candlesBySymbol — словарь предзагруженной истории ДО сигнала. Sync.
   *
   * Для бэктеста (replay вперёд + реализованный pnl) используй backtest().
   */
  plan(items: ParserItem[], getCandles: GetCandles, policy?: Partial<SignalPolicy>): Promise<TradeSignal[]>;
  plan(items: ParserItem[], candlesBySymbol: Record<string, ICandleData[]>, policy?: Partial<SignalPolicy>): TradeSignal[];
  plan(
    items: ParserItem[],
    source: GetCandles | Record<string, ICandleData[]>,
    policy?: Partial<SignalPolicy>,
  ): TradeSignal[] | Promise<TradeSignal[]> {
    if (typeof source === "function") {
      return this.planLiveViaGetCandles(items, source, policy);
    }
    const eff = intersectPolicy(this.params.policy, policy);
    const out: TradeSignal[] = [];
    for (const v of this._predict(items).signals) {
      const s = this.buildSignalLive(v, source[v.symbol] ?? null, eff);
      if (s) out.push(s);
    }
    return out;
  }

  private async planLiveViaGetCandles(
    items: ParserItem[],
    getCandles: GetCandles,
    policy?: Partial<SignalPolicy>,
  ): Promise<TradeSignal[]> {
    const eff = intersectPolicy(this.params.policy, policy);
    // окно ДО сигнала (единый источник — геттер lookbackMinutes): базлайн объёма +
    // горизонт каскада, всё в прошлом, без forward. Momentum-фильтр требует своё
    // окно (по умолчанию 24ч) — расширяем lookback, иначе гейту нечего мерить.
    const momWin = eff.minMomentum24hPct !== undefined
      ? (eff.momentumWindowMinutes ?? 1440) + 5 : 0;
    const lookback = Math.max(this.lookbackMinutes, momWin);
    const out: TradeSignal[] = [];
    for (const v of this._predict(items).signals) {
      let candles: ICandleData[] | null = null;
      try {
        // тянем lookback свечей, заканчивающихся НА сигнальной минуте (не позже).
        // since = entryStartTs - lookback·step: окно строго ДО входа.
        const step = STEP_MS["1m"];
        const start = entryStartTs(v.ts, "1m");
        const since = start - lookback * step;
        candles = await fetchCandlesChunked(getCandles, v.symbol, "1m", lookback, since);
        if (!candles.length) candles = null;
      } catch {
        candles = null; // битый символ → сигнал без свечей, не рушим весь вызов
      }
      const s = this.buildSignalLive(v, candles, eff);
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * БЭКТЕСТ — replay вперёд по истории + реализованный pnl/каскад. Тянет свечи
   * ПОСЛЕ сигнала (life-cap горизонт), прогоняет полный replay. ТОЛЬКО для анализа
   * завершённого прошлого: в live свечей вперёд нет. Look-ahead отсутствует, т.к.
   * мы в настоящем смотрим на уже закрытые свечи прошлого.
   *
   * Источник свечей — getCandles (async) или словарь {symbol: candles} (sync).
   */
  backtest(items: ParserItem[], getCandles: GetCandles, policy?: Partial<SignalPolicy>): Promise<BacktestSignal[]>;
  backtest(items: ParserItem[], candlesBySymbol: Record<string, ICandleData[]>, policy?: Partial<SignalPolicy>): BacktestSignal[];
  backtest(
    items: ParserItem[],
    source: GetCandles | Record<string, ICandleData[]>,
    policy?: Partial<SignalPolicy>,
  ): BacktestSignal[] | Promise<BacktestSignal[]> {
    if (typeof source === "function") {
      return this.backtestViaGetCandles(items, source, policy);
    }
    const eff = intersectPolicy(this.params.policy, policy);
    const out: BacktestSignal[] = [];
    for (const v of this._predict(items).signals) {
      // зона входа уже в вердикте (протянута из parser-item) → buildSignal её прокинет
      const s = this.buildSignal(v, source[v.symbol] ?? null, eff);
      if (s) out.push(s);
    }
    return out;
  }

  private async backtestViaGetCandles(
    items: ParserItem[],
    getCandles: GetCandles,
    policy?: Partial<SignalPolicy>,
  ): Promise<BacktestSignal[]> {
    const eff = intersectPolicy(this.params.policy, policy);
    const maxLife = this.params.exit.global.staleMinutes;
    // momentum-фильтр меряется по свечам ДО сигнала — тянем окно и в бэктесте.
    // replay при этом всё равно стартует от сигнала (replayResult срезает прошлое).
    const momWin = eff.minMomentum24hPct !== undefined
      ? (eff.momentumWindowMinutes ?? 1440) : 0;
    const limit = maxLife * 2 + 5 + momWin;
    const step = STEP_MS["1m"];
    const out: BacktestSignal[] = [];
    for (const v of this._predict(items).signals) {
      let candles: ICandleData[] | null = null;
      try {
        const since = entryStartTs(v.ts, "1m") - momWin * step;
        candles = await fetchCandlesChunked(getCandles, v.symbol, "1m", limit, since);
        if (!candles.length) candles = null;
      } catch {
        candles = null;
      }
      const s = this.buildSignal(v, candles, eff);
      if (s) out.push(s);
    }
    return out;
  }

  /** Точечно под ОДНУ позицию в LIVE (вход = последняя свеча, каскад по прошлому). */
  planFor(
    symbol: string,
    direction: Direction,
    channel: string | null,
    candles: ICandleData[],
    policy?: Partial<SignalPolicy>,
  ): TradeSignal | null {
    const entryTs = candles[candles.length - 1]?.timestamp ?? 0;
    const v: PumpVerdict = {
      symbol, direction, action: "open", ts: entryTs,
      independentClusters: 1, totalChannels: 1, confidence: 0.5,
      reason: "planFor", source: this.params.meta.mode, channel,
    };
    const eff = intersectPolicy(this.params.policy, policy);
    return this.buildSignalLive(v, candles, eff);
  }

  /**
   * Бэктест под ОДНУ позицию с явным entryTs (replay вперёд, каскад по будущему).
   * Возвращает BacktestSignal с реализованным result. Зона входа не задаётся —
   * replay берёт точку = open первой свечи (как при отсутствии зоны в обучении).
   */
  planForAt(
    symbol: string,
    direction: Direction,
    channel: string | null,
    candles: ICandleData[],
    entryTs: number,
    policy?: Partial<SignalPolicy>,
  ): BacktestSignal | null {
    const v: PumpVerdict = {
      symbol, direction, action: "open", ts: entryTs,
      independentClusters: 1, totalChannels: 1, confidence: 0.5,
      reason: "planFor", source: this.params.meta.mode, channel,
    };
    const eff = intersectPolicy(this.params.policy, policy);
    return this.buildSignal(v, candles, eff);
  }

  /** Полный отчёт (все вердикты + карта авторства) — для разбора. */
  explain(items: ParserItem[]) {
    return this._predict(items);
  }

  // ── общий сборщик: predict → buildSignal → отсев null (veto/не разрешено) ──
  // signals() — без свечей. Используем LIVE-сборку: каскад не оценивается (нет свечей),
  // и result не доклеивается — signals() отдаёт чистый TradeSignal, не BacktestSignal.
  private collect(
    items: ParserItem[],
    candlesOf: (v: PumpVerdict) => ICandleData[] | null,
    policy?: Partial<SignalPolicy>,
  ): TradeSignal[] {
    const eff = intersectPolicy(this.params.policy, policy);
    const out: TradeSignal[] = [];
    for (const v of this._predict(items).signals) {
      const s = this.buildSignalLive(v, candlesOf(v), eff);
      if (s) out.push(s); // null = veto или исход не в allow → не отдаём
    }
    return out;
  }

  private flatExit(ex: {
    trailingTake: number; hardStop: number; staleMinutes: number;
    stalenessSinceProfit: number; stalenessSinceMinutes: number;
  }): ExitPlan {
    return {
      trailingTake: ex.trailingTake,
      hardStop: ex.hardStop,
      impactHorizonMinutes: ex.staleMinutes,
      stalenessSinceProfit: ex.stalenessSinceProfit,
      stalenessSinceMinutes: ex.stalenessSinceMinutes,
    };
  }

  /**
   * BACKTEST-сборка сигнала: каскад по свечам ПОСЛЕ входа (forward squeezePressure),
   * допустимо только на истории. Возвращает BacktestSignal с реализованным result
   * (replay exit-плана вперёд) — главное отличие backtest от plan. entryFrom/entryTo
   * — зона входа для replay (из parser-item); без свечей result.entered=false.
   */
  private buildSignal(
    v: PumpVerdict,
    candles: ICandleData[] | null,
    policy: SignalPolicy,
  ): BacktestSignal | null {
    const sig = this.buildSignalCore(v, candles, policy, "backtest");
    if (!sig) return null;
    return { ...sig, result: this.replayResult(sig, candles) };
  }

  /**
   * LIVE-сборка сигнала: каскад по свечам ДО входа (backward squeezePressureBefore),
   * БЕЗ look-ahead. Делегирует в общее ядро с mode="live".
   */
  private buildSignalLive(
    v: PumpVerdict,
    candles: ICandleData[] | null,
    policy: SignalPolicy,
  ): TradeSignal | null {
    return this.buildSignalCore(v, candles, policy, "live");
  }

  /**
   * Реализованный результат для backtest: replay ИТОГОВОГО (с учётом инверсии)
   * направления и exit-плана сигнала по свечам после входа. Зона входа из parser-item;
   * если не задана — точка = open первой свечи (как в обучении). Нет свечей → не вошли.
   */
  private replayResult(
    sig: TradeSignal,
    candles: ICandleData[] | null,
  ): BacktestResult {
    if (!candles || candles.length === 0) {
      return { entered: false, pnl: 0, peak: 0, reason: "no-candles", heldMinutes: 0, entryPrice: 0, exitPrice: 0, truncated: false };
    }
    // replay ТОЛЬКО от сигнала вперёд: словарь/planForAt может нести историю ДО
    // сигнала (она нужна volZ/каскаду), но вход в позицию не может случиться в
    // прошлом — иначе реплей «входил» на свечах до сигнала и pnl считался по
    // чужому пути. Срез с первой полностью сформированной свечи после сигнала.
    const startTs = entryStartTs(sig.ts, "1m");
    const fromIdx = candles.findIndex((c) => c.timestamp >= startTs);
    if (fromIdx < 0) {
      return { entered: false, pnl: 0, peak: 0, reason: "no-candles", heldMinutes: 0, entryPrice: 0, exitPrice: 0, truncated: false };
    }
    const fwd = fromIdx === 0 ? candles : candles.slice(fromIdx);
    // зона входа теперь в самом сигнале (протянута из parser-item); нет → open первой свечи.
    const from = sig.entryFromPrice ?? fwd[0].open;
    const to = sig.entryToPrice ?? fwd[0].open;
    const r = replayExit(fwd, sig.direction, from, to, {
      trailingTake: sig.exit.trailingTake,
      hardStop: sig.exit.hardStop,
      stalenessSinceProfit: sig.exit.stalenessSinceProfit,
      stalenessSinceMinutes: sig.exit.stalenessSinceMinutes,
      staleMinutes: sig.exit.impactHorizonMinutes,
    });
    return {
      entered: r.entered, pnl: r.pnl, peak: r.peak, reason: r.reason,
      heldMinutes: r.heldMinutes, entryPrice: r.entryPrice, exitPrice: r.exitPrice,
      truncated: r.truncated,
    };
  }

  /**
   * Строит ЕДИНЫЙ TradeSignal из вердикта. Возвращает null, если исполнять нечего:
   * каскад дал veto ИЛИ получившийся action не в allow-списке. Инверсия здесь же
   * разворачивает direction и тянет exit из инверс-ячейки — наружу уходит готовое
   * направление, без флагов.
   *
   * mode="live": каскад меряется по свечам ДО входа (squeezePressureBefore) — в live
   *   свечей после входа нет, look-ahead запрещён.
   * mode="backtest": каскад по свечам ПОСЛЕ входа (squeezePressure) — допустимо на
   *   завершённой истории.
   */
  private buildSignalCore(
    v: PumpVerdict,
    candles: ICandleData[] | null,
    policy: SignalPolicy,
    mode: "live" | "backtest",
  ): TradeSignal | null {
    const ch = v.channel ?? "_matrix";
    const allow = new Set(policy.allow);

    // ── АВТО-ТРИАЖ КАНАЛА (channelPlan из fit): drop/invert без участия оператора ──
    // "drop": канал значимо убыточен — сигнал не отдаётся. "invert": механический
    // анти-предиктивный канал (стоп-хант бот) — направление разворачивается ЗДЕСЬ,
    // до резолва exit и гейтов: все downstream-проверки (momentum, каскад, тензор)
    // работают с направлением, которое мы РЕАЛЬНО торгуем. Matrix (channel=null)
    // план не затрагивает.
    let dir = v.direction!;
    let planInverted: Direction | null = null;
    if (v.channel !== null) {
      const plan = this.params.channelPlan?.[v.channel];
      if (plan === "drop") return null;
      if (plan === "invert") {
        if (!allow.has("invert")) return null; // инверсия запрещена → как veto
        planInverted = dir;
        dir = dir === "long" ? "short" : "long";
      }
    }

    // ── readonly RR-фильтр: режем символы с backtest-RR ниже порога ──
    if (policy.minRiskReward !== undefined) {
      const rr = this.params.riskReward?.bySymbol?.[v.symbol];
      // rrMetric гарантированно задан intersectPolicy (там ?? "mean"), здесь не дефолтим
      const metric = policy.rrMetric!;
      // нет статистики по символу → нечем подтвердить RR → режем (консервативно)
      if (!rr || rr[metric] < policy.minRiskReward) return null;
    }

    // ── фильтр КАЧЕСТВА АВТОРА: single-каналы ниже порога скора режутся ──
    // matrix-сигнал межканальный (channel=null) — его качество уже подтверждено
    // независимостью кластеров, фильтр не применяется. Канал без статистики —
    // консервативно режем (нечем подтвердить).
    if (policy.minChannelScore !== undefined && v.channel !== null) {
      const cs = this.params.channelScore?.[v.channel];
      if (!cs || cs.score < policy.minChannelScore) return null;
    }

    let volRegime: VolRegime | null = null;

    const probe = resolveExit(this.params.exit, v.source, ch, v.symbol, dir, "calm");
    const volZThr = probe.exit.volZThreshold ?? 2.0;
    const baseWin = probe.exit.volBaselineWindow ?? 20;
    const horizon = probe.exit.cascadeWindowMinutes ?? probe.exit.staleMinutes;

    let sqPressure: number | null = null;
    let liquidityQuote: number | null = null;
    if (candles && candles.length > 0) {
      // первая свеча, ОТКРЫВШАЯСЯ не раньше сигнальной минуты (без look-ahead в
      // формирующуюся свечу сигнала). entryStartTs гарантирует полностью сформированную.
      const startTs = entryStartTs(v.ts, "1m");
      let entryIdx = candles.findIndex((c) => c.timestamp >= startTs);
      if (entryIdx < 0) entryIdx = candles.length - 1;
      const volZ = volumeZScore(candles, entryIdx, baseWin);
      // КАСКАД: live — по прошлым свечам (без look-ahead), backtest — по будущим.
      sqPressure = mode === "live"
        ? squeezePressureBefore(candles, entryIdx, dir, horizon)
        : squeezePressure(candles, entryIdx, dir, horizon);
      volRegime = volRegimeOf(volZ, volZThr);
      // advisory-ёмкость: медианный минутный оборот до сигнала (котируемая валюта).
      // Прод сравнивает со своим размером сам — фильтровать за него нельзя (не знаем ордер).
      const pre = candles.slice(Math.max(0, entryIdx - 60), entryIdx);
      if (pre.length >= 5) {
        const vols = pre.map((c) => c.volume).sort((a, b) => a - b);
        const medVol = vols[Math.floor(vols.length / 2)];
        liquidityQuote = +(medVol * pre[pre.length - 1].close).toFixed(2);
      }
    }

    // ── ФИЛЬТР ЁМКОСТИ: сверка твоего размера с минутным оборотом — внутри ──
    // Ордер, сопоставимый с минутным оборотом, сам двигает цену: эджа на таком
    // размере нет. Раньше сравнение оставалось оператору («смотри liquidityQuote»);
    // теперь policy.notionalQuote решает автоматически. Нет свечей/оборота →
    // подтвердить ёмкость нечем → режем консервативно.
    if (policy.notionalQuote !== undefined) {
      const share = policy.maxLiquidityShare ?? 0.1;
      if (liquidityQuote === null || policy.notionalQuote > share * liquidityQuote) return null;
    }

    // ── ПОДТВЕРЖДЕНИЕ РЫНКОМ: пост без аномального объёма на ленте — не памп ──
    // Реальному пампу предшествует набор позиции автором → всплеск объёма ДО поста.
    // calm-лента = пост без рыночной реакции = шум. Нет свечей → подтвердить нечем →
    // режем консервативно (signals() без свечей с этим флагом всегда пуст — см. policy).
    if (policy.requireVolumeConfirm && volRegime !== "anomalous") return null;

    // ── MOMENTUM-ФИЛЬТР (эдж из habr 1041898): цена уже двигалась не против ──
    // сигнала ДО публикации (приток реального капитала). Momentum считается по
    // свечам СТРОГО до сигнальной минуты — без look-ahead. Нет свечей/окна →
    // подтвердить нечем → режем консервативно.
    if (policy.minMomentum24hPct !== undefined) {
      if (!candles || candles.length === 0) return null;
      const startTs = entryStartTs(v.ts, "1m");
      let preEnd = candles.findIndex((c) => c.timestamp >= startTs);
      if (preEnd < 0) preEnd = candles.length; // вся серия до сигнала
      const m = momentumPct(candles, preEnd, policy.momentumWindowMinutes ?? 1440);
      if (m === null) return null;
      const directional = dir === "long" ? m : -m;
      if (directional < policy.minMomentum24hPct) return null;
    }

    let resolved = volRegime
      ? resolveExit(this.params.exit, v.source, ch, v.symbol, dir, volRegime)
      : resolveExitNoRegime(this.params.exit, v.source, v.symbol, dir);
    let exit = resolved.exit;

    // ── решение по каскаду → action + (возможно) разворот direction ──
    // channelPlan-инверсия уже применена к dir выше: action стартует с "invert",
    // invertedFrom несёт исходное направление ПОСТА (что говорил канал).
    let action: SignalAction = planInverted ? "invert" : "enter";
    let finalDir = dir;
    let invertedFrom: Direction | null = planInverted;
    let tightenFired = false;

    const fires = sqPressure !== null && sqPressure >= (exit.squeezeThreshold ?? 0.6);
    if (fires) {
      const pol = exit.squeezePolicy;
      if (pol === "veto") {
        return null; // каскад — НЕ входить. veto не попадает в выдачу.
      }
      if (pol === "invert" && !planInverted) {
        // канальная инверсия ГЛАВНЕЕ: двойной разворот (план + каскад) вернул бы
        // направление поста, чью анти-предиктивность триаж уже доказал — не делаем.
        if (!allow.has("invert")) return null; // инверсия запрещена → защищаемся как veto
        action = "invert";
        finalDir = dir === "long" ? "short" : "long";
        invertedFrom = dir;
        // fires=true ⇒ были свечи ⇒ volRegime гарантированно посчитан (calm|anomalous),
        // поэтому здесь всегда cell-резолв по режиму — без noRegime-ветки.
        resolved = resolveExit(this.params.exit, v.source, ch, v.symbol, finalDir, volRegime!);
        exit = resolved.exit;
      } else if (pol === "tighten") {
        if (!allow.has("tighten")) return null;
        // при канальной инверсии маркер "invert" важнее: ужатие применяем к плану,
        // но action не затираем (origin.invertedFrom + ужатый trailing в exit)
        if (!planInverted) action = "tighten";
        tightenFired = true;
      }
      // pol === "ignore": каскад замечен, но НАМЕРЕННО игнорируется — входим в
      // исходном направлении (action остаётся "enter"). В отличие от veto/invert
      // сигнал НЕ отсекается; реализуется реальный (обычно плохой) pnl. Это даёт
      // контрфакт «что если не реагировать на каскад» прямо в выдаче, а не только
      // в стороннем анализе. pol === "none" ведёт себя так же (вход без реакции).
    }

    if (action === "enter" && !allow.has("enter")) return null;

    const plan = this.flatExit(exit);
    if (tightenFired) {
      plan.trailingTake = +(exit.trailingTake * (exit.tightenFactor ?? 0.5)).toFixed(6);
    }

    const origin: SignalOrigin = {
      detector: v.source,
      channel: v.channel,
      invertedFrom,
      exitSource: resolved.source,
      volRegime,
      confidence: v.confidence,
      independentClusters: v.independentClusters,
      modelConfidence: this.params.meta.confidence,
      modelReliable: this.params.meta.reliable,
      id: v.id,
      ids: v.ids,
      liquidityQuote,
    };

    return {
      symbol: v.symbol, direction: finalDir, action, ts: v.ts,
      entryFromPrice: v.entryFromPrice, entryToPrice: v.entryToPrice,
      exit: plan, origin,
    };
  }
}

export type { TradeSignal, BacktestSignal, BacktestResult, SignalAction, SignalOrigin, ExitPlan, SignalPolicy } from "./signal";
