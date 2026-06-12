import { Direction, SignalEvent } from "../types";

export type Key = string; // `${symbol}|${direction}`

export const keyOf = (e: SignalEvent): Key => `${e.symbol}|${e.direction}`;

export const splitKey = (k: Key): [string, Direction] =>
  k.split("|") as [string, Direction];

export interface EventTable {
  /** все события, отсортированы по ts */
  events: SignalEvent[];
  /** события по (symbol,direction), каждая группа отсортирована по ts */
  byKey: Map<Key, SignalEvent[]>;
  /** `${channel}|${key}` → отсортированные ts */
  byChannelKey: Map<string, number[]>;
  /** список уникальных каналов */
  channels: string[];
}

/** Нормализует сырой поток событий в индексированную таблицу. */
export function buildTable(raw: SignalEvent[]): EventTable {
  const events = [...raw].sort((a, b) => a.ts - b.ts);
  const byKey = new Map<Key, SignalEvent[]>();
  const byChannelKey = new Map<string, number[]>();
  const channelSet = new Set<string>();

  for (const e of events) {
    const k = keyOf(e);
    let g = byKey.get(k);
    if (!g) byKey.set(k, (g = []));
    g.push(e);
    const ck = `${e.channel}|${k}`;
    let c = byChannelKey.get(ck);
    if (!c) byChannelKey.set(ck, (c = []));
    c.push(e.ts);

    channelSet.add(e.channel);
  }

  return { events, byKey, byChannelKey, channels: [...channelSet] };
}
