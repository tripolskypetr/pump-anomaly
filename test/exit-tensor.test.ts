import { describe, it, expect } from "vitest";
import { resolveExit, ExitTensor } from "../src/exit-tensor";
import { ExitParams } from "../src/replay";

const E = (over: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 1, stalenessSinceProfit: 1,
  stalenessSinceMinutes: 240, staleMinutes: 240, ...over,
});

describe("resolveExit — иерархия [channel][symbol][direction][volRegime]", () => {
  const tensor: ExitTensor = {
    cells: {
      single: {
        crypto_yoda: {
          TRXUSDT: {
            short: { anomalous: E({ trailingTake: 0.3 }), calm: E({ trailingTake: 1.0 }) },
            long: { calm: E({ trailingTake: 2.0 }) },
          },
        },
      },
      matrix: {},
    },
    bySymbolDir: {
      single: { TRXUSDT: { short: E({ trailingTake: 0.8 }), long: E({ trailingTake: 1.5 }) } },
      matrix: {},
    },
    byMode: {
      single: E({ trailingTake: 1.1 }),
      matrix: E({ trailingTake: 3.0 }),
    },
    global: E({ trailingTake: 1.0, staleMinutes: 1000 }),
  };

  it("точное попадание в ячейку [single][crypto_yoda][TRX][short][anomalous]", () => {
    const r = resolveExit(tensor, "single", "crypto_yoda", "TRXUSDT", "short", "anomalous");
    expect(r.source).toBe("cell");
    expect(r.exit.trailingTake).toBe(0.3); // туже на аномальном объёме (топливо для сквиза)
  });

  it("СИММЕТРИЯ: long и short — РАЗНЫЕ ячейки одного символа", () => {
    const short = resolveExit(tensor, "single", "crypto_yoda", "TRXUSDT", "short", "calm");
    const long = resolveExit(tensor, "single", "crypto_yoda", "TRXUSDT", "long", "calm");
    expect(short.exit.trailingTake).toBe(1.0);
    expect(long.exit.trailingTake).toBe(2.0);
    expect(short.exit.trailingTake).not.toBe(long.exit.trailingTake);
  });

  it("calm vs anomalous внутри одного направления — разные exit", () => {
    const calm = resolveExit(tensor, "single", "crypto_yoda", "TRXUSDT", "short", "calm");
    const anom = resolveExit(tensor, "single", "crypto_yoda", "TRXUSDT", "short", "anomalous");
    expect(calm.exit.trailingTake).toBe(1.0);
    expect(anom.exit.trailingTake).toBe(0.3);
  });

  it("отсутствующий volRegime в ячейке → fallback на symbol-dir", () => {
    // long есть только calm; запрос anomalous → падает на symbol-dir
    const r = resolveExit(tensor, "single", "crypto_yoda", "TRXUSDT", "long", "anomalous");
    expect(r.source).toBe("symbol-dir");
    expect(r.exit.trailingTake).toBe(1.5);
  });

  it("symbol-dir сохраняет СИММЕТРИЮ направления", () => {
    const short = resolveExit(tensor, "single", "unknown_ch", "TRXUSDT", "short", "calm");
    const long = resolveExit(tensor, "single", "unknown_ch", "TRXUSDT", "long", "calm");
    expect(short.source).toBe("symbol-dir");
    expect(short.exit.trailingTake).toBe(0.8);
    expect(long.exit.trailingTake).toBe(1.5);
  });

  it("неизвестный символ → fallback на уровень режима", () => {
    const r = resolveExit(tensor, "single", "crypto_yoda", "NEARUSDT", "long", "calm");
    expect(r.source).toBe("mode");
    expect(r.exit.trailingTake).toBe(1.1);
  });

  it("matrix-режим → byMode.matrix, отличается от single", () => {
    const m = resolveExit(tensor, "matrix", "_matrix", "SOLUSDT", "long", "calm");
    const s = resolveExit(tensor, "single", "x", "SOLUSDT", "long", "calm");
    expect(m.exit.trailingTake).toBe(3.0);
    expect(m.exit.trailingTake).not.toBe(s.exit.trailingTake);
  });

  it("полностью пустой режим → global", () => {
    const empty: ExitTensor = {
      cells: { single: {}, matrix: {} },
      bySymbolDir: { single: {}, matrix: {} },
      byMode: { single: undefined as any, matrix: undefined as any },
      global: E({ trailingTake: 9.9 }),
    };
    const r = resolveExit(empty, "single", "a", "b", "long", "calm");
    expect(r.source).toBe("global");
    expect(r.exit.trailingTake).toBe(9.9);
  });
});
