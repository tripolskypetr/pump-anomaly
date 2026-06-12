import { ParserItem, Direction } from "../src/types";

const MIN = 60_000;
const H = 60 * MIN;

/** Детерминированный ГПСЧ — тесты должны быть воспроизводимы. */
function makeRng(seed = 42) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

export interface Fixture {
  items: ParserItem[];
  t0: number;
  /** ожидаемые братские группы (для проверки кластеризации) */
  siblings: string[][];
  /** ожидаемый настоящий памп */
  truePump: { symbol: string; direction: Direction; channels: string[] };
}

/**
 * Сцена: фон из честных каналов + два автора-манипулятора с братскими каналами
 * + один настоящий синхронный памп от независимых источников.
 */
export function buildFixture(seed = 42): Fixture {
  const rnd = makeRng(seed);
  const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);
  const items: ParserItem[] = [];

  const SYMS = ["TRXUSDT", "SOLUSDT", "NEARUSDT", "HYPEUSDT", "POLUSDT"];
  const DIRS: Direction[] = ["long", "short"];

  // фон: 6 честных независимых каналов
  const bg = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  for (const ch of bg)
    for (let d = 0; d < 26; d++)
      if (rnd() < 0.5)
        items.push({
          channel: ch,
          symbol: SYMS[Math.floor(rnd() * SYMS.length)],
          direction: DIRS[Math.floor(rnd() * 2)],
          ts: t0 + d * 24 * H + Math.floor(rnd() * 20 * H),
        });

  // автор X: 3 братских канала, TRX short, лаг ~3 мин
  const authorX = ["x_main", "x_mirror", "x_backup"];
  for (let d = 0; d < 8; d++) {
    const base = t0 + d * 3 * 24 * H + 10 * H;
    authorX.forEach((ch, i) =>
      items.push({
        channel: ch,
        symbol: "TRXUSDT",
        direction: "short",
        ts: base + i * 3 * MIN + Math.floor(rnd() * 60_000),
      }),
    );
  }

  // автор Y: 2 братских канала, NEAR long, лаг ~5 мин
  const authorY = ["y_one", "y_two"];
  for (let d = 0; d < 7; d++) {
    const base = t0 + d * 3 * 24 * H + 15 * H;
    authorY.forEach((ch, i) =>
      items.push({
        channel: ch,
        symbol: "NEARUSDT",
        direction: "long",
        ts: base + i * 5 * MIN + Math.floor(rnd() * 60_000),
      }),
    );
  }

  // настоящий памп: SOL long, разные независимые источники в одно окно
  const pumpTs = t0 + 12 * 24 * H + 9 * H;
  const pumpHitters = ["x_main", "y_one", "alpha", "bravo"];
  pumpHitters.forEach((ch, i) =>
    items.push({
      channel: ch,
      symbol: "SOLUSDT",
      direction: "long",
      ts: pumpTs + i * 4 * MIN + Math.floor(rnd() * 30_000),
    }),
  );

  return {
    items,
    t0,
    siblings: [authorX, authorY],
    truePump: { symbol: "SOLUSDT", direction: "long", channels: pumpHitters },
  };
}
