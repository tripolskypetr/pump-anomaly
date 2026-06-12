import {
  DEFAULT_CONFIG,
  DetectorConfig,
  ParserItem,
  PredictionResult,
  SignalEvent,
} from "./types";
import { buildTable } from "./core/event-table";
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
 *   - "auto":   ≥2 каналов и матрица дала сигналы → matrix, иначе → single.
 *
 * Слой выхода (trailing/hardStop) один на оба режима — меняется только условие входа.
 */
export function predict(
  parserItems: ParserItem[],
  config: Partial<DetectorConfig> = {},
): PredictionResult {
  const cfg: DetectorConfig = { ...DEFAULT_CONFIG, ...config };
  const events = normalize(parserItems);
  const tbl = buildTable(events);

  const tau = selfTuneLag(tbl);
  const window = Math.min(cfg.windowK * tau, cfg.maxBurstWindowMs);

  const screened = jaccardScreen(tbl, window, cfg.jaccardThreshold);
  const directed = lagXCorr(tbl, screened, cfg.lagPeakThreshold, window);
  const authors = clusterAuthors(tbl.channels, directed);
  const matrixVerdicts = earlyWarning(tbl, authors, cfg, tau);
  const matrixOpens = matrixVerdicts.filter((v) => v.action === "open");

  // оценка жизнеспособности матрицы (строгий критерий: явные кластеры + перекрытие)
  const viability = assessViability(tbl, directed, authors, {
    ...DEFAULT_VIABILITY,
    ...cfg.viability,
  });

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
export { buildTable } from "./core/event-table";
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
export type { LabeledBurst } from "./label";
export { replayExit } from "./replay";
export type { ExitParams, ExitReason, ReplayResult } from "./replay";
export {
  volumeZScore, squeezePressure, volumeFeatures, volRegimeOf,
} from "./volume";
export type { VolumeFeatures, VolRegime } from "./volume";
export { shrinkageExpectancy, winrate } from "./objective";
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
  TrainResult,
} from "./train";
export { PumpMatrix } from "./pump-matrix";
export type { TradePlan } from "./pump-matrix";
