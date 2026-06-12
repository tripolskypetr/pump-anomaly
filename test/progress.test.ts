import { describe, it, expect } from "vitest";
import { train, ProgressEvent, stdoutProgress, silentProgress } from "../src/index";
import { buildFixture } from "./fixture";
import { makeGetCandles, PriceInjection } from "./fake-candles";

describe("train — прогрессбар", () => {
  const fx = buildFixture();
  const pumpTs = fx.t0 + 12 * 24 * 3600_000 + 9 * 3600_000;
  const injections: PriceInjection[] = [
    { symbol: "SOLUSDT", ts: pumpTs, direction: "long", drift: 0.1 },
  ];
  const getCandles = makeGetCandles(injections);
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
    trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
    stalenessSinceMinutes: [240], staleMinutes: [240],
    volZThreshold: [2.0], squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
  };

  it("вызывает onProgress с обеими фазами и монотонным done", async () => {
    const events: ProgressEvent[] = [];
    await train(fx.items, getCandles, { folds: 3, grid, onProgress: (e) => events.push(e) });

    expect(events.length).toBeGreaterThan(0);
    const phases = new Set(events.map((e) => e.phase));
    expect(phases.has("label")).toBe(true);
    expect(phases.has("score")).toBe(true);

    // в каждой фазе done монотонно растёт и не превышает total
    for (const phase of ["label", "score"] as const) {
      const seq = events.filter((e) => e.phase === phase);
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i].done).toBeGreaterThanOrEqual(seq[i - 1].done);
        expect(seq[i].done).toBeLessThanOrEqual(seq[i].total);
      }
    }
  });

  it("score-фаза достигает total (100%)", async () => {
    const events: ProgressEvent[] = [];
    await train(fx.items, getCandles, { folds: 3, grid, onProgress: (e) => events.push(e) });
    const score = events.filter((e) => e.phase === "score");
    const last = score[score.length - 1];
    expect(last.done).toBe(last.total);
  });

  it("по умолчанию (casual) пишет в stdout — без onProgress", async () => {
    // setup.ts глушит реальный stdout; перехватываем write, чтобы убедиться, что
    // дефолтный путь действительно туда пишет (а не молчит).
    const writes: string[] = [];
    const real = process.stdout.write;
    // @ts-expect-error — временно перехватываем
    process.stdout.write = (chunk: string) => { writes.push(String(chunk)); return true; };
    try {
      await train(fx.items, getCandles, { folds: 3, grid }); // без onProgress → stdout по умолчанию
    } finally {
      process.stdout.write = real;
    }
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => w.includes("label"))).toBe(true);
  });

  it("silentProgress — no-op, не бросает", () => {
    expect(() => silentProgress({ done: 1, total: 2, phase: "label", label: "x" })).not.toThrow();
  });

  it("stdoutProgress игнорирует total<=0 без записи", () => {
    // не должно бросать и не делить на ноль
    expect(() => stdoutProgress({ done: 0, total: 0, phase: "label", label: "x" })).not.toThrow();
  });
});
