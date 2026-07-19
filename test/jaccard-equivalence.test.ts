import { describe, it, expect } from "vitest";
import { buildTable } from "../src/core/event-table";
import { jaccardScreen, jaccardPair, Edge } from "../src/layers/jaccard-screen";
import { SignalEvent } from "../src/types";
import { MIN, HOUR, mulberry32 } from "./helpers/synthetic-world";

/**
 * ЭКВИВАЛЕНТНОСТЬ РАЗРЕЖЕННОГО СИТА ПОЛНОМУ ПЕРЕБОРУ — бит-в-бит.
 *
 * Сито ускорено двумя отсечениями (со-активность + верхняя граница
 * jaccard ≤ 2·min(nA,nB)/(nA+nB)). Оба обязаны быть ТОЧНЫМИ: качество анализа
 * не имеет права упасть ни на одно ребро. Эталон — дословный старый полный
 * перебор через публичный jaccardPair. Сравнение строгое: тот же порядок,
 * те же пары, те же значения jaccard.
 */

const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);

/** дословный старый полный перебор — эталон */
function naiveScreen(tbl: ReturnType<typeof buildTable>, window: number, threshold: number): Edge[] {
  const ch = tbl.channels;
  const edges: Edge[] = [];
  for (let i = 0; i < ch.length; i++) {
    for (let j = i + 1; j < ch.length; j++) {
      const jac = jaccardPair(tbl, ch[i], ch[j], window);
      if (jac >= threshold) edges.push({ a: ch[i], b: ch[j], jaccard: jac });
    }
  }
  return edges;
}

const expectSame = (tbl: ReturnType<typeof buildTable>, window: number, threshold: number) => {
  const fast = jaccardScreen(tbl, window, threshold);
  const slow = naiveScreen(tbl, window, threshold);
  expect(fast.length).toBe(slow.length);
  for (let i = 0; i < slow.length; i++) {
    expect(fast[i].a).toBe(slow[i].a);
    expect(fast[i].b).toBe(slow[i].b);
    expect(fast[i].jaccard).toBeCloseTo(slow[i].jaccard, 12);
  }
};

/** сеяный мир: смесь эхо-пар, скальперов и редких независимых авторов */
function randomWorld(seed: number, nChannels: number, nSymbols: number): SignalEvent[] {
  const rnd = mulberry32(seed);
  const events: SignalEvent[] = [];
  for (let c = 0; c < nChannels; c++) {
    const channel = `ch${c}`;
    // размер канала: от 2 постов до «скальпера» на пару сотен
    const n = 2 + Math.floor(rnd() * rnd() * 200);
    for (let e = 0; e < n; e++) {
      const symbol = `S${Math.floor(rnd() * nSymbols)}USDT`;
      const direction = rnd() < 0.7 ? "long" : "short";
      const ts = t0 + Math.floor(rnd() * 30 * 24 * 60) * MIN;
      events.push({ channel, symbol, direction, ts });
      // треть каналов — эхо-боты соседа: тот же пост через ~3 мин
      if (c % 3 === 0 && c + 1 < nChannels && rnd() < 0.5) {
        events.push({ channel: `ch${c + 1}`, symbol, direction, ts: ts + 3 * MIN });
      }
    }
  }
  return events;
}

describe("разреженное jaccard-сито ≡ полный перебор", () => {
  it("случайные миры: 5 сидов × пороги × окна — бит-в-бит", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const tbl = buildTable(randomWorld(seed, 40, 6));
      for (const threshold of [0.02, 0.1, 0.3, 0.7]) {
        for (const window of [5 * MIN, 30 * MIN]) {
          expectSame(tbl, window, threshold);
        }
      }
    }
  });

  it("порог 0 (вырожденный): фолбэк возвращает и нулевые пары — как полный перебор", () => {
    const tbl = buildTable(randomWorld(7, 12, 4));
    expectSame(tbl, 10 * MIN, 0);
    // санити: при пороге 0 рёбер ровно C(n,2) — ни одна пара не потеряна
    const n = tbl.channels.length;
    expect(jaccardScreen(tbl, 10 * MIN, 0).length).toBe((n * (n - 1)) / 2);
  });

  it("граница не пере-отсекает: jaccard РОВНО на пороге проходит", () => {
    // два канала: 1 совпадение из 2+2 событий → jaccard = 2/4 = 0.5 ровно
    const tbl = buildTable([
      { channel: "a", symbol: "XUSDT", direction: "long", ts: t0 },
      { channel: "a", symbol: "XUSDT", direction: "long", ts: t0 + 10 * HOUR },
      { channel: "b", symbol: "XUSDT", direction: "long", ts: t0 + MIN },
      { channel: "b", symbol: "XUSDT", direction: "long", ts: t0 + 20 * HOUR },
    ]);
    expectSame(tbl, 5 * MIN, 0.5);
    expect(jaccardScreen(tbl, 5 * MIN, 0.5).length).toBe(1); // 0.5 >= 0.5 — в деле
    expect(jaccardScreen(tbl, 5 * MIN, 0.5 + 1e-9).length).toBe(0);
  });

  it("скальпер × редкий автор: пара отсекается границей, но НЕ теряется на её краю", () => {
    const events: SignalEvent[] = [];
    // скальпер: 997 постов; редкий: 3 поста-эха (все совпадут)
    for (let i = 0; i < 997; i++) {
      events.push({ channel: "scalper", symbol: "BUSDT", direction: "long", ts: t0 + i * 17 * MIN });
    }
    for (let i = 0; i < 3; i++) {
      events.push({ channel: "tiny", symbol: "BUSDT", direction: "long", ts: t0 + i * 17 * MIN + MIN });
    }
    const tbl = buildTable(events);
    // точный jaccard = 2·3/(997+3) = 0.006
    const exact = jaccardPair(tbl, tbl.channels[0], tbl.channels[1], 5 * MIN);
    expect(exact).toBeCloseTo(0.006, 12);
    // порог чуть НИЖЕ значения — ребро обязано выжить (граница = 0.006 не строго < 0.0059)
    expectSame(tbl, 5 * MIN, 0.0059);
    expect(jaccardScreen(tbl, 5 * MIN, 0.0059).length).toBe(1);
    // порог чуть выше — честный ноль
    expectSame(tbl, 5 * MIN, 0.0061);
    expect(jaccardScreen(tbl, 5 * MIN, 0.0061).length).toBe(0);
  });

  it("каналы без общих ключей: пары не генерируются, результат совпадает", () => {
    const tbl = buildTable([
      { channel: "a", symbol: "AUSDT", direction: "long", ts: t0 },
      { channel: "a", symbol: "AUSDT", direction: "long", ts: t0 + HOUR },
      { channel: "b", symbol: "BUSDT", direction: "long", ts: t0 },
      { channel: "b", symbol: "BUSDT", direction: "long", ts: t0 + HOUR },
      { channel: "c", symbol: "AUSDT", direction: "short", ts: t0 }, // тот же символ, другой dir
    ]);
    for (const th of [0.1, 0.3]) expectSame(tbl, 10 * MIN, th);
    expect(jaccardScreen(tbl, 10 * MIN, 0.1).length).toBe(0);
  });

  it("вырожденные таблицы: пусто и один канал", () => {
    expect(jaccardScreen(buildTable([]), 10 * MIN, 0.3)).toEqual([]);
    expect(jaccardScreen(buildTable([
      { channel: "solo", symbol: "XUSDT", direction: "long", ts: t0 },
    ]), 10 * MIN, 0.3)).toEqual([]);
  });

  it("масштаб: 400 каналов считаются ситом за секунды и совпадают с эталоном на 150", () => {
    // эквивалентность на размере, где эталон ещё быстрый
    const tbl150 = buildTable(randomWorld(11, 150, 8));
    expectSame(tbl150, 10 * MIN, 0.3);
    // санити скорости: 400 каналов не должны жеваться минутами (раньше — часы на 2250)
    const tbl400 = buildTable(randomWorld(12, 400, 10));
    const started = Date.now();
    const edges = jaccardScreen(tbl400, 10 * MIN, 0.3);
    // щедрый порог: под параллельной нагрузкой набора тайминги плавают ×3;
    // охраняемая регрессия — ЧАСЫ квадрата на тысячах каналов, не секунды
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(Array.isArray(edges)).toBe(true);
  });
});
