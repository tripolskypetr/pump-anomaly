/**
 * Контракты pump-matrix.
 *
 * ParserItem — совместим со схемой parser-items из backtest-ollama-crontab
 * (поля direction/entry/targets/stoploss присутствуют в источнике, но детектору
 *  нужны только channel/symbol/direction/ts — остальное игнорируется).
 */
type Direction = "long" | "short";
/** Режим отбора входов. */
type DetectorMode = "auto" | "matrix" | "single";
/** Пороги жизнеспособности матрицы авторства (строгий критерий для auto-режима). */
interface ViabilityConfig {
    /** нижняя граница общих событий; при autoOverlap поднимается до порога случайности */
    minSharedEvents: number;
    minPeakShare: number;
    minStrongEdges: number;
    minStructure: number;
    /**
     * Авто-порог перекрытия: вместо фиксированного minSharedEvents требовать
     * «значимо больше совпадений, чем даёт случай» — λ + 2√λ, где λ — ожидаемое
     * число случайных коинциденций (Пуассон) при данной плотности событий и окне.
     * На плотной истории планка растёт сама; на разреженной остаётся minSharedEvents.
     * Включается автоматически, когда minSharedEvents не задан пользователем явно.
     */
    autoOverlap?: boolean;
}
/** Отчёт о жизнеспособности матрицы — почему auto выбрал matrix или single. */
interface ViabilityReport {
    viable: boolean;
    channels: number;
    maxSharedEvents: number;
    strongEdges: number;
    multiChannelClusters: number;
    clusterCount: number;
    reason: string;
    /** фактически применённый порог перекрытия (поднят Пуассоном при autoOverlap) */
    minSharedEventsUsed?: number;
}
/** Строка из коллекции parser-items (вход публичного API). */
interface ParserItem {
    channel: string;
    symbol: string;
    direction: Direction;
    /** unix-время публикации, мс. */
    ts: number;
    /** нижняя граница зоны входа (один пост уже двигает цену). */
    entryFromPrice?: number;
    /** верхняя граница зоны входа. */
    entryToPrice?: number;
    /** идентификатор исходного поста — протягивается до dump() и origin live-сигнала для сопоставления с парсингом. */
    id?: string | number;
    [extra: string]: unknown;
}
/** Нормализованное событие, с которым работают внутренние слои. */
interface SignalEvent {
    channel: string;
    symbol: string;
    direction: Direction;
    ts: number;
    entryFromPrice?: number;
    entryToPrice?: number;
    /** идентификатор исходного parser-item — для сопоставления результата теста с парсингом */
    id?: string;
}
/** Вердикт по одному (symbol, direction). */
interface PumpVerdict {
    symbol: string;
    action: "open" | "skip";
    direction: Direction | null;
    ts: number;
    independentClusters: number;
    totalChannels: number;
    confidence: number;
    reason: string;
    /** каким режимом получен сигнал: matrix (корреляция) или single (fallback) */
    source: "matrix" | "single";
    /** канал-источник (для single — конкретный пост; для matrix — null, межканальный) */
    channel: string | null;
    /** id якорного parser-item (для сопоставления live-сигнала с парсингом) */
    id?: string;
    /** id всех parser-item, вошедших в сигнал */
    ids?: string[];
    /** зона входа из parser-item — нужна для открытия live-позиции */
    entryFromPrice?: number;
    entryToPrice?: number;
    /** ЭФФЕКТИВНОЕ число независимых авторов всплеска (participation ratio, дробное):
     *  {5 постов A, 1 пост B} → 1.4, а не «2 кластера». Гейт minClusters остаётся
     *  на целочисленном independentClusters; N_eff взвешивает confidence. */
    nEffClusters?: number;
    /** слой 6: кратность превышения Hawkes-возбуждения над порогом случайности (≥1 = значимо) */
    burstScore?: number;
    /** слой 7: среднее лидерство каналов всплеска (0.5 нейтрально, <0.5 — эхо без лидеров) */
    leaderShare?: number;
}
/** Карта авторства: канал → id кластера-автора. */
type AuthorMap = Map<string, number>;
/** Полный результат предсказания. */
interface PredictionResult {
    /** Только action="open", отсортированы по confidence убыв. — то, ради чего всё. */
    signals: PumpVerdict[];
    /** Все вердикты, включая skip. */
    verdicts: PumpVerdict[];
    /** Карта склеенных каналов одного автора. */
    authors: AuthorMap;
    /** Сколько независимых авторов выявлено. */
    authorCount: number;
    /** Самооценённый характерный лаг между братскими каналами, мс. */
    tauMs: number;
    /** Итоговое окно синхронности всплеска, мс. */
    windowMs: number;
    /** Каким режимом фактически отработал детектор. */
    usedMode: "matrix" | "single";
    /** Оценка жизнеспособности матрицы (почему выбран режим в auto). */
    viability: ViabilityReport;
    /** Слой 7: влиятельность каналов из направленного lead-lag графа (matrix/auto). */
    influence?: Map<string, number>;
}
interface DetectorConfig {
    windowK: number;
    minClusters: number;
    jaccardThreshold: number;
    lagPeakThreshold: number;
    maxBurstWindowMs: number;
    /** режим отбора входов: auto (по жизнеспособности матрицы) | matrix | single */
    mode: DetectorMode;
    /** переопределение порогов жизнеспособности матрицы (auto-режим) */
    viability?: Partial<ViabilityConfig>;
    /**
     * Окно стационарности, мс: статистики (τ, author-матрица) считаются по локальному
     * окну, а не по всей истории — защита от дрейфа режима на длинном горизонте.
     * Infinity (по умолчанию) = вся история.
     */
    stationarityWindowMs: number;
    /**
     * Оценщик графа авторства (matrix-режим):
     *  - "xcorr"  (дефолт) — конвейер jaccard-сито → лаговая кросс-корреляция;
     *  - "hawkes" — multivariate Hawkes: EM-оценка α-матрицы кросс-возбуждения,
     *    рёбра по значимости массы потомков против пуассоновского порога. Убирает
     *    три порога конвейера (jaccard/lagPeak/peakShare), их роль — правдоподобие.
     */
    authorGraph?: "xcorr" | "hawkes";
}
declare const DEFAULT_CONFIG: DetectorConfig;

/**
 * Контракт источника свечей. Совместим с getCandles из backtest-kit.
 * Тренировка идёт в прошлом (не realtime), поэтому look-ahead-ограничения сняты:
 * свечи можно брать по обе стороны от события.
 */
type CandleInterval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "8h" | "1d";
interface ICandleData {
    /** Unix ms, момент ОТКРЫТИЯ свечи. */
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
/** Длительность одного шага интервала в мс. */
declare const STEP_MS: Record<CandleInterval, number>;
/** Выравнивание timestamp вниз к границе свечи интервала. */
declare const alignTs: (t: number, interval: CandleInterval) => number;
/**
 * Первая ПОЛНОСТЬЮ сформированная свеча, торгуемая БЕЗ look-ahead: если сигнал
 * пришёл внутри минуты (ts > границы), свеча, СОДЕРЖАЩАЯ сигнал, ещё формируется —
 * её close/high/low станут известны только в КОНЦЕ минуты, ПОСЛЕ сигнала. Входить
 * в неё = заглядывать вперёд. Поэтому старт входа = следующая граница. Если сигнал
 * ровно на границе (ts === aligned) — эта свеча открывается одновременно с сигналом
 * и торгуема честно, не пропускаем.
 */
declare const entryStartTs: (t: number, interval: CandleInterval) => number;
/**
 * Источник свечей. Семантика диапазонов (sDate inclusive, eDate exclusive):
 *   (limit)                 → [alignedWhen − limit·step, alignedWhen)
 *   (limit, sDate)          → [align(sDate), align(sDate) + limit·step)
 *   (limit, _, eDate)       → [align(eDate) − limit·step, eDate)
 *   (_, sDate, eDate)       → [align(sDate), eDate), limit из диапазона
 *   (limit, sDate, eDate)   → [align(sDate), …), ровно limit свечей
 */
type GetCandles = (symbol: string, interval: CandleInterval, limit?: number, sDate?: number, eDate?: number) => Promise<ICandleData[]>;

type Key = string;
interface EventTable {
    /** все события, отсортированы по ts */
    events: SignalEvent[];
    /** события по (symbol,direction), каждая группа отсортирована по ts */
    byKey: Map<Key, SignalEvent[]>;
    /** `${channel}|${key}` → отсортированные ts */
    byChannelKey: Map<string, number[]>;
    /** список уникальных каналов */
    channels: string[];
}
/** Нормализует сырой поток событий в индексированную таблицу. */
declare function buildTable(raw: SignalEvent[]): EventTable;
/**
 * Окно стационарности. Статистики (τ, author-матрица, Jaccard) на длинном горизонте
 * корраптятся: они агрегируются по ВСЕЙ истории, а за 5 месяцев режим дрейфует —
 * каналы появляются/замолкают, «братские» пары распадаются, τ плывёт. Один глобальный
 * набор усредняет несопоставимые периоды.
 *
 * Решение без новой математики: считать статистики только по локальному окну,
 * заканчивающемуся в момент anchorTs. windowMs=Infinity → вся история (старое
 * поведение, для коротких данных). Размер окна перебирается grid'ом в train.
 */
declare function windowEvents(events: SignalEvent[], anchorTs: number, windowMs: number): SignalEvent[];
/** Таблица, построенная по окну стационарности до anchorTs. */
declare function buildWindowedTable(events: SignalEvent[], anchorTs: number, windowMs: number): EventTable;

/**
 * Слой 1 — самооценка характерного лага τ.
 *
 * Строит гистограмму всех попарных положительных задержек между РАЗНЫМИ каналами
 * по совпадающим (symbol,direction). У случайных пар распределение ≈ плоское,
 * у «братских» каналов — острый пик у малого лага. Модальный лог-бин даёт τ.
 *
 * Возвращает τ в мс, зажатый в [30с, 60мин]. Если данных мало — дефолт 15 мин.
 */
declare function selfTuneLag(tbl: EventTable): number;
/** Детальная оценка τ: параметры смеси «пик братских задержек + фон совпадений». */
interface LagDetail {
    /** τ = мода логнормальной компоненты, зажат в [30с, 60мин] */
    tauMs: number;
    /** ширина пика в лог-пространстве (σ) — «насколько братья пунктуальны» */
    sigmaLog: number;
    /** вес пиковой компоненты (доля задержек, объяснимых братством, 0..1) */
    peakWeight: number;
    /** число задержек в оценке */
    n: number;
}
/** Публичная детальная версия selfTuneLag (τ + ширина пика + вес братской компоненты). */
declare function selfTuneLagDetail(tbl: EventTable): LagDetail;

/**
 * МОДЕЛЬ ИСХОДА — калиброванная вероятность P(win|признаки) вместо ступенчатых
 * гейтов и эвристического confidence.
 *
 * Проблема: гейты бинарны (momentum −0.99% проходит, −1.01% режется в ноль), а
 * confidence — произведение ad-hoc весов без вероятностного смысла. Прогноз
 * становится точным, когда сигналу приписывается откалиброванная вероятность.
 *
 * Аппарат подобран под МАЛЫЕ выборки (n ~ 100–300 сделок), где ML-зоопарк —
 * гарантированный оверфит:
 *
 *  1. НАИВНЫЙ БАЙЕС С ИЗОТОННЫМИ МАРЖИНАЛАМИ. Для каждого признака x_i оцениваем
 *     P(win|x_i) изотонной регрессией (PAVA): монотонная, непараметрическая,
 *     не переобучается. Направление монотонности — по знаку корреляции.
 *     Вклад признака = log-likelihood ratio: LLR_i(x) = logit(P(win|x_i)) − logit(prior).
 *     Каждый жёсткий гейт превращается в мягкий вклад в правдоподобие;
 *     отсутствующий признак честно даёт 0.
 *  2. КАЛИБРОВКА НА OUT-OF-FOLD. Сумма LLR наивна (признаки коррелированы,
 *     вклады двоятся) — поэтому сырой скор пере-калибруется изотонной регрессией
 *     на out-of-fold предсказаниях (хронологические фолды): предсказанные 0.7
 *     обязаны выигрывать ~70%. Это одновременно лечит наивность и даёт честную
 *     вероятностную шкалу.
 *  3. INFORMATIVE-ГВАРД. Если OOF-Brier модели НЕ лучше Brier константного prior —
 *     модель ничего не выучила: informative=false, рантайм отдаёт prior, а не
 *     псевдоточные проценты. Модель не имеет права быть увереннее данных.
 *
 * E[pnl|x] = pWin·meanWin + (1−pWin)·meanLoss — решение о входе становится
 * решением об ожидаемой ценности (policy.minExpectedPnlPct), а не о ступеньках.
 */
interface StepFn {
    /** правые границы ступеней по x (возрастание) */
    breaks: number[];
    /** значение ступени */
    values: number[];
}
interface IsotonicLLR {
    /** −1 = признак инвертируется перед применением (убывающая зависимость) */
    direction: 1 | -1;
    fn: StepFn;
}
interface OutcomeModel {
    version: 1;
    /** базовая P(win) по всем сделкам */
    prior: number;
    /** маржиналы по именам признаков */
    features: Record<string, IsotonicLLR>;
    /** калибровка сырого скора (Σ LLR) → вероятность, изотонная по OOF */
    calibration: StepFn;
    /** средний pnl выигрышных / проигрышных сделок (для E[pnl]) */
    meanWin: number;
    meanLoss: number;
    n: number;
    /** OOF-Brier модели и константного prior — качество ЧЕСТНО хуже/лучше базы */
    brier: number;
    brierPrior: number;
    /** false = модель не лучше prior → рантайм отдаёт prior, не псевдоточность */
    informative: boolean;
}
interface OutcomeRow {
    /** 1 = pnl > 0 */
    y: 0 | 1;
    pnl: number;
    ts: number;
    /** null = признак недоступен для этой сделки (вклад 0) */
    features: Record<string, number | null>;
}
/**
 * Обучение модели исхода. null, если данных мало или исход одноклассовый —
 * честное «модели нет», а не мусорная модель.
 */
declare function fitOutcomeModel(rowsIn: OutcomeRow[], folds?: number): OutcomeModel | null;
interface OutcomePrediction {
    /** калиброванная P(win); при informative=false = prior */
    pWin: number;
    /** E[pnl|x] = pWin·meanWin + (1−pWin)·meanLoss, доли */
    expectedPnl: number;
    informative: boolean;
}
declare function predictOutcome(model: OutcomeModel, features: Record<string, number | null | undefined>): OutcomePrediction;

/**
 * Objective для подбора порогов: shrinkage-expectancy.
 *
 *   score = mean(returns) · N/(N+k)
 *
 * Средний forward-return отобранных всплесков, усаженный к нулю при малой выборке.
 * Без усадки grid выбрал бы вырожденный порог, ловящий 1 жирный всплеск и
 * рапортующий «идеальный эдж» — ровно ловушка winrate-68%-с-чёрным-лебедем.
 * k — сила усадки (по умолчанию 5): при N=k вклад режется вдвое.
 */
declare function shrinkageExpectancy(returns: number[], k?: number): number;
/** Доля положительных (winrate) — для отчёта, не для оптимизации. */
declare function winrate(returns: number[]): number;
/**
 * Стандартная ошибка среднего по фолдам: SE = std(foldScores) / sqrt(n).
 * std — выборочное (делитель n-1). При n<2 SE=0 (разброс не оценить).
 */
declare function standardError(foldScores: number[]): number;
/**
 * One-standard-error rule (Breiman 1984) — против winner's curse при grid-search.
 *
 * Проблема: argmax по CV-score из N конфигураций систематически завышен — максимум
 * шумных оценок смещён вверх на ~sigma·sqrt(2·ln N) даже при истинном edge=0. Чем
 * больше grid, тем сильнее переобучение на шум выборки.
 *
 * Правило: берём НЕ максимум, а самую КОНСЕРВАТИВНУЮ конфигурацию среди тех, чей
 * score в пределах 1 SE от максимума. Разница внутри 1 SE статистически незначима
 * (внутри шума), поэтому вместо счастливого выброса выбираем робастную конфигурацию.
 *
 * @param entries    кандидаты
 * @param scoreOf    извлечь CV-score кандидата
 * @param foldsOf    извлечь fold-scores кандидата (для SE максимума)
 * @param isSimpler  компаратор «a консервативнее b» (true → предпочесть a)
 */
declare function oneStandardErrorSelect<T>(entries: T[], scoreOf: (e: T) => number, foldsOf: (e: T) => number[], isSimpler: (a: T, b: T) => boolean, seMultiplier?: number): T | null;
/**
 * Перцентиль p (0..1) по выборке методом линейной интерполяции (type-7, как в numpy).
 * percentile([...], 0.95) = P95. Пустая выборка → 0.
 */
declare function percentile(xs: number[], p: number): number;
/**
 * КВАНТИЛЬНЫЕ ПРЕДЛОЖЕНИЯ EXIT из статистики пути (MAE/MFE-анализ, Sweeney).
 *
 * Перебор сетки судит конфиги по финальному pnl, выбрасывая информацию о пути.
 * Путь же говорит напрямую: у ПОБЕДИТЕЛЕЙ адверс-экскурсия (|MAE|) компактна, у
 * лузеров — тяжёлый хвост → стоп сразу за p90 |MAE| победителей режет лузеров,
 * почти не задевая винеров. Аналогично trailing: quantиль отката от пика,
 * который победители реально отдавали (peak − pnl). Это оценка ДВУХ квантилей
 * по всем сделкам сразу — на порядок эффективнее по данным, чем независимый
 * скоринг тысяч конфигов.
 *
 * Возвращает КАНДИДАТОВ (в %), а не решение: refinement подаёт их в CV наравне
 * с сеточными вариантами — принимаются только при значимом улучшении (SE-гвард).
 * Мало победителей (< minWinners) → пустые списки: по 5 сделкам квантили — шум.
 */
interface PathExitProposals {
    hardStop: number[];
    trailingTake: number[];
}
declare function exitProposalsFromPath(rows: Array<{
    pnl: number;
    peak: number;
    trough: number;
    entered: boolean;
}>, minWinners?: number): PathExitProposals;
/** Статистика risk-reward по набору сделок. */
interface RiskRewardStats {
    /** среднее RR */
    mean: number;
    /** P95 RR (хвост в плюс) */
    p95: number;
    /** P99 RR */
    p99: number;
    /** число сделок в выборке */
    n: number;
}
/**
 * RR на сделку = pnl / hardStop (реализованный в единицах риска — сколько R сняли).
 * Считает mean / P95 / P99 по парам (pnl, hardStop). Сделки с hardStop ≤ 0
 * пропускаются (деление на ноль). Главный исследовательский выход бэктеста.
 */
declare function riskRewardStats(trades: Array<{
    pnl: number;
    hardStop: number;
}>): RiskRewardStats;
/**
 * Устойчивая к выбросам статистика реализованного PnL системы (в долях).
 * Дополняет mean процентилями и медианой, чтобы ОДНА плохая (или одна жирная)
 * сделка не определяла оценку выигрыша:
 *   - median — робастный центр, полностью иммунный к выбросам (50-й перцентиль);
 *   - p5     — нижний хвост (насколько плохи худшие 5% сделок);
 *   - p95/p99— верхний хвост (вклад редких крупных выигрышей).
 * mean остаётся для сравнения, но median/перцентили показывают систему без
 * искажения единичными экстремумами. NaN/Infinity отбрасываются.
 */
interface PnlStats {
    /** среднее PnL (чувствительно к выбросам — для сравнения) */
    mean: number;
    /** медиана PnL (робастный центр, иммунный к выбросам) */
    median: number;
    /** P5 — нижний хвост (худшие сделки) */
    p5: number;
    /** P95 — верхний хвост */
    p95: number;
    /** P99 — крайний верхний хвост */
    p99: number;
    /** число сделок в выборке */
    n: number;
}
declare function pnlStats(pnls: number[]): PnlStats;

interface Edge {
    a: string;
    b: string;
    jaccard: number;
}
/**
 * Близость двух каналов по скользящему окну (сырой ts, без бакетизации).
 * Доля событий по общим (symbol,direction), у которых нашёлся партнёр у другого
 * канала в пределах |Δ| ≤ window. Симметризованный Jaccard.
 */
declare function jaccardPair(tbl: EventTable, a: string, b: string, window: number): number;
/** Слой 2 — грубое сито: все пары каналов с Jaccard ≥ threshold. */
declare function jaccardScreen(tbl: EventTable, window: number, threshold: number): Edge[];

interface DirectedEdge extends Edge {
    /** модальная |задержка|, мс */
    lag: number;
    /** доля задержек в окне остроты пика (0..1) */
    peakShare: number;
    /** инициатор */
    leader: string;
    /** ведомый */
    follower: string;
}
/**
 * Слой 3 — лаговая кросс-корреляция точечных процессов.
 *
 * Для каждой пары-кандидата собирает знаковые задержки Δ = t_b − t_a между
 * ближайшими событиями по общим (symbol,direction). Узкий смещённый пик ⇒
 * братские каналы одного автора; размазанный фон ⇒ совпадение, ребро отбрасывается.
 *
 * Острота пика меряется по peakWindow (= windowK·τ, окно сита), НЕ по голому τ:
 * иначе брат с лагом чуть больше τ ложно выпадает и пара рвётся.
 */
declare function lagXCorr(tbl: EventTable, edges: Edge[], peakThreshold: number, peakWindow: number): DirectedEdge[];

/**
 * Слой 4 — кластеризация каналов в авторов (union-find / connected components).
 * Каждое направленное ребро «братства» сливает два канала в один кластер.
 * Возвращает карту channel → целочисленный id кластера.
 */
declare function clusterAuthors(channels: string[], edges: DirectedEdge[]): AuthorMap;

/**
 * Слой 5 — early-warning по НЕЗАВИСИМЫМ кластерам-авторам.
 *
 * Для каждого (symbol,direction) скользящим окном считает плотность не каналов,
 * а РАЗНЫХ кластеров. Всплеск из N каналов одного автора → 1 кластер → skip.
 * Всплеск из ≥ minClusters независимых кластеров → open.
 *
 * confidence = dedup × fill × hawkes × leadership, где
 *   dedup     = clusters/channels (1 = все источники независимы, <1 = дубли автора)
 *   fill      = насыщенность окна относительно minClusters·2
 *   hawkes    = слой 6: дисконт всплеска, не превысившего порог случайности фона
 *               тикера (пачка постов на вечно шумном тикере ≠ пачка на тихом)
 *   leadership= слой 7: дисконт всплеска из одних «эхо»-каналов (лидеры молчат);
 *               нейтральный/лидерский состав → 1 (без изменений)
 */
declare function earlyWarning(tbl: EventTable, clusterOf: AuthorMap, cfg: DetectorConfig, tau: number, 
/** влиятельность каналов из направленного графа (слой 7); нет → нейтрально */
influence?: Map<string, number>): PumpVerdict[];

/**
 * Слой 6 — САМОВОЗБУЖДЕНИЕ потока событий (Hawkes-интенсивность).
 *
 * Памп — самовозбуждающийся каскад: пост порождает посты (пересылы, братские
 * каналы, реакция других авторов). Голый счёт событий в окне (слой 5) не
 * различает «5 постов за час на тикере, где обычно 5 постов в час» и «5 постов
 * за час на тикере, где пост бывает раз в неделю». Hawkes-мера различает:
 *
 *   возбуждение E(t) = Σ_{tᵢ<t} exp(−(t−tᵢ)/τ)   — экспоненциальное ядро, τ из слоя 1
 *   фон       λ₀·τ  = средняя скорость группы × τ — матожидание E при Пуассоне
 *
 * burstScore = E / (λ₀τ + 2·√(λ₀τ) + ε) — кратность превышения ПОРОГА СЛУЧАЙНОСТИ
 * (та же конвенция λ+2√λ, что в viability). score ≥ 1 — возбуждение статистически
 * не объяснимо фоном; score < 1 — «всплеск» в пределах обычной болтовни тикера.
 *
 * Используется как вес confidence в earlyWarning: разреженный тикер с внезапной
 * пачкой постов ценнее, чем вечно шумный с той же пачкой.
 */
interface HawkesBurst {
    /** кратность превышения порога случайности (≥1 = значимо) */
    score: number;
    /** сырое возбуждение E(t) на момент события */
    excitation: number;
    /** порог случайности λ₀τ + 2√(λ₀τ) */
    chanceBound: number;
}
declare function hawkesBurst(
/** ts событий группы (symbol,direction), отсортированы по возрастанию */
groupTs: number[], 
/** индекс события-якоря, на момент которого меряем интенсивность */
idx: number, 
/** характерный лаг τ, мс (из selfTuneLag) */
tau: number): HawkesBurst;
/** Вес для confidence: ниже порога случайности — дисконт, выше — без штрафа. */
declare const hawkesWeight: (score: number) => number;

/**
 * Слой 7 — ВЛИЯТЕЛЬНОСТЬ авторов из направленного lead-lag графа.
 *
 * Слой 3 уже знает, КТО ЗА КЕМ повторяет (leader/follower с остротой пика), но
 * до сих пор эта информация схлопывалась в ненаправленный union-find (слой 4).
 * Направление несёт сигнал: всплеск, в котором участвуют ЛИДЕРЫ графа, и всплеск
 * из одних «эхо»-каналов (чьи лидеры молчат) — разные события. Эхо без лидера —
 * подозрение на копипасту/бота, а не на независимое подтверждение.
 *
 * influence ∈ [0,1] на канал: сглаженная (Лаплас) доля лидерства по рёбрам,
 * взвешенная остротой пика ребра:
 *
 *   influence = (0.5 + Σ_lead peakShare) / (1 + Σ_lead peakShare + Σ_follow peakShare)
 *
 * Изолированный канал (нет рёбер) → нейтральные 0.5: независимость не награда
 * и не штраф, мы просто ничего не знаем о его роли.
 */
declare function authorInfluence(channels: string[], edges: DirectedEdge[]): Map<string, number>;
/**
 * Вес всплеска по лидерству участников: среднее influence каналов среза,
 * нормированное так, что нейтральный состав (0.5) → 1 (без изменений),
 * чистое эхо → дисконт к 0, лидеры → без бонуса (консервативно, cap 1).
 */
declare function leadershipWeight(sliceChannels: Iterable<string>, influence: Map<string, number>): {
    weight: number;
    leaderShare: number;
};

/**
 * Слой 9 — MULTIVARIATE HAWKES: одна генеративная модель вместо конвейера
 * jaccard-сито → медианный лаг → union-find.
 *
 * Интенсивность канала j:
 *
 *   λ_j(t) = μ_j + Σ_i Σ_{t_ik < t} α_ij · β · exp(−β(t − t_ik)),   β = 1/τ
 *
 * α_ij — среднее число «эхо»-событий канала j, порождаемых ОДНИМ событием
 * канала i. EM-оценка: E-шаг раскладывает каждое событие на «фон» и «потомка
 * конкретного предка» по ответственностям, M-шаг обновляет α = масса потомков /
 * число событий предка и μ = фоновая масса / экспозиция. Диагональ α_ii
 * (самовозбуждение серий постов) оценивается, но в рёбра не идёт — она
 * впитывает внутриканальные очереди, чтобы те не раздували кросс-α.
 *
 * Значимость ребра — та же пуассоновская конвенция, что в viability: масса
 * потомков m_ij должна превысить ожидание случайных коинциденций λ + 2√λ.
 * Так исчезают ТРИ независимых порога конвейера (jaccardThreshold,
 * lagPeakThreshold, peakShare) — их роль берёт на себя правдоподобие.
 *
 * Включается config.authorGraph = "hawkes" (по умолчанию "xcorr" — прежний
 * конвейер, поведение без флага не меняется).
 */
interface HawkesGraph {
    channels: string[];
    /** α[i][j]: события канала i порождают в среднем α_ij событий канала j */
    alpha: number[][];
    /** фоновые интенсивности μ_j, событий/мс */
    mu: number[];
    /** β = 1/τ экспоненциального ядра */
    beta: number;
    /** значимые направленные рёбра (совместимы со слоями 4/7) */
    edges: DirectedEdge[];
}
declare function fitHawkesGraph(tbl: EventTable, tau: number): HawkesGraph;

/**
 * Слой 8 — АЛГОРИТМИЧЕСКАЯ СИГНАТУРА канала (формализация habr 1028592).
 *
 * В исследовании алгоритмическое происхождение сигналов выдали механические
 * паттерны: решётка интервалов между постами (одинаковые множители) и посты по
 * расписанию. Такой канал — не человек с инсайтом, а бот-стратегия, и его
 * сигналы часто анти-предиктивны (стоп-хант: 8/8 шортов TRX двинулись против) —
 * кандидат на ИНВЕРСИЮ, а не на следование.
 *
 * Две интерпретируемые компоненты, обе ∈ [0,1]:
 *  - intervalRegularity: 1 − нормированная энтропия лог-гистограммы интервалов
 *    между постами. Метроном → энтропия 0 → регулярность 1; человеческий поток
 *    (широкое распределение) → регулярность ≈ 0.
 *  - modalHourShare*: доля постов в модальном часе суток (UTC), нормированная
 *    от фона 1/24 к 1. Бот на cron постит в одно время; человек размазан.
 *
 * algoScore = max(компонент): любой ОДИН механический паттерн — уже сигнатура.
 * n < 8 → algoScore 0 (не судим по паре постов). Это ДИАГНОСТИКА (advisory):
 * сериализуется в channelScore, решение «инвертировать/выкинуть канал» — за
 * оператором, у которого есть контекст.
 */
interface AlgoSignature {
    /** итоговое подозрение на алгоритмическое происхождение, 0..1 */
    algoScore: number;
    /** регулярность интервалов (1 = метроном/решётка) */
    intervalRegularity: number;
    /** концентрация по часу суток, нормированная (1 = все посты в один час) */
    modalHourConcentration: number;
    /** по скольким постам судим */
    n: number;
}
declare function algoSignatureOf(postTs: number[]): AlgoSignature;

/**
 * Single-channel fallback. Когда корреляция недоступна (один канал / mode="single"),
 * матрица авторства пуста и earlyWarning молчит. Но даже один пост двигает рынок:
 * аудитория входит, возникает краткосрочный импульс. Поэтому здесь КАЖДЫЙ пост =
 * сигнал к входу, а вся ответственность за результат — на обученном exit
 * (trailing take / hard stop / staleness / импакт-горизонт), который уже доказал,
 * что отделяет памп от stop hunt.
 *
 * Дедупликация: несколько постов по одному (symbol,direction) в пределах окна
 * схлопываются в один вход (повторный пост в активную позицию — не новый вход).
 */
declare function singleChannelSignals(tbl: EventTable, cfg: DetectorConfig, tau: number): PumpVerdict[];

/**
 * Жизнеспособность матрицы авторства. Отвечает на вопрос «достаточно ли в данных
 * структуры, чтобы доверять корреляции», а НЕ «выдала ли матрица хоть что-то».
 *
 * Без этого auto оставался бы в matrix даже на двух каналах со ШУМОВЫМ совпадением
 * (Jaccard случайно перевалил порог на 1-2 событиях) и выдавал бы ложный сигнал.
 * Строгий критерий: матрица годна только при ЯВНЫХ кластерах И достаточном
 * событийном перекрытии; иначе — откат в single.
 */
declare const DEFAULT_VIABILITY: ViabilityConfig;
declare function assessViability(tbl: EventTable, directed: DirectedEdge[], authors: AuthorMap, cfg?: ViabilityConfig, 
/** окно синхронности для оценки случайного перекрытия (нужно при autoOverlap) */
windowMs?: number): ViabilityReport;

/**
 * Объёмная математика детектора каскада ликвидаций. ПОЛНОСТЬЮ СИММЕТРИЧНА по
 * направлению — long-trap и short-trap это зеркала одного механизма:
 *
 *   short-squeeze: толпа шортит на плече → стена ликвидаций СВЕРХУ → каскад
 *                  форсированных buy толкает вверх (против short).
 *   long-cascade:  толпа лонгует на плече → стена ликвидаций СНИЗУ → каскад
 *                  форсированных sell толкает вниз (против long).
 *
 * Отличить ловушку от честного движения: при каскаде объём растёт на свечах,
 * где цена идёт ПРОТИВ позиции (ликвидации — форсированные сделки против толпы).
 * При честном движении объём растёт В СТОРОНУ позиции. Знак «против» определяется
 * через направление, поэтому формула одна на оба случая.
 */
interface VolumeFeatures {
    /** z-score объёма входной свечи против базлайна до входа: накопление плечевого топлива */
    volZ: number;
    /** доля объёма на движениях ПРОТИВ позиции в окне после входа (0..1): сигнатура каскада */
    squeezePressure: number;
}
/**
 * volZ: насколько объём входной свечи аномален против скользящего окна ДО входа.
 * Высокий volZ = синхронный заход толпы в плечо (та самая «синяя свеча» из 1028592).
 * baselineWindow — сколько свечей до входа берём за норму.
 */
declare function volumeZScore(candles: ICandleData[], entryIdx: number, baselineWindow: number): number;
/**
 * squeezePressure: доля объёма в окне после входа, пришедшегося на свечи, где цена
 * двигалась ПРОТИВ позиции. Симметрично: для long «против» = свеча закрылась ниже
 * открытия (давление вниз, каскад sell); для short «против» = выше (каскад buy).
 *
 * Высокое значение → движение питается ликвидациями толпы, а не честным потоком →
 * это ловушка (stop hunt / squeeze), входить опасно либо выходить раньше.
 */
declare function squeezePressure(candles: ICandleData[], entryIdx: number, dir: Direction, horizon: number): number;
/** Считает оба признака разом для входа на entryIdx. */
declare function volumeFeatures(candles: ICandleData[], entryIdx: number, dir: Direction, baselineWindow: number, horizon: number): VolumeFeatures;
/** Режим объёма по порогу volZ: спокойный или аномальный (топливо накоплено). */
type VolRegime = "calm" | "anomalous";
declare const volRegimeOf: (volZ: number, threshold: number) => VolRegime;

/**
 * Точная симуляция prod-выхода по минутным свечам (listenActivePing на закрытии
 * каждой 1m-свечи). Метка обучения = то, что реально снимет твой выход, а не
 * close-to-close. Так stop hunting отсекается: прокол не дотягивает до trailingTake,
 * а откат бьёт hard stop → отрицательная метка, даже если close[t+H] положительный.
 *
 * moonbag (long)  — hard stop НИЖЕ входа.
 * gravebag (short) — hard stop ВЫШЕ входа.
 */
interface ExitParams {
    /** trailing take: откат от пикового PnL%, при currentProfit ≥ 0 → выход */
    trailingTake: number;
    /** hard stop: фикса % от входа против позиции */
    hardStop: number;
    /** peak staleness: пик должен достичь этого PnL%, чтобы таймер протухания включился */
    stalenessSinceProfit: number;
    /** peak staleness: минут без нового пика → выход */
    stalenessSinceMinutes: number;
    /** потолок жизни позиции в минутных свечах (эмпирически подбираемый импакт-горизонт) */
    staleMinutes: number;
    /** baseline-окно для volZ (свечей до входа); если не задано — volZ не считается */
    volBaselineWindow?: number;
    /** порог volZ для разметки режима calm/anomalous */
    volZThreshold?: number;
    /** политика реакции на каскад: tighten (туже trailing) | veto (не входить) | none */
    squeezePolicy?: "none" | "tighten" | "veto" | "invert" | "ignore";
    /** порог squeezePressure, выше которого срабатывает policy */
    squeezeThreshold?: number;
    /** множитель ужатия trailing при policy="tighten" (0.5 = вдвое туже) */
    tightenFactor?: number;
    /**
     * Окно детекции каскада ликвидаций в минутах — НЕЗАВИСИМО от staleMinutes.
     * Сквиз/каскад это БЫСТРОЕ событие (минуты), его нельзя мерить на 24ч-горизонте
     * удержания: длинное окно размывает резкий разворот. Раньше брался staleMinutes,
     * что связывало два несвязанных концерна (жизнь позиции и окно детектора).
     * Если не задано — fallback на staleMinutes (обратная совместимость).
     */
    cascadeWindowMinutes?: number;
    /**
     * Суммарная стоимость round-trip (комиссии тейкера на вход+выход + проскальзывание),
     * % от нотионала. Вычитается из реализованного pnl КАЖДОЙ вошедшей сделки —
     * бэктест без издержек систематически красивее реальности, особенно на
     * низколиквидных памп-коинах. 0 / не задано = идеальное исполнение (старое поведение).
     * Это КОНСТАНТА СРЕДЫ (твоя биржа/тариф), не ось оптимизации grid.
     */
    roundTripCostPct?: number;
    /**
     * STATE-DEPENDENT проскальзывание: доля ДИАПАЗОНА свечи-исполнения, приложенная
     * против позиции на входе И на выходе. Константная издержка занижает боль ровно
     * там, где она максимальна: на сигнальной свече пампа и на свече каскада спред
     * взрывается вместе с range. slip = k·(high−low)/entry на каждой из двух свечей
     * исполнения — стоп в обвале автоматически дороже стопа в тишине.
     * Аппроксимация вычетом из pnl (уровни триггеров не сдвигаются). 0 = выкл.
     * КОНСТАНТА СРЕДЫ (глубина твоего размера в стакане), не ось grid.
     */
    slippageRangeFrac?: number;
}
type ExitReason = "trailing-take" | "hard-stop" | "peak-staleness" | "life-cap" | "cascade-veto" | "invert" | "no-entry";
interface ReplayResult {
    /**
     * реализованный НЕТТО PnL% (в долях: 0.05 = +5%), за вычетом roundTripCostPct.
     * hard-stop = -hardStop%; trailing/staleness = close свечи-триггера (НЕ пик —
     * прод выходит маркетом по close, пик нереализуем); life-cap = close последней свечи.
     */
    pnl: number;
    reason: ExitReason;
    /** пиковый PnL% за жизнь позиции (MFE) */
    peak: number;
    /** наихудший PnL% за жизнь позиции (MAE, ≤0; при стопе = −hardStop%) — сырьё для
     *  квантильного подбора стопа: p90 |MAE| победителей режет лузеров, не задевая винеров */
    trough: number;
    /** минут от входа до выхода */
    heldMinutes: number;
    entered: boolean;
    /** цена входа (close в зоне либо clamp midpoint). 0 если не вошли. */
    entryPrice: number;
    /** цена выхода, по которой реализован pnl. 0 если не вошли. */
    exitPrice: number;
    /** z-score объёма входной свечи (накопление плечевого топлива) */
    volZ: number;
    /** доля объёма против позиции (сигнатура каскада ликвидаций) */
    squeezePressure: number;
    /** режим объёма на входе: calm | anomalous */
    volRegime: VolRegime;
    /** была ли позиция инвертирована (policy=invert сработал) */
    inverted: boolean;
    /** замер горизонта неполный: после входа не хватило свечей на полный life-cap */
    truncated: boolean;
}
/**
 * Прогоняет 1m-свечи через prod-выход. candles должны быть отсортированы по ts
 * и покрывать окно от события вперёд (минимум до staleMinutes).
 *
 * entryFrom/entryTo — зона входа: вход на первой свече, чей хвост пересекает зону.
 * entryPrice = close, если он попал в зону, иначе clamp midpoint к [low,high].
 * Цена входа = кламп середины зоны в диапазон свечи (консервативно — фактическое касание).
 */
declare function replayExit(candles: ICandleData[], dir: Direction, entryFrom: number, entryTo: number, p: ExitParams): ReplayResult;

/**
 * Tensor exit-параметров: mode → channel → symbol → direction → volRegime → ExitParams.
 *
 * Математика выхода НЕ смешивается между источниками: каждая ячейка обучается
 * только на своих replay-результатах. Каскад ликвидаций симметричен, но long-trap
 * и short-trap получают РАЗНЫЕ ячейки (разная динамика разворота), и режим объёма
 * (calm/anomalous) тоже разделён — short в аномальном объёме это накопленное
 * топливо для сквиза, exit там должен быть туже.
 *
 * Иерархический fallback при пустой ячейке:
 *   [mode][channel][symbol][direction][volRegime]
 *     → схлопнуть volRegime: [mode][channel][symbol][direction]
 *     → схлопнуть direction: [mode][channel][symbol]
 *     → [mode]  →  global
 */
type RegimeCell = Partial<Record<VolRegime, ExitParams>>;
type DirCell = Partial<Record<Direction, RegimeCell>>;
type SymbolCell = Record<string, DirCell>;
type ChannelCell = Record<string, SymbolCell>;
interface ExitTensor {
    cells: {
        matrix: ChannelCell;
        single: ChannelCell;
    };
    /** уровень символа+направления (схлопнут volRegime) */
    bySymbolDir: {
        matrix: Record<string, Partial<Record<Direction, ExitParams>>>;
        single: Record<string, Partial<Record<Direction, ExitParams>>>;
    };
    /** уровень режима (схлопнуты канал/символ/направление) */
    byMode: {
        matrix: ExitParams;
        single: ExitParams;
    };
    /** корень дерева */
    global: ExitParams;
}
type ResolveSource = "cell" | "symbol-dir" | "mode" | "global";
interface ResolvedExit {
    exit: ExitParams;
    source: ResolveSource;
}
/**
 * Иерархический резолвер. Возвращает exit + уровень, с которого он разрешён,
 * чтобы прод видел, обучен ли он персонально под (канал,символ,направление,режим)
 * или это fallback.
 */
declare function resolveExit(tensor: ExitTensor, mode: "matrix" | "single", channel: string, symbol: string, direction: Direction, volRegime: VolRegime): ResolvedExit;
/**
 * Резолв БЕЗ volRegime (свечей нет): пропускаем cell-уровень (требует режима),
 * начинаем с symbol-dir → mode → global.
 */
declare function resolveExitNoRegime(tensor: ExitTensor, mode: "matrix" | "single", symbol: string, direction: Direction): ResolvedExit;

/** Кандидат-всплеск без применённого порога minClusters — для переиспользования в grid. */
interface CandidateBurst {
    symbol: string;
    direction: Direction;
    ts: number;
    independentClusters: number;
    totalChannels: number;
    confidence: number;
    /** id якорного (последнего в окне) события — для сопоставления с парсингом */
    id?: string;
    /** id ВСЕХ событий, вошедших во всплеск (в matrix может быть несколько) */
    ids?: string[];
}
/**
 * Перечисляет ВСЕ всплески при заданных (windowK, jaccardThreshold, lagPeakThreshold),
 * НЕ отсекая по minClusters — это делает grid дёшево поверх готового списка.
 * Кластеризация зависит от jaccard/lag/windowK, поэтому пересчитывается на эти оси grid;
 * а minClusters — пост-фильтр, его перебор бесплатный.
 */
declare function enumerateBursts(items: ParserItem[] | SignalEvent[], windowK: number, jaccardThreshold: number, lagPeakThreshold: number, maxBurstWindowMs: number, stationarityWindowMs?: number): CandidateBurst[];
/**
 * Перечисляет КАЖДЫЙ пост как кандидата (single-channel fallback), схлопывая
 * близкие посты по одному (symbol,direction) в пределах окна в один вход.
 * independentClusters=1 всегда — фильтра качества нет, исход решает exit.
 */
declare function enumeratePosts(items: ParserItem[] | SignalEvent[], windowK: number, maxBurstWindowMs: number): CandidateBurst[];

/**
 * Размеченный всплеск: реализованный PnL по prod-выходу для каждого набора
 * exit-параметров. Метку ставит симуляция твоего trailing/hard-stop по 1m-свечам,
 * а не close-to-close — поэтому stop hunting получает отрицательную метку.
 */
interface LabeledBurst {
    symbol: string;
    direction: Direction;
    ts: number;
    /** ключ exit-набора → результат replay */
    byExit: Map<string, ReplayResult>;
}
/**
 * Исход разметки одного кандидата. Диагностика «немых» пустых fit: пустой результат
 * выглядит одинаково для «нет данных» и «нет входов», а это РАЗНЫЕ проблемы (битый
 * getCandles vs реально не было входов в зону).
 *  - ok           — размечен, есть вход (burst != null);
 *  - adapter-error — getCandles бросил (look-ahead guard / дыра / count-mismatch);
 *  - no-candles    — getCandles вернул пусто (символ/диапазон не дали свечей);
 *  - no-entry      — свечи есть, но ни один exit-набор не вошёл в зону (или все truncated).
 */
type LabelOutcome = "ok" | "adapter-error" | "no-candles" | "no-entry";
/** Результат labelBurst: типизированный исход + сам размеченный всплеск (null кроме ok). */
interface LabelResult {
    outcome: LabelOutcome;
    burst: LabeledBurst | null;
    /** текст брошенного getCandles исключения (только при outcome="adapter-error"). */
    error?: string;
}
/** Стабильный строковый ключ exit-набора для кэша/grid. */
declare const exitKey: (p: ExitParams) => string;
/**
 * Достаёт 1m-свечи от события вперёд на покрытие максимального life-cap и
 * прогоняет каждый exit-набор через replay. Зона входа берётся из события;
 * если не задана — точка entryFrom=entryTo=open первой свечи.
 */
declare function labelBurst(getCandles: GetCandles, symbol: string, direction: Direction, ts: number, exitSets: ExitParams[], entryFromPrice?: number, entryToPrice?: number): Promise<LabelResult>;

/**
 * Кэширующая обёртка над getCandles (ключ = symbol|interval|limit|since).
 *
 *  - PROMISE-DEDUP: конкурентные запросы одного окна (пул разметки) сливаются в
 *    один сетевой вызов — оба ждут общий promise, а не бьют биржу дважды.
 *  - FIFO-кап держит память (окно 1445 свечей ≈ 130КБ; cap 512 ≈ 65МБ worst-case).
 *  - Переживает границы fit: walkForward оборачивает источник ОДИН раз и передаёт
 *    во все срезы — K переобучений не перезапрашивают одну и ту же историю.
 *
 * Запросы с eDate не кэшируются (внутренние пути либы их не используют).
 * Ошибка источника НЕ кэшируется — следующий вызов попробует снова.
 */
declare function withCandleCache(getCandles: GetCandles, capacity?: number): GetCandles;
/** Максимум свечей в одном чанке (как CC_MAX_CANDLES_PER_REQUEST в проде). */
declare const MAX_CANDLES_PER_CHUNK = 500;
/**
 * Chunked-загрузчик свечей. Дублирует логику пагинации из prod-адаптера: если
 * запрошено больше MAX_CANDLES_PER_CHUNK, бьёт на чанки, двигая since вперёд на
 * chunkLimit·step, и склеивает с дедупликацией по timestamp.
 *
 * Зачем внутри либы: labelBurst под длинный импакт-горизонт (staleMinutes до 1440)
 * просит staleMinutes·2+5 ≈ 2885 свечей. Если адаптер пагинацию НЕ делает сам и
 * упирается в лимит биржи, либа должна разрулить это сама, а не зависеть от того,
 * как реализован чужой getCandles.
 *
 * Семантика — forward от since (case sDate+limit): возвращает ровно столько свечей,
 * сколько доступно, начиная с align(since). Если адаптер на каком-то чанке вернул
 * пусто (край истории / дыра) — останавливаемся и отдаём, что собрали.
 */
declare function fetchCandlesChunked(getCandles: GetCandles, symbol: string, interval: CandleInterval, limit: number, since: number, chunkSize?: number): Promise<ICandleData[]>;

/**
 * Достоверность обучения. Отвечает на вопрос «можно ли доверять подобранным
 * порогам», а НЕ «велик ли эдж». На малой выборке confidence низкий и
 * reliable=false (либа работает, но честно предупреждает); по мере роста
 * данных все три оси растут → confidence→1, reliable переключается сам.
 *
 *   confidence = support × stability × significance   (каждое в [0,1])
 *
 * Менять код при росте выборки не нужно — формула пересчитывает доверие.
 */
interface ReliabilityInput {
    /** per-fold средние forward-return на валидации */
    foldMeans: number[];
    /** per-fold размеры валидационных выборок */
    foldSizes: number[];
    /** все валидационные ретёрны (для значимости против нуля) */
    allReturns: number[];
}
interface Reliability {
    confidence: number;
    reliable: boolean;
    support: number;
    stability: number;
    significance: number;
    totalN: number;
}
interface ReliabilityConfig {
    /** при N=supportK вклад объёма ≈ 0.5 */
    supportK: number;
    /** порог confidence для reliable=true */
    confidenceThreshold: number;
    /** минимум суммарных сделок для reliable=true */
    minN: number;
}
declare const DEFAULT_RELIABILITY: ReliabilityConfig;
declare function computeReliability(input: ReliabilityInput, cfg?: ReliabilityConfig): Reliability;

/**
 * Прогрессбар обучения. Train делает вложенные циклы: фаза разметки (медленная,
 * каждый кандидат = await getCandles по 1m-свечам) и фаза grid-скоринга (быстрая,
 * чистый CPU по кэшу). Бар отражает РЕАЛЬНУЮ работу — тики разметки, где идёт IO.
 *
 * Передаётся в train как опция onProgress; по умолчанию пишет в stdout в стиле,
 * заданном пользователем. В тестах подменяется на no-op или сборщик, чтобы не
 * засорять вывод.
 */
interface ProgressEvent {
    /** сколько единиц обработано */
    done: number;
    /** всего единиц в текущей фазе */
    total: number;
    /** метка фазы: "label" (разметка) | "score" (grid) | "nested" (CV) | "refine" (уточнение шага) */
    phase: "label" | "score" | "nested" | "refine";
    /** что сейчас обрабатывается (символ/ключ кластеризации) — для контекста */
    label: string;
}
type ProgressFn = (e: ProgressEvent) => void;
/** Дефолтный stdout-бар в стиле пользователя. */
declare const stdoutProgress: ProgressFn;
/** No-op для тестов/тихого режима. */
declare const silentProgress: ProgressFn;

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
type SignalAction = "enter" | "invert" | "tighten";
/** Плоский исполняемый exit-план. Готов к передаче в openPosition без доработки. */
interface ExitPlan {
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
interface SignalOrigin {
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
interface TradeSignal {
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
    probability?: {
        pWin: number;
        expectedPnl: number;
        informative: boolean;
    } | null;
    /** происхождение (аудит), не для ветвления */
    origin: SignalOrigin;
}
/**
 * Реализованный результат сделки — РЕПЛЕЙ exit-плана по свечам ПОСЛЕ входа.
 * Существует только в backtest (forward-replay по закрытой истории); plan/signals
 * его НЕ дают (там позиция ещё не закрыта). pnl/peak в долях (0.05 = +5%).
 */
interface BacktestResult {
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
interface BacktestSignal extends TradeSignal {
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
type AllowAction = "enter" | "invert" | "tighten";
interface SignalPolicy {
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
}
declare const DEFAULT_POLICY: SignalPolicy;
/**
 * Пересечение политик: эффективный allow = trained ∩ requested.
 * Реализует readonly-инвариант — запрос не может разрешить то, чего нет в обученной.
 * RR-фильтр (minRiskReward/rrMetric) — чисто рантаймовый: запрос может его ужесточить,
 * обученная политика дефолта не несёт (RR-статистика отдельно в params.riskReward).
 */
declare function intersectPolicy(trained: SignalPolicy, requested?: Partial<SignalPolicy>): SignalPolicy;

/**
 * Математический аппарат для отличия РЕАЛЬНОГО эджа от ВЫБРОСА/оверфита.
 *
 * Брутфорс-grid (argmax по CV из N конфигов) систематически выдаёт ложный эдж:
 * максимум N шумных оценок смещён вверх на ≈ σ·√(2·ln N) даже при истинном эдже 0.
 * Эти функции дают СТАТИСТИЧЕСКИЙ СЕРТИФИКАТ, а не «score повыше».
 *
 * Ссылки: López de Prado (Deflated Sharpe 2014, PBO 2015, minTRL),
 * White (Reality Check 2000), Hansen (SPA 2005), Politis-Romano (stationary
 * bootstrap 1994), Breiman (1-SE 1984).
 *
 * Все функции — чистые над массивами ретёрнов сделок. Без внешних зависимостей.
 */
declare function mean(a: number[]): number;
declare function variance(a: number[]): number;
declare function stdev(a: number[]): number;
/** Выборочный коэффициент асимметрии (Fisher-Pearson). */
declare function skewness(a: number[]): number;
/** Выборочный куртозис (НЕ excess: нормаль = 3). */
declare function kurtosis(a: number[]): number;
/** Sharpe ratio по ряду ретёрнов (без аннуализации; per-trade). */
declare function sharpe(returns: number[]): number;
/** CDF стандартной нормали через erf-приближение Abramowitz-Stegun 7.1.26. */
declare function normalCdf(z: number): number;
/** Обратная нормаль (quantile) — Acklam 2003. Точность ~1e-9 в [1e-15, 1-1e-15]. */
declare function normalInv(p: number): number;
/**
 * Ожидаемый МАКСИМАЛЬНЫЙ Sharpe при истинном эдже 0, если перебрано N независимых
 * конфигураций с дисперсией SR-оценок varSR. Это «планка случайности»: насколько
 * высокий Sharpe выскочит из чистого шума просто потому, что мы выбрали лучший из N.
 *
 * E[max] ≈ √varSR · [(1−γ)·Z(1−1/N) + γ·Z(1−1/(N·e))]   (López de Prado 2014)
 */
declare function expectedMaxSharpe(varSR: number, nTrials: number): number;
/**
 * Deflated Sharpe Ratio: вероятность, что ИСТИННЫЙ Sharpe > порога случайности,
 * с поправкой на (а) число испытаний N, (б) асимметрию/куртозис ряда, (в) длину T.
 *
 * DSR = Φ( (SR − SR0)·√(T−1) / √(1 − skew·SR + (kurt−1)/4·SR²) )
 *
 * SR — наблюдаемый Sharpe лучшей стратегии; SR0 — expectedMaxSharpe(varSR, N).
 * Возвращает p ∈ [0,1]. p ≥ 0.95 → эдж РЕАЛЕН с учётом перебора. На малой выборке
 * или огромном N → p ≈ 0 (честный отказ вместо ложного «reliable»).
 */
declare function deflatedSharpe(returns: number[], nTrials: number, varSRAcrossTrials: number): number;
/**
 * Минимальная длина ряда (число сделок), при которой наблюдаемый Sharpe значим на
 * уровне α (по умолчанию 0.05). Если фактическое N < minTRL — выборки физически НЕ
 * хватает, любой вывод преждевременен. Это «сколько сделок до доверия».
 *
 * minTRL = 1 + [1 − skew·SR + (kurt−1)/4·SR²]·(Z_α / SR)²   (López de Prado)
 */
declare function minTrackRecordLength(returns: number[], alpha?: number): number;
/**
 * Probability of Backtest Overfitting через Combinatorially-Symmetric CV (CSCV).
 *
 * Матрица M[config][fold] (perf каждого конфига на каждом фолде). Делим S фолдов
 * на все C(S, S/2) комбинаций IS/OOS. На каждой: выбираем лучший конфиг по IS,
 * смотрим его РАНГ на OOS. Если IS-лучший систематически плох на OOS — это оверфит.
 *
 * PBO = доля разбиений, где IS-лучший попал в нижнюю половину OOS (logit < 0).
 * PBO → 0.5 = чистый оверфит; PBO → 0 = эдж переносится OOS.
 *
 * @param perf perf[c][f] — метрика конфига c на фолде f (больше = лучше)
 */
declare function probabilityOfBacktestOverfitting(perf: number[][]): number;
/**
 * Stationary bootstrap (Politis-Romano 1994): ресэмпл ряда блоками случайной
 * геометрической длины (средняя 1/p), сохраняя автокорреляцию. Для зависимых рядов
 * сделок обычный i.i.d. бутстрэп даёт оптимистичный результат — блочность чинит это.
 */
declare function stationaryBootstrapResample(returns: number[], pBlock: number, rng: () => number): number[];
/** Детерминированный ГПСЧ (mulberry32) — воспроизводимые бутстрэп-прогоны в тестах. */
declare function mulberry32(seed: number): () => number;
/**
 * White's Reality Check / Hansen SPA через stationary bootstrap.
 * H0: лучшая из N стратегий НЕ лучше бенчмарка 0 (весь эдж — data-snooping).
 *
 * Статистика V = max_k √T · mean(returns_k). Бутстрэпим центрированные ряды,
 * считаем распределение макс-статистики при H0, p-value = доля бутстрэп-V,
 * превысивших наблюдаемый V. p ≤ 0.05 → отвергаем H0 (эдж не объясним перебором).
 *
 * @param strategiesReturns массив рядов (по одному на конфиг-кандидат)
 */
declare function realityCheckPValue(strategiesReturns: number[][], opts?: {
    bootstraps?: number;
    pBlock?: number;
    seed?: number;
}): number;
/**
 * Итоговый сертификат: пять барьеров López de Prado / White / Hansen.
 * certified=true ТОЛЬКО если эдж переживает поправку на N испытаний, не оверфит
 * по CSCV, не объясним data-snooping, и выборки достаточно.
 */
interface CertificationInput {
    /** ретёрны ВЫБРАННОЙ стратегии (по сделкам) */
    selectedReturns: number[];
    /** число перебранных конфигураций (N испытаний) */
    nTrials: number;
    /** дисперсия Sharpe-оценок ПО испытаниям (для DSR planка) */
    varSRAcrossTrials: number;
    /** perf[config][fold] для PBO (CSCV) */
    perfMatrix: number[][];
    /** ретёрны всех конфигов-кандидатов для SPA */
    candidateReturns: number[][];
    /** несмещённый nested-CV OOS score (null если не считался) */
    nestedScore: number | null;
}
interface Certification {
    certified: boolean;
    dsr: number;
    pbo: number;
    spaPValue: number;
    minTRL: number;
    actualN: number;
    nestedScore: number | null;
    reasons: string[];
}
declare function certifyStrategy(inp: CertificationInput, thresholds?: {
    dsr?: number;
    pbo?: number;
    spa?: number;
}): Certification;

/**
 * Мета-учёт переобучений — против МЕТА-winner's-curse.
 *
 * Проблема (Tripolsky): DSR штрафует N конфигов ВНУТРИ одного fit, но если гонять
 * fit 720 раз за месяц (ежечасно) и торговать только когда выпал certified=true —
 * это повторный перебор УЖЕ ПО ВРЕМЕНИ. Каждый «сертифицированный» прогон может быть
 * тем самым выбросом среди 720 попыток. Сертификат на отдельном fit слеп к цепочке.
 *
 * Лечение (двухчастное):
 *  1) CADENCE GUARD: запрет частого переобучения. fit разрешён не чаще minRefitMs
 *     (дни/недели, не часы). Частые refit = размножение испытаний.
 *  2) FAMILY-WISE коррекция: эффективное число испытаний = N_внутри × число_fit_попыток.
 *     ВСЕ попытки логируются (не только certified), иначе знаменатель занижен и
 *     поправка лжёт. DSR на эффективном N нейтрализует мета-curse (доказано тестом:
 *     720 fit на шуме → наивно 2 ложных, мета 0).
 */
interface FitAttempt {
    /** когда запущен fit (ms epoch) */
    ts: number;
    /** число конфигов в гриде этого fit (внутренние испытания) */
    innerTrials: number;
    /** сертифицирован ли ЭТОТ fit по собственному (наивному) критерию */
    certifiedNaive: boolean;
}
interface MetaLedgerState {
    /** ВСЕ попытки fit, не только успешные — иначе знаменатель занижен */
    attempts: FitAttempt[];
}
interface MetaPolicy {
    /** минимальный интервал между fit (ms). По умолчанию 7 дней. */
    minRefitMs: number;
}
declare const DEFAULT_META_POLICY: MetaPolicy;
/** Пустой реестр. */
declare function emptyLedger(): MetaLedgerState;
/**
 * Разрешён ли новый fit сейчас по cadence-политике. Возвращает {allowed, reason,
 * nextAllowedTs}. Частое переобучение размножает испытания → запрещаем.
 */
declare function canRefit(ledger: MetaLedgerState, now: number, policy?: MetaPolicy): {
    allowed: boolean;
    reason: string;
    nextAllowedTs: number;
};
/** Регистрирует попытку fit (ЛЮБУЮ — и certified, и нет). Возвращает новый реестр. */
declare function recordAttempt(ledger: MetaLedgerState, attempt: FitAttempt): MetaLedgerState;
/**
 * Эффективное число испытаний для family-wise коррекции DSR: суммарно по ВСЕМ
 * fit-попыткам, не только текущей. Если за месяц было M fit-ов с N конфигов каждый —
 * эффективно перебрано до Σ Nᵢ гипотез. Это и есть честный знаменатель для DSR.
 *
 * Используется как nTrials в deflatedSharpe вместо одного board.length. Так
 * сертификат учитывает, что ты гонял fit многократно и выбираешь успешные.
 */
declare function effectiveTrials(ledger: MetaLedgerState, currentInnerTrials: number): number;
/**
 * Сколько РАЗ был запущен fit (длина цепочки попыток + текущая). Для отчёта и для
 * грубой Bonferroni-поправки порога значимости при желании.
 */
declare function fitAttemptCount(ledger: MetaLedgerState): number;

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
interface CalibrationAxes {
    hardStop?: number[];
    trailingTake?: number[];
    stalenessSinceProfit?: number[];
    staleMinutes?: number[];
    stalenessSinceMinutes?: number[];
    /** меню порогов обучаемого momentum-гейта (null = без гейта — всегда в меню) */
    momentumGatePct?: Array<number | null>;
}
interface Calibration {
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
/**
 * Калибрует оси грида по данным. Ошибки getCandles на отдельных точках не роняют
 * калибровку (точка пропускается); если не измерилось ничего — оси не заменяются,
 * reason честно говорит о фолбэке на дефолт.
 */
declare function calibrateGrid(items: ParserItem[], getCandles: GetCandles, baseHorizons: {
    staleMinutes: number[];
    stalenessSinceMinutes: number[];
}): Promise<Calibration>;

/**
 * Параметры выбора конфигурации и валидации. Вынесены в одно место, чтобы в логике
 * train не было магических литералов — каждое число здесь именовано и объяснено.
 */
interface SelectionConfig {
    /** множитель SE для коридора one-standard-error (1 = классический Breiman) */
    seMultiplier: number;
    /** число внешних фолдов nested-CV для несмещённой оценки (0 = не делать nested) */
    nestedOuterFolds: number;
}
declare const DEFAULT_SELECTION: SelectionConfig;
/**
 * Порядок агрессии реакции на каскад: чем выше, тем агрессивнее вмешательство.
 * ignore (вход вопреки каскаду) ≈ none (просто вход) < tighten (ужать) <
 * veto (не входить) < invert (развернуться).
 * Используется как ось консервативности: при near-tie выбираем менее агрессивную.
 * ignore намеренно НЕ реагирует на каскад → наименее консервативная реакция (0).
 */
declare const CASCADE_AGGRESSION: Record<string, number>;
declare const cascadeAggressionOf: (policy: string | undefined) => number;
/**
 * Ключ консервативности exit-конфигурации для one-standard-error tie-break.
 * Лексикографический порядок (меньше = консервативнее):
 *   1) hardStop          — меньший риск на сделку
 *   2) staleMinutes      — короче экспозиция
 *   3) cascade aggression— мягче вмешательство в каскад
 *   4) -cvScore          — при полном равенстве выше score (детерминизм)
 *
 * `score` передаётся отдельно, т.к. ExitParams его не содержит.
 */
declare function conservatismKey(exit: ExitParams, cvScore: number): number[];
/** Сравнение «a консервативнее b» по лексикографическому ключу (true → предпочесть a). */
declare function isMoreConservative(a: {
    exit: ExitParams;
    cvScore: number;
}, b: {
    exit: ExitParams;
    cvScore: number;
}): boolean;

interface TrainGrid {
    windowK: number[];
    minClusters: number[];
    jaccardThreshold: number[];
    lagPeakThreshold: number[];
    trailingTake: number[];
    hardStop: number[];
    stalenessSinceProfit: number[];
    stalenessSinceMinutes: number[];
    /** life-cap в минутных свечах — ЭМПИРИЧЕСКИЙ импакт-горизонт поста */
    staleMinutes: number[];
    /** порог volZ для разметки calm/anomalous — эмпирически */
    volZThreshold: number[];
    /** политика реакции на каскад: train выберет по CV (или зафиксируй параметром) */
    squeezePolicy: Array<"none" | "tighten" | "veto" | "invert" | "ignore">;
    /** порог squeezePressure для срабатывания policy */
    squeezeThreshold: number[];
    /** baseline-окно для volZ (свечей до входа) */
    volBaselineWindow: number[];
    /**
     * Окно детекции каскада в минутах — НЕЗАВИСИМО от staleMinutes. Сквиз быстрый,
     * окно должно быть коротким (минуты). Перебирается отдельно от горизонта удержания.
     */
    cascadeWindowMinutes: number[];
    /**
     * Окно стационарности, мс: на длинном горизонте статистики (τ, author-матрица)
     * считаются по локальному окну, а не по всей истории. Infinity = вся история.
     * train перебирает варианты и выбирает по CV.
     */
    stationarityWindowMs: number[];
    /**
     * ОБУЧАЕМЫЙ momentum-гейт (эдж из habr 1041898): пороги направленного momentum
     * ДО поста, среди которых CV выбирает. null = без гейта. Кандидат проходит,
     * если momentum в сторону сигнала ≥ порога (long не ловит нож, short не шортит
     * ракету). Пост-фильтр кандидатов — перебор почти бесплатный (без новых replay).
     * Выбранный порог вшивается в policy.minMomentum24hPct (runtime применит сам).
     * Дефолт [null] — гейт не перебирается (оси добавляет автокалибровка или юзер).
     */
    momentumGatePct: Array<number | null>;
}
declare const DEFAULT_GRID: TrainGrid;
interface TrainOptions {
    grid?: Partial<TrainGrid>;
    /** число фолдов time-series K-fold (расширяющееся окно) */
    folds?: number;
    /** сила усадки objective */
    shrinkageK?: number;
    /** жёсткий потолок окна всплеска, мс */
    maxBurstWindowMs?: number;
    /** настройка порогов доверия */
    reliability?: Partial<ReliabilityConfig>;
    /** режим отбора входов для обучения: auto | matrix | single */
    mode?: "auto" | "matrix" | "single";
    /** переопределение порогов жизнеспособности матрицы (auto-режим) */
    viability?: Partial<ViabilityConfig>;
    /** колбэк прогресса обучения (по умолчанию stdout-бар; передай silentProgress чтобы заглушить) */
    onProgress?: ProgressFn;
    /**
     * Политика разрешённых исходов, вшиваемая в обученную модель (сериализуется).
     * По умолчанию все: enter, invert, tighten. В исполнении её можно только сузить.
     */
    policy?: SignalPolicy;
    /** настройка выбора конфигурации: SE-коридор + nested-CV (см. selection.ts) */
    selection?: Partial<SelectionConfig>;
    /**
     * Мета-реестр прошлых fit-попыток (против МЕТА-winner's-curse). Если передан:
     *  1) CADENCE-GUARD ПРИМЕНЯЕТСЯ: train БРОСАЕТ, если с последней попытки прошло
     *     меньше metaPolicy.minRefitMs (частый refit = размножение испытаний).
     *     Раньше guard существовал только как экспорт — библиотека его не вызывала,
     *     и «защита» работала лишь у тех, кто вручную собрал обвязку.
     *  2) DSR использует эффективное число испытаний = Σ конфигов по ВСЕМ fit-ам.
     * Обновлённый реестр (с записанной ЭТОЙ попыткой) возвращается в TrainResult.ledger —
     * сохрани его и передай в следующий fit, иначе цепочка попыток рвётся.
     */
    metaLedger?: MetaLedgerState;
    /** политика cadence-guard (интервал между fit). По умолчанию DEFAULT_META_POLICY (7 дней). */
    metaPolicy?: MetaPolicy;
    /** явное отключение cadence-guard (осознанный обход, например в тестах/ресёрче) */
    ignoreCadence?: boolean;
    /**
     * Автокалибровка осей грида по данным (casual-режим). По умолчанию включается,
     * когда grid НЕ передан: %-оси (hardStop/trailingTake/stalenessSinceProfit)
     * масштабируются измеренным шумом 1m-свечей, оси горизонтов фильтруются по
     * реальному покрытию истории. Явное true — калибровать и при частичном grid
     * (только оси, которые пользователь не задал); false — никогда.
     * Итог замеров сериализуется в meta.calibration (полный аудит).
     */
    autoCalibrate?: boolean;
    /**
     * Окно momentum-гейта, минуты (по умолчанию 1440 = 24ч, как в исследовании).
     * Используется и для фичи в разметке, и вшивается в policy.momentumWindowMinutes
     * при выбранном гейте.
     */
    momentumWindowMinutes?: number;
    /**
     * Авто-триаж каналов (channelPlan): drop значимо убыточных, invert механических
     * стоп-хант каналов. По умолчанию включён; false — план не строится (все follow).
     */
    channelTriage?: boolean;
    /**
     * Модель исхода (P(win|признаки)): по умолчанию строится, если сделок достаточно.
     * false — не строить (params.outcome = null).
     */
    outcomeModel?: boolean;
    /**
     * Принудительно считать momentum-фичу для модели исхода, даже если ось
     * momentumGatePct не перебирается (стоит пре-фетча свечей на кандидата).
     * По умолчанию фича есть только когда её уже считает гейт-ось.
     */
    momentumFeature?: boolean;
    /**
     * Конкурентность фазы разметки: сколько labelBurst-запросов держать в полёте.
     * Разметка IO-bound (getCandles на каждого кандидата) — пул из N параллельных
     * запросов режет время стены кратно при живой бирже. Результат ДЕТЕРМИНИРОВАН
     * (порядок кандидатов сохраняется независимо от порядка ответов сети).
     * Подбирай под rate-limit своей биржи. По умолчанию 4. 1 = последовательно.
     */
    labelConcurrency?: number;
    /**
     * Раунды УТОЧНЯЮЩЕГО брутфорса (coarse-to-fine) вокруг победителя грубой сетки.
     * Грубый шаг (×2–×4 между узлами) может целиком спрятать узкую прибыльную
     * область — истинный оптимум между узлами невидим, и fit ложно скажет «эджа
     * нет». Каждый раунд пробует середины интервалов вокруг победителя по всем
     * непрерывным exit-осям (+порог momentum-гейта); шаг ополовинивается сам.
     * Против оверфита на мелком шаге: переезд только при улучшении БОЛЬШЕ SE
     * победителя, и каждый вариант — честное испытание (входит в innerTrials/DSR).
     * nestedScore считается по грубой сетке (уточнение в nested не повторяется).
     * Дефолт: 2 в casual-режиме (grid не передан), 0 при явном гриде.
     */
    refineRounds?: number;
    /**
     * Издержки исполнения round-trip (комиссии+проскальзывание), % от нотионала.
     * КОНСТАНТА СРЕДЫ, не ось grid: штампуется в каждый exit-набор, так что метки,
     * CV-отбор и сертификация считаются под РЕАЛЬНУЮ стоимость сделки, а не под
     * идеальное исполнение. Типично 0.1–0.3 для тейкера на памп-коинах. Дефолт 0.
     */
    roundTripCostPct?: number;
    /**
     * STATE-DEPENDENT проскальзывание: доля диапазона свечи-исполнения против позиции
     * на входе и на выходе (см. ExitParams.slippageRangeFrac). Константная издержка
     * недооценивает боль ровно на свече пампа/каскада, где спред взрывается вместе
     * с range. Типично 0.05–0.2 в зависимости от твоего размера. Дефолт 0.
     */
    slippageRangeFrac?: number;
}
/**
 * Запись истории одного сигнала для внешней аналитики (dump()).
 * Все цены абсолютные; pnl/peak в долях (0.05 = +5%); ts в мс.
 */
interface SignalRecord {
    /** id якорного parser-item — для сопоставления результата теста с парсингом */
    id?: string;
    /** id всех parser-item, вошедших в сигнал (в matrix может быть несколько) */
    ids?: string[];
    symbol: string;
    direction: "long" | "short";
    channel: string;
    /** время сигнала (ts всплеска), мс */
    ts: number;
    /** вошли ли в позицию (false для no-entry / cascade-veto) */
    entered: boolean;
    entryPrice: number;
    exitPrice: number;
    /** реализованный PnL в долях */
    pnl: number;
    /** пиковый PnL за жизнь позиции, доли */
    peak: number;
    reason: string;
    heldMinutes: number;
    /** была ли позиция инвертирована (policy=invert) */
    inverted: boolean;
    volRegime: VolRegime;
    /** число независимых кластеров авторства на всплеске (1 в single-режиме) */
    independentClusters: number;
}
interface TrainedParams {
    version: 3;
    config: DetectorConfig;
    /** prod-выход: tensor3d [mode][channel][symbol] + иерархический fallback */
    exit: ExitTensor;
    /**
     * Политика разрешённых исходов, ЗАФИКСИРОВАННАЯ на обучении и сериализуемая.
     * В исполнении readonly — signals() может только сузить её, не расширить.
     */
    policy: SignalPolicy;
    /**
     * Risk-reward (pnl/hardStop) по бэктесту: per-symbol (для runtime-фильтра по
     * символам) + global (отчёт). Главный исследовательский выход наряду с
     * impactHorizonMinutes. Сериализуем, в исполнении readonly.
     */
    riskReward: {
        bySymbol: Record<string, RiskRewardStats>;
        global: RiskRewardStats;
    };
    /**
     * Устойчивая к выбросам статистика реализованного PnL (median + перцентили),
     * чтобы одна плохая/жирная сделка не определяла оценку выигрыша системы.
     * Per-symbol + global. Сериализуется, в исполнении readonly.
     */
    pnl: {
        bySymbol: Record<string, PnlStats>;
        global: PnlStats;
    };
    /**
     * КАЧЕСТВО АВТОРОВ: per-channel скор по вошедшим сделкам истории.
     * score = shrinkage-expectancy (mean·n/(n+k)) — канал с 2 удачными постами не
     * обгонит канал с 30 стабильными: малое n усаживается к нулю. median/n — для
     * аудита. Runtime-фильтр policy.minChannelScore режет сигналы каналов ниже
     * порога (matrix-сигналы межканальные — проходят всегда). Сериализуется.
     *
     * algoScore (слой 8) — подозрение на АЛГОРИТМИЧЕСКОЕ происхождение канала по
     * механическим паттернам постинга (решётка интервалов, cron-расписание).
     * Высокий algoScore + отрицательный score = кандидат на инверсию (habr 1028592).
     */
    channelScore?: Record<string, {
        score: number;
        median: number;
        n: number;
        algoScore?: number;
    }>;
    /**
     * АВТО-ТРИАЖ КАНАЛОВ — неочевидная логика «что делать с каналом» автоматизирована:
     *  - "drop"   — канал ЗНАЧИМО убыточен (усаженный скор < 0, |t| ≥ 2, n достаточно):
     *               его сигналы режутся в рантайме;
     *  - "invert" — значимо убыточен И механического происхождения (algoScore высок):
     *               паттерн стоп-хант-бота из habr 1028592 — сигналы разворачиваются
     *               (long поста → short сделка), exit из инверс-ячейки тензора;
     *  - отсутствие записи = follow (обычное следование).
     * Решение принимается на fit по бэктест-истории и валидируется walk-forward'ом
     * как часть модели (OOS-срезы обучают свой план на своём прошлом).
     * Отключается opts.channelTriage: false. Сериализуется.
     */
    channelPlan?: Record<string, "invert" | "drop">;
    /**
     * МОДЕЛЬ ИСХОДА: калиброванная P(win|признаки) поверх torгуемого потока
     * (наивный Байес с изотонными маржиналами + OOF-калибровка, см. outcome-model.ts).
     * Признаки: independentClusters, momentum до поста (если считался), algoScore
     * канала, hawkes-burstScore. Рантайм отдаёт probability в каждом TradeSignal
     * и применяет гейты policy.minPWin / minExpectedPnlPct. null = данных мало
     * или модель не лучше prior (informative-гвард честно отключает её).
     */
    outcome?: OutcomeModel | null;
    /**
     * История сигналов выбранной конфигурации (для аналитики сторонним скриптом).
     * Каждая запись — один кандидат-всплеск, размеченный ВЫБРАННЫМ global-exit:
     * цена входа/выхода, реализованный pnl, причина и длительность. Сериализуется в
     * save()/load(); удобнее получать через dump() (плоский JSON-массив).
     */
    history?: SignalRecord[];
    meta: {
        trainedAt: number;
        folds: number;
        shrinkageK: number;
        cvScore: number;
        /** несмещённая out-of-sample оценка через nested CV (null если не считалась) */
        nestedScore: number | null;
        cvWinrate: number;
        cvSupport: number;
        gridSize: number;
        /** эффективный режим обучения: matrix | single */
        mode: "matrix" | "single";
        /** честная диагностика: ПОЧЕМУ выбран этот режим (auto-критерий или явный) */
        modeReason: string;
        impactHorizonMinutes: number;
        confidence: number;
        reliable: boolean;
        support: number;
        stability: number;
        significance: number;
        totalSamples: number;
        /** статистический сертификат (DSR/PBO/SPA/minTRL) */
        certification: Certification;
        /** эффективное число испытаний с family-wise поправкой на цепочку fit (мета-curse) */
        effectiveTrials: number;
        /** число конфигов в гриде текущего fit */
        innerTrials: number;
        /** сколько раз всего запускался fit (для прозрачности мета-перебора) */
        fitAttempts: number;
        /**
         * Диагностика фазы разметки: сколько УНИКАЛЬНЫХ кандидатов-всплесков и во что они
         * вылились (outcomes по LabelOutcome — присутствуют только ненулевые исходы).
         * totalSamples=0 при candidates>0 указывает причину: "adapter-error" — getCandles
         * бросает (look-ahead/дыра/символ); "no-candles" — пусто (символ/диапазон);
         * "no-entry" — свечи есть, но входов в зону нет. Без этого пустой fit немой.
         */
        labeling: {
            candidates: number;
            outcomes: Partial<Record<LabelOutcome, number>>;
            /** уникальные тексты getCandles-исключений → счётчик (для adapter-error). */
            errors: Record<string, number>;
            /** сколько сырых parser-items отброшено нормализацией входа (мусор/битые поля) */
            invalidItems?: number;
        };
        /**
         * Аудит автокалибровки (casual-режим): измеренный шум 1m-свечей, доступное
         * форвард-покрытие и какие оси грида были выведены из данных. null =
         * калибровка не запускалась (передан явный grid без autoCalibrate).
         */
        calibration?: Calibration | null;
        /**
         * Аудит уточняющего брутфорса (coarse-to-fine): сколько раундов пройдено,
         * сколько вариантов оценено (все они учтены в innerTrials) и сколько
         * переездов принято по правилу «улучшение > SE». null = уточнение выключено.
         */
        refinement?: {
            rounds: number;
            evaluated: number;
            accepted: number;
        } | null;
        /**
         * Мета-реестр попыток fit С ЗАПИСАННОЙ текущей — model.json несёт родословную
         * переобучений: цепочка cadence-guard/family-wise DSR переживает save()/load().
         */
        ledger?: MetaLedgerState;
    };
}
interface TrainResult {
    predict: (items: ParserItem[]) => PredictionResult;
    params: TrainedParams;
    reliability: Reliability;
    leaderboard: Array<{
        config: DetectorConfig;
        exit: ExitParams;
        /** порог обучаемого momentum-гейта записи (null = без гейта) */
        momentumGatePct: number | null;
        cvScore: number;
        cvWinrate: number;
        cvSupport: number;
    }>;
    /**
     * Мета-реестр С ЗАПИСАННОЙ этой попыткой (цепочка стартует и без входного ledger).
     * Сохрани и передай в opts.metaLedger следующего fit — иначе family-wise поправка
     * DSR и cadence-guard не видят историю переобучений (мета-winner's-curse).
     */
    ledger: MetaLedgerState;
}
/**
 * Обучает пороги детектора И параметры prod-выхода на исторических данных.
 * Метку ставит симуляция твоего trailing/hard-stop по 1m-свечам (replay),
 * поэтому stop hunting размечается как убыток. Объектив — shrinkage-expectancy
 * под time-series K-fold. Эмпирически выбирает импакт-горизонт (staleMinutes).
 */
declare function train(rawItems: ParserItem[], getCandles: GetCandles, opts?: TrainOptions): Promise<TrainResult>;
declare function loadPredict(params: TrainedParams): (items: ParserItem[]) => PredictionResult;

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
declare class PumpMatrix {
    private readonly params;
    private readonly _predict;
    private readonly _ledger;
    private constructor();
    /** Обучить модель на истории сигналов. */
    static fit(history: ParserItem[], getCandles: GetCandles, opts?: TrainOptions): Promise<PumpMatrix>;
    /**
     * Мета-реестр попыток fit С ЗАПИСАННОЙ текущей. Сериализуется в model.json
     * (meta.ledger) — цепочка переживает save()/load(): передай его в
     * opts.metaLedger следующего fit, и cadence-guard + family-wise DSR видят всю
     * историю переобучений. null только у моделей без родословной (старый формат).
     */
    get ledgerAfterFit(): MetaLedgerState | null;
    /** Восстановить модель из сохранённого JSON (в проде, без обучения). */
    static load(json: string | TrainedParams): PumpMatrix;
    /** Сериализовать модель в JSON-строку (включая policy). */
    save(): string;
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
    /** Число записей в истории сигналов (0 если модель загружена без истории). */
    get historySize(): number;
    /** Полный exit-tensor (для аудита). */
    get exit(): ExitTensor;
    /** Политика разрешённых исходов, зашитая в модель (readonly-копия). */
    get policy(): SignalPolicy;
    /**
     * Скор авторов по бэктест-истории: channel → { score, median, n }.
     * score = shrinkage-expectancy (усажен к нулю при малом n). Основа для
     * runtime-фильтра policy.minChannelScore и для ручного аудита каналов.
     */
    get channelScore(): Record<string, {
        score: number;
        median: number;
        n: number;
        algoScore?: number;
    }>;
    /**
     * Авто-триаж каналов, принятый на fit: channel → "drop" (значимо убыточен,
     * сигналы режутся) | "invert" (механический стоп-хант канал, сигналы
     * разворачиваются). Отсутствие записи = follow. Применяется рантаймом сам.
     */
    get channelPlan(): Record<string, "invert" | "drop">;
    /** Надёжна ли модель (хватило ли данных при обучении). */
    get reliable(): boolean;
    /** Доверие к модели 0..1. */
    get confidence(): number;
    /**
     * Эффективное число испытаний с family-wise поправкой на цепочку fit (мета-curse).
     * Если fit гнали многократно — это Σ конфигов по всем попыткам, а не текущий грид.
     */
    get effectiveTrials(): number;
    /** Число конфигов в гриде текущего fit (внутренние испытания). */
    get innerTrials(): number;
    /** Сколько раз всего запускался fit (прозрачность мета-перебора). */
    get fitAttempts(): number;
    /**
     * Диагностика фазы разметки: { candidates, outcomes, errors }. Если модель пустая
     * (totalSamples=0), причина в outcomes по LabelOutcome: "adapter-error" (getCandles
     * бросает), "no-candles" (вернул пусто — символ/диапазон), "no-entry" (свечи есть,
     * входов в зону нет), "ok" (размечено). errors — уникальные тексты исключений
     * getCandles со счётчиком (чтобы adapter-error не был немым).
     */
    get labeling(): {
        candidates: number;
        outcomes: Partial<Record<LabelOutcome, number>>;
        errors: Record<string, number>;
        invalidItems?: number;
    };
    /**
     * Статистический сертификат: прошёл ли эдж пять барьеров (DSR ≥ 0.95, PBO ≤ 0.10,
     * SPA p ≤ 0.05, N ≥ minTRL, nested OOS > 0). certified=false с reasons, если эдж
     * не доказан — тогда модель торговать НЕ должна.
     */
    get certification(): Certification;
    /**
     * Аудит автокалибровки casual-режима: измеренный шум 1m-свечей, доступное
     * форвард-покрытие, и какие оси грида были выведены из данных (с объяснением).
     * null = fit шёл с явным grid (калибровка не запускалась) или модель из load()
     * старого формата.
     */
    get calibration(): Calibration | null;
    /** Эмпирический импакт-горизонт поста в минутах (global-уровень). */
    get impactHorizonMinutes(): number;
    /**
     * Сколько минут истории СВЕЧЕЙ ДО сигнала нужно live-вызову plan() для каждого
     * сигнала: max(volBaselineWindow, cascadeWindowMinutes) + запас 5 свечей. Столько
     * 1m-свечей plan() запрашивает у getCandles (строго в прошлое, без look-ahead).
     * В проде держи доступной историю минимум на это окно для каждого свежего сигнала.
     */
    get lookbackMinutes(): number;
    /**
     * Минимальное число НЕЗАВИСИМЫХ кластеров авторства, которые должны сойтись на
     * тикере, чтобы matrix-всплеск считался сигналом. Из config (по умолчанию 2).
     * В single-режиме не применяется (там всегда 1 кластер).
     */
    get minClusters(): number;
    /**
     * Минимальное число ОБЩИХ событий между каналами, при котором author-матрица
     * считается жизнеспособной (не шумовое совпадение) — порог перекрытия для
     * auto-режима. Из config.viability (по умолчанию DEFAULT_VIABILITY.minSharedEvents).
     * Грубо: сколько раз кластеры должны совпасть, чтобы их связь была не случайной.
     */
    get minSharedEvents(): number;
    /** Режим, которым обучена модель: matrix (корреляция) | single (fallback). */
    get mode(): "matrix" | "single";
    /** Честная диагностика: ПОЧЕМУ выбран этот режим (auto-критерий или явный выбор). */
    get modeReason(): string;
    /**
     * Risk-reward по бэктесту: per-symbol + global. Главный исследовательский выход.
     * RR = pnl/hardStop в единицах риска (сколько R снято). bySymbol используется
     * runtime-фильтром minRiskReward.
     */
    get riskReward(): {
        bySymbol: Record<string, RiskRewardStats>;
        global: RiskRewardStats;
    };
    /**
     * Устойчивая к выбросам статистика реализованного PnL: median + перцентили
     * (p5/p95/p99) per-symbol и global. median/перцентили показывают выигрыш
     * системы без искажения единичной плохой или жирной сделкой.
     */
    get pnl(): {
        bySymbol: Record<string, PnlStats>;
        global: PnlStats;
    };
    /**
     * Главный prod-вызов БЕЗ свечей. Возвращает ТОЛЬКО исполняемые сигналы — veto
     * уже отфильтрован. Без свечей каскад не оценивается → все исходы "enter".
     * Второй аргумент — allow-список, сужающий разрешённые исходы (не шире обученной).
     */
    signals(items: ParserItem[], policy?: Partial<SignalPolicy>): TradeSignal[];
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
    private planLiveViaGetCandles;
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
    private backtestViaGetCandles;
    /** Точечно под ОДНУ позицию в LIVE (вход = последняя свеча, каскад по прошлому). */
    planFor(symbol: string, direction: Direction, channel: string | null, candles: ICandleData[], policy?: Partial<SignalPolicy>): TradeSignal | null;
    /**
     * Бэктест под ОДНУ позицию с явным entryTs (replay вперёд, каскад по будущему).
     * Возвращает BacktestSignal с реализованным result. Зона входа не задаётся —
     * replay берёт точку = open первой свечи (как при отсутствии зоны в обучении).
     */
    planForAt(symbol: string, direction: Direction, channel: string | null, candles: ICandleData[], entryTs: number, policy?: Partial<SignalPolicy>): BacktestSignal | null;
    /** Полный отчёт (все вердикты + карта авторства) — для разбора. */
    explain(items: ParserItem[]): PredictionResult;
    private collect;
    private flatExit;
    /**
     * BACKTEST-сборка сигнала: каскад по свечам ПОСЛЕ входа (forward squeezePressure),
     * допустимо только на истории. Возвращает BacktestSignal с реализованным result
     * (replay exit-плана вперёд) — главное отличие backtest от plan. entryFrom/entryTo
     * — зона входа для replay (из parser-item); без свечей result.entered=false.
     */
    private buildSignal;
    /**
     * LIVE-сборка сигнала: каскад по свечам ДО входа (backward squeezePressureBefore),
     * БЕЗ look-ahead. Делегирует в общее ядро с mode="live".
     */
    private buildSignalLive;
    /**
     * Реализованный результат для backtest: replay ИТОГОВОГО (с учётом инверсии)
     * направления и exit-плана сигнала по свечам после входа. Зона входа из parser-item;
     * если не задана — точка = open первой свечи (как в обучении). Нет свечей → не вошли.
     */
    private replayResult;
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
    private buildSignalCore;
}

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
interface WalkForwardSlice {
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
interface WalkForwardResult {
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
interface WalkForwardOptions {
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
}
declare function walkForward(items: ParserItem[], getCandles: GetCandles, opts?: WalkForwardOptions): Promise<WalkForwardResult>;

/**
 * ASSESS EDGE — операционный чеклист «можно ли этим торговать», автоматизированный.
 *
 * Раньше решение собиралось оператором из кусков: прогнать fit → посмотреть
 * certification → прогнать walkForward → сравнить certified-only срез → решить.
 * Теперь это ОДИН вызов с одним структурированным вердиктом:
 *
 *  - "trade"   — walk-forward OOS в режиме эксплуатации (только сертифицированные
 *                срезы) положителен, выборка ≥ minTRL, финальная модель на всей
 *                истории сертифицирована. Можно торговать малым риском.
 *  - "paper"   — эдж виден (OOS-медиана и Sharpe > 0), но доказательств не хватает:
 *                мало сделок (< minTRL), срезы не сертифицируются, или финальный
 *                сертификат красный. Торговать НА БУМАГЕ/микро и копить данные.
 *  - "no-edge" — OOS-цепочка не положительна. Не торговать; reasons говорят почему.
 *
 * Все пороги — уже существующие статистические инструменты (minTRL, сертификат,
 * walk-forward), никаких новых магических констант. reasons всегда объясняют
 * вердикт человеческим языком — решение проверяемо, а не оракульно.
 */
type EdgeVerdict = "trade" | "paper" | "no-edge";
interface EdgeAssessment {
    verdict: EdgeVerdict;
    /** человекочитаемые причины вердикта (что выполнено, чего не хватило) */
    reasons: string[];
    /** финальная модель, обученная на ВСЕЙ истории (её и деплоить при "trade") */
    model: PumpMatrix;
    /** полный walk-forward отчёт (кривая, просадка, срезы) — для аудита */
    walkForward: WalkForwardResult;
    /** минимальная длина трек-рекорда для значимости OOS-цепочки (Infinity при SR≤0) */
    minTRL: number;
    /** сколько OOS-сделок реально есть в оценивавшейся цепочке */
    oosTrades: number;
}
interface AssessOptions {
    /** опции обучения (grid/costs/mode/…) — общие для срезов walk-forward и финального fit */
    trainOptions?: TrainOptions;
    /** опции walk-forward (slices/policy/embargo/…) */
    walkForward?: Omit<WalkForwardOptions, "trainOptions">;
}
declare function assessEdge(items: ParserItem[], getCandles: GetCandles, opts?: AssessOptions): Promise<EdgeAssessment>;

/**
 * Нормализует parser-items в чистые события, отбрасывая лишние поля и мусор
 * (null-строки, нечисловой ts, невалидное направление). Используется и predict,
 * и train: битая запись не должна молча искажать кластеризацию/разметку.
 */
declare function normalizeParserItems(items: ParserItem[]): SignalEvent[];
/**
 * Чёрная коробка. Единственная точка входа.
 *
 *   predict(parserItems) -> PredictionResult
 *
 * Два режима отбора входов (config.mode):
 *   - "matrix": вход = синхронный всплеск независимых кластеров-авторов.
 *   - "single": fallback — каждый пост = вход, исход решает обученный exit.
 *   - "auto":   матрица только если корреляция жизнеспособна, иначе single.
 *
 * Exit НЕ единый: подбирается отдельно под каждую ячейку тензора
 * [mode][channel][symbol][direction][volRegime] — математика разных источников
 * не смешивается (matrix/single, long/short, calm/anomalous — свои критерии).
 */
declare function predict(parserItems: ParserItem[], config?: Partial<DetectorConfig>): PredictionResult;

export { CASCADE_AGGRESSION, DEFAULT_CONFIG, DEFAULT_GRID, DEFAULT_META_POLICY, DEFAULT_POLICY, DEFAULT_RELIABILITY, DEFAULT_SELECTION, DEFAULT_VIABILITY, MAX_CANDLES_PER_CHUNK, PumpMatrix, STEP_MS, algoSignatureOf, alignTs, assessEdge, assessViability, authorInfluence, buildTable, buildWindowedTable, calibrateGrid, canRefit, cascadeAggressionOf, certifyStrategy, clusterAuthors, computeReliability, conservatismKey, deflatedSharpe, earlyWarning, effectiveTrials, emptyLedger, entryStartTs, enumerateBursts, enumeratePosts, exitKey, exitProposalsFromPath, expectedMaxSharpe, fetchCandlesChunked, fitAttemptCount, fitHawkesGraph, fitOutcomeModel, hawkesBurst, hawkesWeight, intersectPolicy, isMoreConservative, jaccardPair, jaccardScreen, kurtosis, labelBurst, lagXCorr, leadershipWeight, loadPredict, mean, minTrackRecordLength, mulberry32, normalCdf, normalInv, normalizeParserItems, oneStandardErrorSelect, percentile, pnlStats, predict, predictOutcome, probabilityOfBacktestOverfitting, realityCheckPValue, recordAttempt, replayExit, resolveExit, resolveExitNoRegime, riskRewardStats, selfTuneLag, selfTuneLagDetail, sharpe, shrinkageExpectancy, silentProgress, singleChannelSignals, skewness, squeezePressure, standardError, stationaryBootstrapResample, stdev, stdoutProgress, train, variance, volRegimeOf, volumeFeatures, volumeZScore, walkForward, windowEvents, winrate, withCandleCache };
export type { AlgoSignature, AssessOptions, AuthorMap, BacktestResult, BacktestSignal, Calibration, CalibrationAxes, CandleInterval, Certification, CertificationInput, DetectorConfig, DetectorMode, Direction, EdgeAssessment, EdgeVerdict, ExitParams, ExitPlan, ExitReason, ExitTensor, FitAttempt, GetCandles, HawkesBurst, HawkesGraph, ICandleData, IsotonicLLR, LabeledBurst, LagDetail, MetaLedgerState, MetaPolicy, OutcomeModel, OutcomePrediction, OutcomeRow, ParserItem, PathExitProposals, PnlStats, PredictionResult, ProgressEvent, ProgressFn, PumpVerdict, Reliability, ReliabilityConfig, ReliabilityInput, ReplayResult, ResolveSource, ResolvedExit, RiskRewardStats, SelectionConfig, SignalAction, SignalEvent, SignalOrigin, SignalPolicy, SignalRecord, TradeSignal, TrainGrid, TrainOptions, TrainResult, TrainedParams, ViabilityConfig, ViabilityReport, VolRegime, VolumeFeatures, WalkForwardOptions, WalkForwardResult, WalkForwardSlice };
