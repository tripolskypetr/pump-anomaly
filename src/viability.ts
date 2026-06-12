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

/** Считает макс. событийное перекрытие среди всех пар каналов по общим ключам. */
function maxSharedEvents(tbl: EventTable): number {
  const ch = tbl.channels;
  let max = 0;
  for (let i = 0; i < ch.length; i++)
    for (let j = i + 1; j < ch.length; j++) {
      let shared = 0;
      for (const k of tbl.byKey.keys()) {
        const a = tbl.byChannelKey.get(`${ch[i]}|${k}`);
        const b = tbl.byChannelKey.get(`${ch[j]}|${k}`);
        if (a && b) shared += Math.min(a.length, b.length);
      }
      if (shared > max) max = shared;
    }
  return max;
}

export function assessViability(
  tbl: EventTable,
  directed: DirectedEdge[],
  authors: AuthorMap,
  cfg: ViabilityConfig = DEFAULT_VIABILITY,
): ViabilityReport {
  const channels = tbl.channels.length;
  const maxShared = maxSharedEvents(tbl);
  const strongEdges = directed.filter((e) => e.peakShare >= cfg.minPeakShare).length;

  // структура графа: размеры кластеров
  const sizeById = new Map<number, number>();
  for (const id of authors.values()) sizeById.set(id, (sizeById.get(id) ?? 0) + 1);
  const multiChannelClusters = [...sizeById.values()].filter((s) => s > 1).length;
  const clusterCount = sizeById.size;

  // СТРОГИЙ критерий: все условия одновременно
  const enoughChannels = channels >= 2;
  const enoughOverlap = maxShared >= cfg.minSharedEvents;
  const enoughEdges = strongEdges >= cfg.minStrongEdges;
  // нетривиальность: либо найдены братья (кластер >1), либо ≥minStructure независимых кластеров
  const nontrivial = multiChannelClusters >= 1 || clusterCount >= cfg.minStructure;

  const viable = enoughChannels && enoughOverlap && enoughEdges && nontrivial;

  let reason: string;
  if (!enoughChannels) reason = `один канал — корреляция невозможна`;
  else if (!enoughOverlap) reason = `мало общих событий (макс ${maxShared} < ${cfg.minSharedEvents}) — перекрытие шумовое`;
  else if (!enoughEdges) reason = `нет связей с острым пиком (${strongEdges} < ${cfg.minStrongEdges}) — корреляция случайна`;
  else if (!nontrivial) reason = `граф тривиален (кластеров >1: ${multiChannelClusters}, всего: ${clusterCount})`;
  else reason = `матрица жизнеспособна: ${strongEdges} острых связей, перекрытие ${maxShared}, кластеров >1: ${multiChannelClusters}`;

  return {
    viable, channels, maxSharedEvents: maxShared, strongEdges,
    multiChannelClusters, clusterCount, reason,
  };
}
