/**
 * Контракты pump-matrix.
 *
 * ParserItem — совместим со схемой parser-items из backtest-ollama-crontab
 * (поля direction/entry/targets/stoploss присутствуют в источнике, но детектору
 *  нужны только channel/symbol/direction/ts — остальное игнорируется).
 */

export type Direction = "long" | "short";

/** Режим отбора входов. */
export type DetectorMode = "auto" | "matrix" | "single";

/** Пороги жизнеспособности матрицы авторства (строгий критерий для auto-режима). */
export interface ViabilityConfig {
  minSharedEvents: number;
  minPeakShare: number;
  minStrongEdges: number;
  minStructure: number;
}

/** Отчёт о жизнеспособности матрицы — почему auto выбрал matrix или single. */
export interface ViabilityReport {
  viable: boolean;
  channels: number;
  maxSharedEvents: number;
  strongEdges: number;
  multiChannelClusters: number;
  clusterCount: number;
  reason: string;
}

/** Строка из коллекции parser-items (вход публичного API). */
export interface ParserItem {
  channel: string;
  symbol: string;
  direction: Direction;
  /** unix-время публикации, мс. */
  ts: number;
  /** нижняя граница зоны входа (один пост уже двигает цену). */
  entryFromPrice?: number;
  /** верхняя граница зоны входа. */
  entryToPrice?: number;
  // прочие поля parser-items (targets/stoploss/...) допускаются и игнорируются
  [extra: string]: unknown;
}

/** Нормализованное событие, с которым работают внутренние слои. */
export interface SignalEvent {
  channel: string;
  symbol: string;
  direction: Direction;
  ts: number;
  entryFromPrice?: number;
  entryToPrice?: number;
}

/** Вердикт по одному (symbol, direction). */
export interface PumpVerdict {
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
export type AuthorMap = Map<string, number>;

/** Полный результат предсказания. */
export interface PredictionResult {
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

export interface DetectorConfig {
  windowK: number;
  minClusters: number;
  jaccardThreshold: number;
  lagPeakThreshold: number;
  maxBurstWindowMs: number;
  /** режим отбора входов: auto (по жизнеспособности матрицы) | matrix | single */
  mode: DetectorMode;
  /** переопределение порогов жизнеспособности матрицы (auto-режим) */
  viability?: Partial<ViabilityConfig>;
}

export const DEFAULT_CONFIG: DetectorConfig = {
  windowK: 3,
  minClusters: 2,
  jaccardThreshold: 0.3,
  lagPeakThreshold: 0.5,
  maxBurstWindowMs: 60 * 60 * 1000,
  mode: "auto",
};
