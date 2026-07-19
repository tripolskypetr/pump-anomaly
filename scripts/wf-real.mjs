// Walk-forward на реальных MQL5-данных (кэш свечей уже прогрет первым fit).
import { readFileSync, writeFileSync } from "node:fs";
import { getCandles } from "./binance-cache.mjs";
import { walkForward } from "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/build/index.mjs";

const DATA = "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/data";
const items = JSON.parse(readFileSync(`${DATA}/mql5-items.json`, "utf8"));

const t0 = Date.now();
const wf = await walkForward(items, getCandles, {
  slices: 3,
  maxConcurrentPositions: 2, // честная ёмкость: 2 слота капитала
  policy: { acknowledgeUncertified: true },
  trainOptions: {
    takerFeePct: 0.1,
    labelConcurrency: 8,
    onProgress: () => {},
  },
});
console.log(`walkForward занял ${((Date.now() - t0) / 60000).toFixed(1)} мин`);

for (const s of wf.slices) {
  const med = [...s.pnls].sort((a, b) => a - b)[Math.floor(s.pnls.length / 2)] ?? 0;
  console.log(`срез до ${new Date(s.trainUntil).toISOString().slice(0, 10)}: ` +
    `train=${s.nTrain} test=${s.nTest} вошло=${s.entered} медиана=${(med * 100).toFixed(3)}% ` +
    `cert=${s.certifiedOnTrain} conf=${s.confidenceOnTrain.toFixed(2)}`);
}
console.log("\nOOS-цепочка:", wf.oosPnls.length, "сделок");
console.log("stats:", JSON.stringify(wf.stats));
console.log("sharpe:", wf.sharpe, "maxDrawdown:", (wf.maxDrawdown * 100).toFixed(1) + "%");
console.log("certifiedOnly:", JSON.stringify({ n: wf.certifiedOnly.oosPnls.length, stats: wf.certifiedOnly.stats, sharpe: wf.certifiedOnly.sharpe, slices: wf.certifiedOnly.slicesUsed }));
console.log("\nкапитал (2 слота):", JSON.stringify({
  demandPeak: wf.capital.demandPeak, taken: wf.capital.taken, skipped: wf.capital.skipped,
  sumConstrained: +(wf.capital.sumConstrained * 100).toFixed(1) + "%",
  sumUnconstrained: +(wf.capital.sumUnconstrained * 100).toFixed(1) + "%",
}));
writeFileSync(`${DATA}/mql5-walkforward.json`, JSON.stringify({
  slices: wf.slices.map(({ pnls, ...rest }) => ({ ...rest, n: pnls.length })),
  stats: wf.stats, sharpe: wf.sharpe, maxDrawdown: wf.maxDrawdown,
  certifiedOnly: { ...wf.certifiedOnly, oosPnls: undefined },
  capital: wf.capital, oosPnls: wf.oosPnls,
}));
