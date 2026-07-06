import { DirectedEdge } from "./lag-xcorr";

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
export function authorInfluence(
  channels: string[],
  edges: DirectedEdge[],
): Map<string, number> {
  const lead = new Map<string, number>();
  const follow = new Map<string, number>();
  for (const e of edges) {
    lead.set(e.leader, (lead.get(e.leader) ?? 0) + e.peakShare);
    follow.set(e.follower, (follow.get(e.follower) ?? 0) + e.peakShare);
  }
  const out = new Map<string, number>();
  for (const c of channels) {
    const l = lead.get(c) ?? 0;
    const f = follow.get(c) ?? 0;
    out.set(c, (0.5 + l) / (1 + l + f));
  }
  return out;
}

/**
 * Вес всплеска по лидерству участников: среднее influence каналов среза,
 * нормированное так, что нейтральный состав (0.5) → 1 (без изменений),
 * чистое эхо → дисконт к 0, лидеры → без бонуса (консервативно, cap 1).
 */
export function leadershipWeight(
  sliceChannels: Iterable<string>,
  influence: Map<string, number>,
): { weight: number; leaderShare: number } {
  let sum = 0;
  let n = 0;
  for (const c of sliceChannels) {
    sum += influence.get(c) ?? 0.5;
    n++;
  }
  const leaderShare = n ? sum / n : 0.5;
  return { weight: Math.min(2 * leaderShare, 1), leaderShare };
}
