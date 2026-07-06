/**
 * Слой 8 — АЛГОРИТМИЧЕСКАЯ СИГНАТУРА канала (формализация habr 1028592).
 *
 * В исследовании алгоритмическое происхождение сигналов выдали механические
 * паттерны: решётка интервалов между постами (одинаковые множители) и посты по
 * расписанию. Такой канал — не человек с инсайтом, а бот-стратегия, и его
 * сигналы часто анти-предиктивны (стоп-хант: 8/8 шортов TRX двинулись против) —
 * кандидат на ИНВЕРСИЮ, а не на следование.
 *
 * Две интерпретируемые компоненты, обе ∈ [0,1]:
 *  - intervalRegularity: 1 − нормированная энтропия лог-гистограммы интервалов
 *    между постами. Метроном → энтропия 0 → регулярность 1; человеческий поток
 *    (широкое распределение) → регулярность ≈ 0.
 *  - modalHourShare*: доля постов в модальном часе суток (UTC), нормированная
 *    от фона 1/24 к 1. Бот на cron постит в одно время; человек размазан.
 *
 * algoScore = max(компонент): любой ОДИН механический паттерн — уже сигнатура.
 * n < 8 → algoScore 0 (не судим по паре постов). Это ДИАГНОСТИКА (advisory):
 * сериализуется в channelScore, решение «инвертировать/выкинуть канал» — за
 * оператором, у которого есть контекст.
 */

export interface AlgoSignature {
  /** итоговое подозрение на алгоритмическое происхождение, 0..1 */
  algoScore: number;
  /** регулярность интервалов (1 = метроном/решётка) */
  intervalRegularity: number;
  /** концентрация по часу суток, нормированная (1 = все посты в один час) */
  modalHourConcentration: number;
  /** по скольким постам судим */
  n: number;
}

const BINS = 12;

export function algoSignatureOf(postTs: number[]): AlgoSignature {
  const ts = [...postTs].sort((a, b) => a - b);
  const n = ts.length;
  if (n < 8) return { algoScore: 0, intervalRegularity: 0, modalHourConcentration: 0, n };

  // ── регулярность интервалов: энтропия лог-гистограммы ──
  const intervals: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) intervals.push(d);
  }
  let intervalRegularity = 0;
  if (intervals.length >= 4) {
    const logs = intervals.map((d) => Math.log(d));
    const lo = Math.min(...logs);
    const hi = Math.max(...logs);
    if (hi - lo < 1e-9) {
      intervalRegularity = 1; // все интервалы одинаковы — чистый метроном
    } else {
      const hist = new Array(BINS).fill(0);
      for (const l of logs) {
        let b = Math.floor(((l - lo) / (hi - lo)) * BINS);
        if (b >= BINS) b = BINS - 1;
        hist[b]++;
      }
      let H = 0;
      for (const h of hist) {
        if (h > 0) {
          const p = h / logs.length;
          H -= p * Math.log(p);
        }
      }
      const Hmax = Math.log(Math.min(BINS, logs.length));
      intervalRegularity = Hmax > 0 ? Math.max(0, 1 - H / Hmax) : 0;
    }
  }

  // ── концентрация по часу суток: бот на cron постит в одно и то же время ──
  const hourCount = new Array(24).fill(0);
  for (const t of ts) hourCount[new Date(t).getUTCHours()]++;
  const modalShare = Math.max(...hourCount) / n;
  const modalHourConcentration = Math.max(0, (modalShare - 1 / 24) / (1 - 1 / 24));

  return {
    algoScore: +Math.max(intervalRegularity, modalHourConcentration).toFixed(6),
    intervalRegularity: +intervalRegularity.toFixed(6),
    modalHourConcentration: +modalHourConcentration.toFixed(6),
    n,
  };
}
