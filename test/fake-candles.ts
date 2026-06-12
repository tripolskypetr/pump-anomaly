import { CandleInterval, GetCandles, ICandleData, STEP_MS, alignTs } from "../src/candle";
import { Direction } from "../src/types";

/**
 * Фейковый источник свечей для тестов. Базовый случайный walk + впрыснутые
 * "истинные" движения: после каждого настоящего пампа цена дрейфует в сторону
 * сигнала, после ложного — шумит вокруг нуля. Так train может реально различить.
 */
export interface PriceInjection {
  symbol: string;
  ts: number;
  direction: Direction;
  /** относительный дрейф за ~24ч, доли (0.08 = +8% в сторону direction) */
  drift: number;
}

export function makeGetCandles(
  injections: PriceInjection[],
  seed = 7,
): GetCandles {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  // базовая цена на символ
  const base: Record<string, number> = {
    TRXUSDT: 0.3, SOLUSDT: 135, NEARUSDT: 1.77, HYPEUSDT: 26, POLUSDT: 0.13,
    BTCUSDT: 92000, DEFAULT: 10,
  };

  const priceAt = (symbol: string, ts: number): number => {
    let p = base[symbol] ?? base.DEFAULT;
    // суммируем дрейфы инъекций, чьё событие уже наступило, с насыщением за 24ч
    for (const inj of injections) {
      if (inj.symbol !== symbol) continue;
      if (ts < inj.ts) continue;
      const elapsed = ts - inj.ts;
      const sat = Math.min(elapsed / (24 * 3600_000), 1); // линейное насыщение за сутки
      const sign = inj.direction === "long" ? 1 : -1;
      p *= 1 + sign * inj.drift * sat;
    }
    // лёгкий детерминированный шум
    p *= 1 + (rnd() - 0.5) * 0.002;
    return p;
  };

  return async (
    symbol: string,
    interval: CandleInterval,
    limit?: number,
    sDate?: number,
    eDate?: number,
  ): Promise<ICandleData[]> => {
    const step = STEP_MS[interval];
    let since: number;
    let count: number;

    if (sDate != null && eDate != null && limit == null) {
      since = alignTs(sDate, interval);
      count = Math.max(0, Math.floor((eDate - since) / step));
    } else if (sDate != null) {
      since = alignTs(sDate, interval);
      count = limit ?? Math.max(0, Math.floor(((eDate ?? since) - since) / step));
    } else if (eDate != null && limit != null) {
      since = alignTs(eDate, interval) - limit * step;
      count = limit;
    } else if (limit != null) {
      // (limit) — без опорной даты тест не использует; берём от 0
      since = 0;
      count = limit;
    } else {
      return [];
    }

    const out: ICandleData[] = [];
    for (let i = 0; i < count; i++) {
      const t = since + i * step;
      const o = priceAt(symbol, t);
      const c = priceAt(symbol, t + step);
      const hi = Math.max(o, c) * 1.001;
      const lo = Math.min(o, c) * 0.999;
      out.push({ timestamp: t, open: o, high: hi, low: lo, close: c, volume: 1000 + rnd() * 100 });
    }
    return out;
  };
}
