import { describe, it, expect } from "vitest";
import { labelBurst, replayExit, ExitParams } from "../src/index";
import { ICandleData, GetCandles } from "../src/candle";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);

const EXIT = (over: Partial<ExitParams> = {}): ExitParams => ({
  trailingTake: 1, hardStop: 2, stalenessSinceProfit: 1,
  stalenessSinceMinutes: 240, staleMinutes: 240, ...over,
});

function flat(n: number, startTs = t0): ICandleData[] {
  const out: ICandleData[] = [];
  for (let i = 0; i < n; i++) {
    const p = 100;
    out.push({ timestamp: startTs + i * MIN, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: 1000 });
  }
  return out;
}

describe("labelBurst — устойчивость к ошибкам адаптера", () => {
  it("getCandles бросает (look-ahead guard / дыра в символе) → кандидат пропущен, не краш", async () => {
    const throwing: GetCandles = async () => { throw new Error("look-ahead bias protection"); };
    const res = await labelBurst(throwing, "FARTCOINUSDT", "long", t0, [EXIT()], 99, 101);
    expect(res).toBe(null); // пропущен, исключение проглочено
  });

  it("getCandles вернул пусто → null, не краш", async () => {
    const empty: GetCandles = async () => [];
    const res = await labelBurst(empty, "SOLUSDT", "long", t0, [EXIT()], 99, 101);
    expect(res).toBe(null);
  });

  it("нормальные данные → метка ставится", async () => {
    const ok: GetCandles = async (_s, _i, limit) => flat(limit ?? 100);
    const res = await labelBurst(ok, "SOLUSDT", "long", t0, [EXIT({ staleMinutes: 60 })], 99, 101);
    expect(res).not.toBe(null);
    expect(res!.byExit.size).toBe(1);
  });
});

describe("replayExit — усечённый горизонт (боковик)", () => {
  it("поздний вход → не хватило свечей на life-cap → truncated=true", () => {
    // вход в зоне [105,106] случается только на свече 90, а life-cap=240:
    // после входа осталось мало свечей
    const rows: ICandleData[] = [];
    for (let i = 0; i < 90; i++) rows.push({ timestamp: t0 + i * MIN, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 });
    // свеча 90 задевает зону [105,106]
    rows.push({ timestamp: t0 + 90 * MIN, open: 105, high: 105.5, low: 104.9, close: 105.2, volume: 1000 });
    for (let i = 91; i < 100; i++) rows.push({ timestamp: t0 + i * MIN, open: 105, high: 105.5, low: 104.5, close: 105, volume: 1000 });
    const r = replayExit(rows, "long", 105, 106, EXIT({ staleMinutes: 240, hardStop: 50, trailingTake: 50 }));
    expect(r.entered).toBe(true);
    expect(r.truncated).toBe(true); // forwardAvail (9) << staleMinutes (240)
  });

  it("полного окна хватает → truncated=false", () => {
    const rows = flat(300);
    rows[0] = { ...rows[0], open: 100, high: 101, low: 99.9, close: 100 }; // вход сразу
    const r = replayExit(rows, "long", 99.9, 100.1, EXIT({ staleMinutes: 60, hardStop: 50, trailingTake: 50 }));
    expect(r.entered).toBe(true);
    expect(r.truncated).toBe(false); // 299 forward >> 60
  });

  it("labelBurst отбрасывает усечённый exit, оставляя полный", async () => {
    // окно 1m свечей: 200 штук. exit с life=60 уложится, exit с life=720 — нет
    const ok: GetCandles = async (_s, _i, limit) => flat(Math.min(limit ?? 200, 200));
    const res = await labelBurst(
      ok, "SOLUSDT", "long", t0,
      [EXIT({ staleMinutes: 60, hardStop: 50, trailingTake: 50 }), EXIT({ staleMinutes: 720, hardStop: 50, trailingTake: 50 })],
      99.9, 100.1,
    );
    // вход на свече 0, forward=199: life=60 ок (truncated=false), life=720 усечён (отброшен)
    expect(res).not.toBe(null);
    const keys = [...res!.byExit.keys()];
    expect(keys.some((k) => k.includes("life60"))).toBe(true);
    expect(keys.some((k) => k.includes("life720"))).toBe(false);
  });
});
