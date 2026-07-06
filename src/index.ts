import {
  AuthorMap,
  DEFAULT_CONFIG,
  DetectorConfig,
  ParserItem,
  PredictionResult,
  PumpVerdict,
  SignalEvent,
  ViabilityReport,
} from "./types";
import { buildTable, buildWindowedTable } from "./core/event-table";
import { selfTuneLag } from "./layers/self-tune-lag";
import { jaccardScreen } from "./layers/jaccard-screen";
import { lagXCorr } from "./layers/lag-xcorr";
import { clusterAuthors } from "./layers/cluster-authors";
import { earlyWarning } from "./layers/early-warning";
import { singleChannelSignals } from "./layers/single-channel";
import { assessViability, DEFAULT_VIABILITY } from "./viability";

/** Нормализует parser-items в чистые события, отбрасывая лишние поля и мусор. */
function normalize(items: ParserItem[]): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (const it of items) {
    if (!it || typeof it.channel !== "string" || typeof it.symbol !== "string")
      continue;
    if (it.direction !== "long" && it.direction !== "short") continue;
    if (typeof it.ts !== "number" || !Number.isFinite(it.ts)) continue;
    out.push({
      channel: it.channel,
      symbol: it.symbol,
      direction: it.direction,
      ts: it.ts,
      entryFromPrice: typeof it.entryFromPrice === "number" ? it.entryFromPrice : undefined,
      entryToPrice: typeof it.entryToPrice === "number" ? it.entryToPrice : undefined,
      id: typeof it.id === "string" ? it.id : (typeof it.id === "number" ? String(it.id) : undefined),
    });
  }
  return out;
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
export function predict(
  parserItems: ParserItem[],
  config: Partial<DetectorConfig> = {},
): PredictionResult {
  const cfg: DetectorConfig = { ...DEFAULT_CONFIG, ...config };
  const events = normalize(parserItems);
  const fullTbl = buildTable(events);

  // окно стационарности: статистики авторства считаем по последнему окну,
  // заканчивающемуся на самом свежем событии (а не по всей истории).
  // anchor — из ОТСОРТИРОВАННОЙ таблицы: parser-items приходят в произвольном
  // порядке, и «последний элемент входа» может быть старым событием — тогда окно
  // заякорилось бы в прошлом и молча выбросило самые свежие сигналы.
  const sorted = fullTbl.events;
  const anchorTs = sorted.length ? sorted[sorted.length - 1].ts : 0;
  const tbl = Number.isFinite(cfg.stationarityWindowMs)
    ? buildWindowedTable(events, anchorTs, cfg.stationarityWindowMs)
    : fullTbl;

  const tau = selfTuneLag(tbl);
  const window = Math.min(cfg.windowK * tau, cfg.maxBurstWindowMs);

  // В ФОРС-single матричный конвейер НЕ гоняем: jaccardScreen O(C²·events) +
  // lagXCorr + кластеризация считались и выбрасывались на каждом live-вызове
  // (обученная single-модель платила за мёртвую корреляцию). Авторы — тривиально
  // независимые каналы; viability — честная заглушка «не оценивалась», а не
  // результат вычисления, которое никто не читает.
  let authors: AuthorMap;
  let matrixVerdicts: PumpVerdict[];
  let viability: ViabilityReport;
  if (cfg.mode === "single") {
    authors = new Map(tbl.channels.map((c, i) => [c, i]));
    matrixVerdicts = [];
    viability = {
      viable: false,
      channels: tbl.channels.length,
      maxSharedEvents: 0,
      strongEdges: 0,
      multiChannelClusters: 0,
      clusterCount: tbl.channels.length,
      reason: "mode=single задан явно — матрица авторства не оценивалась",
    };
  } else {
    const screened = jaccardScreen(tbl, window, cfg.jaccardThreshold);
    const directed = lagXCorr(tbl, screened, cfg.lagPeakThreshold, window);
    authors = clusterAuthors(tbl.channels, directed);
    matrixVerdicts = earlyWarning(tbl, authors, cfg, tau);
    // оценка жизнеспособности матрицы (строгий критерий: явные кластеры + перекрытие).
    // Порог перекрытия авто-поднимается до границы случайности (Пуассон), если
    // пользователь не зафиксировал minSharedEvents явно — фикс «3» без плотности
    // данных был магическим числом.
    viability = assessViability(tbl, directed, authors, {
      ...DEFAULT_VIABILITY,
      ...cfg.viability,
      autoOverlap: cfg.viability?.minSharedEvents === undefined
        && (cfg.viability?.autoOverlap ?? true),
    }, window);
  }
  const matrixOpens = matrixVerdicts.filter((v) => v.action === "open");

  // ── разрешение режима ──
  let usedMode: "matrix" | "single";
  if (cfg.mode === "matrix") usedMode = "matrix";
  else if (cfg.mode === "single") usedMode = "single";
  else {
    // auto: матрица только если корреляция ЖИЗНЕСПОСОБНА И реально дала сигнал.
    // Плохая корреляция на 2+ каналах (шумовое совпадение) → откат в single.
    usedMode = viability.viable && matrixOpens.length > 0 ? "matrix" : "single";
  }

  let signals; let verdicts;
  if (usedMode === "matrix") {
    verdicts = matrixVerdicts;
    signals = matrixOpens;
  } else {
    const fb = singleChannelSignals(tbl, cfg, tau);
    verdicts = fb;
    signals = fb; // в fallback все вердикты — это входы
  }

  return {
    signals,
    verdicts,
    authors,
    authorCount: new Set(authors.values()).size,
    tauMs: tau,
    windowMs: window,
    usedMode,
    viability,
  };
}

export * from "./types";
export * from "./candle";
export { buildTable, buildWindowedTable, windowEvents } from "./core/event-table";
export { selfTuneLag } from "./layers/self-tune-lag";
export { jaccardScreen, jaccardPair } from "./layers/jaccard-screen";
export { lagXCorr } from "./layers/lag-xcorr";
export { clusterAuthors } from "./layers/cluster-authors";
export { earlyWarning } from "./layers/early-warning";
export { singleChannelSignals } from "./layers/single-channel";
export { assessViability, DEFAULT_VIABILITY } from "./viability";
export { resolveExit, resolveExitNoRegime } from "./exit-tensor";
export type { ExitTensor, ResolvedExit, ResolveSource } from "./exit-tensor";
export { enumerateBursts, enumeratePosts } from "./enumerate";
export { labelBurst, exitKey } from "./label";
export { fetchCandlesChunked, MAX_CANDLES_PER_CHUNK } from "./chunked-candles";
export type { LabeledBurst } from "./label";
export { replayExit } from "./replay";
export type { ExitParams, ExitReason, ReplayResult } from "./replay";
export {
  volumeZScore, squeezePressure, volumeFeatures, volRegimeOf,
} from "./volume";
export type { VolumeFeatures, VolRegime } from "./volume";
export { shrinkageExpectancy, winrate, percentile, riskRewardStats, standardError, oneStandardErrorSelect, pnlStats } from "./objective";
export type { RiskRewardStats, PnlStats } from "./objective";
export {
  computeReliability,
  DEFAULT_RELIABILITY,
} from "./reliability";
export type {
  Reliability,
  ReliabilityInput,
  ReliabilityConfig,
} from "./reliability";
export {
  train,
  loadPredict,
  DEFAULT_GRID,
} from "./train";
export type {
  TrainGrid,
  TrainOptions,
  TrainedParams,
  SignalRecord,
  TrainResult,
} from "./train";
export { PumpMatrix } from "./pump-matrix";
export type {
  TradeSignal, BacktestSignal, BacktestResult, SignalAction, SignalOrigin, ExitPlan, SignalPolicy,
} from "./signal";
export { DEFAULT_POLICY, intersectPolicy } from "./signal";
export { DEFAULT_SELECTION, CASCADE_AGGRESSION, cascadeAggressionOf, conservatismKey, isMoreConservative } from "./selection";
export type { SelectionConfig } from "./selection";
export { stdoutProgress, silentProgress } from "./progress";
export type { ProgressFn, ProgressEvent } from "./progress";
export * from "./statistics";
export * from "./meta-ledger";
export { calibrateGrid } from "./calibrate";
export type { Calibration, CalibrationAxes } from "./calibrate";
export { walkForward } from "./walk-forward";
export type { WalkForwardResult, WalkForwardSlice, WalkForwardOptions } from "./walk-forward";
