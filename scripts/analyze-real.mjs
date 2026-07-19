// Реальные данные MQL5 → casual-путь библиотеки: inspectItems → fit (autopilot) → отчёт.
import { readFileSync, writeFileSync } from "node:fs";
import { getCandles, requestCount } from "./binance-cache.mjs";
import { train, inspectItems, PumpMatrix } from "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/build/index.mjs";

const HOUR = 3600_000;
const DATA = "/Users/tripolskypetr/Documents/GitHub/pump-anomaly/data";

// ── EET/EEST (европейский DST): смещение сервера брокера, откалибровано по ценам ──
const lastSunday = (y, m) => { // m: 0-based; последнее воскресенье месяца, 01:00 UTC
  const d = new Date(Date.UTC(y, m + 1, 0));
  return Date.UTC(y, m + 1, 0 - d.getUTCDay(), 1, 0, 0);
};
const serverOffset = (utcApprox) => {
  const y = new Date(utcApprox).getUTCFullYear();
  const dst = utcApprox >= lastSunday(y, 2) && utcApprox < lastSunday(y, 9);
  return (dst ? 3 : 2) * HOUR;
};
const toUtc = (serverTs) => serverTs - serverOffset(serverTs - 2 * HOUR);

const raw = JSON.parse(readFileSync(`${DATA}/mql5-positions.json`, "utf8"));
const items = raw.map((p) => ({
  channel: p.channel, symbol: p.symbol, direction: p.direction, ts: toUtc(p.ts),
}));

// длительности удержания провайдеров — ориентир для импакт-горизонта
const holds = raw.filter((p) => p.closeTs).map((p) => (p.closeTs - p.ts) / 60000).sort((a, b) => a - b);
const q = (arr, p) => arr[Math.floor(arr.length * p)];
console.log(`удержание, мин: p25=${q(holds, 0.25).toFixed(0)} p50=${q(holds, 0.5).toFixed(0)} p75=${q(holds, 0.75).toFixed(0)} p90=${q(holds, 0.9).toFixed(0)}`);

console.log("\n── inspectItems ──");
console.log(JSON.stringify(inspectItems(items), null, 2));

console.log("\n── fit (casual autopilot: авто-калибровка, авто-издержки, триаж) ──");
const t0 = Date.now();
let lastLine = "";
const res = await train(items, getCandles, {
  takerFeePct: 0.1, // спот Binance; авто-cost добавит измеренный спред
  labelConcurrency: 8,
  onProgress: (e) => {
    const line = `${e.phase} ${e.done}/${e.total}`;
    if (line !== lastLine && (e.done % 500 === 0 || e.done === e.total)) {
      console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}м] ${line} ${e.label}`);
      lastLine = line;
    }
  },
});
console.log(`\nfit занял ${((Date.now() - t0) / 60000).toFixed(1)} мин, запросов к Binance: ${requestCount()}`);

const model = PumpMatrix.load(res.params);
writeFileSync(`${DATA}/mql5-model.json`, model.save());
writeFileSync(`${DATA}/mql5-items.json`, JSON.stringify(items));

console.log("\n── ОТЧЁТ ──");
console.log(model.report());
console.log("\nкалибровка:", JSON.stringify(res.params.meta.calibration));
console.log("\nрежим:", res.params.meta.mode, "|", res.params.meta.modeReason);
console.log("издержки в метках, % за круг:", res.params.exit.global.roundTripCostPct);
console.log("выбранный exit:", JSON.stringify(res.params.exit.global));
console.log("pnl.global:", JSON.stringify(res.params.pnl.global));
console.log("сертификат:", JSON.stringify(res.params.meta.certification));
console.log("labeling:", JSON.stringify(res.params.meta.labeling.outcomes), "errors:", JSON.stringify(res.params.meta.labeling.errors));

console.log("\n── каналы (score = shrinkage-expectancy нетто) ──");
const ranked = Object.entries(res.params.channelScore ?? {}).sort((a, b) => b[1].score - a[1].score);
for (const [ch, s] of ranked) {
  const plan = res.params.channelPlan?.[ch] ?? "follow";
  console.log(`${ch}: score=${(s.score * 100).toFixed(3)}% median=${(s.median * 100).toFixed(3)}% n=${s.n} winRate=${(s.winRate * 100 ?? 0).toFixed(0)}% algo=${s.algoScore?.toFixed(2)} → ${plan}`);
}
console.log("\nмодель исхода:", res.params.outcome
  ? `informative=${res.params.outcome.informative} признаки=[${Object.keys(res.params.outcome.features).join(",")}] категориальные=[${Object.keys(res.params.outcome.categoricals ?? {}).join(",")}] prior=${res.params.outcome.prior}`
  : "null");
