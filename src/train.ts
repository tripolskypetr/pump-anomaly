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
import { labelBurst, exitKey } from "./label";
import { ExitParams } from "./replay";
import { ExitTensor } from "./exit-tensor";
import { SignalPolicy, DEFAULT_POLICY } from "./signal";
import { shrinkageExpectancy, winrate } from "./objective";
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
  squeezePolicy: Array<"none" | "tighten" | "veto" | "invert">;
  /** порог squeezePressure для срабатывания policy */
  squeezeThreshold: number[];
  /** baseline-окно для volZ (свечей до входа) */
  volBaselineWindow: number[];
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
  jaccardThreshold: [0.2, 0.3, 0.4],
  lagPeakThreshold: [0.4, 0.5, 0.6],
  trailingTake: [0.5, 1.0, 2.0],
  hardStop: [1.0, 2.0, 3.0],
  stalenessSinceProfit: [1.0],
  stalenessSinceMinutes: [240],
  staleMinutes: [60, 240, 720, 1440], // 1ч / 4ч / 12ч / 24ч — какой импакт-горизонт лучше
  volZThreshold: [1.5, 2.5],          // когда считать объём аномальным (накопление топлива)
  squeezePolicy: ["none", "tighten", "veto", "invert"], // train выберет реакцию по CV
  squeezeThreshold: [0.55, 0.7],      // доля объёма против позиции для срабатывания
  volBaselineWindow: [20],
  // вся история + конечные окна (4 / 8 недель); train выберет по CV
  stationarityWindowMs: [Infinity, 28 * 24 * 3600_000, 56 * 24 * 3600_000],
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
}

// ─────────────────── сериализуемый результат обучения ─────────────────────────

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
  meta: {
    trainedAt: number;
    folds: number;
    shrinkageK: number;
    cvScore: number;
    cvWinrate: number;
    cvSupport: number;
    gridSize: number;
    /** эффективный режим обучения: matrix | single */
    mode: "matrix" | "single";
    // импакт-горизонт отдельно — главный исследовательский выход
    impactHorizonMinutes: number;
    confidence: number;
    reliable: boolean;
    support: number;
    stability: number;
    significance: number;
    totalSamples: number;
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
  const maxBurstWindowMs = opts.maxBurstWindowMs ?? DEFAULT_CONFIG.maxBurstWindowMs;

  // разрешаем эффективный режим обучения — тем же строгим критерием, что и predict
  const reqMode = opts.mode ?? "auto";
  let effMode: "matrix" | "single";
  if (reqMode === "matrix") effMode = "matrix";
  else if (reqMode === "single") effMode = "single";
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
                    exitSets.push({
                      trailingTake: tt, hardStop: hs,
                      stalenessSinceProfit: sp, stalenessSinceMinutes: sm, staleMinutes: life,
                      volZThreshold: vz, squeezePolicy: pol,
                      squeezeThreshold: sqt, volBaselineWindow: bw,
                    });

  // кэш: ключ кластеризации → размеченные всплески.
  // храним полный ReplayResult (нужен volRegime + entered для tensor и veto-метрики).
  type Labeled = {
    channel: string; symbol: string; direction: "long" | "short"; ts: number;
    independentClusters: number;
    byExit: Map<string, { pnl: number; volRegime: import("./volume").VolRegime; entered: boolean }>;
  };
  const labeledCache = new Map<string, Labeled[]>();
  const seenCluster = new Set<string>();

  const labelCandidates = async (
    cands: ReturnType<typeof enumerateBursts>,
    onTick?: (symbol: string) => void,
  ): Promise<Labeled[]> => {
    const labeled: Labeled[] = [];
    for (const b of cands) {
      const src = entryIndex.get(`${b.symbol}|${b.direction}|${b.ts}`);
      const lb = await labelBurst(
        getCandles, b.symbol, b.direction, b.ts, exitSets,
        src?.entryFromPrice, src?.entryToPrice,
      );
      onTick?.(b.symbol);
      if (!lb) continue;
      const byExit = new Map<string, { pnl: number; volRegime: import("./volume").VolRegime; entered: boolean }>();
      // veto-вход (entered=false, reason=cascade-veto) тоже несёт сигнал: его pnl=0,
      // и он ДОЛЖЕН учитываться как «не вошли и не потеряли», иначе policy=veto нечестно
      // сравнивать с policy=none. Поэтому храним и не-entered, помечая флагом.
      for (const [k, r] of lb.byExit) {
        byExit.set(k, { pnl: r.pnl, volRegime: r.volRegime, entered: r.entered });
      }
      if (byExit.size === 0) continue;
      labeled.push({
        channel: src?.channel ?? "_unknown",
        symbol: b.symbol, direction: b.direction, ts: b.ts,
        independentClusters: b.independentClusters, byExit,
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
    _foldMeans: number[]; _foldSizes: number[]; _returns: number[];
  };
  const board: Entry[] = [];

  // total для фазы score = число (wK×jac×lag×sw) комбинаций (тик на каждую)
  const scoreTotal = grid.windowK.length * grid.jaccardThreshold.length
    * grid.lagPeakThreshold.length * swAxis.length;
  let scoreDone = 0;

  for (const wK of grid.windowK)
    for (const jac of grid.jaccardThreshold)
      for (const lag of grid.lagPeakThreshold)
        for (const sw of swAxis) {
        const labeled = effMode === "single"
          ? labeledCache.get(`single|${wK}`)!
          : labeledCache.get(`${wK}|${jac}|${lag}|${sw}`)!;
        for (const minC of minClusterAxis)
          for (const ex of exitSets) {
            const ekey = exitKey(ex);
            const selected = labeled
              .filter((b) => b.independentClusters >= minC && b.byExit.has(ekey))
              .sort((a, b) => a.ts - b.ts);
            const cfg = cfgOf(wK, minC, jac, lag, maxBurstWindowMs, effMode, sw);
            if (selected.length === 0) {
              board.push({ config: cfg, exit: ex, cvScore: 0, cvWinrate: 0, cvSupport: 0,
                _foldMeans: [], _foldSizes: [], _returns: [] });
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
              allRet.push(...valRet);
            }
            const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
            board.push({
              config: cfg, exit: ex,
              cvScore: +avg(foldScores).toFixed(6),
              cvWinrate: +avg(foldWins).toFixed(6),
              cvSupport: +avg(foldSupp).toFixed(2),
              _foldMeans: foldMeans, _foldSizes: foldSupp, _returns: allRet,
            });
          }
        scoreDone++;
        progress({ done: scoreDone, total: scoreTotal, phase: "score", label: `${wK}|${jac}|${lag}|${sw === Infinity ? "all" : sw}` });
      }

  board.sort((a, b) => b.cvScore - a.cvScore);
  const top = board[0];

  const reliability = computeReliability(
    { foldMeans: top._foldMeans, foldSizes: top._foldSizes, allReturns: top._returns },
    { ...DEFAULT_RELIABILITY, ...opts.reliability },
  );

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
        .filter((r): r is { pnl: number; volRegime: import("./volume").VolRegime; entered: boolean } =>
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

  const params: TrainedParams = {
    version: 3,
    config: top.config,
    exit: tensor,
    policy: opts.policy ?? DEFAULT_POLICY,
    meta: {
      trainedAt: Date.now(), folds, shrinkageK,
      cvScore: top.cvScore, cvWinrate: top.cvWinrate, cvSupport: top.cvSupport,
      gridSize: board.length,
      mode: effMode,
      impactHorizonMinutes: globalExit.staleMinutes,
      confidence: reliability.confidence, reliable: reliability.reliable,
      support: reliability.support, stability: reliability.stability,
      significance: reliability.significance, totalSamples: reliability.totalN,
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
