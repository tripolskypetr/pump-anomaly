import { describe, it, expect } from "vitest";
import { predict, PumpMatrix, ParserItem } from "../src/index";
import { makeGetCandles, PriceInjection } from "./fake-candles";

const H = 3600_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

/** один канал, серия постов по разным символам */
function singleChannelItems(): ParserItem[] {
  const out: ParserItem[] = [];
  const syms = ["SOLUSDT", "TRXUSDT", "NEARUSDT", "POLUSDT"];
  for (let d = 0; d < 8; d++) {
    const sym = syms[d % syms.length];
    out.push({
      channel: "crypto_yoda", symbol: sym, direction: "long",
      ts: t0 + d * 12 * H,
      entryFromPrice: 100, entryToPrice: 101,
    });
  }
  return out;
}

describe("predict — режимы и fallback", () => {
  it("auto: один канал → usedMode='single', каждый пост = сигнал", () => {
    const items = singleChannelItems();
    const res = predict(items);
    expect(res.usedMode).toBe("single");
    expect(res.signals.length).toBeGreaterThan(0);
    expect(res.signals.every((s) => s.source === "single")).toBe(true);
  });

  it("auto: один канал не молчит (в отличие от чистой матрицы)", () => {
    const items = singleChannelItems();
    const matrixOnly = predict(items, { mode: "matrix" });
    const auto = predict(items);
    // матрица на одном канале молчит, fallback — нет
    expect(matrixOnly.signals.length).toBe(0);
    expect(auto.signals.length).toBeGreaterThan(0);
  });

  it("принудительный single на мультиканале тоже даёт по сигналу на пост", () => {
    const items: ParserItem[] = [
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 },
      { channel: "b", symbol: "SOLUSDT", direction: "long", ts: t0 + 2 * 60_000 },
    ];
    const single = predict(items, { mode: "single" });
    expect(single.usedMode).toBe("single");
    expect(single.signals.every((s) => s.source === "single")).toBe(true);
  });

  it("принудительный matrix на одном канале → молчит (нет корреляции)", () => {
    const res = predict(singleChannelItems(), { mode: "matrix" });
    expect(res.usedMode).toBe("matrix");
    expect(res.signals.length).toBe(0);
  });

  it("дедупликация: два поста по одному символу в окне → один вход", () => {
    const items: ParserItem[] = [
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 },
      { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 + 60_000 }, // через минуту
    ];
    const res = predict(items, { mode: "single" });
    const sol = res.signals.filter((s) => s.symbol === "SOLUSDT" && s.direction === "long");
    expect(sol.length).toBe(1);
  });
});

describe("train — single-channel fallback может стать reliable", () => {
  it("одноканальная история с реальным эджем обучается в single и даёт сигналы", async () => {
    const items = singleChannelItems();
    // каждый пост двигает рынок вверх (аудитория входит) — кладём дрейф на каждый
    const injections: PriceInjection[] = items.map((it) => ({
      symbol: it.symbol, ts: it.ts, direction: "long" as const, drift: 0.05,
    }));
    const getCandles = makeGetCandles(injections);

    const model = await PumpMatrix.fit(items, getCandles, {
      folds: 3,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5],
        trailingTake: [1.0], hardStop: [2.0],
        stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
        staleMinutes: [240],
      },
    });

    expect(model.mode).toBe("single");
    const plans = model.signals(items);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => p.source === "single")).toBe(true);
    // exit-план приложен
    expect(plans[0].trailingTake).toBe(1.0);
    expect(plans[0].hardStop).toBe(2.0);
    expect(plans[0].impactHorizonMinutes).toBe(240);
  });
});
