import { describe, it, expect } from "vitest";
import {
  buildTable, earlyWarning, predict, train,
  hawkesBurst, hawkesWeight, authorInfluence, leadershipWeight, algoSignatureOf,
} from "../src/index";
import { SignalEvent, ParserItem, DEFAULT_CONFIG } from "../src/types";
import { DirectedEdge } from "../src/layers/lag-xcorr";
import { GetCandles, ICandleData } from "../src/candle";
import { silentProgress } from "../src/progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// СЛОЙ 6 — Hawkes-самовозбуждение: пачка постов на ТИХОМ тикере значима,
// та же пачка на вечно шумном — фон.
// ─────────────────────────────────────────────────────────────────────────────
describe("hawkesBurst — всплеск против пуассоновского фона тикера", () => {
  const tau = 5 * MIN;

  it("пачка на разреженном тикере → score >> 1 (значимо)", () => {
    // 6 событий раз в неделю, затем 3 события за 4 минуты
    const ts = [
      ...Array.from({ length: 6 }, (_, i) => t0 + i * 7 * DAY),
      t0 + 45 * DAY, t0 + 45 * DAY + 2 * MIN, t0 + 45 * DAY + 4 * MIN,
    ];
    const b = hawkesBurst(ts, ts.length - 1, tau);
    expect(b.score).toBeGreaterThan(1);
    expect(hawkesWeight(b.score)).toBe(1); // выше порога случайности — без штрафа
  });

  it("та же пачка на вечно шумном тикере → score < 1 (фон)", () => {
    // событие каждые 10 минут, 10 часов подряд — «всплеск» ничем не выделяется
    const ts = Array.from({ length: 60 }, (_, i) => t0 + i * 10 * MIN);
    const b = hawkesBurst(ts, 59, tau);
    expect(b.score).toBeLessThan(1);
    expect(hawkesWeight(b.score)).toBeLessThan(1); // дисконт
  });

  it("одиночное событие: фона нет → score от возбуждения предыдущих (0 без них)", () => {
    const b = hawkesBurst([t0], 0, tau);
    expect(b.excitation).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// СЛОЙ 7 — влиятельность авторов: лидер > 0.5 > эхо; изолированный нейтрален.
// ─────────────────────────────────────────────────────────────────────────────
describe("authorInfluence / leadershipWeight — лидер vs эхо", () => {
  const edge = (leader: string, follower: string, peakShare = 0.8): DirectedEdge =>
    ({ a: leader, b: follower, jaccard: 0.5, lag: 3 * MIN, peakShare, leader, follower });

  it("лидер выше нейтрали, эхо ниже, изолированный ровно 0.5", () => {
    const inf = authorInfluence(["boss", "echo1", "echo2", "loner"], [
      edge("boss", "echo1"), edge("boss", "echo2"),
    ]);
    expect(inf.get("boss")!).toBeGreaterThan(0.5);
    expect(inf.get("echo1")!).toBeLessThan(0.5);
    expect(inf.get("loner")).toBe(0.5);
  });

  it("вес всплеска: нейтральный состав → 1, чистое эхо → дисконт, лидеры → cap 1", () => {
    const inf = authorInfluence(["boss", "echo1", "echo2", "loner"], [
      edge("boss", "echo1"), edge("boss", "echo2"),
    ]);
    expect(leadershipWeight(["loner"], inf).weight).toBe(1);
    const echoes = leadershipWeight(["echo1", "echo2"], inf);
    expect(echoes.weight).toBeLessThan(1);
    expect(echoes.leaderShare).toBeLessThan(0.5);
    expect(leadershipWeight(["boss"], inf).weight).toBe(1); // консервативно: без бонуса
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ИНТЕГРАЦИЯ в earlyWarning: confidence несёт оба веса, поля в вердикте.
// ─────────────────────────────────────────────────────────────────────────────
describe("earlyWarning — hawkes и лидерство в confidence", () => {
  // тихий тикер: 4 недельных события-предыстории + синхронный всплеск 3 каналов
  const events: SignalEvent[] = [
    ...Array.from({ length: 4 }, (_, i) => ({
      channel: "a", symbol: "SOLUSDT", direction: "long" as const, ts: t0 + i * 7 * DAY,
    })),
    { channel: "a", symbol: "SOLUSDT", direction: "long", ts: t0 + 40 * DAY },
    { channel: "b", symbol: "SOLUSDT", direction: "long", ts: t0 + 40 * DAY + 2 * MIN },
    { channel: "c", symbol: "SOLUSDT", direction: "long", ts: t0 + 40 * DAY + 4 * MIN },
  ];
  const tbl = buildTable(events);
  const clusters = new Map([["a", 0], ["b", 1], ["c", 2]]);
  const cfg = { ...DEFAULT_CONFIG, minClusters: 2 };
  const tau = 5 * MIN;

  it("вердикт несёт burstScore/leaderShare; тихий тикер значим", () => {
    const v = earlyWarning(tbl, clusters, cfg, tau)
      .find((x) => x.action === "open")!;
    expect(v.burstScore!).toBeGreaterThan(1);
    expect(v.leaderShare).toBe(0.5); // influence не передан → нейтрально
  });

  it("всплеск из одних эхо-каналов дисконтируется против нейтрального", () => {
    const neutral = earlyWarning(tbl, clusters, cfg, tau).find((x) => x.action === "open")!;
    const echoInfluence = new Map([["a", 0.1], ["b", 0.1], ["c", 0.1]]); // все — эхо
    const echoed = earlyWarning(tbl, clusters, cfg, tau, echoInfluence)
      .find((x) => x.action === "open")!;
    expect(echoed.confidence).toBeLessThan(neutral.confidence);
    expect(echoed.leaderShare!).toBeCloseTo(0.1, 6);
  });

  it("шумный тикер: тот же состав кластеров, но confidence ниже (hawkes-дисконт)", () => {
    const noisy: SignalEvent[] = [];
    for (let i = 0; i < 120; i++) {
      noisy.push({ channel: ["a", "b", "c"][i % 3], symbol: "SOLUSDT", direction: "long", ts: t0 + i * 10 * MIN });
    }
    const nv = earlyWarning(buildTable(noisy), clusters, cfg, tau).find((x) => x.action === "open")!;
    expect(nv.burstScore!).toBeLessThan(1);
    const quiet = earlyWarning(tbl, clusters, cfg, tau).find((x) => x.action === "open")!;
    expect(quiet.burstScore!).toBeGreaterThan(nv.burstScore!);
  });

  it("predict отдаёт карту влиятельности в matrix/auto и не считает её в single", () => {
    const items = events as unknown as ParserItem[];
    expect(predict(items).influence).toBeInstanceOf(Map);
    expect(predict(items, { mode: "single" }).influence).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// СЛОЙ 8 — алгоритмическая сигнатура канала (habr 1028592).
// ─────────────────────────────────────────────────────────────────────────────
describe("algoSignatureOf — бот-паттерны постинга", () => {
  it("метроном (равные интервалы) → регулярность 1, algoScore высокий", () => {
    const ts = Array.from({ length: 20 }, (_, i) => t0 + i * 137 * MIN);
    const s = algoSignatureOf(ts);
    expect(s.intervalRegularity).toBe(1);
    expect(s.algoScore).toBeGreaterThan(0.9);
  });

  it("cron-расписание (ежедневно в один час) → концентрация часа ≈ 1", () => {
    const ts = Array.from({ length: 15 }, (_, i) => Date.UTC(2026, 0, 6 + i, 14, 0, 0));
    const s = algoSignatureOf(ts);
    expect(s.modalHourConcentration).toBeGreaterThan(0.95);
    expect(s.algoScore).toBeGreaterThan(0.95);
  });

  it("человеческий поток (рваные интервалы, разные часы) → низкий algoScore", () => {
    // псевдослучайные интервалы 3ч..40ч, часы размазаны
    let t = t0;
    const ts: number[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 30; i++) {
      t += (3 + rnd() * 37) * HOUR;
      ts.push(t);
    }
    const s = algoSignatureOf(ts);
    expect(s.algoScore).toBeLessThan(0.5);
  });

  it("мало постов (< 8) → не судим (0)", () => {
    expect(algoSignatureOf([t0, t0 + HOUR, t0 + 2 * HOUR]).algoScore).toBe(0);
  });

  it("train сериализует algoScore: бот-канал выше человеческого", async () => {
    const items: ParserItem[] = [];
    // бот: ежедневно в 14:00 по AUSDT
    for (let i = 0; i < 10; i++) items.push({ channel: "bot", symbol: "AUSDT", direction: "long", ts: Date.UTC(2026, 0, 6 + i, 14, 0, 0) });
    // человек: рваные интервалы и часы по BUSDT
    let t = Date.UTC(2026, 0, 6, 3, 17, 0);
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 10; i++) {
      t += (5 + rnd() * 33) * HOUR;
      items.push({ channel: "human", symbol: "BUSDT", direction: "long", ts: t });
    }
    const gc: GetCandles = async (_s, _i, limit, sDate) => {
      const out: ICandleData[] = [];
      for (let i = 0; i < (limit ?? 0); i++) {
        const tt = (sDate ?? 0) + i * MIN;
        const p = 100 + ((tt - t0) / MIN) * 0.0005;
        out.push({ timestamp: tt, open: p, high: p + 0.05, low: p - 0.05, close: p + 0.02, volume: 1000 + (i % 5) * 50 });
      }
      return out;
    };
    const res = await train(items, gc, {
      folds: 3, mode: "single", onProgress: silentProgress,
      grid: {
        windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
        trailingTake: [50], hardStop: [50], stalenessSinceProfit: [1],
        stalenessSinceMinutes: [240], staleMinutes: [30], volZThreshold: [2.0],
        squeezePolicy: ["none"], squeezeThreshold: [0.6], volBaselineWindow: [20],
        cascadeWindowMinutes: [15], stationarityWindowMs: [Infinity], momentumGatePct: [null],
      },
      selection: { nestedOuterFolds: 0 },
    });
    const cs = res.params.channelScore!;
    expect(cs.bot.algoScore!).toBeGreaterThan(0.9);
    expect(cs.human.algoScore!).toBeLessThan(cs.bot.algoScore!);
  });
});
