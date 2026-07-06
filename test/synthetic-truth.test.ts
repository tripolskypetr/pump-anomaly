import { describe, it, expect } from "vitest";
import {
  train, walkForward, assessEdge, PumpMatrix, ParserItem,
} from "../src/index";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

/**
 * СИНТЕТИКА С ЗАЛОЖЕННОЙ ИСТИНОЙ — финальная валидация всего конвейера.
 *
 * Другие тесты проверяют механизмы по отдельности; здесь мир генерируется
 * сеяным ГСЧ, истина закладывается руками (памп идёт за постом / постов никто
 * не слышит / эдж живёт только в определённый час), и утверждается главное:
 *  1) заложенный эдж инструмент НАХОДИТ (fit восстанавливает pnl пампа);
 *  2) незаложенный эдж инструмент НЕ ВЫДУМЫВАЕТ (шум − издержки ≤ 0 OOS);
 *  3) плацебо-контроль отличает «эдж в постах» от «эдж в рынке»;
 *  4) заложенная сезонность восстанавливается категориальным маржиналом
 *     сквозь ПОЛНЫЙ путь fit → save/load → plan.
 * Всё детерминировано (mulberry32) — никакого Math.random, повтор бит-в-бит.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0); // 09:00 UTC, выровнено по минуте

// ── сеяный ГСЧ и хэш символа ──
const mulberry32 = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hashOf = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h | 0;
};

interface PlantedPump {
  symbol: string;
  ts: number;
  /** амплитуда в лог-долях (0.03 ≈ +3% к пику) */
  pct: number;
  riseMin?: number;   // минут до пика (дефолт 20)
  decayMin?: number;  // минут спада после пика (дефолт 60)
  residual?: number;  // доля pct, остающаяся навсегда (дефолт 0.5)
}

/**
 * Сеяная биржа: случайное блуждание σ=0.05%/мин в лог-цене + заложенные пампы
 * (линейный разгон до pct, спад до residual·pct). Объём ×4 на разгоне.
 * Любой символ (включая BTCUSDT для фон-фичи) генерируется лениво со своим сидом.
 */
function syntheticExchange(cfg: {
  seed: number;
  spanFrom: number; // выровнен по минуте
  spanTo: number;
  pumps?: PlantedPump[];
}): GetCandles {
  const minutes = Math.floor((cfg.spanTo - cfg.spanFrom) / MIN) + 2;
  const paths = new Map<string, { logp: Float64Array; vol: Float64Array }>();
  const pathOf = (symbol: string) => {
    const hit = paths.get(symbol);
    if (hit) return hit;
    const rnd = mulberry32(cfg.seed ^ hashOf(symbol));
    const logp = new Float64Array(minutes);
    const vol = new Float64Array(minutes);
    logp[0] = Math.log(100);
    vol[0] = 1000;
    for (let m = 1; m < minutes; m++) {
      logp[m] = logp[m - 1] + (rnd() - 0.5) * 2 * 0.0005;
      vol[m] = 800 + 400 * rnd();
    }
    for (const p of cfg.pumps ?? []) {
      if (p.symbol !== symbol) continue;
      const m0 = Math.floor((p.ts - cfg.spanFrom) / MIN);
      const rise = p.riseMin ?? 20;
      const decay = p.decayMin ?? 60;
      const residual = p.residual ?? 0.5;
      for (let m = Math.max(m0, 0); m < minutes; m++) {
        const d = m - m0;
        const bump = d <= rise
          ? (p.pct * d) / rise
          : d <= rise + decay
            ? p.pct + (residual * p.pct - p.pct) * ((d - rise) / decay)
            : residual * p.pct;
        logp[m] += bump;
        if (d <= rise) vol[m] *= 4;
      }
    }
    const path = { logp, vol };
    paths.set(symbol, path);
    return path;
  };
  return async (symbol, _i, limit, sDate) => {
    const { logp, vol } = pathOf(symbol);
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
        volume: vol[i],
      });
    }
    return out;
  };
}

const grid = {
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
  stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
  squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
  cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
};
const baseOpts = {
  folds: 3, mode: "single" as const, onProgress: silentProgress,
  selection: { nestedOuterFolds: 0 }, grid,
};

// пампованный мир: 40 постов, за каждым — заложенный памп +3% за 20 минут
const pumpWorld = () => {
  const spanFrom = t0 - 20 * DAY;
  const items: ParserItem[] = Array.from({ length: 40 }, (_, k) => ({
    channel: "pumpers", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
  }));
  const gc = syntheticExchange({
    seed: 42, spanFrom, spanTo: t0 + 21 * DAY,
    pumps: items.map((it) => ({ symbol: it.symbol, ts: it.ts, pct: 0.03 })),
  });
  return { items, gc };
};

describe("синтетика: заложенный эдж находится", () => {
  it("fit восстанавливает pnl пампа: медиана ≈ +2..3% нетто, все сделки размечены", async () => {
    const { items, gc } = pumpWorld();
    const res = await train(items, gc, { ...baseOpts, roundTripCostPct: 0.1 });
    // все 40 постов размечены (totalSamples меньше — это CV-валид-срезы, 3/4 при 3 фолдах)
    expect(res.params.meta.labeling.candidates).toBe(40);
    expect(res.params.meta.labeling.outcomes.ok).toBe(40);
    expect(res.params.meta.totalSamples).toBeGreaterThanOrEqual(30);
    // life-cap 30мин на пампе +3%/20мин со спадом → ≈ +2.5% минус издержки
    expect(res.params.pnl.global.median).toBeGreaterThan(0.01);
    expect(res.params.pnl.global.median).toBeLessThan(0.04); // не выдумывает лишнего
    // walk-forward подтверждает вне обучения
    const wf = await walkForward(items, gc, {
      slices: 2, trainOptions: { ...baseOpts, roundTripCostPct: 0.1 },
      policy: { acknowledgeUncertified: true },
    });
    expect(wf.oosPnls.length).toBeGreaterThan(5);
    expect(wf.stats.median).toBeGreaterThan(0.01);
  }, 120_000);
});

describe("синтетика: незаложенный эдж не выдумывается", () => {
  it("те же посты на чистом блуждании: OOS-медиана ≤ 0 (шум минус издержки), не «trade»", async () => {
    const spanFrom = t0 - 20 * DAY;
    const items: ParserItem[] = Array.from({ length: 40 }, (_, k) => ({
      channel: "pumpers", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + k * 12 * HOUR,
    }));
    const gc = syntheticExchange({ seed: 42, spanFrom, spanTo: t0 + 21 * DAY }); // БЕЗ pumps
    const a = await assessEdge(items, gc, {
      walkForward: { slices: 2, policy: { acknowledgeUncertified: true } },
      trainOptions: { ...baseOpts, roundTripCostPct: 0.3 },
    });
    expect(a.verdict).not.toBe("trade");
    expect(a.walkForward.stats.median).toBeLessThanOrEqual(0);
  }, 120_000);
});

describe("синтетика: плацебо отличает «эдж в постах» от «эдж в рынке»", () => {
  it("пампованный мир: реальный прогон бьёт плацебо (сдвинутые посты торгуют шум)", async () => {
    const { items, gc } = pumpWorld();
    const a = await assessEdge(items, gc, {
      walkForward: { slices: 2, policy: { acknowledgeUncertified: true } },
      trainOptions: { ...baseOpts, roundTripCostPct: 0.1 },
      placebo: true,
    });
    // истина: пампы существуют ТОЛЬКО в минуты постов; посты, сдвинутые на
    // 3–14 дней назад, торгуют чистое блуждание − издержки
    expect(a.placebo).not.toBe(null);
    expect(a.placebo!.beatsPlacebo).toBe(true);
    expect(a.walkForward.stats.median).toBeGreaterThan(a.placebo!.stats.median);
    expect(a.verdict).not.toBe("no-edge"); // эдж в OOS-цепочке есть
  }, 240_000);
});

describe("синтетика: заложенная сезонность восстанавливается сквозь fit → save/load → plan", () => {
  it("пампы только у 09:00-постов; 21:00-посты — пустышки → pWin(09) > pWin(21)", async () => {
    const spanFrom = t0 - 20 * DAY;
    const items: ParserItem[] = [];
    const pumps: PlantedPump[] = [];
    for (let k = 0; k < 22; k++) {
      const at9 = t0 + k * DAY;              // 09:00 UTC — реальный памп
      const at21 = t0 + k * DAY + 12 * HOUR; // 21:00 UTC — пост без реакции рынка
      items.push({ channel: "pumpers", symbol: "SOLUSDT", direction: "long", ts: at9 });
      items.push({ channel: "pumpers", symbol: "SOLUSDT", direction: "long", ts: at21 });
      pumps.push({ symbol: "SOLUSDT", ts: at9, pct: 0.03 });
    }
    const gc = syntheticExchange({ seed: 7, spanFrom, spanTo: t0 + 23 * DAY, pumps });
    const res = await train(items, gc, { ...baseOpts, roundTripCostPct: 0.2 });

    // модель исхода обучилась и выучила именно сезонность (пре-сигнальные фичи
    // обоих слотов одинаковы — блуждание до поста; различает только час)
    expect(res.params.outcome).not.toBe(null);
    expect(res.params.outcome!.informative).toBe(true);
    expect(res.params.outcome!.categoricals?.hourOfDay).toBeDefined();

    // полный путь: save → load → plan; свежие посты в оба слота
    const m = PumpMatrix.load(PumpMatrix.load(res.params).save());
    const fresh9 = t0 + 30 * DAY;             // 09:00 UTC
    const fresh21 = t0 + 30 * DAY + 12 * HOUR; // 21:00 UTC
    const sigs = m.plan([
      { channel: "pumpers", symbol: "SOLUSDT", direction: "long", ts: fresh9 },
      { channel: "pumpers", symbol: "SOLUSDT", direction: "long", ts: fresh21 },
    ], {}, { acknowledgeUncertified: true });
    expect(sigs.length).toBe(2);
    const p9 = sigs.find((s) => s.ts === fresh9)!.probability!;
    const p21 = sigs.find((s) => s.ts === fresh21)!.probability!;
    expect(p9.pWin).toBeGreaterThan(p21.pWin);
    // Келли согласован с сезонностью: утренний слот сайзится больше вечернего
    expect(p9.recommendedRiskFrac).toBeGreaterThanOrEqual(p21.recommendedRiskFrac);
  }, 120_000);
});
