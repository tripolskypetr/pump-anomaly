import { AuthorMap, DetectorConfig, PumpVerdict } from "../types";
import { EventTable, splitKey } from "../core/event-table";
import { hawkesBurst, hawkesWeight } from "./hawkes-burst";
import { leadershipWeight } from "./author-influence";

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
export function earlyWarning(
  tbl: EventTable,
  clusterOf: AuthorMap,
  cfg: DetectorConfig,
  tau: number,
  /** влиятельность каналов из направленного графа (слой 7); нет → нейтрально */
  influence?: Map<string, number>,
): PumpVerdict[] {
  const window = Math.min(cfg.windowK * tau, cfg.maxBurstWindowMs);
  const verdicts: PumpVerdict[] = [];

  for (const [k, evs] of tbl.byKey) {
    const [symbol, direction] = splitKey(k);
    const groupTs = evs.map((e) => e.ts);
    let lo = 0;
    let best: PumpVerdict | null = null;

    for (let hi = 0; hi < evs.length; hi++) {
      while (evs[hi].ts - evs[lo].ts > window) lo++;
      const slice = evs.slice(lo, hi + 1);
      const clusters = new Set(slice.map((e) => clusterOf.get(e.channel)));
      const channels = new Set(slice.map((e) => e.channel));

      if (clusters.size >= cfg.minClusters) {
        // ЭФФЕКТИВНОЕ число независимых авторов (participation ratio, число Хилла):
        // N_eff = 1/Σp², p_c — доля событий кластера c в срезе. Целочисленный
        // clusters.size слеп к дисбалансу: {5 постов автора A, 1 пост B} — это не
        // «2 независимых источника», а 1.4. Гейт остаётся на clusters.size
        // (консервативная совместимость), но confidence взвешивается N_eff —
        // ошибки кластеризации деградируют плавно, а не ступенькой.
        const perCluster = new Map<number | undefined, number>();
        for (const e of slice) {
          const c = clusterOf.get(e.channel);
          perCluster.set(c, (perCluster.get(c) ?? 0) + 1);
        }
        let sumP2 = 0;
        for (const cnt of perCluster.values()) sumP2 += (cnt / slice.length) ** 2;
        const nEff = 1 / sumP2;
        const dedup = nEff / channels.size;
        const fill = Math.min(slice.length / (cfg.minClusters * 2), 1);
        const burst = hawkesBurst(groupTs, hi, tau);
        const lw = influence
          ? leadershipWeight(channels, influence)
          : { weight: 1, leaderShare: 0.5 };
        const confidence = +(dedup * fill * hawkesWeight(burst.score) * lw.weight).toFixed(6);
        const cand: PumpVerdict = {
          symbol,
          direction,
          action: "open",
          ts: evs[hi].ts,
          independentClusters: clusters.size,
          nEffClusters: +nEff.toFixed(3),
          totalChannels: channels.size,
          confidence,
          burstScore: +burst.score.toFixed(6),
          leaderShare: +lw.leaderShare.toFixed(6),
          reason:
            `${clusters.size} независимых кластеров по ${symbol} ${direction} ` +
            `в окне ${(window / 60000).toFixed(0)}м (каналов: ${channels.size}, ` +
            `hawkes ×${burst.score.toFixed(2)}, лидерство ${lw.leaderShare.toFixed(2)})`,
          source: "matrix",
          channel: null,
          entryFromPrice: evs[hi].entryFromPrice,
          entryToPrice: evs[hi].entryToPrice,
        };
        if (!best || cand.confidence > best.confidence) best = cand;
      }
    }

    verdicts.push(
      best ?? {
        symbol,
        direction,
        action: "skip",
        ts: evs[evs.length - 1]?.ts ?? 0,
        independentClusters: 0,
        totalChannels: new Set(evs.map((e) => e.channel)).size,
        confidence: 0,
        reason: `нет синхронного всплеска независимых авторов по ${symbol} ${direction}`,
        source: "matrix",
        channel: null,
      },
    );
  }

  return verdicts.sort((a, b) => b.confidence - a.confidence);
}
