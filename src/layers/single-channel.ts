import { DetectorConfig, PumpVerdict } from "../types";
import { EventTable, splitKey } from "../core/event-table";

/**
 * Single-channel fallback. Когда корреляция недоступна (один канал / mode="single"),
 * матрица авторства пуста и earlyWarning молчит. Но даже один пост двигает рынок:
 * аудитория входит, возникает краткосрочный импульс. Поэтому здесь КАЖДЫЙ пост =
 * сигнал к входу, а вся ответственность за результат — на обученном exit
 * (trailing take / hard stop / staleness / импакт-горизонт), который уже доказал,
 * что отделяет памп от stop hunt.
 *
 * Дедупликация: несколько постов по одному (symbol,direction) в пределах окна
 * схлопываются в один вход (повторный пост в активную позицию — не новый вход).
 */
export function singleChannelSignals(
  tbl: EventTable,
  cfg: DetectorConfig,
  tau: number,
): PumpVerdict[] {
  const window = Math.min(cfg.windowK * tau, cfg.maxBurstWindowMs);
  const verdicts: PumpVerdict[] = [];

  const toId = (e: { id?: unknown }): string | undefined => {
    const r = e.id;
    return typeof r === "string" ? r : (typeof r === "number" ? String(r) : undefined);
  };
  for (const [k, evs] of tbl.byKey) {
    const [symbol, direction] = splitKey(k);
    // схлопываем близкие посты в один вход
    let lastTs = -Infinity;
    let current: PumpVerdict | null = null;
    for (const e of evs) {
      const id = toId(e as { id?: unknown });
      if (e.ts - lastTs <= window) {
        // схлопнутый пост — его id НЕ теряем (иначе несопоставим с парсингом)
        if (current && id != null) current.ids!.push(id);
        continue;
      }
      lastTs = e.ts;
      current = {
        symbol,
        direction,
        action: "open",
        ts: e.ts,
        independentClusters: 1,
        totalChannels: 1,
        confidence: 0.5, // нейтральная уверенность: вход есть, фильтра качества нет
        reason: `single-channel fallback: пост по ${symbol} ${direction} (exit решает исход)`,
        source: "single",
        channel: e.channel,
        id,
        ids: id != null ? [id] : [],
      };
      verdicts.push(current);
    }
  }

  return verdicts.sort((a, b) => b.ts - a.ts);
}
