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
  /** id якорного (последнего в окне) события — для сопоставления с парсингом */
  id?: string;
  /** id ВСЕХ событий, вошедших во всплеск (в matrix может быть несколько) */
  ids?: string[];
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

  // ── ДВА РАЗНЫХ ОКНА (их легко перепутать) ──
  // 1) stationarityWindowMs — окно ИСТОРИИ для построения author-матрицы: как далеко
  //    назад смотреть, чтобы понять КАКИЕ каналы — братский кластер. Infinity =
  //    вся история (кластеры стабильны). НЕ длительность пампа и НЕ время удержания.
  // 2) burst window = min(windowK·τ, maxBurstWindowMs) (ниже) — окно СИНХРОННОСТИ
  //    самого пампа: события в этом окне на одном тикере = один всплеск. Ограничено
  //    maxBurstWindowMs (обычно 1ч), поэтому ПАМП ВСЕГДА КОРОТКИЙ — растянутые на
  //    часы/дни события НЕ собираются в один памп. Время удержания позиции — отдельно
  //    (staleMinutes в replay), тоже конечное.
  const buildAuthorCtx = (anchorTs: number) => {
    const tbl = Number.isFinite(stationarityWindowMs)
      ? buildWindowedTable(events, anchorTs, stationarityWindowMs)
      : fullTbl;
    const tau = selfTuneLag(tbl);
    const window = Math.min(windowK * tau, maxBurstWindowMs); // окно СИНХРОННОСТИ пампа
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
    // Раньше брался ОДИН best-per-symbol по всей истории — это ТЕРЯЛО разнесённые во
    // времени всплески (второй памп на том же тикере молча отбрасывался вместе с его
    // id). Теперь перечисляем все НЕПЕРЕСЕКАЮЩИЕСЯ по времени всплески: внутри каждого
    // временно́го кластера берём лучший по clusters/confidence, но кластеры не сливаем.
    let i = 0;
    while (i < evs.length) {
      // временно́й кластер: события, попадающие в окно синхронности от evs[i]
      const ctxStart = globalCtx ?? buildAuthorCtx(evs[i].ts);
      let j = i;
      while (j + 1 < evs.length && evs[j + 1].ts - evs[i].ts <= ctxStart.window) j++;
      // лучший анкер внутри кластера [i..j]
      let best: CandidateBurst | null = null;
      for (let hi = i; hi <= j; hi++) {
        const ctx = globalCtx ?? buildAuthorCtx(evs[hi].ts);
        let lo = hi;
        while (lo > i && evs[hi].ts - evs[lo - 1].ts <= ctx.window) lo--;
        const slice = evs.slice(lo, hi + 1);
        const clusters = new Set(slice.map((e) => ctx.clusterOf.get(e.channel)));
        const channels = new Set(slice.map((e) => e.channel));
        const dedup = clusters.size / channels.size;
        const fill = Math.min(slice.length / 4, 1);
        const rawAnchorId = (evs[hi] as SignalEvent & { id?: unknown }).id;
        const anchorId = typeof rawAnchorId === "string" ? rawAnchorId : (typeof rawAnchorId === "number" ? String(rawAnchorId) : undefined);
        const cand: CandidateBurst = {
          symbol, direction, ts: evs[hi].ts,
          independentClusters: clusters.size,
          totalChannels: channels.size,
          confidence: +(dedup * fill).toFixed(6),
          id: anchorId,
          // ids ВСЕГО временно́го кластера [i..j], чтобы ни один parser-item не пропал
          ids: evs.slice(i, j + 1).map((e) => {
            const r = (e as SignalEvent & { id?: unknown }).id;
            return typeof r === "string" ? r : (typeof r === "number" ? String(r) : undefined);
          }).filter((x): x is string => x != null),
        };
        if (!best || cand.independentClusters > best.independentClusters ||
          (cand.independentClusters === best.independentClusters && cand.confidence > best.confidence))
          best = cand;
      }
      if (best && best.independentClusters >= 1) bursts.push(best);
      i = j + 1; // следующий непересекающийся кластер
    }
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

  const toId = (e: SignalEvent & { id?: unknown }): string | undefined => {
    const r = e.id;
    return typeof r === "string" ? r : (typeof r === "number" ? String(r) : undefined);
  };
  const out: CandidateBurst[] = [];
  for (const [k, evs] of tbl.byKey) {
    const [symbol, direction] = splitKey(k);
    let lastTs = -Infinity;
    let current: CandidateBurst | null = null;
    for (const e of evs) {
      const id = toId(e as SignalEvent);
      if (e.ts - lastTs <= window) {
        // пост схлопывается в текущий всплеск — но его id НЕ теряем: добавляем в ids,
        // иначе исходный parser-item стал бы несопоставимым с результатом.
        if (current && id != null) current.ids!.push(id);
        continue;
      }
      lastTs = e.ts;
      current = {
        symbol, direction, ts: e.ts,
        independentClusters: 1, totalChannels: 1, confidence: 0.5,
        id,
        ids: id != null ? [id] : [],
      };
      out.push(current);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
