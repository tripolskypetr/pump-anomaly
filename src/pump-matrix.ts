import { ParserItem, PumpVerdict, Direction } from "./types";
import { GetCandles, ICandleData } from "./candle";
import { resolveExit, resolveExitNoRegime, ExitTensor } from "./exit-tensor";
import { volumeZScore, squeezePressure, volRegimeOf, VolRegime } from "./volume";
import {
  TradeSignal, SignalAction, SignalPolicy, ExitPlan, SignalOrigin,
  intersectPolicy, DEFAULT_POLICY,
} from "./signal";
import {
  train,
  loadPredict,
  TrainedParams,
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
    return new PumpMatrix(params, loadPredict(params));
  }

  /** Сериализовать модель в JSON-строку (включая policy). */
  save(): string {
    return JSON.stringify(this.params);
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

  /**
   * Главный prod-вызов БЕЗ свечей. Возвращает ТОЛЬКО исполняемые сигналы — veto
   * уже отфильтрован. Без свечей каскад не оценивается → все исходы "enter".
   * Второй аргумент — allow-список, сужающий разрешённые исходы (не шире обученной).
   */
  signals(items: ParserItem[], policy?: Partial<SignalPolicy>): TradeSignal[] {
    return this.collect(items, () => null, policy);
  }

  /**
   * Prod-вызов СО свечами. volRegime из свечей, cell-exit, детекция каскада.
   * Возвращает только исполняемые сигналы (veto отфильтрован). Нет свечей для
   * символа → как signals() для него.
   */
  plan(
    items: ParserItem[],
    candlesBySymbol: Record<string, ICandleData[]>,
    policy?: Partial<SignalPolicy>,
  ): TradeSignal[] {
    return this.collect(items, (v) => candlesBySymbol[v.symbol] ?? null, policy);
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

    let volRegime: VolRegime | null = null;

    const probe = resolveExit(this.params.exit, v.source, ch, v.symbol, dir, "calm");
    const volZThr = probe.exit.volZThreshold ?? 2.0;
    const baseWin = probe.exit.volBaselineWindow ?? 20;
    const horizon = probe.exit.staleMinutes;

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
        resolved = volRegime
          ? resolveExit(this.params.exit, v.source, ch, v.symbol, finalDir, volRegime)
          : resolveExitNoRegime(this.params.exit, v.source, v.symbol, finalDir);
        exit = resolved.exit;
      } else if (pol === "tighten") {
        if (!allow.has("tighten")) return null;
        action = "tighten";
      }
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
