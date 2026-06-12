import { Direction } from "./types";

/**
 * ЕДИНЫЙ СТАБИЛЬНЫЙ КОНТРАКТ ВЫВОДА.
 *
 * Один сигнал = одно исполняемое решение. Никаких optional-флагов, размазывающих
 * состояние по объекту (было: inverted + originalDirection + recommendation —
 * три поля про одно решение). Прод читает плоскую исполняемую часть и не думает.
 *
 * Что исполнять — всегда валидно (symbol, direction, exit). Происхождение — в
 * одном вложенном `origin`, для аудита, не для ветвления в прикладном коде.
 */

/** Что это за исход — единственный дискриминатор. */
export type SignalAction = "enter" | "invert" | "tighten";

/** Плоский исполняемый exit-план. Готов к передаче в openPosition без доработки. */
export interface ExitPlan {
  /** trailing take %, откат от пика PnL (уже ужат, если action="tighten") */
  trailingTake: number;
  /** hard stop %, фикса от входа */
  hardStop: number;
  /** через сколько минут пост теряет импакт (эмпирический потолок жизни) */
  impactHorizonMinutes: number;
  /** пик-протухание: порог прибыли % */
  stalenessSinceProfit: number;
  /** пик-протухание: минут без нового пика */
  stalenessSinceMinutes: number;
}

/** Происхождение сигнала — единый вложенный объект, не флаги. Для аудита. */
export interface SignalOrigin {
  /** режим детектора: matrix (корреляция авторов) | single (fallback на пост) */
  detector: "matrix" | "single";
  /** канал-источник (single) или null (matrix — межканальный) */
  channel: string | null;
  /**
   * Если сигнал инвертирован — исходное направление поста (а direction уже развёрнут).
   * null = инверсии не было. Это НЕ дублирует direction: direction = что исполнять,
   * invertedFrom = что говорил канал. Чтение не обязательно для исполнения.
   */
  invertedFrom: Direction | null;
  /** с какого уровня тензора разрешён exit: cell | symbol-dir | mode | global */
  exitSource: "cell" | "symbol-dir" | "mode" | "global";
  /** режим объёма на входе (если считался из свечей): calm | anomalous | null */
  volRegime: "calm" | "anomalous" | null;
  /** острота всплеска (из детектора) */
  confidence: number;
  /** число независимых кластеров-авторов */
  independentClusters: number;
  /** доверие к модели на момент обучения (0..1) */
  modelConfidence: number;
  /** надёжна ли модель (хватило ли данных) */
  modelReliable: boolean;
}

/** Единый исполняемый сигнал. Прод читает плоскую часть, origin — для аудита. */
export interface TradeSignal {
  symbol: string;
  /** ИТОГОВОЕ направление к исполнению (при инверсии — уже развёрнутое против поста) */
  direction: Direction;
  /** что это за исход */
  action: SignalAction;
  /** unix-время сигнала, мс */
  ts: number;
  /** готовый exit-план */
  exit: ExitPlan;
  /** происхождение (аудит), не для ветвления */
  origin: SignalOrigin;
}

/**
 * Политика разрешённых исходов (allow-список).
 *
 * Сериализуема: фиксируется в момент fit, попадает в params (model.json).
 * В исполнении READONLY: второй аргумент signals() может СУЗИТЬ allow для одного
 * вызова, но не расширить — исполнение не разрешает то, что обучение запретило.
 *
 * veto в allow быть НЕ может: veto это «не входить», т.е. отсутствие сигнала.
 * Запрет veto = удаление сигнала из выдачи (фильтр внутри signals).
 */
export type AllowAction = "enter" | "invert" | "tighten";

export interface SignalPolicy {
  /** какие исходы попадают в выдачу. По умолчанию все три. */
  allow: AllowAction[];
}

export const DEFAULT_POLICY: SignalPolicy = {
  allow: ["enter", "invert", "tighten"],
};

/**
 * Пересечение политик: эффективный allow = trained ∩ requested.
 * Реализует readonly-инвариант — запрос не может разрешить то, чего нет в обученной.
 */
export function intersectPolicy(
  trained: SignalPolicy,
  requested?: Partial<SignalPolicy>,
): SignalPolicy {
  if (!requested?.allow) return { allow: [...trained.allow] };
  const t = new Set(trained.allow);
  return { allow: requested.allow.filter((a) => t.has(a)) };
}
