// ФОРВАРД-ЖУРНАЛ по MQL5-сигналам: замыкает петлю «прогноз → реальность».
//
// Использование:
//   1) скачайте свежие data/<id>.positions.csv с mql5.com (те же файлы, новее);
//   2) node scripts/mql5-paper.mjs
//
// Скрипт берёт позиции НОВЕЕ тех, на которых обучалась data/mql5-model.json,
// честно реплеит их выученным exit-планом по свечам Binance (не по отчёту
// провайдера!) и копит в PaperTrader-журнале data/paper-journal.json.
// CUSUM/KS сравнивают форвард с train-распределением: «дрейфа нет, копить ещё N»
// либо «СТОП, переобучиться». Журнал переживает перезапуски.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { getCandles } from "./binance-cache.mjs";
import { PumpMatrix, PaperTrader } from "../build/index.mjs";

const DATA = new URL("../data/", import.meta.url).pathname;
const HOUR = 3600_000;

// ── парсинг CSV + серверное время EET/EEST (откалибровано по ценам) ──
const SYMBOL_MAP = { BTCUSD: "BTCUSDT", "BTCUSD+": "BTCUSDT" };
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
const parseTs = (s) => {
  const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};
const items = [];
for (const f of readdirSync(DATA).filter((x) => x.endsWith(".positions.csv"))) {
  const channel = f.split(".")[0];
  for (const line of readFileSync(DATA + f, "utf8").replace(/^﻿/, "").split(/\r?\n/).slice(1)) {
    const c = line.split(";");
    if (c.length < 11) continue;
    const ts = parseTs(c[0].trim());
    const symbol = SYMBOL_MAP[c[3].trim()];
    const dir = c[1].trim().toLowerCase();
    if (!ts || !symbol || (dir !== "buy" && dir !== "sell")) continue;
    items.push({ channel, symbol, direction: dir === "buy" ? "long" : "short", ts: toUtc(ts) });
  }
}
// дедуп (частичные закрытия MQL5 пишут открытие дважды)
const seen = new Set();
const unique = items.filter((it) => {
  const k = `${it.channel}|${it.symbol}|${it.direction}|${it.ts}`;
  return seen.has(k) ? false : (seen.add(k), true);
});

// ── модель + граница обучения ──
const model = PumpMatrix.load(readFileSync(`${DATA}/mql5-model.json`, "utf8"));
const trained = JSON.parse(readFileSync(`${DATA}/mql5-items-dedup.json`, "utf8"));
const cutoff = Math.max(...trained.map((x) => x.ts));
console.log(`граница обучения: ${new Date(cutoff).toISOString()}`);

// ── форвард: только посты НОВЕЕ обучения и ещё не в журнале ──
const journalFile = `${DATA}/paper-journal.json`;
const pt = existsSync(journalFile)
  ? PaperTrader.load(readFileSync(journalFile, "utf8"), model)
  : new PaperTrader(model);
const recorded = new Set(pt.trades.map((t) => `${t.channel}|${t.ts}`));
const fresh = unique
  .filter((it) => it.ts > cutoff && !recorded.has(`${it.channel}|${it.ts}`))
  .sort((a, b) => a.ts - b.ts);
console.log(`новых постов после границы: ${fresh.length}`);

if (fresh.length > 0) {
  // честный реплей выученным exit-планом по свечам Binance (сигналы, прошедшие
  // обученные гейты; незакрытые/усечённые горизонты отбрасываются)
  const sigs = await model.backtest(fresh, getCandles, { acknowledgeUncertified: true });
  let added = 0;
  for (const s of sigs) {
    if (!s.result.entered || s.result.truncated) continue;
    pt.record({ ts: s.ts, pnl: s.result.pnl, symbol: s.symbol, channel: s.origin.channel ?? undefined });
    added++;
  }
  console.log(`сигналов прошло гейты: ${sigs.length}, записано сделок: ${added}`);
  writeFileSync(journalFile, pt.save());
}

// ── вердикт монитора ──
const st = pt.status();
console.log(`\nфорвард: ${st.n} сделок (baseline: ${st.baselineN})`);
console.log(`средняя: форвард ${(st.meanForward * 100).toFixed(3)}% vs train ${(st.meanBaseline * 100).toFixed(3)}%`);
console.log(`CUSUM: ${st.cusum.stat}σ / порог ${st.cusum.threshold}σ${st.cusum.fired ? " — СРАБОТАЛ" : ""}`);
console.log(`KS: ${st.ks ? `p=${st.ks.pValue}${st.ks.fired ? " — СРАБОТАЛ" : ""}` : "ждёт ≥10 сделок"}`);
if (st.tradesToSignificance !== null) console.log(`до значимости форвард-цепочки: ещё ~${st.tradesToSignificance} сделок`);
console.log(`\n${st.alarm ? "ТРЕВОГА" : "ok"}: ${st.recommendation}`);
