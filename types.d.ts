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
    minSharedEvents: number;
    minPeakShare: number;
    minStrongEdges: number;
    minStructure: number;
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
 * confidence = dedup × fill, где
 *   dedup = clusters/channels (1 = все источники независимы, <1 = есть дубли автора)
 *   fill  = насыщенность окна относительно minClusters·2 (растёт с числом источников)
 */
declare function earlyWarning(tbl: EventTable, clusterOf: AuthorMap, cfg: DetectorConfig, tau: number): PumpVerdict[];

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
declare function assessViability(tbl: EventTable, directed: DirectedEdge[], authors: AuthorMap, cfg?: ViabilityConfig): ViabilityReport;

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
}
type ExitReason = "trailing-take" | "hard-stop" | "peak-staleness" | "life-cap" | "cascade-veto" | "invert" | "no-entry";
interface ReplayResult {
    /** реализованный PnL% (в долях: 0.05 = +5%). При hard-stop = -hardStop% (честный убыток). */
    pnl: number;
    reason: ExitReason;
    /** пиковый PnL% за жизнь позиции */
    peak: number;
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
/** Стабильный строковый ключ exit-набора для кэша/grid. */
declare const exitKey: (p: ExitParams) => string;
/**
 * Достаёт 1m-свечи от события вперёд на покрытие максимального life-cap и
 * прогоняет каждый exit-набор через replay. Зона входа берётся из события;
 * если не задана — точка entryFrom=entryTo=open первой свечи.
 */
declare function labelBurst(getCandles: GetCandles, symbol: string, direction: Direction, ts: number, exitSets: ExitParams[], entryFromPrice?: number, entryToPrice?: number): Promise<LabeledBurst | null>;

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
    /** метка фазы: "label" (разметка свечами) | "score" (grid-скоринг) */
    phase: "label" | "score" | "nested";
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
     * Мета-реестр прошлых fit-попыток (против МЕТА-winner's-curse). Если передан,
     * DSR использует эффективное число испытаний = Σ конфигов по ВСЕМ fit-ам, а не
     * только текущему. Так сертификат учитывает, что fit гоняли многократно.
     * Без него (undefined) — поправки нет (одиночный fit, наивный N).
     */
    metaLedger?: MetaLedgerState;
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
        /** статистический сертификат (DSR/PBO/SPA/minTRL); optional для обратной совместимости */
        certification?: Certification;
        /** эффективное число испытаний с family-wise поправкой на цепочку fit (мета-curse) */
        effectiveTrials?: number;
        /** число конфигов в гриде текущего fit */
        innerTrials?: number;
        /** сколько раз всего запускался fit (для прозрачности мета-перебора) */
        fitAttempts?: number;
    };
}
interface TrainResult {
    predict: (items: ParserItem[]) => PredictionResult;
    params: TrainedParams;
    reliability: Reliability;
    leaderboard: Array<{
        config: DetectorConfig;
        exit: ExitParams;
        cvScore: number;
        cvWinrate: number;
        cvSupport: number;
    }>;
}
/**
 * Обучает пороги детектора И параметры prod-выхода на исторических данных.
 * Метку ставит симуляция твоего trailing/hard-stop по 1m-свечам (replay),
 * поэтому stop hunting размечается как убыток. Объектив — shrinkage-expectancy
 * под time-series K-fold. Эмпирически выбирает импакт-горизонт (staleMinutes).
 */
declare function train(items: ParserItem[], getCandles: GetCandles, opts?: TrainOptions): Promise<TrainResult>;
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
    private constructor();
    /** Обучить модель на истории сигналов. */
    static fit(history: ParserItem[], getCandles: GetCandles, opts?: TrainOptions): Promise<PumpMatrix>;
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
    /** Надёжна ли модель (хватило ли данных при обучении). */
    get reliable(): boolean;
    /** Доверие к модели 0..1. */
    get confidence(): number;
    /**
     * Эффективное число испытаний с family-wise поправкой на цепочку fit (мета-curse).
     * Если fit гнали многократно — это Σ конфигов по всем попыткам, а не текущий грид.
     * undefined у моделей до этой версии.
     */
    get effectiveTrials(): number | undefined;
    /** Сколько раз всего запускался fit (прозрачность мета-перебора). */
    get fitAttempts(): number | undefined;
    /**
     * Статистический сертификат: прошёл ли эдж пять барьеров (DSR ≥ 0.95, PBO ≤ 0.10,
     * SPA p ≤ 0.05, N ≥ minTRL, nested OOS > 0). certified=false с reasons, если эдж
     * не доказан — тогда модель торговать НЕ должна. undefined у моделей до этой версии.
     */
    get certification(): Certification | undefined;
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
    backtest(items: ParserItem[], getCandles: GetCandles, policy?: Partial<SignalPolicy>): Promise<TradeSignal[]>;
    backtest(items: ParserItem[], candlesBySymbol: Record<string, ICandleData[]>, policy?: Partial<SignalPolicy>): TradeSignal[];
    private backtestViaGetCandles;
    /** Точечно под ОДНУ позицию в LIVE (вход = последняя свеча, каскад по прошлому). */
    planFor(symbol: string, direction: Direction, channel: string | null, candles: ICandleData[], policy?: Partial<SignalPolicy>): TradeSignal | null;
    /** Бэктест под ОДНУ позицию с явным entryTs (replay вперёд, каскад по будущему). */
    planForAt(symbol: string, direction: Direction, channel: string | null, candles: ICandleData[], entryTs: number, policy?: Partial<SignalPolicy>): TradeSignal | null;
    /** Полный отчёт (все вердикты + карта авторства) — для разбора. */
    explain(items: ParserItem[]): PredictionResult;
    private collect;
    private flatExit;
    /**
     * BACKTEST-сборка сигнала: каскад по свечам ПОСЛЕ входа (forward squeezePressure),
     * допустимо только на истории. Делегирует в общее ядро с mode="backtest".
     */
    private buildSignal;
    /**
     * LIVE-сборка сигнала: каскад по свечам ДО входа (backward squeezePressureBefore),
     * БЕЗ look-ahead. Делегирует в общее ядро с mode="live".
     */
    private buildSignalLive;
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

export { CASCADE_AGGRESSION, DEFAULT_CONFIG, DEFAULT_GRID, DEFAULT_META_POLICY, DEFAULT_POLICY, DEFAULT_RELIABILITY, DEFAULT_SELECTION, DEFAULT_VIABILITY, MAX_CANDLES_PER_CHUNK, PumpMatrix, STEP_MS, alignTs, assessViability, buildTable, buildWindowedTable, canRefit, cascadeAggressionOf, certifyStrategy, clusterAuthors, computeReliability, conservatismKey, deflatedSharpe, earlyWarning, effectiveTrials, emptyLedger, entryStartTs, enumerateBursts, enumeratePosts, exitKey, expectedMaxSharpe, fetchCandlesChunked, fitAttemptCount, intersectPolicy, isMoreConservative, jaccardPair, jaccardScreen, kurtosis, labelBurst, lagXCorr, loadPredict, mean, minTrackRecordLength, mulberry32, normalCdf, normalInv, oneStandardErrorSelect, percentile, pnlStats, predict, probabilityOfBacktestOverfitting, realityCheckPValue, recordAttempt, replayExit, resolveExit, resolveExitNoRegime, riskRewardStats, selfTuneLag, sharpe, shrinkageExpectancy, silentProgress, singleChannelSignals, skewness, squeezePressure, standardError, stationaryBootstrapResample, stdev, stdoutProgress, train, variance, volRegimeOf, volumeFeatures, volumeZScore, windowEvents, winrate };
export type { AuthorMap, CandleInterval, Certification, CertificationInput, DetectorConfig, DetectorMode, Direction, ExitParams, ExitPlan, ExitReason, ExitTensor, FitAttempt, GetCandles, ICandleData, LabeledBurst, MetaLedgerState, MetaPolicy, ParserItem, PnlStats, PredictionResult, ProgressEvent, ProgressFn, PumpVerdict, Reliability, ReliabilityConfig, ReliabilityInput, ReplayResult, ResolveSource, ResolvedExit, RiskRewardStats, SelectionConfig, SignalAction, SignalEvent, SignalOrigin, SignalPolicy, SignalRecord, TradeSignal, TrainGrid, TrainOptions, TrainResult, TrainedParams, ViabilityConfig, ViabilityReport, VolRegime, VolumeFeatures };
