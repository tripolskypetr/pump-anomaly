// v2: дедуп + single-режим + калиброванные оси выхода. Casual-грид с 12 детектор-
// комбо породил 89552 кандидата и 4GB-OOM; здесь кандидаты = уникальные позиции.
import { readFileSync, writeFileSync } from "node:fs";
import { getCandles, requestCount } from "./binance-cache.mjs";
import {
  train, calibrateGrid, DEFAULT_GRID, PumpMatrix,
} from "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/build/index.mjs";

const DATA = "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/data";

// серверное время брокера = EET/EEST (откалибровано по ценам против Binance)
const HOUR = 3600_000;
const lastSunday = (y, m) => {
  const d = new Date(Date.UTC(y, m + 1, 0));
  return Date.UTC(y, m + 1, 0 - d.getUTCDay(), 1, 0, 0);
};
const toUtc = (serverTs) => {
  const approx = serverTs - 2 * HOUR;
  const y = new Date(approx).getUTCFullYear();
  const dst = approx >= lastSunday(y, 2) && approx < lastSunday(y, 9);
  return serverTs - (dst ? 3 : 2) * HOUR;
};
const raw = JSON.parse(readFileSync(`${DATA}/mql5-positions.json`, "utf8"))
  .map((p) => ({ channel: p.channel, symbol: p.symbol, direction: p.direction, ts: toUtc(p.ts) }));

// дедуп: частичные закрытия MQL5 пишут одно ОТКРЫТИЕ дважды (2773 дубля)
const seen = new Set();
const items = raw.filter((it) => {
  const k = `${it.channel}|${it.symbol}|${it.direction}|${it.ts}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
console.log(`items: ${raw.length} → ${items.length} после дедупа`);

// оси выхода — из данных (шум 1m, покрытие, спред), не из головы
const cal = await calibrateGrid(items, getCandles, {
  staleMinutes: DEFAULT_GRID.staleMinutes,
  stalenessSinceMinutes: DEFAULT_GRID.stalenessSinceMinutes,
});
console.log("калибровка:", JSON.stringify({ noisePct: cal.noisePct, spreadPct: cal.spreadPct, coverage: cal.forwardCoverageMinutes }));
console.log("оси:", JSON.stringify(cal.axes));
console.log("reason:", cal.reason);

// издержки среды: 2×такер спота (0.1%) + измеренный спред
const roundTripCostPct = +(2 * 0.1 + (cal.spreadPct ?? 0.01)).toFixed(4);
console.log("roundTripCostPct:", roundTripCostPct);

const grid = {
  ...DEFAULT_GRID,
  // один символ, 10 провайдеров: каждый пост = кандидат; детекторные оси не переберём
  windowK: [3], jaccardThreshold: [0.3], lagPeakThreshold: [0.5], minClusters: [1],
  stationarityWindowMs: [Infinity],
  ...cal.axes,
};
console.log("exit-сеты ≈", ["trailingTake", "hardStop", "stalenessSinceProfit", "stalenessSinceMinutes", "staleMinutes", "volZThreshold", "squeezePolicy", "squeezeThreshold", "volBaselineWindow", "cascadeWindowMinutes"]
  .map((k) => `${k}:${(grid[k] ?? []).length}`).join(" "));

const t0 = Date.now();
const res = await train(items, getCandles, {
  mode: "single",
  grid,
  roundTripCostPct,
  marketSymbol: null, // бенчмарк BTCUSDT для сигналов по BTCUSDT — тавтология
  labelConcurrency: 8,
  onProgress: (e) => {
    if (e.done % 1000 === 0 || e.done === e.total) {
      console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}м] ${e.phase} ${e.done}/${e.total} ${e.label}`);
    }
  },
});
console.log(`\nfit занял ${((Date.now() - t0) / 60000).toFixed(1)} мин, запросов: ${requestCount()}`);

const model = PumpMatrix.load(res.params);
writeFileSync(`${DATA}/mql5-model.json`, model.save());
writeFileSync(`${DATA}/mql5-items-dedup.json`, JSON.stringify(items));

console.log("\n── ОТЧЁТ ──");
console.log(model.report());
console.log("\nрежим:", res.params.meta.mode, "|", res.params.meta.modeReason);
console.log("выбранный exit:", JSON.stringify(res.params.exit.global));
console.log("momentum-гейт:", JSON.stringify({ pct: res.params.policy.minMomentum24hPct ?? null, win: res.params.policy.momentumWindowMinutes ?? null }));
console.log("pnl.global:", JSON.stringify(res.params.pnl.global));
console.log("riskReward.global:", JSON.stringify(res.params.riskReward.global));
console.log("сертификат:", JSON.stringify(res.params.meta.certification));
console.log("labeling:", JSON.stringify(res.params.meta.labeling.outcomes), "errors:", JSON.stringify(res.params.meta.labeling.errors));

console.log("\n── каналы (score = shrinkage-expectancy нетто) ──");
const ranked = Object.entries(res.params.channelScore ?? {}).sort((a, b) => b[1].score - a[1].score);
for (const [ch, s] of ranked) {
  const plan = res.params.channelPlan?.[ch] ?? "follow";
  console.log(`${ch}: score=${(s.score * 100).toFixed(3)}% median=${(s.median * 100).toFixed(3)}% n=${s.n} winRate=${((s.winRate ?? 0) * 100).toFixed(0)}% algo=${s.algoScore?.toFixed(2)} → ${plan}`);
}
console.log("\nмодель исхода:", res.params.outcome
  ? `informative=${res.params.outcome.informative} признаки=[${Object.keys(res.params.outcome.features).join(",")}] категориальные=[${Object.keys(res.params.outcome.categoricals ?? {}).join(",")}] prior=${res.params.outcome.prior} meanWin=${res.params.outcome.meanWin} meanLoss=${res.params.outcome.meanLoss}`
  : "null");
