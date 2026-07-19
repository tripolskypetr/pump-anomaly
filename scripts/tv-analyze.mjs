#!/usr/bin/env node
/**
 * Полный прогон библиотеки на архиве TradingView-идей (ts ≥ 2022-01-01):
 * калибровка осей → fit (mode auto: авторов много — matrix возможен) → отчёт.
 * Свечи — дисковый день-кэш Binance (scripts/binance-cache.mjs).
 */
import { writeFileSync } from "node:fs";
import { getCandles, requestCount, prefetchDays, daysForRange } from "./binance-cache.mjs";
import { loadTvItems } from "./tv-items.mjs";
import { train, calibrateGrid, DEFAULT_GRID, PumpMatrix, inspectItems } from "../build/index.mjs";

const DATA = new URL("../data/", import.meta.url).pathname;
const FROM = Date.UTC(2022, 0, 1);

const { items: all, dropped } = await loadTvItems();
const items = all.filter((it) => it.ts >= FROM);
console.log(`items: ${all.length} всего, ${items.length} с 2022-01-01 | отсев:`, JSON.stringify(dropped));
console.log("inspect:", JSON.stringify(inspectItems(items)));

const cal = await calibrateGrid(items, getCandles, {
  staleMinutes: DEFAULT_GRID.staleMinutes,
  stalenessSinceMinutes: DEFAULT_GRID.stalenessSinceMinutes,
});
console.log("калибровка:", JSON.stringify({ noisePct: cal.noisePct, spreadPct: cal.spreadPct, coverage: cal.forwardCoverageMinutes }));
console.log("оси:", JSON.stringify(cal.axes));
const roundTripCostPct = +(2 * 0.1 + (cal.spreadPct ?? 0.02)).toFixed(4);
console.log("roundTripCostPct:", roundTripCostPct);

const grid = {
  ...DEFAULT_GRID,
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1, 2],
  stationarityWindowMs: [Infinity],
  ...cal.axes,
};

// ── ФАЗА 1: ПРЕФЕТЧ — все свечи скачиваются ДО математики ──
// Разметка с холодным кэшем перемежает IO и CPU (воркеры ждут сеть, процессор
// простаивает). Считаем полный набор (symbol, день) под окна разметки:
// назад — momentum/пре-фичи (1440м) и фон BTC, вперёд — жизнь метки (2·stale+5).
const MIN_MS = 60_000;
const staleMax = Math.max(...grid.staleMinutes);
const momBack = 1440 + 5;
const pairs = [];
for (const it of items) {
  pairs.push(...daysForRange(it.symbol, it.ts - momBack * MIN_MS, it.ts + (2 * staleMax + 5) * MIN_MS));
  pairs.push(...daysForRange("BTCUSDT", it.ts - momBack * MIN_MS, it.ts)); // market-фон
}
const tPre = Date.now();
const pre = await prefetchDays(pairs, {
  concurrency: 12,
  onProgress: (d, total) => console.log(`[префетч ${((Date.now() - tPre) / 60000).toFixed(1)}м] ${d}/${total} дней (req=${requestCount()})`),
});
console.log(`префетч: ${pre.days} (symbol,день)-пар за ${((Date.now() - tPre) / 60000).toFixed(1)} мин; битые символы: ${pre.failedSymbols.length ? pre.failedSymbols.join(",") : "нет"}`);

// ── ФАЗА 2: МАТЕМАТИКА — по горячему кэшу, без сетевых ожиданий ──
const t0 = Date.now();
const res = await train(items, getCandles, {
  grid, // mode auto: viability сама решит matrix vs single
  roundTripCostPct,
  labelConcurrency: 8,
  onProgress: (e) => {
    if (e.done % 2000 === 0 || e.done === e.total) {
      console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}м] ${e.phase} ${e.done}/${e.total} ${e.label} (req=${requestCount()})`);
    }
  },
});
console.log(`\nfit занял ${((Date.now() - t0) / 60000).toFixed(1)} мин, запросов: ${requestCount()}`);

const model = PumpMatrix.load(res.params);
writeFileSync(`${DATA}tv-model.json`, model.save());
writeFileSync(`${DATA}tv-items-used.json`, JSON.stringify(items));

console.log("\n── ОТЧЁТ ──");
console.log(model.report());
console.log("\nрежим:", res.params.meta.mode, "|", res.params.meta.modeReason);
console.log("выбранный exit:", JSON.stringify(res.params.exit.global));
console.log("momentum-гейт:", JSON.stringify({ pct: res.params.policy.minMomentum24hPct ?? null, win: res.params.policy.momentumWindowMinutes ?? null }));
console.log("pnl.global:", JSON.stringify(res.params.pnl.global));
console.log("сертификат:", JSON.stringify(res.params.meta.certification));
console.log("labeling:", JSON.stringify(res.params.meta.labeling.outcomes));
const errs = Object.entries(res.params.meta.labeling.errors ?? {}).slice(0, 5);
if (errs.length) console.log("errors(топ):", JSON.stringify(errs));

console.log("\n── топ-каналы (n ≥ 10) ──");
const ranked = Object.entries(res.params.channelScore ?? {})
  .filter(([, s]) => s.n >= 10)
  .sort((a, b) => b[1].score - a[1].score);
for (const [ch, s] of ranked.slice(0, 15)) {
  console.log(`@${ch}: score=${(s.score * 100).toFixed(3)}% median=${(s.median * 100).toFixed(3)}% n=${s.n} wr=${((s.winRate ?? 0) * 100).toFixed(0)}% algo=${s.algoScore?.toFixed(2)} → ${res.params.channelPlan?.[ch] ?? "follow"}`);
}
console.log(`...каналов со статистикой (n≥10): ${ranked.length}`);
const plan = res.params.channelPlan ?? {};
console.log(`триаж: drop=${Object.values(plan).filter((x) => x === "drop").length} invert=${Object.values(plan).filter((x) => x === "invert").length}`);
console.log("\nмодель исхода:", res.params.outcome
  ? `informative=${res.params.outcome.informative} признаки=[${Object.keys(res.params.outcome.features).join(",")}] категориальные=[${Object.keys(res.params.outcome.categoricals ?? {}).join(",")}]`
  : "null");
