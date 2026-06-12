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

/**
 * Окно стационарности. Статистики (τ, author-матрица, Jaccard) на длинном горизонте
 * корраптятся: они агрегируются по ВСЕЙ истории, а за 5 месяцев режим дрейфует —
 * каналы появляются/замолкают, «братские» пары распадаются, τ плывёт. Один глобальный
 * набор усредняет несопоставимые периоды.
 *
 * Решение без новой математики: считать статистики только по локальному окну,
 * заканчивающемуся в момент anchorTs. windowMs=Infinity → вся история (старое
 * поведение, для коротких данных). Размер окна перебирается grid'ом в train.
 */
export function windowEvents(
  events: SignalEvent[],
  anchorTs: number,
  windowMs: number,
): SignalEvent[] {
  if (!Number.isFinite(windowMs)) return events;
  const lo = anchorTs - windowMs;
  // events отсортированы по ts → берём срез (lo, anchorTs]
  return events.filter((e) => e.ts > lo && e.ts <= anchorTs);
}

/** Таблица, построенная по окну стационарности до anchorTs. */
export function buildWindowedTable(
  events: SignalEvent[],
  anchorTs: number,
  windowMs: number,
): EventTable {
  return buildTable(windowEvents(events, anchorTs, windowMs));
}
