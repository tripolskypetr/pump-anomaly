#!/usr/bin/env node
/**
 * Честная валидация TV-эджа: walk-forward (3 хронологических среза) + плацебо
 * (та же машина на постах со сдвинутым временем). Двухфазно: префетч недостающих
 * дней (плацебо сдвигает посты на 3-14 дней назад — их окна не были скачаны) →
 * математика по горячему кэшу.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getCandles, requestCount, prefetchDays, daysForRange } from "./binance-cache.mjs";
import { walkForward, placeboItems, calibrateGrid, DEFAULT_GRID } from "../build/index.mjs";

const DATA = new URL("../data/", import.meta.url).pathname;
const MIN_MS = 60_000;
const items = JSON.parse(readFileSync(`${DATA}tv-items-used.json`, "utf8"));
const placebo = placeboItems(items);

const cal = await calibrateGrid(items, getCandles, {
  staleMinutes: DEFAULT_GRID.staleMinutes,
  stalenessSinceMinutes: DEFAULT_GRID.stalenessSinceMinutes,
});
const grid = {
  ...DEFAULT_GRID,
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1, 2],
  stationarityWindowMs: [Infinity],
  ...cal.axes,
};
const roundTripCostPct = +(2 * 0.1 + (cal.spreadPct ?? 0.02)).toFixed(4);
const trainOptions = {
  grid, roundTripCostPct, marketSymbol: null, labelConcurrency: 8, onProgress: () => {},
};

// ── префетч покрытия ОБЕИХ веток (реальная уже на диске — пролетит) ──
const staleMax = Math.max(...grid.staleMinutes);
const momBack = 1440 + 5;
const pairs = [];
for (const set of [items, placebo]) {
  for (const it of set) {
    pairs.push(...daysForRange(it.symbol, it.ts - momBack * MIN_MS, it.ts + (2 * staleMax + 5) * MIN_MS));
  }
}
const tPre = Date.now();
await prefetchDays(pairs, {
  concurrency: 12,
  onProgress: (d, total) => { if (d % 2000 === 0 || d === total) console.log(`[префетч ${((Date.now() - tPre) / 60000).toFixed(1)}м] ${d}/${total} (req=${requestCount()})`); },
});
console.log(`префетч закончен за ${((Date.now() - tPre) / 60000).toFixed(1)} мин`);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const runWf = async (label, its) => {
  const t0 = Date.now();
  const wf = await walkForward(its, getCandles, {
    slices: 3,
    maxConcurrentPositions: 2,
    policy: { acknowledgeUncertified: true },
    trainOptions,
  });
  console.log(`\n── ${label}: ${((Date.now() - t0) / 60000).toFixed(1)} мин ──`);
  for (const s of wf.slices) {
    console.log(`срез до ${new Date(s.trainUntil).toISOString().slice(0, 10)}: train=${s.nTrain} test=${s.nTest} вошло=${s.entered} медиана=${(med(s.pnls) * 100).toFixed(3)}% сумма=${(s.pnls.reduce((a, b) => a + b, 0) * 100).toFixed(1)}% cert=${s.certifiedOnTrain}`);
  }
  console.log(`OOS: ${wf.oosPnls.length} сделок | медиана=${(wf.stats.median * 100).toFixed(3)}% mean=${(wf.stats.mean * 100).toFixed(3)}% p5=${(wf.stats.p5 * 100).toFixed(2)}% sharpe=${wf.sharpe.toFixed(3)} dd=${(wf.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`капитал(2 слота): пик спроса=${wf.capital.demandPeak} пропущено=${wf.capital.skipped}/${wf.capital.taken + wf.capital.skipped} сумма=${(wf.capital.sumConstrained * 100).toFixed(1)}% (без лимита ${(wf.capital.sumUnconstrained * 100).toFixed(1)}%)`);
  return wf;
};

const real = await runWf("РЕАЛЬНЫЕ ПОСТЫ", items);
const plc = await runWf("ПЛАЦЕБО (время уничтожено)", placebo);

const beats = real.stats.median > plc.stats.median && real.sharpe > plc.sharpe;
console.log(`\n════ beatsPlacebo=${beats} ════`);
console.log(`медиана: реальные ${(real.stats.median * 100).toFixed(3)}% vs плацебо ${(plc.stats.median * 100).toFixed(3)}%`);
console.log(`sharpe:  реальные ${real.sharpe.toFixed(3)} vs плацебо ${plc.sharpe.toFixed(3)}`);
writeFileSync(`${DATA}tv-validation.json`, JSON.stringify({
  real: { stats: real.stats, sharpe: real.sharpe, n: real.oosPnls.length, maxDrawdown: real.maxDrawdown, capital: real.capital },
  placebo: { stats: plc.stats, sharpe: plc.sharpe, n: plc.oosPnls.length },
  beats,
}));
