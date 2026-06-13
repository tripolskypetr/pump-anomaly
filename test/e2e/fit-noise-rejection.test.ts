import { describe, it, expect } from "vitest";
import { PumpMatrix } from "../../src/index";
import { ParserItem } from "../../src/types";
import { GetCandles, ICandleData, STEP_MS, alignTs } from "../../src/candle";
import { silentProgress } from "../../src/progress";
import { mulberry32 } from "../../src/statistics";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);

describe("E2E: полный fit на ЧИСТОМ ШУМЕ не сертифицирует (брутфорс найдёт 'эдж', аппарат отклонит)", () => {
  it("60 случайных сигналов, случайные свечи → certified=false, несмотря на argmax по гриду", async () => {
    const rng = mulberry32(777);
    // случайное блуждание — НЕТ предсказуемого эджа. Грид всё равно выберет лучший конфиг.
    const gc: GetCandles = async (s, i, lim, sd) => {
      const since = sd != null ? alignTs(sd, i) : 0; const n = lim ?? 0;
      const out: ICandleData[] = []; let p = 100;
      for (let k = 0; k < n; k++) {
        p *= 1 + (rng() - 0.5) * 0.02;
        out.push({ timestamp: since + k * STEP_MS[i], open: p, high: p * 1.005, low: p * 0.995, close: p * (1 + (rng() - 0.5) * 0.005), volume: 1000 + rng() * 500 });
      }
      return out;
    };
    const items: ParserItem[] = [];
    for (let d = 0; d < 60; d++) items.push({ channel: "yoda", symbol: "SOLUSDT", direction: "long", ts: t0 + d * DAY, entryFromPrice: 99, entryToPrice: 101 });

    const m = await PumpMatrix.fit(items, gc, {
      mode: "single", onProgress: silentProgress, selection: { nestedOuterFolds: 3 },
      // явный грид (не полный дефолтный 2.5M): достаточно для демонстрации, что
      // перебор найдёт "лучший" конфиг на шуме, а сертификация его отклонит.
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [0.5, 1.0, 2.0], hardStop: [1.0, 2.0, 3.0],
        stalenessSinceProfit: [0.5, 1.0, 2.0], stalenessSinceMinutes: [60, 120, 240],
        staleMinutes: [60, 240, 720], volZThreshold: [1.5, 2.5],
        squeezePolicy: ["none", "veto"], squeezeThreshold: [0.6],
        volBaselineWindow: [20], cascadeWindowMinutes: [15, 30],
      },
    });
    const c = m.certification;
    expect(c).toBeDefined();
    expect(c!.certified).toBe(false);           // ГЛАВНОЕ: шум НЕ сертифицируется через полный пайплайн
    expect(c!.reasons.length).toBeGreaterThan(0); // хотя бы один барьер поймал (defense-in-depth:
    // на этом шуме DSR может быть высоким, но PBO/SPA/minTRL ловят оверфит — потому барьеров пять)
    expect(m.reliable).toBe(false);             // и старый reliable тоже честно false
  }, 60_000);
});
