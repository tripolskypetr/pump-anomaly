import { ParserItem, PumpVerdict, Direction } from "./types";
import { GetCandles, ICandleData } from "./candle";
import { ExitParams } from "./replay";
import { ExitTensor, resolveExit, resolveExitNoRegime, ResolveSource } from "./exit-tensor";
import { volumeZScore, squeezePressure, volRegimeOf, VolRegime } from "./volume";
import {
  train,
  loadPredict,
  TrainedParams,
  TrainOptions,
  TrainResult,
} from "./train";

/**
 * Casual-фасад. Минимум церемоний:
 *
 *   const model = await PumpMatrix.fit(history, getCandles);   // обучить
 *   const json  = model.save();                                // сохранить (string)
 *   ...
 *   const model = PumpMatrix.load(json);                       // в проде, без обучения
 *   const plan  = model.signals(liveItems);                    // что открыть + как выйти
 *
 * Каждый сигнал несёт вход и exit-план, разрешённый по тензору [mode][channel][symbol]
 * — математика выхода разных источников не смешивается.
 */

/** Сигнал к открытию с приложенным prod-планом выхода. */
export interface TradePlan {
  symbol: string;
  /** направление к ИСПОЛНЕНИЮ (при инверсии — уже развёрнутое против поста) */
  direction: "long" | "short";
  /** исходное направление поста (отличается от direction при инверсии) */
  originalDirection: "long" | "short";
  /** была ли позиция инвертирована детектором каскада */
  inverted: boolean;
  /** канал-источник (single) или null (matrix, межканальный) */
  channel: string | null;
  ts: number;
  confidence: number;            // острота всплеска (из predict)
  independentClusters: number;
  /** trailing take %, откат от пика PnL */
  trailingTake: number;
  /** hard stop %, фикса от входа (moonbag для long / gravebag для short) */
  hardStop: number;
  /** через сколько минут пост теряет импакт (эмпирический потолок жизни) */
  impactHorizonMinutes: number;
  /** пик-протухание: порог прибыли % */
  stalenessSinceProfit: number;
  /** пик-протухание: минут без нового пика */
  stalenessSinceMinutes: number;
  /** политика реакции на каскад ликвидаций: none | tighten | veto | invert */
  squeezePolicy: "none" | "tighten" | "veto" | "invert";
  /** порог squeezePressure для срабатывания policy */
  squeezeThreshold: number;
  /** порог volZ для режима calm/anomalous */
  volZThreshold: number;
  /** с какого уровня тензора разрешён exit */
  exitSource: ResolveSource;
  /** режим объёма на входе (посчитан из свечей, если переданы): calm | anomalous | null */
  volRegime: VolRegime | null;
  /** z-score объёма входной свечи (из свечей) или null */
  volZ: number | null;
  /** доля объёма против позиции (из свечей) или null */
  squeezePressure: number | null;
  /**
   * Итоговая рекомендация с учётом каскада ликвидаций:
   *   "enter"   — входить по плану в direction,
   *   "tighten" — входить, но trailing уже ужат (squeezePolicy=tighten сработал),
   *   "veto"    — НЕ входить (squeezePolicy=veto, обнаружен каскад),
   *   "invert"  — войти ПРОТИВ поста (squeezePolicy=invert): direction уже развёрнут.
   * Каскад оценивается только при наличии свечей (squeezePressure). Без свечей — "enter".
   */
  recommendation: "enter" | "tighten" | "veto" | "invert";
  /** доверие к самой модели на момент обучения (0..1) */
  modelConfidence: number;
  /** надёжна ли модель (хватило ли данных) */
  modelReliable: boolean;
  /** источник сигнала: matrix (корреляция авторов) | single (fallback на пост) */
  source: "matrix" | "single";
}

/** Рантайм-опции исполнения (без переобучения модели). */
export interface RuntimeOptions {
  /**
   * Заглушить инверсию: invert→veto. Полезно временно отключить разворот в проде,
   * не трогая обученные params. По умолчанию false (инверсия активна, если обучена).
   */
  disableInvert?: boolean;
  /**
   * Заглушить ВСЮ реакцию на каскад (veto/tighten/invert) → всегда enter в направлении
   * поста с базовым exit. Жёсткий обход squeeze-логики. По умолчанию false.
   */
  disableSqueeze?: boolean;
}

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
    return new PumpMatrix(params, loadPredict(params));
  }

  /** Сериализовать модель в JSON-строку. */
  save(): string {
    return JSON.stringify(this.params);
  }

  /** Полный exit-tensor (для аудита). */
  get exit(): ExitTensor {
    return this.params.exit;
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
   * Главный prod-вызов БЕЗ свечей: что открывать + как выходить.
   * volRegime неизвестен → exit резолвится на уровне symbol-dir, recommendation="enter".
   * Для точного cell-exit и детекции каскада используй plan() со свечами.
   */
  signals(items: ParserItem[], opts: RuntimeOptions = {}): TradePlan[] {
    return this._predict(items).signals.map((v) => this.buildPlan(v, null, opts));
  }

  /**
   * Prod-вызов СО свечами. На вход — сигналы + словарь свечей по символам
   * (1m, отсортированы по времени, покрывают момент входа). На выход — готовые
   * планы: volRegime посчитан, cell-exit разрешён, каскад оценён, recommendation
   * проставлена. Думать на проде не нужно — берёшь план и исполняешь.
   *
   * candlesBySymbol[symbol] — свечи для этого тикера. Если для символа свечей нет,
   * план строится как в signals() (symbol-dir fallback, recommendation="enter").
   *
   * opts.disableInvert — рантайм-глушитель инверсии без переобучения: invert→veto.
   */
  plan(
    items: ParserItem[],
    candlesBySymbol: Record<string, ICandleData[]>,
    opts: RuntimeOptions = {},
  ): TradePlan[] {
    return this._predict(items).signals.map((v) =>
      this.buildPlan(v, candlesBySymbol[v.symbol] ?? null, opts),
    );
  }

  /**
   * Точечный план под ОДНУ позицию: символ/направление/канал + свечи этого тикера.
   * Возвращает готовый план с cell-exit под фактический volRegime и рекомендацией.
   */
  planFor(
    symbol: string,
    direction: Direction,
    channel: string | null,
    candles: ICandleData[],
    opts: RuntimeOptions = {},
  ): TradePlan {
    // live: вход = последняя свеча окна (текущий бар), история перед ней даёт volZ.
    const entryTs = candles[candles.length - 1]?.timestamp ?? 0;
    return this.planForAt(symbol, direction, channel, candles, entryTs, opts);
  }

  /**
   * Как planFor, но с ЯВНЫМ моментом входа entryTs (для бэктеста: история до,
   * вход на entryTs, форвардные свечи после — squeezePressure считается вперёд).
   */
  planForAt(
    symbol: string,
    direction: Direction,
    channel: string | null,
    candles: ICandleData[],
    entryTs: number,
    opts: RuntimeOptions = {},
  ): TradePlan {
    const v: PumpVerdict = {
      symbol, direction, action: "open", ts: entryTs,
      independentClusters: 1, totalChannels: 1, confidence: 0.5,
      reason: "planFor", source: this.params.meta.mode, channel,
    };
    return this.buildPlan(v, candles, opts);
  }

  /** Полный отчёт (все вердикты + карта авторства) — для разбора. */
  explain(items: ParserItem[]) {
    return this._predict(items);
  }

  private resolveNoRegime(mode: "matrix" | "single", channel: string, symbol: string, dir: Direction) {
    return resolveExitNoRegime(this.params.exit, mode, symbol, dir);
  }

  // ── единый построитель плана: с/без свечей ──
  private buildPlan(v: PumpVerdict, candles: ICandleData[] | null, opts: RuntimeOptions = {}): TradePlan {
    const ch = v.channel ?? "_matrix";
    const dir = v.direction!;

    let volRegime: VolRegime | null = null;
    let volZ: number | null = null;
    let sqPressure: number | null = null;

    // пороги volZ/squeeze берём из любого обученного exit для этой (symbol,dir):
    // пробуем cell-calm как репрезентативный, иначе падает на symbol-dir/mode/global.
    const probe = resolveExit(this.params.exit, v.source, ch, v.symbol, dir, "calm");
    const volZThr = probe.exit.volZThreshold ?? 2.0;
    const baseWin = probe.exit.volBaselineWindow ?? 20;
    const horizon = probe.exit.staleMinutes;

    if (candles && candles.length > 0) {
      let entryIdx = candles.findIndex((c) => c.timestamp >= v.ts);
      if (entryIdx < 0) entryIdx = candles.length - 1;
      volZ = volumeZScore(candles, entryIdx, baseWin);
      sqPressure = squeezePressure(candles, entryIdx, dir, horizon);
      volRegime = volRegimeOf(volZ, volZThr);
    }

    // финальный exit: при известном volRegime → cell-уровень;
    // без свечей НЕ резолвим cell (volRegime неизвестен) → symbol-dir.
    let resolved = volRegime
      ? resolveExit(this.params.exit, v.source, ch, v.symbol, dir, volRegime)
      : this.resolveNoRegime(v.source, ch, v.symbol, dir);
    let exit = resolved.exit;

    // рекомендация по каскаду
    let recommendation: "enter" | "tighten" | "veto" | "invert" = "enter";
    let finalDir = dir;
    const fires = !opts.disableSqueeze
      && sqPressure !== null && sqPressure >= (exit.squeezeThreshold ?? 0.6);
    if (fires) {
      if (exit.squeezePolicy === "veto") recommendation = "veto";
      else if (exit.squeezePolicy === "tighten") recommendation = "tighten";
      else if (exit.squeezePolicy === "invert") {
        if (opts.disableInvert) {
          // инверсия заглушена рантайм-флагом → не разворачиваем, а защищаемся: veto.
          // Безопаснее, чем войти в направление поста, который детектор считает ловушкой.
          recommendation = "veto";
        } else {
          // ИНВЕРСИЯ: разворачиваем позицию против поста и тянем exit из ИНВЕРС-ячейки
          // тензора [mode][channel][symbol][oppositeDir][volRegime]. signals отдаёт
          // уже развёрнутый direction — прод думать не должен.
          recommendation = "invert";
          finalDir = dir === "long" ? "short" : "long";
          resolved = volRegime
            ? resolveExit(this.params.exit, v.source, ch, v.symbol, finalDir, volRegime)
            : this.resolveNoRegime(v.source, ch, v.symbol, finalDir);
          exit = resolved.exit;
        }
      }
    }

    // при tighten отдаём уже ужатый trailing, чтобы прод не считал сам
    const tightenFactor = exit.tightenFactor ?? 0.5;
    const trailingTake = recommendation === "tighten"
      ? +(exit.trailingTake * tightenFactor).toFixed(6)
      : exit.trailingTake;

    return {
      symbol: v.symbol,
      direction: finalDir,
      originalDirection: dir,
      inverted: recommendation === "invert",
      channel: v.channel,
      ts: v.ts,
      confidence: v.confidence,
      independentClusters: v.independentClusters,
      trailingTake,
      hardStop: exit.hardStop,
      impactHorizonMinutes: exit.staleMinutes,
      stalenessSinceProfit: exit.stalenessSinceProfit,
      stalenessSinceMinutes: exit.stalenessSinceMinutes,
      squeezePolicy: exit.squeezePolicy ?? "none",
      squeezeThreshold: exit.squeezeThreshold ?? 0.6,
      volZThreshold: exit.volZThreshold ?? 2.0,
      exitSource: resolved.source,
      volRegime,
      volZ: volZ !== null ? +volZ.toFixed(6) : null,
      squeezePressure: sqPressure !== null ? +sqPressure.toFixed(6) : null,
      recommendation,
      modelConfidence: this.params.meta.confidence,
      modelReliable: this.params.meta.reliable,
      source: v.source,
    };
  }
}
