import { describe, it, expect } from "vitest";
import { train, predict, buildTable, fitHawkesGraph, clusterAuthors } from "../src/index";
import { SignalEvent, ParserItem } from "../src/types";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";
import { buildFixture } from "./fixture";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// ИЕРАРХИЧЕСКИЙ ПУЛИНГ ТЕНЗОРА: ячейка с парой сделок следует родителю,
// ячейка с большой выборкой перевешивает его своим n.
// ─────────────────────────────────────────────────────────────────────────────
describe("пулинг тензора — James-Stein к родителю вместо независимого шума", () => {
  // Формы цены по циклу 120м от события:
  //  LONGRUN: линейный рост 0.1%/мин 30 мин → life5 = +0.5%, life30 = +3%
  //  SPIKE:   рост 0.2%/мин 5 мин (+1%), затем слив до −2% к 30-й минуте
  const shapeOf = (symbol: string, minuteInCycle: number): number => {
    const m = Math.max(0, Math.min(minuteInCycle, 30));
    if (symbol === "MAINUSDT") return 100 * (1 + 0.001 * m);
    // SPIKE-профиль
    if (m <= 5) return 100 * (1 + 0.002 * m);
    return 100 * (1 + 0.01 - 0.0012 * (m - 5)); // к 30-й минуте ≈ −2%
  };
  const gc: GetCandles = async (symbol, _i, limit, sDate) => {
    const out: ICandleData[] = [];
    for (let i = 0; i < (limit ?? 0); i++) {
      const t = (sDate ?? 0) + i * MIN;
      const mc = Math.floor((t - t0) / MIN) % 120;
      const o = shapeOf(symbol, mc);
      const c = shapeOf(symbol, mc + 1);
      out.push({
        timestamp: t, open: o, close: c,
        high: Math.max(o, c), low: Math.min(o, c) - 0.01,
        volume: 1000 + (i % 5) * 50,
      });
    }
    return out;
  };
  const grid = {
    windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
    trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
    stalenessSinceMinutes: [240], staleMinutes: [5, 30], volZThreshold: [2.0],
    squeezePolicy: ["none" as const], squeezeThreshold: [0.6], volBaselineWindow: [20],
    cascadeWindowMinutes: [3], stationarityWindowMs: [Infinity], momentumGatePct: [null],
  };
  const opts = {
    folds: 3, mode: "single" as const, onProgress: silentProgress, grid,
    channelTriage: false, outcomeModel: false, selection: { nestedOuterFolds: 0 },
  };
  const mkItems = (symbol: string, n: number, offset: number): ParserItem[] =>
    Array.from({ length: n }, (_, k) => ({
      channel: "ch", symbol, direction: "long" as const, ts: t0 + (k * 2 + offset) * 120 * MIN,
    }));

  it("малое n (2 сделки) утягивается к глобальному ранжированию", async () => {
    // MAIN: 20 сделок, life30 лучше; RARE (SPIKE-профиль): 2 сделки, локально life5
    const items = [...mkItems("MAINUSDT", 20, 0), ...mkItems("RAREUSDT", 2, 1)];
    const res = await train(items, gc, opts);
    // глобально побеждает life30 (20 из 22 сделок за него)
    expect(res.params.exit.global.staleMinutes).toBe(30);
    // RARE с n=2 < k=5: собственный шумный выбор life5 перевешен родителем
    expect(res.params.exit.bySymbolDir.single.RAREUSDT!.long!.staleMinutes).toBe(30);
  });

  it("большое n перевешивает родителя — свой профиль сохраняется", async () => {
    // CONTRA: 30 сделок SPIKE-профиля — данных достаточно, чтобы отстоять life5
    const items = [...mkItems("MAINUSDT", 20, 0), ...mkItems("CONTRAUSDT", 30, 1)];
    const res = await train(items, gc, opts);
    expect(res.params.exit.bySymbolDir.single.CONTRAUSDT!.long!.staleMinutes).toBe(5);
    expect(res.params.exit.bySymbolDir.single.MAINUSDT!.long!.staleMinutes).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MULTIVARIATE HAWKES: EM восстанавливает планированную структуру возбуждения.
// ─────────────────────────────────────────────────────────────────────────────
describe("fitHawkesGraph — α-матрица кросс-возбуждения", () => {
  const ev = (channel: string, ts: number): SignalEvent =>
    ({ channel, symbol: "TRXUSDT", direction: "short", ts });

  // мир: x_main постит, x_echo зеркалит через ~3 мин; solo постит независимо
  const world = (): SignalEvent[] => {
    const events: SignalEvent[] = [];
    for (let i = 0; i < 30; i++) {
      const base = t0 + i * 8 * HOUR;
      events.push(ev("x_main", base));
      events.push(ev("x_echo", base + 3 * MIN + (i % 3) * 20_000));
      events.push(ev("solo", base + 4 * HOUR + (i % 7) * 11 * MIN));
    }
    return events;
  };
  const tau = 5 * MIN;

  it("восстанавливает направление: α[main→echo] велик, обратный и solo ≈ 0", () => {
    const g = fitHawkesGraph(buildTable(world()), tau);
    const i = (c: string) => g.channels.indexOf(c);
    expect(g.alpha[i("x_main")][i("x_echo")]).toBeGreaterThan(0.5);
    expect(g.alpha[i("x_echo")][i("x_main")]).toBeLessThan(0.2);
    expect(g.alpha[i("x_main")][i("solo")]).toBeLessThan(0.2);
    expect(g.alpha[i("solo")][i("x_echo")]).toBeLessThan(0.2);
  });

  it("рёбра: только значимая пара, лидерство направлено верно", () => {
    const g = fitHawkesGraph(buildTable(world()), tau);
    const pair = g.edges.find((e) => e.leader === "x_main" && e.follower === "x_echo");
    expect(pair).toBeDefined();
    expect(g.edges.some((e) => e.leader === "solo" || e.follower === "solo")).toBe(false);
    // кластеризация по этим рёбрам: братья вместе, solo отдельно
    const authors = clusterAuthors(["x_main", "x_echo", "solo"], g.edges);
    expect(authors.get("x_main")).toBe(authors.get("x_echo"));
    expect(authors.get("solo")).not.toBe(authors.get("x_main"));
  });

  it("authorGraph:'hawkes' в predict группирует братьев фикстуры как xcorr", () => {
    const { items, siblings } = buildFixture();
    const res = predict(items, { authorGraph: "hawkes" });
    for (const family of siblings) {
      const ids = new Set(family.map((c) => res.authors.get(c)));
      expect(ids.size).toBe(1); // вся братская семья — один кластер
    }
    // независимые фоновые каналы не слиты в семьи
    expect(res.authorCount).toBeGreaterThan(siblings.length);
    // влиятельность из α-графа: лидер семьи ≥ нейтрали, эхо ниже
    const inf = res.influence!;
    expect(inf.get("x_main")!).toBeGreaterThan(inf.get("x_mirror")!);
  });

  it("дефолт без флага — прежний xcorr-конвейер (поведение не изменилось)", () => {
    const { items } = buildFixture();
    const a = predict(items);
    const b = predict(items, { authorGraph: "xcorr" });
    expect(JSON.stringify([...a.authors])).toBe(JSON.stringify([...b.authors]));
  });
});
