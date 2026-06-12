import { describe, it, expect } from "vitest";
import { predict, ParserItem } from "../src/index";
import { buildFixture } from "./fixture";

describe("predict() — публичный фасад", () => {
  const fx = buildFixture();
  const res = predict(fx.items);

  it("самооценивает характерный лаг τ в минутном масштабе", () => {
    const tauMin = res.tauMs / 60_000;
    expect(tauMin).toBeGreaterThan(1);
    expect(tauMin).toBeLessThan(15);
  });

  it("склеивает братские каналы автора X в один кластер", () => {
    const ids = fx.siblings[0].map((c) => res.authors.get(c));
    expect(new Set(ids).size).toBe(1);
  });

  it("склеивает братские каналы автора Y в один кластер", () => {
    const ids = fx.siblings[1].map((c) => res.authors.get(c));
    expect(new Set(ids).size).toBe(1);
  });

  it("разводит двух разных авторов по разным кластерам", () => {
    const idX = res.authors.get(fx.siblings[0][0]);
    const idY = res.authors.get(fx.siblings[1][0]);
    expect(idX).not.toBe(idY);
  });

  it("ловит настоящий памп (SOL long) топовым сигналом", () => {
    const top = res.signals[0];
    expect(top.symbol).toBe(fx.truePump.symbol);
    expect(top.direction).toBe(fx.truePump.direction);
    expect(top.action).toBe("open");
    expect(top.independentClusters).toBeGreaterThanOrEqual(2);
  });

  it("НЕ открывает памп одного актора (TRX short от автора X) — skip", () => {
    const trx = res.verdicts.find(
      (v) => v.symbol === "TRXUSDT" && v.direction === "short",
    );
    expect(trx?.action).toBe("skip");
  });

  it("выдаёт детерминированный результат на одинаковом входе", () => {
    const a = predict(fx.items);
    const b = predict(fx.items);
    expect(a.signals).toEqual(b.signals);
    expect([...a.authors]).toEqual([...b.authors]);
  });
});

describe("predict() — устойчивость к мусору на входе", () => {
  it("игнорирует битые строки и не падает", () => {
    const dirty = [
      { channel: "a", symbol: "BTCUSDT", direction: "long", ts: 1000 },
      { channel: "b", symbol: "BTCUSDT", direction: "bad" as never, ts: 2000 },
      { channel: "c", symbol: "BTCUSDT", direction: "long", ts: NaN },
      { symbol: "BTCUSDT", direction: "long", ts: 3000 } as never,
      null as never,
    ] as ParserItem[];
    const res = predict(dirty);
    expect(res.verdicts.length).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(res.tauMs)).toBe(true);
  });

  it("на пустом входе возвращает пустые сигналы", () => {
    const res = predict([]);
    expect(res.signals).toEqual([]);
    expect(res.authorCount).toBe(0);
  });

  it("игнорирует поля parser-items сверх контракта (entry/targets/stoploss)", () => {
    const items: ParserItem[] = [
      {
        channel: "a", symbol: "SOLUSDT", direction: "long", ts: 1000,
        entry: { from: 1, to: 2 }, targets: [3, 4], stoploss: 0.5,
      },
      {
        channel: "b", symbol: "SOLUSDT", direction: "long", ts: 1000 + 120_000,
        entry: { from: 1, to: 2 }, targets: [3], stoploss: 0.5,
      },
    ];
    expect(() => predict(items)).not.toThrow();
  });
});
