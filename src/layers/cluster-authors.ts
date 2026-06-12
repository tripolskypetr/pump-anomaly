import { AuthorMap } from "../types";
import { DirectedEdge } from "./lag-xcorr";

/**
 * Слой 4 — кластеризация каналов в авторов (union-find / connected components).
 * Каждое направленное ребро «братства» сливает два канала в один кластер.
 * Возвращает карту channel → целочисленный id кластера.
 */
export function clusterAuthors(
  channels: string[],
  edges: DirectedEdge[],
): AuthorMap {
  const parent = new Map<string, string>();
  channels.forEach((c) => parent.set(c, c));

  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // path compression
    while (parent.get(x) !== r) {
      const n = parent.get(x)!;
      parent.set(x, r);
      x = n;
    }
    return r;
  };

  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (const e of edges) union(e.a, e.b);

  const rootId = new Map<string, number>();
  const result: AuthorMap = new Map();
  let next = 0;
  for (const c of channels) {
    const r = find(c);
    if (!rootId.has(r)) rootId.set(r, next++);
    result.set(c, rootId.get(r)!);
  }
  return result;
}
