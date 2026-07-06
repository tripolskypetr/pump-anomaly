import { PnlStats, pnlStats } from "./objective";
import { sharpe } from "./statistics";

/**
 * КАПИТАЛЬНАЯ ОДНОВРЕМЕННОСТЬ — последняя крупная нечестность бэктеста.
 *
 * Σpnl всех сделок предполагает бесконечный капитал: пампы кластеризуются во
 * времени (каскады библиотека сама детектит), и в плотный час может открыться
 * 5 сигналов при капитале на 1–2 позиции. Реальный доход — pnl сделок, которые
 * УСПЕЛИ взять, а не всех подряд.
 *
 * Симуляция ЧЕСТНАЯ (жадная хронологическая): позиция занимает слот от входа до
 * выхода; сигнал при заполненных слотах пропускается — открытую позицию нельзя
 * вытеснить задним числом. Единственное место, где уместен выбор, — несколько
 * сигналов В ОДИН момент на меньшее число слотов: там ранжируем по priority
 * (E[pnl] модели исхода — прогноз вероятности впервые ЗАРАБАТЫВАЕТ, а не только
 * фильтрует). Знать будущее (какая из позиций окажется лучше) симуляция не может.
 */

export interface CapitalTrade {
  /** время входа, мс */
  ts: number;
  /** длительность позиции, минут (слот занят [ts, ts + heldMinutes·60000)) */
  heldMinutes: number;
  /** реализованный pnl, доли */
  pnl: number;
  /** приоритет при одновременном прибытии (E[pnl] модели исхода); null = нет прогноза */
  priority?: number | null;
}

export interface CapitalSimResult {
  /** лимит слотов, под который считалось (null = без ограничения, чистый замер спроса) */
  maxConcurrentPositions: number | null;
  /** пиковый СПРОС на слоты: сколько позиций было бы открыто одновременно без лимита */
  demandPeak: number;
  /** взято сделок / пропущено из-за занятых слотов */
  taken: number;
  skipped: number;
  /** pnl взятых сделок, хронологически */
  pnls: number[];
  stats: PnlStats;
  sharpe: number;
  /** Σpnl без ограничения (бумажная сумма «бесконечного капитала») */
  sumUnconstrained: number;
  /** Σpnl взятых сделок (что реально снимет капитал с этим лимитом) */
  sumConstrained: number;
}

/**
 * Жадная симуляция очереди слотов. trades в любом порядке — сортируются по ts;
 * при равном ts первым берётся больший priority (модель исхода ранжирует).
 */
export function simulateCapital(
  trades: CapitalTrade[],
  maxConcurrentPositions?: number | null,
): CapitalSimResult {
  const cap = maxConcurrentPositions ?? null;
  const sorted = [...trades].sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : (b.priority ?? -Infinity) - (a.priority ?? -Infinity));

  // спрос на слоты: sweep по событиям вход/выход (без лимита)
  const events: Array<{ t: number; d: 1 | -1 }> = [];
  for (const tr of sorted) {
    events.push({ t: tr.ts, d: 1 });
    events.push({ t: tr.ts + Math.max(tr.heldMinutes, 0) * 60_000, d: -1 });
  }
  // выход раньше входа при равном t: освободившийся слот доступен новому сигналу
  events.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.d - b.d));
  let open = 0;
  let demandPeak = 0;
  for (const e of events) {
    open += e.d;
    if (open > demandPeak) demandPeak = open;
  }

  // жадная очередь: busyUntil занятых слотов
  const busyUntil: number[] = [];
  const pnls: number[] = [];
  let skipped = 0;
  for (const tr of sorted) {
    // освобождаем слоты, чьи позиции уже закрылись к моменту сигнала
    for (let i = busyUntil.length - 1; i >= 0; i--) {
      if (busyUntil[i] <= tr.ts) busyUntil.splice(i, 1);
    }
    if (cap !== null && busyUntil.length >= cap) {
      skipped++;
      continue;
    }
    busyUntil.push(tr.ts + Math.max(tr.heldMinutes, 0) * 60_000);
    pnls.push(tr.pnl);
  }

  const sumAll = sorted.reduce((s, t) => s + t.pnl, 0);
  const sumTaken = pnls.reduce((s, p) => s + p, 0);
  return {
    maxConcurrentPositions: cap,
    demandPeak,
    taken: pnls.length,
    skipped,
    pnls,
    stats: pnlStats(pnls),
    sharpe: +sharpe(pnls).toFixed(6),
    sumUnconstrained: +sumAll.toFixed(6),
    sumConstrained: +sumTaken.toFixed(6),
  };
}
