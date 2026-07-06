import { GetCandles, ICandleData } from "../../src/candle";

/** Общий сеяный мир для синтетик: блуждание + заложенные бампы + опц. отрава. */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const mulberry32 = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const hashOf = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h | 0;
};

export interface WorldBump {
  symbol: string;
  ts: number;
  pct: number;       // лог-доли: 0.03 ≈ +3% к пику
  riseMin?: number;  // дефолт 20
  decayMin?: number; // дефолт 40
  residual?: number; // дефолт 0.5
}

export interface WorldCfg {
  seed: number;
  spanFrom: number; // выровнен по минуте
  spanTo: number;
  bumps?: WorldBump[];
  /** ОТРАВА для канарейки look-ahead: с этого ts лог-цена взлетает на +poisonBoost */
  poisonFromTs?: number;
  poisonBoost?: number;
  /** сдвиг всей шкалы цен в лог-долях (scale-инвариантность: ln(1000) = ×1000) */
  logScale?: number;
}

export function syntheticExchange(cfg: WorldCfg): GetCandles {
  const minutes = Math.floor((cfg.spanTo - cfg.spanFrom) / MIN) + 2;
  const paths = new Map<string, Float64Array>();
  const pathOf = (symbol: string): Float64Array => {
    const hit = paths.get(symbol);
    if (hit) return hit;
    const rnd = mulberry32(cfg.seed ^ hashOf(symbol));
    const logp = new Float64Array(minutes);
    logp[0] = Math.log(100) + (cfg.logScale ?? 0);
    for (let m = 1; m < minutes; m++) logp[m] = logp[m - 1] + (rnd() - 0.5) * 2 * 0.0005;
    for (const b of cfg.bumps ?? []) {
      if (b.symbol !== symbol) continue;
      const m0 = Math.floor((b.ts - cfg.spanFrom) / MIN);
      const rise = b.riseMin ?? 20;
      const decay = b.decayMin ?? 40;
      const residual = b.residual ?? 0.5;
      for (let m = Math.max(m0, 0); m < minutes; m++) {
        const d = m - m0;
        logp[m] += d <= rise
          ? (b.pct * d) / rise
          : d <= rise + decay
            ? b.pct + (residual * b.pct - b.pct) * ((d - rise) / decay)
            : residual * b.pct;
      }
    }
    if (cfg.poisonFromTs !== undefined) {
      const mp = Math.floor((cfg.poisonFromTs - cfg.spanFrom) / MIN);
      for (let m = Math.max(mp, 0); m < minutes; m++) logp[m] += cfg.poisonBoost ?? 3;
    }
    paths.set(symbol, logp);
    return logp;
  };
  return async (symbol, _i, limit, sDate) => {
    const logp = pathOf(symbol);
    const start = Math.floor((sDate ?? cfg.spanFrom) / MIN) * MIN;
    const out: ICandleData[] = [];
    for (let k = 0; k < (limit ?? 0); k++) {
      const i = Math.floor((start - cfg.spanFrom) / MIN) + k;
      if (i < 0 || i >= minutes - 1) continue; // край истории — честно недодаём
      const o = Math.exp(logp[i]);
      const c = Math.exp(logp[i + 1]);
      out.push({
        timestamp: cfg.spanFrom + i * MIN, open: o, close: c,
        high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998,
        volume: 900 + (i % 7) * 40,
      });
    }
    return out;
  };
}

/** компактный грид из одной точки (переопредели нужную ось) */
export const oneShotGrid = (over: Record<string, unknown> = {}) => ({
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [50], hardStop: [50], stalenessSinceProfit: [50],
  stalenessSinceMinutes: [500], staleMinutes: [30], volZThreshold: [2.0],
  squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
  cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
  ...over,
});
