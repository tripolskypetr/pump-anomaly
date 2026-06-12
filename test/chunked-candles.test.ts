import { describe, it, expect, vi } from "vitest";
import { fetchCandlesChunked, MAX_CANDLES_PER_CHUNK } from "../src/index";
import { ICandleData, GetCandles, STEP_MS } from "../src/candle";

const t0 = Date.UTC(2026, 0, 6, 0, 0, 0);
const STEP = STEP_MS["1m"];

/** адаптер, отдающий ровно `limit` свечей подряд от since (как строгий prod-адаптер) */
function strictAdapter(): GetCandles {
  return async (_s, _i, limit, sDate) => {
    const since = sDate!;
    const out: ICandleData[] = [];
    for (let i = 0; i < (limit ?? 0); i++) {
      const ts = since + i * STEP;
      out.push({ timestamp: ts, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    }
    return out;
  };
}

describe("fetchCandlesChunked", () => {
  it("limit ≤ chunk → один прямой вызов (passthrough)", async () => {
    const spy = vi.fn(strictAdapter());
    const res = await fetchCandlesChunked(spy, "SOLUSDT", "1m", 300, t0);
    expect(res.length).toBe(300);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("limit > chunk → бьёт на чанки по 500", async () => {
    const spy = vi.fn(strictAdapter());
    const res = await fetchCandlesChunked(spy, "SOLUSDT", "1m", 1200, t0);
    expect(res.length).toBe(1200);
    // 1200 → 500 + 500 + 200 = 3 вызова
    expect(spy).toHaveBeenCalledTimes(3);
    const calls = spy.mock.calls.map((c) => c[2]); // limit каждого чанка
    expect(calls).toEqual([500, 500, 200]);
  });

  it("since двигается вперёд на chunkLimit·step между чанками", async () => {
    const spy = vi.fn(strictAdapter());
    await fetchCandlesChunked(spy, "SOLUSDT", "1m", 1100, t0);
    const sinces = spy.mock.calls.map((c) => c[3]); // sDate каждого чанка
    expect(sinces[0]).toBe(t0);
    expect(sinces[1]).toBe(t0 + 500 * STEP);
    expect(sinces[2]).toBe(t0 + 1000 * STEP);
  });

  it("свечи склеены непрерывно и отсортированы по ts", async () => {
    const res = await fetchCandlesChunked(strictAdapter(), "SOLUSDT", "1m", 1300, t0);
    expect(res.length).toBe(1300);
    for (let i = 1; i < res.length; i++) {
      expect(res[i].timestamp).toBe(res[i - 1].timestamp + STEP);
    }
  });

  it("дедуп пограничной свечи на стыке чанков", async () => {
    // адаптер отдаёт limit+1 свечу (одна лишняя на конце) → дубль на стыке
    const overlapping: GetCandles = async (_s, _i, limit, sDate) => {
      const since = sDate!;
      const out: ICandleData[] = [];
      for (let i = 0; i < (limit ?? 0) + 1; i++) {
        out.push({ timestamp: since + i * STEP, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      }
      return out;
    };
    const res = await fetchCandlesChunked(overlapping, "SOLUSDT", "1m", 1000, t0);
    const seen = new Set(res.map((c) => c.timestamp));
    expect(seen.size).toBe(res.length); // нет дублей
  });

  it("пустой чанк (край истории / дыра) → отдаёт собранное, не виснет", async () => {
    let call = 0;
    const truncating: GetCandles = async (_s, _i, limit, sDate) => {
      call++;
      if (call >= 2) return []; // второй чанк пуст
      const out: ICandleData[] = [];
      for (let i = 0; i < (limit ?? 0); i++) out.push({ timestamp: sDate! + i * STEP, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      return out;
    };
    const res = await fetchCandlesChunked(truncating, "FARTCOINUSDT", "1m", 2000, t0);
    expect(res.length).toBe(500); // только первый чанк
  });

  it("MAX_CANDLES_PER_CHUNK = 500", () => {
    expect(MAX_CANDLES_PER_CHUNK).toBe(500);
  });
});

describe("chunked — дедуп оставляет ПЕРВОЕ вхождение (авторитетное)", () => {
  const STEP = STEP_MS["1m"];
  it("дубль ts с разными данными → побеждает первая свеча, не последняя", async () => {
    // адаптер отдаёт дубль каждого чётного ts с битым объёмом ПОСЛЕ настоящего
    const dups: GetCandles = async (_s, _i, lim, sd) => {
      const out: ICandleData[] = [];
      for (let i = 0; i < (lim ?? 0); i++) {
        out.push({ timestamp: sd! + i * STEP, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
        if (i % 2 === 0) out.push({ timestamp: sd! + i * STEP, open: 100, high: 101, low: 99, close: 100, volume: 9999 }); // битый дубль
      }
      return out;
    };
    const r = await fetchCandlesChunked(dups, "X", "1m", 1000, t0, 500);
    const first = r.find((c) => c.timestamp === t0);
    expect(first!.volume).toBe(1000); // первая (настоящая), не битый дубль 9999
    // все ts уникальны
    expect(new Set(r.map((c) => c.timestamp)).size).toBe(r.length);
  });

  it("адаптер возвращает свечи в обратном порядке → результат отсортирован", async () => {
    const reversed: GetCandles = async (_s, _i, lim, sd) => {
      const out: ICandleData[] = [];
      for (let i = (lim ?? 0) - 1; i >= 0; i--) out.push({ timestamp: sd! + i * STEP, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      return out;
    };
    const r = await fetchCandlesChunked(reversed, "X", "1m", 1000, t0, 500);
    for (let i = 1; i < r.length; i++) expect(r[i].timestamp).toBeGreaterThan(r[i - 1].timestamp);
  });
});
