import { ParserItem, PumpVerdict, Direction } from "./types";
import { GetCandles, ICandleData, alignTs } from "./candle";
import { fetchCandlesChunked } from "./chunked-candles";
import { resolveExit, resolveExitNoRegime, ExitTensor } from "./exit-tensor";
import { volumeZScore, squeezePressure, volRegimeOf, VolRegime } from "./volume";
import { RiskRewardStats, PnlStats } from "./objective";
import {
  TradeSignal, SignalAction, SignalPolicy, ExitPlan, SignalOrigin,
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
  ) {}

  /** Обучить модель на истории сигналов. */
  static async fit(
    history: ParserItem[],
    getCandles: GetCandles,
    opts?: TrainOptions,
  ): Promise<PumpMatrix> {
    const res = await train(history, getCandles, opts);
    return new PumpMatrix(res.params, res.predict);
  }

  /** Восстановить модель из сохранённого JSON (в проде, без обучения). */
  static load(json: string | TrainedParams): PumpMatrix {
    const params: TrainedParams = typeof json === "string" ? JSON.parse(json) : json;
    if (!params.policy) params.policy = DEFAULT_POLICY; // обратная совместимость
    if (!params.riskReward) params.riskReward = { bySymbol: {}, global: { mean: 0, p95: 0, p99: 0, n: 0 } };
    if (!params.pnl) params.pnl = { bySymbol: {}, global: { mean: 0, median: 0, p5: 0, p95: 0, p99: 0, n: 0 } };
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
    return { allow: [...this.params.policy.allow] };
  }

  /** Надёжна ли модель (хватило ли данных при обучении). */
  get reliable(): boolean {
    return this.params.meta.reliable;
  }

  /** Доверие к модели 0..1. */
  get confidence(): number {
    return this.params.meta.confidence;
  }

  /** Эмпирический импакт-горизонт поста в минутах (global-уровень). */
  get impactHorizonMinutes(): number {
    return this.params.meta.impactHorizonMinutes;
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
   * Prod-вызов СО свечами: volRegime, cell-exit, детекция каскада. Возвращает
   * только исполняемые сигналы (veto отфильтрован). Нет свечей для символа → как
   * signals() для него.
   *
   * Источник свечей задаётся ОДНИМ из двух способов (перегрузка):
   *  1) getCandles — ТА ЖЕ функция, что и в fit(): свечи подгружаются лениво по
   *     каждому символу (вокруг его ts). Async → Promise. Канонический live-путь:
   *     один источник свечей и в обучении, и в исполнении, без ручного словаря.
   *     Если getCandles бросает по символу (дыра в данных) — сигнал отдаётся без
   *     свечей (как signals()), а не роняет весь вызов.
   *  2) candlesBySymbol — словарь {symbol: candles[]}, когда свечи УЖЕ в памяти
   *     (бэктест, переиспользование набора). Sync → массив.
   */
  plan(items: ParserItem[], getCandles: GetCandles, policy?: Partial<SignalPolicy>): Promise<TradeSignal[]>;
  plan(items: ParserItem[], candlesBySymbol: Record<string, ICandleData[]>, policy?: Partial<SignalPolicy>): TradeSignal[];
  plan(
    items: ParserItem[],
    source: GetCandles | Record<string, ICandleData[]>,
    policy?: Partial<SignalPolicy>,
  ): TradeSignal[] | Promise<TradeSignal[]> {
    if (typeof source === "function") {
      return this.planViaGetCandles(items, source, policy);
    }
    return this.collect(items, (v) => source[v.symbol] ?? null, policy);
  }

  private async planViaGetCandles(
    items: ParserItem[],
    getCandles: GetCandles,
    policy?: Partial<SignalPolicy>,
  ): Promise<TradeSignal[]> {
    const eff = intersectPolicy(this.params.policy, policy);
    // горизонт свечей: запас на life-cap (как в разметке при обучении)
    const maxLife = this.params.exit.global.staleMinutes;
    const limit = maxLife * 2 + 5;
    const out: TradeSignal[] = [];
    for (const v of this._predict(items).signals) {
      let candles: ICandleData[] | null = null;
      try {
        const since = alignTs(v.ts, "1m");
        candles = await fetchCandlesChunked(getCandles, v.symbol, "1m", limit, since);
        if (!candles.length) candles = null;
      } catch {
        candles = null; // битый символ → сигнал без свечей, не рушим весь вызов
      }
      const s = this.buildSignal(v, candles, eff);
      if (s) out.push(s);
    }
    return out;
  }

  /** Точечно под ОДНУ позицию (live: вход = последняя свеча). null при veto. */
  planFor(
    symbol: string,
    direction: Direction,
    channel: string | null,
    candles: ICandleData[],
    policy?: Partial<SignalPolicy>,
  ): TradeSignal | null {
    const entryTs = candles[candles.length - 1]?.timestamp ?? 0;
    return this.planForAt(symbol, direction, channel, candles, entryTs, policy);
  }

  /** Как planFor, но с явным entryTs (бэктест). null при veto. */
  planForAt(
    symbol: string,
    direction: Direction,
    channel: string | null,
    candles: ICandleData[],
    entryTs: number,
    policy?: Partial<SignalPolicy>,
  ): TradeSignal | null {
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
  private collect(
    items: ParserItem[],
    candlesOf: (v: PumpVerdict) => ICandleData[] | null,
    policy?: Partial<SignalPolicy>,
  ): TradeSignal[] {
    const eff = intersectPolicy(this.params.policy, policy);
    const out: TradeSignal[] = [];
    for (const v of this._predict(items).signals) {
      const s = this.buildSignal(v, candlesOf(v), eff);
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
   * Строит ЕДИНЫЙ TradeSignal из вердикта. Возвращает null, если исполнять нечего:
   * каскад дал veto ИЛИ получившийся action не в allow-списке. Инверсия здесь же
   * разворачивает direction и тянет exit из инверс-ячейки — наружу уходит готовое
   * направление, без флагов.
   */
  private buildSignal(
    v: PumpVerdict,
    candles: ICandleData[] | null,
    policy: SignalPolicy,
  ): TradeSignal | null {
    const ch = v.channel ?? "_matrix";
    const dir = v.direction!;
    const allow = new Set(policy.allow);

    // ── readonly RR-фильтр: режем символы с backtest-RR ниже порога ──
    if (policy.minRiskReward !== undefined) {
      const rr = this.params.riskReward?.bySymbol?.[v.symbol];
      // rrMetric гарантированно задан intersectPolicy (там ?? "mean"), здесь не дефолтим
      const metric = policy.rrMetric!;
      // нет статистики по символу → нечем подтвердить RR → режем (консервативно)
      if (!rr || rr[metric] < policy.minRiskReward) return null;
    }

    let volRegime: VolRegime | null = null;

    const probe = resolveExit(this.params.exit, v.source, ch, v.symbol, dir, "calm");
    const volZThr = probe.exit.volZThreshold ?? 2.0;
    const baseWin = probe.exit.volBaselineWindow ?? 20;
    const horizon = probe.exit.cascadeWindowMinutes ?? probe.exit.staleMinutes;

    let sqPressure: number | null = null;
    if (candles && candles.length > 0) {
      let entryIdx = candles.findIndex((c) => c.timestamp >= v.ts);
      if (entryIdx < 0) entryIdx = candles.length - 1;
      const volZ = volumeZScore(candles, entryIdx, baseWin);
      sqPressure = squeezePressure(candles, entryIdx, dir, horizon);
      volRegime = volRegimeOf(volZ, volZThr);
    }

    let resolved = volRegime
      ? resolveExit(this.params.exit, v.source, ch, v.symbol, dir, volRegime)
      : resolveExitNoRegime(this.params.exit, v.source, v.symbol, dir);
    let exit = resolved.exit;

    // ── решение по каскаду → action + (возможно) разворот direction ──
    let action: SignalAction = "enter";
    let finalDir = dir;
    let invertedFrom: Direction | null = null;

    const fires = sqPressure !== null && sqPressure >= (exit.squeezeThreshold ?? 0.6);
    if (fires) {
      const pol = exit.squeezePolicy;
      if (pol === "veto") {
        return null; // каскад — НЕ входить. veto не попадает в выдачу.
      }
      if (pol === "invert") {
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
        action = "tighten";
      }
      // pol === "ignore": каскад замечен, но НАМЕРЕННО игнорируется — входим в
      // исходном направлении (action остаётся "enter"). В отличие от veto/invert
      // сигнал НЕ отсекается; реализуется реальный (обычно плохой) pnl. Это даёт
      // контрфакт «что если не реагировать на каскад» прямо в выдаче, а не только
      // в стороннем анализе. pol === "none" ведёт себя так же (вход без реакции).
    }

    if (action === "enter" && !allow.has("enter")) return null;

    const plan = this.flatExit(exit);
    if (action === "tighten") {
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
    };

    return { symbol: v.symbol, direction: finalDir, action, ts: v.ts, exit: plan, origin };
  }
}

export type { TradeSignal, SignalAction, SignalOrigin, ExitPlan, SignalPolicy } from "./signal";
