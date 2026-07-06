import { describe, it, expect } from "vitest";
import { buildTable } from "../src/core/event-table";
import { selfTuneLagDetail } from "../src/layers/self-tune-lag";
import { jaccardScreen } from "../src/layers/jaccard-screen";
import { lagXCorr } from "../src/layers/lag-xcorr";
import { clusterAuthors } from "../src/layers/cluster-authors";
import { authorInfluence } from "../src/layers/author-influence";
import { fitHawkesGraph } from "../src/layers/hawkes-graph";
import { SignalEvent } from "../src/types";
import { MIN, HOUR, mulberry32 } from "./helpers/synthetic-world";

/**
 * СИНТЕТИКА MATRIX-ДЕТЕКТОРА — слои восстанавливают ЗАЛОЖЕННОЕ АВТОРСТВО.
 *
 * Истина закладывается руками в поток событий (без свечей — детекторы работают
 * по времени постов): канал beta — эхо-бот alpha с лагом ровно 5 минут (±20с
 * джиттера); gamma — независимый канал на тех же символах. Проверяется вся
 * конвейерная цепочка слоёв: τ (EM-смесь) ≈ 5 мин → jaccard находит пару
 * alpha-beta и НЕ склеивает gamma → lagXCorr называет лидера → union-find
 * объединяет только эхо-пару → authorInfluence отдаёт лидерство alpha →
 * multivariate Hawkes находит ребро alpha→beta и не выдумывает alpha→gamma.
 */

const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
const SYMBOLS = ["S1USDT", "S2USDT", "S3USDT", "S4USDT", "S5USDT", "S6USDT"];
const PLANTED_LAG = 5 * MIN;

const events: SignalEvent[] = [];
const jit = mulberry32(777);
for (let k = 0; k < 30; k++) {
  const symbol = SYMBOLS[k % SYMBOLS.length];
  const ts = t0 + k * 9 * HOUR; // внутри (symbol,dir)-группы посты разнесены на 54ч
  events.push({ channel: "alpha", symbol, direction: "long", ts });
  // эхо-бот: тот же символ через 5 мин ± 20 с
  events.push({
    channel: "beta", symbol, direction: "long",
    ts: ts + PLANTED_LAG + Math.round((jit() - 0.5) * 40_000),
  });
  // независимый канал: те же символы, своё РАЗМАЗАННОЕ время (1–5ч — вне
  // jaccard-окна; варьируется, чтобы фон не был вторым «пиком» для EM)
  events.push({
    channel: "gamma", symbol, direction: "long",
    ts: ts + Math.round((1 + 4 * jit()) * HOUR),
  });
}
const tbl = buildTable(events);

describe("синтетика matrix-детектора — заложенное авторство восстанавливается", () => {
  it("слой 1 (EM-смесь): τ восстановлен ≈ 5 мин, пик выраженный", () => {
    const d = selfTuneLagDetail(tbl);
    expect(d.tauMs).toBeGreaterThan(3 * MIN);
    expect(d.tauMs).toBeLessThan(8 * MIN);
    expect(d.peakWeight).toBeGreaterThan(0.3); // братские задержки видны над фоном
    expect(d.n).toBeGreaterThan(20);
  });

  it("слои 2–5: jaccard находит пару, lagXCorr называет лидера, union-find не переклеивает", () => {
    const pairs = jaccardScreen(tbl, 10 * MIN, 0.3);
    const names = pairs.map((e) => [e.a, e.b].sort().join("+"));
    expect(names).toContain("alpha+beta");
    expect(names).not.toContain("alpha+gamma");
    expect(names).not.toContain("beta+gamma");

    const edges = lagXCorr(tbl, pairs, 0.5, 10 * MIN);
    expect(edges.length).toBe(1);
    expect(edges[0].leader).toBe("alpha"); // эхо-бот не может быть инициатором
    expect(edges[0].follower).toBe("beta");
    expect(edges[0].lag).toBeGreaterThan(3 * MIN);
    expect(edges[0].lag).toBeLessThan(7 * MIN);

    const authors = clusterAuthors(["alpha", "beta", "gamma"], edges);
    expect(authors.get("alpha")).toBe(authors.get("beta")); // эхо-пара — один автор
    expect(authors.get("gamma")).not.toBe(authors.get("alpha")); // независимый — отдельно

    const infl = authorInfluence(["alpha", "beta", "gamma"], edges);
    expect(infl.get("alpha")!).toBeGreaterThan(infl.get("beta")!);
  });

  it("слой 9 (multivariate Hawkes): ребро alpha→beta найдено, alpha→gamma не выдумано", () => {
    const g = fitHawkesGraph(tbl, PLANTED_LAG);
    const iA = g.channels.indexOf("alpha");
    const iB = g.channels.indexOf("beta");
    const iG = g.channels.indexOf("gamma");
    // возбуждение направлено: alpha порождает beta, не наоборот и не в gamma
    expect(g.alpha[iA][iB]).toBeGreaterThan(g.alpha[iB][iA]);
    expect(g.alpha[iA][iB]).toBeGreaterThan(g.alpha[iA][iG]);
    const named = g.edges.map((e) => `${e.leader}->${e.follower}`);
    expect(named).toContain("alpha->beta");
    expect(named).not.toContain("alpha->gamma");
    expect(named).not.toContain("gamma->alpha");
  });
});
