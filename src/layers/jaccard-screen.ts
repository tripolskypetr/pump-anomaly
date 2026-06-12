import { EventTable } from "../core/event-table";

export interface Edge {
  a: string;
  b: string;
  jaccard: number;
}

/**
 * Близость двух каналов по скользящему окну (сырой ts, без бакетизации).
 * Доля событий по общим (symbol,direction), у которых нашёлся партнёр у другого
 * канала в пределах |Δ| ≤ window. Симметризованный Jaccard.
 */
export function jaccardPair(
  tbl: EventTable,
  a: string,
  b: string,
  window: number,
): number {
  let matched = 0;
  let total = 0;

  for (const k of tbl.byKey.keys()) {
    const ta = tbl.byChannelKey.get(`${a}|${k}`);
    const tb = tbl.byChannelKey.get(`${b}|${k}`);
    if (!ta && !tb) continue;
    total += (ta?.length ?? 0) + (tb?.length ?? 0);
    if (!ta || !tb) continue;

    // two-pointer: ближайшие пары в пределах окна
    let i = 0;
    let j = 0;
    let m = 0;
    while (i < ta.length && j < tb.length) {
      const d = ta[i] - tb[j];
      if (Math.abs(d) <= window) {
        m++;
        i++;
        j++;
      } else if (d < 0) {
        i++;
      } else {
        j++;
      }
    }
    matched += 2 * m;
  }

  return total === 0 ? 0 : matched / total;
}

/** Слой 2 — грубое сито: все пары каналов с Jaccard ≥ threshold. */
export function jaccardScreen(
  tbl: EventTable,
  window: number,
  threshold: number,
): Edge[] {
  const ch = tbl.channels;
  const edges: Edge[] = [];
  for (let i = 0; i < ch.length; i++) {
    for (let j = i + 1; j < ch.length; j++) {
      const jac = jaccardPair(tbl, ch[i], ch[j], window);
      if (jac >= threshold) edges.push({ a: ch[i], b: ch[j], jaccard: jac });
    }
  }
  return edges;
}
