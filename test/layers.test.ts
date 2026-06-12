import { describe, it, expect } from "vitest";
import { buildTable } from "../src/core/event-table";
import { selfTuneLag } from "../src/layers/self-tune-lag";
import { jaccardPair, jaccardScreen } from "../src/layers/jaccard-screen";
import { lagXCorr } from "../src/layers/lag-xcorr";
import { clusterAuthors } from "../src/layers/cluster-authors";
import { SignalEvent } from "../src/types";

const MIN = 60_000;

function ev(channel: string, symbol: string, direction: "long" | "short", tsMin: number): SignalEvent {
  return { channel, symbol, direction, ts: tsMin * MIN };
}

describe("buildTable", () => {
  it("сортирует по ts и индексирует по ключу и каналу", () => {
    const tbl = buildTable([
      ev("a", "X", "long", 10),
      ev("b", "X", "long", 5),
      ev("a", "Y", "short", 7),
    ]);
    expect(tbl.events[0].ts).toBe(5 * MIN);
    expect(tbl.channels.sort()).toEqual(["a", "b"]);
    expect(tbl.byKey.get("X|long")!.length).toBe(2);
    expect(tbl.byChannelKey.get("a|X|long")).toEqual([10 * MIN]);
  });
});

describe("jaccardPair — скользящее окно по сырому ts", () => {
  it("матчит близкие события на краях бакета (10:29 и 10:31)", () => {
    // фиксированная сетка 30м их бы разорвала; скользящее окно — нет
    const tbl = buildTable([
      ev("a", "X", "long", 10 * 60 + 29),
      ev("b", "X", "long", 10 * 60 + 31),
    ]);
    const j = jaccardPair(tbl, "a", "b", 30 * MIN);
    expect(j).toBeGreaterThan(0); // 2 мин < 30 мин окна
  });

  it("не матчит далёкие события", () => {
    const tbl = buildTable([
      ev("a", "X", "long", 0),
      ev("b", "X", "long", 120),
    ]);
    expect(jaccardPair(tbl, "a", "b", 30 * MIN)).toBe(0);
  });

  it("возвращает 0 для каналов без общих ключей", () => {
    const tbl = buildTable([
      ev("a", "X", "long", 0),
      ev("b", "Y", "short", 1),
    ]);
    expect(jaccardPair(tbl, "a", "b", 30 * MIN)).toBe(0);
  });
});

describe("selfTuneLag", () => {
  it("на малом объёме данных возвращает дефолт 15 мин", () => {
    const tbl = buildTable([ev("a", "X", "long", 0), ev("b", "X", "long", 3)]);
    expect(selfTuneLag(tbl)).toBe(15 * MIN);
  });

  it("находит характерный лаг при кучном пике задержек ~4 мин", () => {
    const evs: SignalEvent[] = [];
    for (let d = 0; d < 12; d++) {
      evs.push(ev("a", "X", "long", d * 600));        // каждые 10ч
      evs.push(ev("b", "X", "long", d * 600 + 4));    // через 4 мин
    }
    const tau = selfTuneLag(buildTable(evs));
    expect(tau).toBeGreaterThanOrEqual(30 * 1000);
    expect(tau).toBeLessThanOrEqual(60 * MIN);
  });
});

describe("lagXCorr — направленность и острота пика", () => {
  it("определяет лидера: a стабильно раньше b", () => {
    const evs: SignalEvent[] = [];
    for (let d = 0; d < 10; d++) {
      evs.push(ev("a", "X", "long", d * 600));
      evs.push(ev("b", "X", "long", d * 600 + 4));
    }
    const tbl = buildTable(evs);
    const edges = jaccardScreen(tbl, 10 * MIN, 0.3);
    const directed = lagXCorr(tbl, edges, 0.5, 10 * MIN);
    expect(directed.length).toBe(1);
    expect(directed[0].leader).toBe("a");
    expect(directed[0].follower).toBe("b");
  });

  it("отбраковывает размазанный фон (низкий peakShare)", () => {
    const evs: SignalEvent[] = [];
    for (let d = 0; d < 10; d++) {
      evs.push(ev("a", "X", "long", d * 600));
      evs.push(ev("b", "X", "long", d * 600 + d * 50 + 200)); // растущий разброс
    }
    const tbl = buildTable(evs);
    const edges = jaccardScreen(tbl, 10 * MIN, 0.0);
    const directed = lagXCorr(tbl, edges, 0.5, 10 * MIN);
    expect(directed.length).toBe(0);
  });
});

describe("clusterAuthors — union-find", () => {
  it("сливает транзитивную цепочку a-b-c в один кластер", () => {
    const edges = [
      { a: "a", b: "b", jaccard: 1, lag: 0, peakShare: 1, leader: "a", follower: "b" },
      { a: "b", b: "c", jaccard: 1, lag: 0, peakShare: 1, leader: "b", follower: "c" },
    ];
    const m = clusterAuthors(["a", "b", "c", "d"], edges);
    expect(m.get("a")).toBe(m.get("c"));
    expect(m.get("a")).not.toBe(m.get("d"));
  });

  it("каждый изолированный канал — свой кластер", () => {
    const m = clusterAuthors(["a", "b", "c"], []);
    expect(new Set(m.values()).size).toBe(3);
  });
});
