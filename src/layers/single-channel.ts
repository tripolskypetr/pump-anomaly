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

  for (const [k, evs] of tbl.byKey) {
    const [symbol, direction] = splitKey(k);
    // схлопываем близкие посты в один вход
    let lastTs = -Infinity;
    for (const e of evs) {
      if (e.ts - lastTs <= window) continue; // в окне уже открытой позиции — пропускаем
      lastTs = e.ts;
      verdicts.push({
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
      });
    }
  }

  return verdicts.sort((a, b) => b.ts - a.ts);
}
