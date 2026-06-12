import { EventTable } from "../core/event-table";

const MIN = 60_000;

/**
 * Слой 1 — самооценка характерного лага τ.
 *
 * Строит гистограмму всех попарных положительных задержек между РАЗНЫМИ каналами
 * по совпадающим (symbol,direction). У случайных пар распределение ≈ плоское,
 * у «братских» каналов — острый пик у малого лага. Модальный лог-бин даёт τ.
 *
 * Возвращает τ в мс, зажатый в [30с, 60мин]. Если данных мало — дефолт 15 мин.
 */
export function selfTuneLag(tbl: EventTable): number {
  const deltas: number[] = [];
  const HORIZON = 6 * 60 * MIN; // парные задержки в пределах 6ч

  for (const evs of tbl.byKey.values()) {
    for (let i = 0; i < evs.length; i++) {
      for (let j = i + 1; j < evs.length; j++) {
        const d = evs[j].ts - evs[i].ts;
        if (d <= 0) continue;
        if (d > HORIZON) break; // массив сортирован — дальше только больше
        if (evs[i].channel !== evs[j].channel) deltas.push(d);
      }
    }
  }

  if (deltas.length < 8) return 15 * MIN;

  deltas.sort((a, b) => a - b);
  const minD = Math.max(deltas[0], 1000);
  const maxD = deltas[deltas.length - 1];
  const BINS = 24;
  const logMin = Math.log(minD);
  const logMax = Math.log(maxD);
  const span = logMax - logMin || 1;

  const hist = new Array(BINS).fill(0);
  for (const d of deltas) {
    let b = Math.floor(((Math.log(d) - logMin) / span) * BINS);
    if (b >= BINS) b = BINS - 1;
    if (b < 0) b = 0;
    hist[b]++;
  }

  let peak = 0;
  for (let b = 1; b < BINS; b++) if (hist[b] > hist[peak]) peak = b;
  const binCenterLog = logMin + ((peak + 0.5) / BINS) * span;
  const tau = Math.exp(binCenterLog);

  return Math.min(Math.max(tau, 30 * 1000), 60 * MIN);
}
