import { describe, it, expect } from "vitest";
import { train, predict, PumpMatrix, ParserItem, labelBurst, exitKey } from "../src/index";
import { emptyLedger, recordAttempt, MetaLedgerState } from "../src/meta-ledger";
import { ExitParams } from "../src/replay";
import { ICandleData, GetCandles } from "../src/candle";
import { silentProgress } from "../src/progress";
import { buildFixture } from "./fixture";
import { makeGetCandles, PriceInjection } from "./fake-candles";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const DAY = 24 * 3600_000;

// ─────────────────────────────────────────────────────────────────────────────
// МЕМОИЗАЦИЯ replay в labelBurst: оси, не влияющие на путь сделки, не должны
// менять результат (точность), а replay для них не должен пересчитываться (CPU).
// Проверяем ТОЧНОСТЬ: результат после мемоизации побитово эквивалентен прямому.
// ─────────────────────────────────────────────────────────────────────────────
describe("labelBurst — мемоизация replay точна", () => {
  // свечи: 20 базлайн @95 (НЕ задевают зону 99.9-100.1 → вход позже, есть базлайн
  // для volZ), затем свеча пересекает зону с АНОМАЛЬНЫМ объёмом, затем рост
  const candles: ICandleData[] = (() => {
    const rows: ICandleData[] = [];
    for (let i = 0; i < 20; i++)
      rows.push({ timestamp: t0 + i * MIN, open: 95, high: 95.3, low: 94.7, close: 95, volume: 800 + (i % 5) * 100 });
    rows.push({ timestamp: t0 + 20 * MIN, open: 99.5, high: 100.6, low: 99.4, close: 100.5, volume: 9000 }); // вход, spike
    for (let i = 21; i < 40; i++) {
      const p = 100.5 + (i - 20) * 0.05;
      rows.push({ timestamp: t0 + i * MIN, open: p, high: p + 0.1, low: p - 0.05, close: p + 0.05, volume: 1000 });
    }
    return rows;
  })();
  const gc: GetCandles = async (_s, _i, limit, sDate) =>
    candles.filter((c) => c.timestamp >= (sDate ?? 0)).slice(0, limit ?? candles.length);

  // staleMinutes=16: limit = 16·2+5 = 37 свечей, вход на idx 20 → forward 16 ≥ life
  // (иначе метка честно отброшена как truncated — см. labelBurst)
  const E = (o: Partial<ExitParams>): ExitParams => ({
    trailingTake: 50, hardStop: 50, stalenessSinceProfit: 1, stalenessSinceMinutes: 240,
    staleMinutes: 16, volBaselineWindow: 20, squeezePolicy: "none",
    squeezeThreshold: 0.6, cascadeWindowMinutes: 10, ...o,
  });

  it("volZThreshold меняет ТОЛЬКО volRegime, pnl-путь общий (и оба ключа на месте)", async () => {
    // сигнал на t0 (вход по зоне на свече 20 после базлайна)
    const sets = [E({ volZThreshold: 2.0 }), E({ volZThreshold: 999 })];
    const res = await labelBurst(gc, "SOLUSDT", "long", t0, sets, 99.9, 100.1);
    expect(res.outcome).toBe("ok");
    const a = res.burst!.byExit.get(exitKey(sets[0]))!;
    const b = res.burst!.byExit.get(exitKey(sets[1]))!;
    expect(a.pnl).toBe(b.pnl);
    expect(a.reason).toBe(b.reason);
    expect(a.entryPrice).toBe(b.entryPrice);
    expect(a.volZ).toBe(b.volZ);
    expect(a.volRegime).toBe("anomalous"); // volZ >> 2
    expect(b.volRegime).toBe("calm");      // порог 999 недостижим
  });

  it("для policy=none squeezeThreshold не меняет ничего (inert-дедуп точен)", async () => {
    const sets = [E({ squeezeThreshold: 0.55 }), E({ squeezeThreshold: 0.7 })];
    const res = await labelBurst(gc, "SOLUSDT", "long", t0, sets, 99.9, 100.1);
    const a = res.burst!.byExit.get(exitKey(sets[0]))!;
    const b = res.burst!.byExit.get(exitKey(sets[1]))!;
    expect(a).toEqual(b);
  });

  it("для АКТИВНОЙ политики squeezeThreshold НЕ схлопывается (влияет на путь)", async () => {
    // после входа все свечи растут → давление против long = 0. Порог 0 срабатывает
    // (0 ≥ 0 → veto), порог 0.99 — нет: ключи разные, результаты действительно свои.
    const sets = [E({ squeezePolicy: "veto", squeezeThreshold: 0 }), E({ squeezePolicy: "veto", squeezeThreshold: 0.99 })];
    const res = await labelBurst(gc, "SOLUSDT", "long", t0, sets, 99.9, 100.1);
    expect(res.outcome).toBe("ok");
    const a = res.burst!.byExit.get(exitKey(sets[0]));
    const b = res.burst!.byExit.get(exitKey(sets[1]));
    // порог 0 всегда срабатывает → cascade-veto (не вошли); 0.99 → обычный вход
    expect(a?.reason).toBe("cascade-veto");
    expect(a?.entered).toBe(false);
    expect(b?.reason).not.toBe("cascade-veto");
    expect(b?.entered).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ЧЕСТНЫЙ innerTrials: оси, не влияющие на результат, не считаются испытаниями.
// Раньше board хранил полное декартово произведение → DSR дефлировался по
// фиктивному N из копий.
// ─────────────────────────────────────────────────────────────────────────────
const fastFit = async (over: object = {}, ledger?: MetaLedgerState) => {
  const fx = buildFixture();
  const pumpTs = fx.t0 + 12 * DAY + 9 * 3600_000;
  const injections: PriceInjection[] = [{ symbol: "SOLUSDT", ts: pumpTs, direction: "long", drift: 0.10 }];
  return train(fx.items, makeGetCandles(injections), {
    folds: 3, mode: "single", onProgress: silentProgress,
    metaLedger: ledger,
    grid: {
      windowK: [3], jaccardThreshold: [0.3, 0.4], lagPeakThreshold: [0.4, 0.5], minClusters: [2],
      trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
      stalenessSinceMinutes: [240], staleMinutes: [240],
      volZThreshold: [1.5, 2.5], squeezePolicy: ["none"], squeezeThreshold: [0.55, 0.7],
      volBaselineWindow: [20], cascadeWindowMinutes: [15, 30], stationarityWindowMs: [Infinity],
    },
    selection: { nestedOuterFolds: 0 },
    ...over,
  });
};

describe("train — испытания без дубликатов", () => {
  it("оси vz/sqt/cw (inert) и jac/lag (single) НЕ множат innerTrials", async () => {
    // наивное произведение: 2jac×2lag×2vz×2sqt×2cw = 32 «испытания»;
    // различимых по результату конфигов — ровно 1.
    const res = await fastFit();
    expect(res.params.meta.innerTrials).toBe(1);
    expect(res.params.meta.gridSize).toBe(1);
  });

  it("активная политика с разными sqt — РАЗНЫЕ испытания (не пересхлопнуто)", async () => {
    const res = await fastFit({
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
        trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
        stalenessSinceMinutes: [240], staleMinutes: [240],
        volZThreshold: [2.0], squeezePolicy: ["none", "tighten"], squeezeThreshold: [0.55, 0.7],
        volBaselineWindow: [20], cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity],
      },
    });
    // none → 1 (sqt схлопнут) + tighten×2 sqt → итого 3 различимых
    expect(res.params.meta.innerTrials).toBe(3);
  });

  it("byMode тензора честно равен global (отдельного уровня режима в данных нет)", async () => {
    const res = await fastFit();
    expect(res.params.exit.byMode.single).toEqual(res.params.exit.global);
    expect(res.params.exit.byMode.matrix).toEqual(res.params.exit.global);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-LEDGER ВСТРОЕН: cadence-guard реально запрещает частый refit, попытка
// записывается в возвращаемый ledger (раньше guard был мёртвым экспортом).
// ─────────────────────────────────────────────────────────────────────────────
describe("meta-ledger — встроен в train/fit", () => {
  it("свежая попытка в ledger → train отклоняет refit (cadence-guard)", async () => {
    const ledger = recordAttempt(emptyLedger(), { ts: Date.now(), innerTrials: 10, certifiedNaive: false });
    await expect(fastFit({}, ledger)).rejects.toThrow(/cadence-guard/);
  });

  it("ignoreCadence: true → осознанный обход разрешён", async () => {
    const ledger = recordAttempt(emptyLedger(), { ts: Date.now(), innerTrials: 10, certifiedNaive: false });
    const res = await fastFit({ ignoreCadence: true }, ledger);
    expect(res.params.version).toBe(3);
  });

  it("старая попытка (8 дней) → fit разрешён, ledger пополнен ЭТОЙ попыткой", async () => {
    const ledger = recordAttempt(emptyLedger(), { ts: Date.now() - 8 * DAY, innerTrials: 10, certifiedNaive: false });
    const res = await fastFit({}, ledger);
    expect(res.ledger.attempts.length).toBe(2);
    expect(res.ledger.attempts[1].innerTrials).toBe(res.params.meta.innerTrials);
    // family-wise: эффективные испытания включают прошлый fit
    expect(res.params.meta.effectiveTrials).toBe(10 + res.params.meta.innerTrials);
  });

  it("без входного ledger цепочка стартует автоматически (1 попытка)", async () => {
    const res = await fastFit();
    expect(res.ledger.attempts.length).toBe(1);
    expect(typeof res.ledger.attempts[0].certifiedNaive).toBe("boolean");
  });

  it("PumpMatrix.fit отдаёт ledgerAfterFit; load() → null", async () => {
    const fx = buildFixture();
    const gc = makeGetCandles([]);
    const m = await PumpMatrix.fit(fx.items.slice(0, 30), gc, {
      folds: 3, mode: "single", onProgress: silentProgress,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [2],
        trailingTake: [1.0], hardStop: [2.0], stalenessSinceProfit: [1.0],
        stalenessSinceMinutes: [240], staleMinutes: [240], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity],
      },
      selection: { nestedOuterFolds: 0 },
    });
    expect(m.ledgerAfterFit).not.toBe(null);
    expect(m.ledgerAfterFit!.attempts.length).toBe(1);
    const loaded = PumpMatrix.load(m.save());
    expect(loaded.ledgerAfterFit).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// predict в форс-single НЕ гоняет мёртвый matrix-пайплайн: авторы тривиальны,
// viability — честная заглушка, сигналы прежние.
// ─────────────────────────────────────────────────────────────────────────────
describe("predict(mode=single) — без мёртвой корреляции", () => {
  const items: ParserItem[] = [
    { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 },
    { channel: "b", symbol: "SOLUSDT", direction: "long", ts: t0 + 2 * MIN },
    { channel: "c", symbol: "TRXUSDT", direction: "short", ts: t0 + 5 * MIN },
  ];

  it("сигналы single-режима не изменились, viability честно говорит «не оценивалась»", () => {
    const res = predict(items, { mode: "single" });
    expect(res.usedMode).toBe("single");
    expect(res.signals.length).toBeGreaterThan(0);
    expect(res.signals.every((s) => s.source === "single")).toBe(true);
    expect(res.viability.reason).toContain("не оценивалась");
    expect(res.viability.viable).toBe(false);
  });

  it("каждый канал — независимый автор (тривиальная карта)", () => {
    const res = predict(items, { mode: "single" });
    expect(res.authorCount).toBe(3);
    expect(res.authors.size).toBe(3);
  });

  it("auto/matrix режимы по-прежнему оценивают матрицу по-настоящему", () => {
    const auto = predict(items); // auto
    expect(auto.viability.reason).not.toContain("не оценивалась");
    const mtx = predict(items, { mode: "matrix" });
    expect(mtx.viability.reason).not.toContain("не оценивалась");
  });
});
