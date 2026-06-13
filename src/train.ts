import {
  DEFAULT_CONFIG,
  DetectorConfig,
  ParserItem,
  PredictionResult,
} from "./types";
import { GetCandles } from "./candle";
import { enumerateBursts, enumeratePosts } from "./enumerate";
import { buildTable } from "./core/event-table";
import { selfTuneLag } from "./layers/self-tune-lag";
import { jaccardScreen } from "./layers/jaccard-screen";
import { lagXCorr } from "./layers/lag-xcorr";
import { clusterAuthors } from "./layers/cluster-authors";
import { assessViability, DEFAULT_VIABILITY } from "./viability";
import { ViabilityConfig } from "./types";
import { ProgressFn, stdoutProgress } from "./progress";
import { labelBurst, exitKey, LabelOutcome } from "./label";
import { ExitParams } from "./replay";
import { ExitTensor } from "./exit-tensor";
import { SignalPolicy, DEFAULT_POLICY } from "./signal";
import { shrinkageExpectancy, winrate, riskRewardStats, RiskRewardStats, oneStandardErrorSelect, pnlStats, PnlStats } from "./objective";
import { certifyStrategy, Certification, sharpe, variance } from "./statistics";
import { MetaLedgerState, effectiveTrials, fitAttemptCount } from "./meta-ledger";
import { SelectionConfig, DEFAULT_SELECTION, isMoreConservative } from "./selection";
import {
  computeReliability,
  Reliability,
  ReliabilityConfig,
  DEFAULT_RELIABILITY,
} from "./reliability";
import { predict as predictRaw } from "./index";

// ─────────────────────────── grid + train опции ──────────────────────────────

export interface TrainGrid {
  // оси детектора (матрица авторства)
  windowK: number[];
  minClusters: number[];
  jaccardThreshold: number[];
  lagPeakThreshold: number[];
  // оси prod-выхода (метку ставит replay по 1m-свечам)
  trailingTake: number[];
  hardStop: number[];
  stalenessSinceProfit: number[];
  stalenessSinceMinutes: number[];
  /** life-cap в минутных свечах — ЭМПИРИЧЕСКИЙ импакт-горизонт поста */
  staleMinutes: number[];
  // оси детектора каскада ликвидаций (симметрично long/short)
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

export const DEFAULT_GRID: TrainGrid = {
  windowK: [2, 3, 5],
  minClusters: [2, 3],
  jaccardThreshold: [0.3, 0.4],       // 0.2 почти никогда не выбирался — убран ради размера грида
  lagPeakThreshold: [0.4, 0.5],       // 0.6 редко лучше — убран ради размера грида
  trailingTake: [0.5, 1.0, 2.0],
  hardStop: [1.0, 2.0, 3.0],
  stalenessSinceProfit: [0.5, 1.0, 2.0],   // порог прибыли (%) для вооружения staleness-выхода
  stalenessSinceMinutes: [60, 120, 240],    // минут застоя от пика до выхода (число staleness-минут)
  staleMinutes: [60, 240, 720],       // 1ч / 4ч / 12ч (24ч редко оптимален для коротких пампов)
  volZThreshold: [1.5, 2.5],          // когда считать объём аномальным (накопление топлива)
  squeezePolicy: ["none", "tighten", "veto", "invert"], // train выберет реакцию по CV
  squeezeThreshold: [0.55, 0.7],      // доля объёма против позиции для срабатывания
  volBaselineWindow: [20],
  cascadeWindowMinutes: [15, 30, 60], // окно детекции каскада: 15м / 30м / 1ч (быстрое событие)
  // вся история + конечные окна (4 / 8 недель); train выберет по CV
  stationarityWindowMs: [7 * 24 * 3600_000, 14 * 24 * 3600_000, 28 * 24 * 3600_000, 56 * 24 * 3600_000],
};

export interface TrainOptions {
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

// ─────────────────── сериализуемый результат обучения ─────────────────────────

/**
 * Запись истории одного сигнала для внешней аналитики (dump()).
 * Все цены абсолютные; pnl/peak в долях (0.05 = +5%); ts в мс.
 */
export interface SignalRecord {
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
  volRegime: import("./volume").VolRegime;
  /** число независимых кластеров авторства на всплеске (1 в single-режиме) */
  independentClusters: number;
}

export interface TrainedParams {
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
    // импакт-горизонт отдельно — главный исследовательский выход
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
    };
  };
}

export interface TrainResult {
  predict: (items: ParserItem[]) => PredictionResult;
  params: TrainedParams;
  reliability: Reliability;
  leaderboard: Array<{
    config: DetectorConfig; exit: ExitParams;
    cvScore: number; cvWinrate: number; cvSupport: number;
  }>;
}

// ─────────────────────────── time-series K-fold ──────────────────────────────

function timeSeriesFolds(n: number, folds: number): Array<{ valLo: number; valHi: number }> {
  const out: Array<{ valLo: number; valHi: number }> = [];
  const seg = Math.max(1, Math.floor(n / (folds + 1)));
  for (let f = 1; f <= folds; f++) {
    const valLo = f * seg;
    const valHi = f === folds ? n : (f + 1) * seg;
    if (valLo < valHi) out.push({ valLo, valHi });
  }
  return out;
}

// ──────────────────────────────── train ──────────────────────────────────────

/**
 * Обучает пороги детектора И параметры prod-выхода на исторических данных.
 * Метку ставит симуляция твоего trailing/hard-stop по 1m-свечам (replay),
 * поэтому stop hunting размечается как убыток. Объектив — shrinkage-expectancy
 * под time-series K-fold. Эмпирически выбирает импакт-горизонт (staleMinutes).
 */
export async function train(
  items: ParserItem[],
  getCandles: GetCandles,
  opts: TrainOptions = {},
): Promise<TrainResult> {
  const grid: TrainGrid = { ...DEFAULT_GRID, ...opts.grid };
  const folds = opts.folds ?? 4;
  const shrinkageK = opts.shrinkageK ?? 5;
  const selection: SelectionConfig = { ...DEFAULT_SELECTION, ...opts.selection };
  const maxBurstWindowMs = opts.maxBurstWindowMs ?? DEFAULT_CONFIG.maxBurstWindowMs;

  // разрешаем эффективный режим обучения — тем же строгим критерием, что и predict
  const reqMode = opts.mode ?? "auto";
  let effMode: "matrix" | "single";
  let modeReason: string;
  if (reqMode === "matrix") { effMode = "matrix"; modeReason = "matrix задан явно (opts.mode)"; }
  else if (reqMode === "single") { effMode = "single"; modeReason = "single задан явно (opts.mode)"; }
  else {
    // auto: пробный прогон матрицы на средних порогах + оценка жизнеспособности
    const probeTbl = buildTable(
      items.map((i) => ({
        channel: i.channel, symbol: i.symbol, direction: i.direction, ts: i.ts,
        entryFromPrice: i.entryFromPrice, entryToPrice: i.entryToPrice,
      })),
    );
    const probeTau = selfTuneLag(probeTbl);
    const probeWin = Math.min(3 * probeTau, maxBurstWindowMs);
    const probeScreened = jaccardScreen(probeTbl, probeWin, 0.3);
    const probeDirected = lagXCorr(probeTbl, probeScreened, 0.5, probeWin);
    const probeAuthors = clusterAuthors(probeTbl.channels, probeDirected);
    const v = assessViability(probeTbl, probeDirected, probeAuthors, {
      ...DEFAULT_VIABILITY, ...opts.viability,
    });
    effMode = v.viable ? "matrix" : "single";
    // честная авто-диагностика: ПОЧЕМУ выбран режим (видно в meta.modeReason)
    modeReason = `auto → ${effMode}: ${v.reason}`;
  }

  // индекс зоны входа по (symbol|direction|ts) — убирает O(n²) find
  const entryIndex = new Map<string, ParserItem>();
  for (const it of items) entryIndex.set(`${it.symbol}|${it.direction}|${it.ts}`, it);

  // полный список exit-наборов (декартово произведение exit+volume осей)
  const exitSets: ExitParams[] = [];
  for (const tt of grid.trailingTake)
    for (const hs of grid.hardStop)
      for (const sp of grid.stalenessSinceProfit)
        for (const sm of grid.stalenessSinceMinutes)
          for (const life of grid.staleMinutes)
            for (const vz of grid.volZThreshold)
              for (const pol of grid.squeezePolicy)
                for (const sqt of grid.squeezeThreshold)
                  for (const bw of grid.volBaselineWindow)
                    for (const cw of grid.cascadeWindowMinutes)
                      exitSets.push({
                        trailingTake: tt, hardStop: hs,
                        stalenessSinceProfit: sp, stalenessSinceMinutes: sm, staleMinutes: life,
                        volZThreshold: vz, squeezePolicy: pol,
                        squeezeThreshold: sqt, volBaselineWindow: bw,
                        cascadeWindowMinutes: cw,
                      });

  // кэш: ключ кластеризации → размеченные всплески.
  // храним полный ReplayResult (нужен volRegime + entered для tensor и veto-метрики).
  // ExitRec несёт и поля для dump() — цены входа/выхода, причину, длительность.
  type ExitRec = {
    pnl: number; volRegime: import("./volume").VolRegime; entered: boolean;
    entryPrice: number; exitPrice: number; reason: string; heldMinutes: number;
    peak: number; inverted: boolean;
  };
  type Labeled = {
    channel: string; symbol: string; direction: "long" | "short"; ts: number;
    independentClusters: number;
    id?: string; ids?: string[];
    byExit: Map<string, ExitRec>;
  };
  const labeledCache = new Map<string, Labeled[]>();
  const seenCluster = new Set<string>();
  // диагностика разметки: исход каждого УНИКАЛЬНОГО всплеска. dedup по (symbol|dir|ts):
  // один всплеск перечисляется в нескольких проходах грида — считаем исход раз, иначе
  // счётчики раздуты числом конфигов. Пустой fit перестаёт быть немым: тэлли скажет,
  // adapter-error / no-candles / no-entry это или реально ok.
  const outcomeTally = new Map<LabelOutcome, number>();
  // уникальные тексты adapter-error → сколько раз встретились (32 одинаковых схлопнутся).
  const errorTally = new Map<string, number>();
  const diagSeen = new Set<string>();

  const labelCandidates = async (
    cands: ReturnType<typeof enumerateBursts>,
    onTick?: (symbol: string) => void,
  ): Promise<Labeled[]> => {
    const labeled: Labeled[] = [];
    for (const b of cands) {
      const src = entryIndex.get(`${b.symbol}|${b.direction}|${b.ts}`);
      const { outcome, burst, error } = await labelBurst(
        getCandles, b.symbol, b.direction, b.ts, exitSets,
        src?.entryFromPrice, src?.entryToPrice,
      );
      onTick?.(b.symbol);
      const diagKey = `${b.symbol}|${b.direction}|${b.ts}`;
      if (!diagSeen.has(diagKey)) {
        diagSeen.add(diagKey);
        outcomeTally.set(outcome, (outcomeTally.get(outcome) ?? 0) + 1);
        if (error) errorTally.set(error, (errorTally.get(error) ?? 0) + 1);
      }
      if (!burst) continue;
      const byExit = new Map<string, ExitRec>();
      // veto-вход (entered=false, reason=cascade-veto) тоже несёт сигнал: его pnl=0,
      // и он ДОЛЖЕН учитываться как «не вошли и не потеряли», иначе policy=veto нечестно
      // сравнивать с policy=none. Поэтому храним и не-entered, помечая флагом.
      for (const [k, r] of burst.byExit) {
        byExit.set(k, {
          pnl: r.pnl, volRegime: r.volRegime, entered: r.entered,
          entryPrice: r.entryPrice, exitPrice: r.exitPrice, reason: r.reason,
          heldMinutes: r.heldMinutes, peak: r.peak, inverted: r.inverted,
        });
      }
      if (byExit.size === 0) continue;
      labeled.push({
        channel: src?.channel ?? "_unknown",
        symbol: b.symbol, direction: b.direction, ts: b.ts,
        independentClusters: b.independentClusters,
        id: b.id, ids: b.ids,
        byExit,
      });
    }
    return labeled;
  };

  // ── фаза разметки с прогрессом ──
  // предварительно перечисляем кандидатов по каждому ключу кластеризации (дёшево,
  // pure CPU без IO), чтобы знать ГЛОБАЛЬНЫЙ total медленных labelBurst-вызовов.
  const progress = opts.onProgress ?? stdoutProgress;
  type Pass = { ckey: string; skey?: string; cands: ReturnType<typeof enumerateBursts> };
  const passes: Pass[] = [];
  // окно стационарности влияет ТОЛЬКО на matrix (author-матрица); в single посты
  // не используют матрицу, поэтому там окно не перебираем (одно значение).
  const swAxis = effMode === "single" ? [Infinity] : grid.stationarityWindowMs;
  for (const wK of grid.windowK)
    for (const jac of grid.jaccardThreshold)
      for (const lag of grid.lagPeakThreshold)
        for (const sw of swAxis) {
          const ckey = `${wK}|${jac}|${lag}|${sw}`;
          if (seenCluster.has(ckey)) continue;
          seenCluster.add(ckey);
          if (effMode === "single") {
            const skey = `single|${wK}`;
            if (labeledCache.has(`__enum_${skey}`)) { passes.push({ ckey, skey, cands: [] }); continue; }
            labeledCache.set(`__enum_${skey}`, []); // маркер «уже перечислили»
            passes.push({ ckey, skey, cands: enumeratePosts(items, wK, maxBurstWindowMs) });
          } else {
            passes.push({ ckey, cands: enumerateBursts(items, wK, jac, lag, maxBurstWindowMs, sw) });
          }
        }
  labeledCache.clear();
  seenCluster.clear();

  const totalTicks = passes.reduce((s, p) => s + p.cands.length, 0);
  let doneTicks = 0;
  const tick = (symbol: string) => {
    doneTicks++;
    progress({ done: doneTicks, total: totalTicks, phase: "label", label: symbol });
  };

  for (const p of passes) {
    let labeled: Labeled[];
    if (p.skey) {
      if (!labeledCache.has(p.skey)) {
        labeledCache.set(p.skey, await labelCandidates(p.cands, tick));
      }
      labeled = labeledCache.get(p.skey)!;
    } else {
      labeled = await labelCandidates(p.cands, tick);
    }
    labeledCache.set(p.ckey, labeled);
  }
  if (totalTicks > 0) progress({ done: totalTicks, total: totalTicks, phase: "label", label: "done" });

  // grid: детектор × exit, CV-score под K-fold
  // в single-режиме minClusters не применяется (всегда 1) — кандидаты уже все посты
  const minClusterAxis = effMode === "single" ? [1] : grid.minClusters;
  type Entry = {
    config: DetectorConfig; exit: ExitParams;
    cvScore: number; cvWinrate: number; cvSupport: number;
    _foldMeans: number[]; _foldSizes: number[]; _returns: number[]; _foldScores: number[];
  };
  const board: Entry[] = [];

  // total для фазы score = число (wK×jac×lag×sw) комбинаций (тик на каждую)
  const scoreTotal = grid.windowK.length * grid.jaccardThreshold.length
    * grid.lagPeakThreshold.length * swAxis.length;

  // буримая функция скоринга: строит board по всем конфигам, учитывая только те
  // размеченные всплески, что проходят keep(ts). keep=()=>true → весь board.
  // onTick(label) вызывается после каждой (wK×jac×lag×sw)-комбинации (для прогресса).
  const buildBoard = (
    keep: (ts: number) => boolean,
    onTick?: (label: string) => void,
  ): Entry[] => {
    const out: Entry[] = [];
    for (const wK of grid.windowK)
      for (const jac of grid.jaccardThreshold)
        for (const lag of grid.lagPeakThreshold)
          for (const sw of swAxis) {
            const labeled = (effMode === "single"
              ? labeledCache.get(`single|${wK}`)!
              : labeledCache.get(`${wK}|${jac}|${lag}|${sw}`)!
            ).filter((b) => keep(b.ts));
            for (const minC of minClusterAxis)
              for (const ex of exitSets) {
                const ekey = exitKey(ex);
                const selected = labeled
                  .filter((b) => b.independentClusters >= minC && b.byExit.has(ekey))
                  .sort((a, b) => a.ts - b.ts);
                const cfg = cfgOf(wK, minC, jac, lag, maxBurstWindowMs, effMode, sw);
                if (selected.length === 0) {
                  out.push({ config: cfg, exit: ex, cvScore: 0, cvWinrate: 0, cvSupport: 0,
                    _foldMeans: [], _foldSizes: [], _returns: [], _foldScores: [] });
                  continue;
                }
                const foldSpecs = timeSeriesFolds(selected.length, folds);
                const foldScores: number[] = [], foldMeans: number[] = [],
                  foldWins: number[] = [], foldSupp: number[] = [], allRet: number[] = [];
                for (const { valLo, valHi } of foldSpecs) {
                  const valRet = selected.slice(valLo, valHi).map((b) => b.byExit.get(ekey)!.pnl);
                  foldScores.push(shrinkageExpectancy(valRet, shrinkageK));
                  foldMeans.push(valRet.length ? valRet.reduce((s, x) => s + x, 0) / valRet.length : 0);
                  foldWins.push(winrate(valRet));
                  foldSupp.push(valRet.length);
                  for (const r of valRet) allRet.push(r);
                }
                const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
                out.push({
                  config: cfg, exit: ex,
                  cvScore: +avg(foldScores).toFixed(6),
                  cvWinrate: +avg(foldWins).toFixed(6),
                  cvSupport: +avg(foldSupp).toFixed(2),
                  _foldMeans: foldMeans, _foldSizes: foldSupp, _returns: allRet, _foldScores: foldScores,
                });
              }
            onTick?.(`${wK}|${jac}|${lag}|${sw === Infinity ? "all" : sw}`);
          }
    return out;
  };

  // основной board — по всем данным, с прогрессом фазы score
  let scoreDone = 0;
  // НЕ спред (board.push(...arr)): на полном гриде arr — десятки тысяч элементов,
  // и spread-в-аргументы переполняет стек вызовов (Maximum call stack size exceeded).
  const mainBoard = buildBoard(() => true, (label) => {
    scoreDone++;
    progress({ done: scoreDone, total: scoreTotal, phase: "score", label });
  });
  for (const entry of mainBoard) board.push(entry);

  // ── выбор победителя: one-standard-error rule (против winner's curse) ──
  // вместо argmax по cvScore берём самую КОНСЕРВАТИВНУЮ конфигурацию среди тех,
  // чей score в пределах SE от максимума. Это убирает переобучение на шум grid:
  // разница внутри SE статистически незначима, поэтому robustness > удача.
  // Порядок консервативности и пороги — в selection.ts, без магических литералов.
  const top = oneStandardErrorSelect(
    board,
    (e) => e.cvScore,
    (e) => e._foldScores,
    (a, b) => isMoreConservative(a, b),
    selection.seMultiplier,
  )!;
  // board всё равно сортируем по score — для отчёта/аудита (gridSize, диагностика)
  board.sort((a, b) => b.cvScore - a.cvScore);

  // ── nested CV: несмещённая оценка прод-эджа (не меняет ВЫБОР, только оценку) ──
  // Внешние фолды по времени: на каждом train-срезе заново выбираем конфиг (1-SE),
  // оцениваем на held-out test-срезе. Среднее out-of-sample = честная оценка того,
  // что ждёт на проде, без winner's curse. ВЫБОР модели остаётся за полным 1-SE выше.
  // Прогресс тикает на КАЖДЫЙ внешний фолд → терминал не молчит дольше одного фолда.
  let nestedScore: number | null = null;
  if (selection.nestedOuterFolds >= 2) {
    // временные границы: все ts размеченных всплесков из основного кэша
    const allBurstTs: number[] = [];
    for (const [k, labeled] of labeledCache) {
      if (k.startsWith("__enum_")) continue;
      for (const b of labeled) allBurstTs.push(b.ts);
    }
    allBurstTs.sort((a, b) => a - b);
    const uniqTs = [...new Set(allBurstTs)];

    if (uniqTs.length >= selection.nestedOuterFolds) {
      const oosScores: number[] = [];
      const K = selection.nestedOuterFolds;
      const foldSize = Math.floor(uniqTs.length / K);
      for (let f = 0; f < K; f++) {
        // outer-test = f-й временной блок; outer-train = всё остальное
        const testLo = uniqTs[f * foldSize];
        const testHi = f === K - 1 ? Infinity : uniqTs[(f + 1) * foldSize];
        const inTest = (ts: number) => ts >= testLo && (testHi === Infinity ? true : ts < testHi);
        const inTrain = (ts: number) => !inTest(ts);

        // на train-срезе выбираем конфиг тем же 1-SE
        const trainBoard = buildBoard(inTrain);
        const trainTop = oneStandardErrorSelect(
          trainBoard, (e) => e.cvScore, (e) => e._foldScores,
          (a, b) => isMoreConservative(a, b), selection.seMultiplier,
        );
        // оцениваем выбранный конфиг на held-out test-срезе
        if (trainTop) {
          const testBoard = buildBoard(inTest);
          const match = testBoard.find((e) =>
            exitKey(e.exit) === exitKey(trainTop.exit) &&
            e.config.windowK === trainTop.config.windowK &&
            e.config.minClusters === trainTop.config.minClusters &&
            e.config.jaccardThreshold === trainTop.config.jaccardThreshold &&
            e.config.lagPeakThreshold === trainTop.config.lagPeakThreshold &&
            e.config.stationarityWindowMs === trainTop.config.stationarityWindowMs);
          if (match) oosScores.push(match.cvScore);
        }
        progress({ done: f + 1, total: K, phase: "nested", label: `fold ${f + 1}/${K}` });
      }
      nestedScore = oosScores.length
        ? +(oosScores.reduce((s, x) => s + x, 0) / oosScores.length).toFixed(6)
        : null;
    }
  }

  const reliability = computeReliability(
    { foldMeans: top._foldMeans, foldSizes: top._foldSizes, allReturns: top._returns },
    { ...DEFAULT_RELIABILITY, ...opts.reliability },
  );

  // ── СЕРТИФИКАТ: математически доказуемый эдж, а не argmax по шуму ──
  // DSR (поправка на N испытаний) + PBO (CSCV-оверфит) + SPA (data-snooping) +
  // minTRL (достаточность выборки) + nested OOS. certified=true только если эдж
  // переживает ВСЕ барьеры. Это и отличает реальный эдж от выброса.
  const candPool = board
    .filter((e) => e._returns.length > 0)
    .slice(0, 50)
    .map((e) => e._returns);
  // perf-матрица для PBO: топ-конфиги × их fold-scores (нужно чётное число фолдов)
  const perfRows = board
    .filter((e) => e._foldScores.length >= 2)
    .slice(0, 30)
    .map((e) => e._foldScores.slice(0, e._foldScores.length - (e._foldScores.length % 2)));
  const evenFolds = perfRows.length && perfRows.every((r) => r.length === perfRows[0].length && r.length >= 2);
  // дисперсия Sharpe ПО испытаниям (планка случайности для DSR)
  const trialSharpes = board
    .filter((e) => e._returns.length >= 2)
    .map((e) => sharpe(e._returns));
  const varSR = variance(trialSharpes);

  // эффективное число испытаний: family-wise по ВСЕМ fit-попыткам (мета-curse),
  // а не только текущему гриду. Без metaLedger — наивный board.length (одиночный fit).
  const innerTrials = Math.max(board.length, 1);
  const nTrialsEff = opts.metaLedger
    ? effectiveTrials(opts.metaLedger, innerTrials)
    : innerTrials;

  const certification = certifyStrategy({
    selectedReturns: top._returns,
    nTrials: nTrialsEff,
    varSRAcrossTrials: varSR,
    perfMatrix: evenFolds ? perfRows : [],
    candidateReturns: candPool.length ? candPool : [top._returns],
    nestedScore,
  });

  // ── exit tensor: лучший exit на каждую ячейку [channel][symbol][direction][volRegime] ──
  // detector-конфиг выбран глобально; exit считаем per-cell, НЕ смешивая математику
  // источников. Каскад ликвидаций симметричен: long-trap и short-trap — РАЗНЫЕ ячейки.
  const winLabeled = effMode === "single"
    ? labeledCache.get(`single|${top.config.windowK}`)!
    : labeledCache.get(`${top.config.windowK}|${top.config.jaccardThreshold}|${top.config.lagPeakThreshold}|${top.config.stationarityWindowMs}`)!;
  const winSelected = winLabeled
    .filter((b) => b.independentClusters >= top.config.minClusters)
    .sort((a, b) => a.ts - b.ts);

  // выбор лучшего exit по подвыборке + опц. фильтру volRegime.
  // Если regime задан — учитываем только результаты, чей volRegime под данным exit совпал.
  const pickExit = (subset: Labeled[], regime?: import("./volume").VolRegime): ExitParams | null => {
    if (subset.length === 0) return null;
    let best: { ex: ExitParams; score: number } | null = null;
    for (const ex of exitSets) {
      const ekey = exitKey(ex);
      const rows = subset
        .map((b) => b.byExit.get(ekey))
        .filter((r): r is ExitRec =>
          !!r && (regime === undefined || r.volRegime === regime));
      if (rows.length === 0) continue;
      const foldSpecs = timeSeriesFolds(rows.length, folds);
      const scores: number[] = [];
      for (const { valLo, valHi } of foldSpecs) {
        scores.push(shrinkageExpectancy(rows.slice(valLo, valHi).map((r) => r.pnl), shrinkageK));
      }
      const avg = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0;
      if (!best || avg > best.score) best = { ex, score: avg };
    }
    return best?.ex ?? null;
  };

  const globalExit = pickExit(winSelected) ?? top.exit;
  const modeExit = pickExit(winSelected) ?? globalExit;

  // bySymbolDir: схлопнут volRegime
  const bySymbolDir: Record<string, Partial<Record<"long" | "short", ExitParams>>> = {};
  // cells: [channel][symbol][direction][volRegime]
  type DirCell = Partial<Record<"long" | "short", Partial<Record<import("./volume").VolRegime, ExitParams>>>>;
  const cells: Record<string, Record<string, DirCell>> = {};

  // ключ канала для ячейки: в matrix-режиме всплеск МЕЖКАНАЛЬНЫЙ (нет одного
  // владельца), поэтому ячейки кладём под канонический "_matrix" — ровно тот ключ,
  // которым их потом ищет buildPlan для matrix-вердиктов (у них channel=null).
  // В single-режиме канал реальный — exit персонален каналу.
  const cellChannel = (realChannel: string) => effMode === "matrix" ? "_matrix" : realChannel;

  // группировка
  const group = new Map<string, Labeled[]>(); // key = channel|symbol|direction
  const groupSD = new Map<string, Labeled[]>(); // key = symbol|direction
  for (const b of winSelected) {
    const gk = `${cellChannel(b.channel)}\u0001${b.symbol}\u0001${b.direction}`;
    (group.get(gk) ?? group.set(gk, []).get(gk)!).push(b);
    const sk = `${b.symbol}\u0001${b.direction}`;
    (groupSD.get(sk) ?? groupSD.set(sk, []).get(sk)!).push(b);
  }

  // symbol-dir уровень (fallback при пустом volRegime)
  for (const [sk, subset] of groupSD) {
    const [symbol, direction] = sk.split("\u0001") as [string, "long" | "short"];
    const ex = pickExit(subset);
    if (ex) ((bySymbolDir[symbol] ??= {}) as any)[direction] = ex;
  }

  // cell уровень: отдельный exit на каждый volRegime (calm/anomalous)
  for (const [gk, subset] of group) {
    const [channel, symbol, direction] = gk.split("\u0001") as [string, string, "long" | "short"];
    for (const regime of ["calm", "anomalous"] as const) {
      const ex = pickExit(subset, regime);
      if (!ex) continue;
      (((cells[channel] ??= {})[symbol] ??= {})[direction] ??= {})[regime] = ex;
    }
  }

  const emptyCh = {} as Record<string, Record<string, DirCell>>;
  const emptySD = {} as Record<string, Partial<Record<"long" | "short", ExitParams>>>;
  const tensor: ExitTensor = {
    cells: {
      matrix: effMode === "matrix" ? cells : emptyCh,
      single: effMode === "single" ? cells : emptyCh,
    },
    bySymbolDir: {
      matrix: effMode === "matrix" ? bySymbolDir : emptySD,
      single: effMode === "single" ? bySymbolDir : emptySD,
    },
    byMode: { matrix: modeExit, single: modeExit },
    global: globalExit,
  };

  // ── risk-reward: исследовательский выход бэктеста ──
  // RR = pnl / hardStop по сделкам с ВЫБРАННЫМ для символа exit. Считаем per-symbol
  // (для runtime-фильтра по символам) и global (для отчёта). Сделки берём из winSelected
  // под exit, реально назначенный символу (symbol-dir уровень), чтобы RR соответствовал
  // тому, что прод исполнит.
  const rrTradesBySymbol = new Map<string, Array<{ pnl: number; hardStop: number }>>();
  const rrTradesGlobal: Array<{ pnl: number; hardStop: number }> = [];
  const pnlsBySymbol = new Map<string, number[]>();
  const pnlsGlobal: number[] = [];
  // история сигналов выбранной конфигурации (для dump → внешней аналитики).
  // Берём exit, выбранный для каждого (symbol,direction) — то, что исполнит прод.
  const history: SignalRecord[] = [];
  for (const [sk, subset] of groupSD) {
    const [symbol, direction] = sk.split("\u0001") as [string, "long" | "short"];
    const ex = bySymbolDir[symbol]?.[direction];
    if (!ex) continue;
    const ekey = exitKey(ex);
    for (const b of subset) {
      const r = b.byExit.get(ekey);
      if (!r) continue;
      // запись истории — для ВСЕХ сигналов (вошли/не вошли), чтобы аналитика
      // могла считать и пропуски (veto/no-entry), и реализованные сделки
      history.push({
        id: b.id, ids: b.ids,
        symbol, direction, channel: b.channel, ts: b.ts,
        entered: r.entered, entryPrice: r.entryPrice, exitPrice: r.exitPrice,
        pnl: r.pnl, peak: r.peak, reason: r.reason, heldMinutes: r.heldMinutes,
        inverted: r.inverted, volRegime: r.volRegime,
        independentClusters: b.independentClusters,
      });
      if (!r.entered) continue;
      const trade = { pnl: r.pnl, hardStop: ex.hardStop };
      (rrTradesBySymbol.get(symbol) ?? rrTradesBySymbol.set(symbol, []).get(symbol)!).push(trade);
      rrTradesGlobal.push(trade);
      (pnlsBySymbol.get(symbol) ?? pnlsBySymbol.set(symbol, []).get(symbol)!).push(r.pnl);
      pnlsGlobal.push(r.pnl);
    }
  }
  history.sort((a, b) => a.ts - b.ts);
  const riskRewardBySymbol: Record<string, RiskRewardStats> = {};
  for (const [symbol, trades] of rrTradesBySymbol) {
    riskRewardBySymbol[symbol] = riskRewardStats(trades);
  }
  const riskRewardGlobal = riskRewardStats(rrTradesGlobal);
  // устойчивая к выбросам статистика PnL: median + перцентили, чтобы одна плохая
  // (или одна жирная) сделка не определяла оценку выигрыша системы.
  const pnlBySymbol: Record<string, PnlStats> = {};
  for (const [symbol, pnls] of pnlsBySymbol) {
    pnlBySymbol[symbol] = pnlStats(pnls);
  }
  const pnlGlobal = pnlStats(pnlsGlobal);

  const params: TrainedParams = {
    version: 3,
    config: top.config,
    exit: tensor,
    policy: opts.policy ?? DEFAULT_POLICY,
    riskReward: { bySymbol: riskRewardBySymbol, global: riskRewardGlobal },
    pnl: { bySymbol: pnlBySymbol, global: pnlGlobal },
    history,
    meta: {
      trainedAt: Date.now(), folds, shrinkageK,
      cvScore: top.cvScore, nestedScore, cvWinrate: top.cvWinrate, cvSupport: top.cvSupport,
      gridSize: board.length,
      mode: effMode,
      modeReason,
      impactHorizonMinutes: globalExit.staleMinutes,
      confidence: reliability.confidence, reliable: reliability.reliable,
      support: reliability.support, stability: reliability.stability,
      significance: reliability.significance, totalSamples: reliability.totalN,
      certification,
      effectiveTrials: nTrialsEff,
      innerTrials,
      fitAttempts: opts.metaLedger ? fitAttemptCount(opts.metaLedger) + 1 : 1,
      labeling: {
        candidates: diagSeen.size,
        outcomes: Object.fromEntries(outcomeTally) as Partial<Record<LabelOutcome, number>>,
        errors: Object.fromEntries(errorTally),
      },
    },
  };

  const leaderboard = board.slice(0, 20).map(
    ({ config, exit, cvScore, cvWinrate, cvSupport }) =>
      ({ config, exit, cvScore, cvWinrate, cvSupport }),
  );
  return { predict: loadPredict(params), params, reliability, leaderboard };
}

function cfgOf(
  windowK: number, minClusters: number, jaccardThreshold: number,
  lagPeakThreshold: number, maxBurstWindowMs: number,
  mode: "matrix" | "single", stationarityWindowMs: number,
): DetectorConfig {
  return { windowK, minClusters, jaccardThreshold, lagPeakThreshold, maxBurstWindowMs, mode, stationarityWindowMs };
}

// ─────────────────── десериализация: params → predict ─────────────────────────

export function loadPredict(
  params: TrainedParams,
): (items: ParserItem[]) => PredictionResult {
  if (params.version !== 3) throw new Error(`unsupported params version: ${params.version}`);
  const cfg = params.config;
  return (items: ParserItem[]) => predictRaw(items, cfg);
}
