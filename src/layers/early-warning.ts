import { AuthorMap, DetectorConfig, PumpVerdict } from "../types";
import { EventTable, splitKey } from "../core/event-table";

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
export function earlyWarning(
  tbl: EventTable,
  clusterOf: AuthorMap,
  cfg: DetectorConfig,
  tau: number,
): PumpVerdict[] {
  const window = Math.min(cfg.windowK * tau, cfg.maxBurstWindowMs);
  const verdicts: PumpVerdict[] = [];

  for (const [k, evs] of tbl.byKey) {
    const [symbol, direction] = splitKey(k);
    let lo = 0;
    let best: PumpVerdict | null = null;

    for (let hi = 0; hi < evs.length; hi++) {
      while (evs[hi].ts - evs[lo].ts > window) lo++;
      const slice = evs.slice(lo, hi + 1);
      const clusters = new Set(slice.map((e) => clusterOf.get(e.channel)));
      const channels = new Set(slice.map((e) => e.channel));

      if (clusters.size >= cfg.minClusters) {
        const dedup = clusters.size / channels.size;
        const fill = Math.min(slice.length / (cfg.minClusters * 2), 1);
        const confidence = +(dedup * fill).toFixed(6);
        const cand: PumpVerdict = {
          symbol,
          direction,
          action: "open",
          ts: evs[hi].ts,
          independentClusters: clusters.size,
          totalChannels: channels.size,
          confidence,
          reason:
            `${clusters.size} независимых кластеров по ${symbol} ${direction} ` +
            `в окне ${(window / 60000).toFixed(0)}м (каналов: ${channels.size})`,
          source: "matrix",
          channel: null,
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
