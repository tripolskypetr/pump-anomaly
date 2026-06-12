import { DetectorConfig, ParserItem, SignalEvent, Direction } from "./types";
import { buildTable, splitKey, EventTable, buildWindowedTable } from "./core/event-table";
import { selfTuneLag } from "./layers/self-tune-lag";
import { jaccardScreen } from "./layers/jaccard-screen";
import { lagXCorr } from "./layers/lag-xcorr";
import { clusterAuthors } from "./layers/cluster-authors";

/** Кандидат-всплеск без применённого порога minClusters — для переиспользования в grid. */
export interface CandidateBurst {
  symbol: string;
  direction: Direction;
  ts: number;
  independentClusters: number;
  totalChannels: number;
  confidence: number;
}

/**
 * Перечисляет ВСЕ всплески при заданных (windowK, jaccardThreshold, lagPeakThreshold),
 * НЕ отсекая по minClusters — это делает grid дёшево поверх готового списка.
 * Кластеризация зависит от jaccard/lag/windowK, поэтому пересчитывается на эти оси grid;
 * а minClusters — пост-фильтр, его перебор бесплатный.
 */
export function enumerateBursts(
  items: ParserItem[] | SignalEvent[],
  windowK: number,
  jaccardThreshold: number,
  lagPeakThreshold: number,
  maxBurstWindowMs: number,
  stationarityWindowMs: number = Infinity,
): CandidateBurst[] {
  const events = items as SignalEvent[];
  const fullTbl: EventTable = buildTable(events);

  // author-матрица + τ считаются по ОКНУ СТАЦИОНАРНОСТИ, чтобы на длинном горизонте
  // не усреднять дрейфующие режимы. Без окна (Infinity) — старое поведение.
  // Для эффективности: если окно бесконечно, считаем матрицу один раз.
  const buildAuthorCtx = (anchorTs: number) => {
    const tbl = Number.isFinite(stationarityWindowMs)
      ? buildWindowedTable(events, anchorTs, stationarityWindowMs)
      : fullTbl;
    const tau = selfTuneLag(tbl);
    const window = Math.min(windowK * tau, maxBurstWindowMs);
    const screened = jaccardScreen(tbl, window, jaccardThreshold);
    const directed = lagXCorr(tbl, screened, lagPeakThreshold, window);
    const clusterOf = clusterAuthors(tbl.channels, directed);
    return { window, clusterOf };
  };

  // глобальный контекст для бесконечного окна (один раз)
  const globalCtx = Number.isFinite(stationarityWindowMs) ? null : buildAuthorCtx(0);

  const bursts: CandidateBurst[] = [];
  for (const [k, evs] of fullTbl.byKey) {
    const [symbol, direction] = splitKey(k);
    let best: CandidateBurst | null = null;
    for (let hi = 0; hi < evs.length; hi++) {
      // контекст авторства на момент этого события (его окно стационарности)
      const ctx = globalCtx ?? buildAuthorCtx(evs[hi].ts);
      // окно синхронности всплеска внутри контекста
      let lo = hi;
      while (lo > 0 && evs[hi].ts - evs[lo - 1].ts <= ctx.window) lo--;
      const slice = evs.slice(lo, hi + 1);
      const clusters = new Set(slice.map((e) => ctx.clusterOf.get(e.channel)));
      const channels = new Set(slice.map((e) => e.channel));
      const dedup = clusters.size / channels.size;
      const fill = Math.min(slice.length / 4, 1);
      const cand: CandidateBurst = {
        symbol, direction, ts: evs[hi].ts,
        independentClusters: clusters.size,
        totalChannels: channels.size,
        confidence: +(dedup * fill).toFixed(6),
      };
      if (!best || cand.independentClusters > best.independentClusters ||
        (cand.independentClusters === best.independentClusters && cand.confidence > best.confidence))
        best = cand;
    }
    if (best && best.independentClusters >= 1) bursts.push(best);
  }
  return bursts.sort((a, b) => a.ts - b.ts);
}

/**
 * Перечисляет КАЖДЫЙ пост как кандидата (single-channel fallback), схлопывая
 * близкие посты по одному (symbol,direction) в пределах окна в один вход.
 * independentClusters=1 всегда — фильтра качества нет, исход решает exit.
 */
export function enumeratePosts(
  items: ParserItem[] | SignalEvent[],
  windowK: number,
  maxBurstWindowMs: number,
): CandidateBurst[] {
  const tbl: EventTable = buildTable(items as SignalEvent[]);
  const tau = selfTuneLag(tbl);
  const window = Math.min(windowK * tau, maxBurstWindowMs);

  const out: CandidateBurst[] = [];
  for (const [k, evs] of tbl.byKey) {
    const [symbol, direction] = splitKey(k);
    let lastTs = -Infinity;
    for (const e of evs) {
      if (e.ts - lastTs <= window) continue;
      lastTs = e.ts;
      out.push({
        symbol, direction, ts: e.ts,
        independentClusters: 1, totalChannels: 1, confidence: 0.5,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
