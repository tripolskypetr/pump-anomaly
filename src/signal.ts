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
  /** id якорного parser-item — для сопоставления live-сигнала с парсингом */
  id?: string;
  /** id всех parser-item, вошедших в сигнал */
  ids?: string[];
  /**
   * ADVISORY-ёмкость: медианный минутный оборот в котируемой валюте по свечам
   * ДО сигнала (median(volume)·close). Твой ордер, сопоставимый с этой величиной,
   * сам станет пампом — эджа на таком размере нет. null = свечей не было.
   */
  liquidityQuote?: number | null;
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
  /** нижняя граница зоны входа из parser-item (для открытия live-позиции; undefined = вход по рынку) */
  entryFromPrice?: number;
  /** верхняя граница зоны входа из parser-item */
  entryToPrice?: number;
  /** готовый exit-план */
  exit: ExitPlan;
  /**
   * ПРОГНОЗ модели исхода: калиброванная P(win) и ожидаемый pnl (доли, нетто).
   * informative=false = модель не побила prior по OOF-Brier — pWin равен prior,
   * не притворяясь точнее данных. null = модель не обучалась (мало сделок).
   */
  probability?: { pWin: number; expectedPnl: number; informative: boolean } | null;
  /** происхождение (аудит), не для ветвления */
  origin: SignalOrigin;
}

/**
 * Реализованный результат сделки — РЕПЛЕЙ exit-плана по свечам ПОСЛЕ входа.
 * Существует только в backtest (forward-replay по закрытой истории); plan/signals
 * его НЕ дают (там позиция ещё не закрыта). pnl/peak в долях (0.05 = +5%).
 */
export interface BacktestResult {
  /** вошли ли в позицию (false → зона входа не задета на окне свечей) */
  entered: boolean;
  /** реализованный pnl, доля (при hard-stop = честный -hardStop%) */
  pnl: number;
  /** пиковый pnl за жизнь позиции, доля */
  peak: number;
  /** причина выхода (hard-stop / trailing-take / peak-staleness / life-cap / …) */
  reason: string;
  /** минут от входа до выхода */
  heldMinutes: number;
  /** цена входа (0 если не вошли) */
  entryPrice: number;
  /** цена выхода (0 если не вошли) */
  exitPrice: number;
  /** замер неполный: после входа не хватило свечей на полный life-cap */
  truncated: boolean;
}

/**
 * Сигнал backtest = TradeSignal + реализованный result. Тип-потомок: главное
 * отличие backtest от plan — он РЕПЛЕИТ позицию вперёд и возвращает realized pnl.
 * Сигнатура backtest() возвращает именно его, поэтому pnl виден без джойна с dump().
 */
export interface BacktestSignal extends TradeSignal {
  result: BacktestResult;
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
  /**
   * Минимальный risk-reward символа для допуска сигнала (readonly-фильтр).
   * Режет символы, у которых backtest-RR ниже порога. Какую метрику сравнивать —
   * задаёт rrMetric. undefined = без RR-фильтра.
   */
  minRiskReward?: number;
  /** какую RR-метрику символа сравнивать с minRiskReward. По умолчанию "mean". */
  rrMetric?: "mean" | "p95" | "p99";
  /**
   * Требовать ПОДТВЕРЖДЕНИЕ РЫНКОМ: сигнал отдаётся только если лента до входа
   * показала аномальный объём (volRegime="anomalous" по обученному volZThreshold).
   * Физика пампа: автор набирает позицию ДО поста — реальному коллу предшествует
   * всплеск объёма; пост без реакции ленты — шум, не памп.
   *
   * Требует свечей: signals() (без свечей) с этим флагом отдаёт ПУСТО — подтверждение
   * без ленты невозможно, режем консервативно. Используй plan(items, getCandles).
   * Тighten-only: запрос может включить, но не выключить вшитый в модель флаг.
   */
  requireVolumeConfirm?: boolean;
  /**
   * MOMENTUM-ФИЛЬТР (эдж из habr 1041898): сигнал допускается, только если за
   * momentumWindowMinutes ДО поста направленный momentum ≥ порога:
   *   long:  momentum ≥ minMomentum24hPct (не ловим падающий нож),
   *   short: −momentum ≥ minMomentum24hPct (не шортим взлетающую ракету).
   * В статье порог −1 (%): сырые посты ≈ нулевая сумма, но с этим фильтром
   * winrate вырос 68% → 100% на выборке — эдж в притоке капитала ДО публикации.
   * Требует свечей до сигнала (без них сигнал режется консервативно).
   * Тighten-only: эффективный порог = max(trained, requested). undefined = выкл.
   */
  minMomentum24hPct?: number;
  /** окно momentum-фильтра в минутах (по умолчанию 1440 = 24ч, как в статье) */
  momentumWindowMinutes?: number;
  /**
   * ФИЛЬТР КАЧЕСТВА АВТОРА: сигнал single-канала допускается, только если его
   * channelScore (shrinkage-expectancy по бэктест-истории канала) ≥ порога.
   * Эдж неравномерен по каналам: один автор стабильно двигает рынок, другой —
   * стабильно сливает подписчиков. Matrix-сигналы (channel=null, межканальное
   * подтверждение) проходят всегда. Канал без статистики режется консервативно.
   * Тighten-only: max(trained, requested). undefined = выкл.
   */
  minChannelScore?: number;
  /**
   * ФИЛЬТР ЁМКОСТИ: твой размер ордера в котируемой валюте. Сигнал режется, если
   * notionalQuote > maxLiquidityShare × liquidityQuote (медианный минутный оборот
   * до сигнала): ордер, сопоставимый с минутным оборотом, — сам себе памп, эджа
   * на таком размере нет. Требует свечей (без них подтвердить ёмкость нечем —
   * режем консервативно). Тighten-only: max(trained, requested). undefined = выкл.
   */
  notionalQuote?: number;
  /**
   * Максимально допустимая доля минутного оборота под твой ордер (по умолчанию 0.1:
   * 10% минутного оборота — уже двигаешь цену). Тighten-only: min(trained, requested).
   */
  maxLiquidityShare?: number;
  /**
   * Порог калиброванной вероятности выигрыша (модель исхода): сигнал с
   * probability.pWin ниже порога режется. Работает и при informative=false
   * (тогда сравнивается prior). Тighten-only: max(trained, requested).
   */
  minPWin?: number;
  /**
   * Порог ожидаемой ценности, % на сделку: режем сигналы с E[pnl|x] ниже.
   * Решение о входе как решение об ожидаемой ценности, а не о ступеньках.
   * Тighten-only: max(trained, requested).
   */
  minExpectedPnlPct?: number;
  /**
   * ЯВНОЕ СОГЛАСИЕ торговать НЕсертифицированной моделью. Путь fit→load→plan
   * по умолчанию честен: live-методы (signals/plan/planFor) модели с красным
   * сертификатом отдают ПУСТО — недоказанный эдж не должен молча открывать
   * позиции у прикладного кодера, скопировавшего Quick start. true = осознанный
   * paper/микро-режим (форвард-валидация). backtest()/planForAt() не гейтятся
   * (исследование прошлого). Модели без сертификата в meta (legacy) не гейтятся.
   */
  acknowledgeUncertified?: boolean;
}

export const DEFAULT_POLICY: SignalPolicy = {
  allow: ["enter", "invert", "tighten"],
};

/**
 * Пересечение политик: эффективный allow = trained ∩ requested.
 * Реализует readonly-инвариант — запрос не может разрешить то, чего нет в обученной.
 * RR-фильтр (minRiskReward/rrMetric) — чисто рантаймовый: запрос может его ужесточить,
 * обученная политика дефолта не несёт (RR-статистика отдельно в params.riskReward).
 */
export function intersectPolicy(
  trained: SignalPolicy,
  requested?: Partial<SignalPolicy>,
): SignalPolicy {
  const allow = !requested?.allow
    ? [...trained.allow]
    : [...new Set(requested.allow.filter((a) => new Set(trained.allow).has(a)))]; // ∩ + дедуп
  // minRiskReward: запрос может только УЖЕСТОЧИТЬ (поднять порог), не ослабить.
  // Берём максимум из обученного и запрошенного — иначе рантайм-запрос мог бы
  // снизить вшитый защитный порог риска, что нарушает инвариант «только сужение».
  let minRiskReward: number | undefined;
  if (trained.minRiskReward !== undefined && requested?.minRiskReward !== undefined) {
    minRiskReward = Math.max(trained.minRiskReward, requested.minRiskReward);
  } else {
    minRiskReward = requested?.minRiskReward ?? trained.minRiskReward;
  }
  // числовые пороги: только ужесточение (выше = строже), как minRiskReward
  const tightenMax = (a?: number, b?: number): number | undefined =>
    a !== undefined && b !== undefined ? Math.max(a, b) : (b ?? a);
  const tightenMin = (a?: number, b?: number): number | undefined =>
    a !== undefined && b !== undefined ? Math.min(a, b) : (b ?? a);
  return {
    allow,
    minRiskReward,
    rrMetric: requested?.rrMetric ?? trained.rrMetric ?? "mean",
    // tighten-only: включён хотя бы одной стороной → включён; выключить вшитое нельзя
    requireVolumeConfirm: (trained.requireVolumeConfirm || requested?.requireVolumeConfirm) || undefined,
    minMomentum24hPct: tightenMax(trained.minMomentum24hPct, requested?.minMomentum24hPct),
    momentumWindowMinutes: requested?.momentumWindowMinutes ?? trained.momentumWindowMinutes,
    minChannelScore: tightenMax(trained.minChannelScore, requested?.minChannelScore),
    // ёмкость: больший размер / меньшая доля оборота = строже отбор
    notionalQuote: tightenMax(trained.notionalQuote, requested?.notionalQuote),
    maxLiquidityShare: tightenMin(trained.maxLiquidityShare, requested?.maxLiquidityShare),
    minPWin: tightenMax(trained.minPWin, requested?.minPWin),
    minExpectedPnlPct: tightenMax(trained.minExpectedPnlPct, requested?.minExpectedPnlPct),
    // согласие на несертифицированную модель — явное, любой стороной (это не
    // ослабление обученной политики, а признание статуса модели вызывающим)
    acknowledgeUncertified: (trained.acknowledgeUncertified || requested?.acknowledgeUncertified) || undefined,
  };
}
