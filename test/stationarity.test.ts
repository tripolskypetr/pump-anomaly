import { describe, it, expect } from "vitest";
import { buildTable, buildWindowedTable, windowEvents } from "../src/core/event-table";
import { selfTuneLag } from "../src/layers/self-tune-lag";
import { jaccardScreen } from "../src/layers/jaccard-screen";
import { lagXCorr } from "../src/layers/lag-xcorr";
import { clusterAuthors } from "../src/layers/cluster-authors";
import { enumerateBursts } from "../src/index";
import { SignalEvent } from "../src/types";

const MIN = 60_000;
const D = 24 * 60 * MIN;

/** A и C синхронны только первый месяц, потом C один; A замолкает по SOL. */
function driftingEvents(): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (let d = 0; d < 30; d++) {
    const t = d * D + 10 * 60 * MIN;
    out.push({ channel: "A", symbol: "SOLUSDT", direction: "long", ts: t });
    out.push({ channel: "C", symbol: "SOLUSDT", direction: "long", ts: t + 3 * MIN });
  }
  for (let d = 30; d < 150; d++) {
    out.push({ channel: "C", symbol: "SOLUSDT", direction: "long", ts: d * D });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function areLinked(tbl: ReturnType<typeof buildTable>): boolean {
  const tau = selfTuneLag(tbl);
  const w = Math.min(3 * tau, 60 * MIN);
  const screened = jaccardScreen(tbl, w, 0.3);
  const directed = lagXCorr(tbl, screened, 0.5, w);
  const cl = clusterAuthors(tbl.channels, directed);
  return cl.get("A") !== undefined && cl.get("A") === cl.get("C");
}

describe("окно стационарности — дрейф режима на длинном горизонте", () => {
  const events = driftingEvents();

  it("windowEvents: Infinity → вся история, конечное → срез", () => {
    expect(windowEvents(events, 140 * D, Infinity).length).toBe(events.length);
    const win = windowEvents(events, 140 * D, 28 * D);
    expect(win.length).toBeLessThan(events.length);
    // в окне нет событий старше 28 дней до anchor
    expect(win.every((e) => e.ts > 140 * D - 28 * D && e.ts <= 140 * D)).toBe(true);
  });

  it("БЕЗ окна: ложная связь A↔C сохраняется на 140-й день (коррапт)", () => {
    const full = buildTable(events);
    expect(areLinked(full)).toBe(true); // A замолчал в первый месяц, но связь «помнится»
  });

  it("С окном 4 недели до дня 140: ложная связь исчезает", () => {
    const windowed = buildWindowedTable(events, 140 * D, 28 * D);
    expect(areLinked(windowed)).toBe(false); // A выпал из окна → нет связи
  });

  it("в раннем периоде окно сохраняет настоящую связь", () => {
    // anchor в первом месяце — A и C реально синхронны
    const windowed = buildWindowedTable(events, 25 * D, 28 * D);
    expect(areLinked(windowed)).toBe(true);
  });

  it("enumerateBursts принимает stationarityWindowMs и не падает", () => {
    const all = enumerateBursts(events, 3, 0.3, 0.5, 60 * MIN, Infinity);
    const win = enumerateBursts(events, 3, 0.3, 0.5, 60 * MIN, 28 * D);
    expect(Array.isArray(all)).toBe(true);
    expect(Array.isArray(win)).toBe(true);
  });
});
