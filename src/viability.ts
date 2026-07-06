import { EventTable } from "./core/event-table";
import { DirectedEdge } from "./layers/lag-xcorr";
import { AuthorMap, ViabilityConfig, ViabilityReport } from "./types";

/**
 * Жизнеспособность матрицы авторства. Отвечает на вопрос «достаточно ли в данных
 * структуры, чтобы доверять корреляции», а НЕ «выдала ли матрица хоть что-то».
 *
 * Без этого auto оставался бы в matrix даже на двух каналах со ШУМОВЫМ совпадением
 * (Jaccard случайно перевалил порог на 1-2 событиях) и выдавал бы ложный сигнал.
 * Строгий критерий: матрица годна только при ЯВНЫХ кластерах И достаточном
 * событийном перекрытии; иначе — откат в single.
 */

export const DEFAULT_VIABILITY: ViabilityConfig = {
  minSharedEvents: 3,
  minPeakShare: 0.6,
  minStrongEdges: 1,
  minStructure: 2,
};

/**
 * Макс. событийное перекрытие среди пар каналов + ожидаемое СЛУЧАЙНОЕ число
 * коинциденций (λ) для пары-рекордсмена. λ по Пуассону: два независимых канала
 * с n_a и n_b событиями по ключу на интервале T дают ≈ n_a·n_b·(2·window/T)
 * случайных совпадений в пределах ±window. Наблюдаемое перекрытие, не превышающее
 * λ + 2√λ, объяснимо случаем — «3 общих события» на плотной истории ничего не значат.
 */
function overlapStats(tbl: EventTable, windowMs?: number): { maxShared: number; lambdaAtMax: number } {
  const ch = tbl.channels;
  const first = tbl.events[0]?.ts ?? 0;
  const last = tbl.events[tbl.events.length - 1]?.ts ?? 0;
  const span = Math.max(last - first, 1);
  let max = 0;
  let lambdaAtMax = 0;
  for (let i = 0; i < ch.length; i++)
    for (let j = i + 1; j < ch.length; j++) {
      let shared = 0;
      let lambda = 0;
      for (const k of tbl.byKey.keys()) {
        const a = tbl.byChannelKey.get(`${ch[i]}|${k}`);
        const b = tbl.byChannelKey.get(`${ch[j]}|${k}`);
        if (a && b) {
          shared += Math.min(a.length, b.length);
          if (windowMs) lambda += a.length * b.length * Math.min((2 * windowMs) / span, 1);
        }
      }
      if (shared > max) { max = shared; lambdaAtMax = lambda; }
    }
  return { maxShared: max, lambdaAtMax };
}

export function assessViability(
  tbl: EventTable,
  directed: DirectedEdge[],
  authors: AuthorMap,
  cfg: ViabilityConfig = DEFAULT_VIABILITY,
  /** окно синхронности для оценки случайного перекрытия (нужно при autoOverlap) */
  windowMs?: number,
): ViabilityReport {
  const channels = tbl.channels.length;
  const { maxShared, lambdaAtMax } = overlapStats(tbl, windowMs);
  // порог перекрытия: фиксированный ИЛИ поднятый до границы случайности (λ + 2√λ).
  // Безразмерного «3» не существует: на плотной истории 3 совпадения — фон.
  const minSharedUsed = cfg.autoOverlap && windowMs
    ? Math.max(cfg.minSharedEvents, Math.ceil(lambdaAtMax + 2 * Math.sqrt(lambdaAtMax)))
    : cfg.minSharedEvents;
  const strongEdges = directed.filter((e) => e.peakShare >= cfg.minPeakShare).length;

  // структура графа: размеры кластеров
  const sizeById = new Map<number, number>();
  for (const id of authors.values()) sizeById.set(id, (sizeById.get(id) ?? 0) + 1);
  const multiChannelClusters = [...sizeById.values()].filter((s) => s > 1).length;
  const clusterCount = sizeById.size;

  // СТРОГИЙ критерий: все условия одновременно
  const enoughChannels = channels >= 2;
  const enoughOverlap = maxShared >= minSharedUsed;
  const enoughEdges = strongEdges >= cfg.minStrongEdges;
  // нетривиальность: либо найдены братья (кластер >1), либо ≥minStructure независимых кластеров
  const nontrivial = multiChannelClusters >= 1 || clusterCount >= cfg.minStructure;

  const viable = enoughChannels && enoughOverlap && enoughEdges && nontrivial;

  const thrNote = minSharedUsed > cfg.minSharedEvents
    ? `${minSharedUsed} (порог случайности: λ=${lambdaAtMax.toFixed(1)})`
    : `${minSharedUsed}`;
  let reason: string;
  if (!enoughChannels) reason = `один канал — корреляция невозможна`;
  else if (!enoughOverlap) reason = `мало общих событий (макс ${maxShared} < ${thrNote}) — перекрытие шумовое`;
  else if (!enoughEdges) reason = `нет связей с острым пиком (${strongEdges} < ${cfg.minStrongEdges}) — корреляция случайна`;
  else if (!nontrivial) reason = `граф тривиален (кластеров >1: ${multiChannelClusters}, всего: ${clusterCount})`;
  else reason = `матрица жизнеспособна: ${strongEdges} острых связей, перекрытие ${maxShared} ≥ ${thrNote}, кластеров >1: ${multiChannelClusters}`;

  return {
    viable, channels, maxSharedEvents: maxShared, strongEdges,
    multiChannelClusters, clusterCount, reason,
    minSharedEventsUsed: minSharedUsed,
  };
}
