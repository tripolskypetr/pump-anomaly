import { ParserItem } from "./types";
import { GetCandles } from "./candle";
import { TrainOptions } from "./train";
import { walkForward, WalkForwardResult, WalkForwardOptions } from "./walk-forward";
import { minTrackRecordLength } from "./statistics";
import { withCandleCache } from "./chunked-candles";
import { PumpMatrix } from "./pump-matrix";

/**
 * ASSESS EDGE — операционный чеклист «можно ли этим торговать», автоматизированный.
 *
 * Раньше решение собиралось оператором из кусков: прогнать fit → посмотреть
 * certification → прогнать walkForward → сравнить certified-only срез → решить.
 * Теперь это ОДИН вызов с одним структурированным вердиктом:
 *
 *  - "trade"   — walk-forward OOS в режиме эксплуатации (только сертифицированные
 *                срезы) положителен, выборка ≥ minTRL, финальная модель на всей
 *                истории сертифицирована. Можно торговать малым риском.
 *  - "paper"   — эдж виден (OOS-медиана и Sharpe > 0), но доказательств не хватает:
 *                мало сделок (< minTRL), срезы не сертифицируются, или финальный
 *                сертификат красный. Торговать НА БУМАГЕ/микро и копить данные.
 *  - "no-edge" — OOS-цепочка не положительна. Не торговать; reasons говорят почему.
 *
 * Все пороги — уже существующие статистические инструменты (minTRL, сертификат,
 * walk-forward), никаких новых магических констант. reasons всегда объясняют
 * вердикт человеческим языком — решение проверяемо, а не оракульно.
 */

export type EdgeVerdict = "trade" | "paper" | "no-edge";

export interface EdgeAssessment {
  verdict: EdgeVerdict;
  /** человекочитаемые причины вердикта (что выполнено, чего не хватило) */
  reasons: string[];
  /** финальная модель, обученная на ВСЕЙ истории (её и деплоить при "trade") */
  model: PumpMatrix;
  /** полный walk-forward отчёт (кривая, просадка, срезы) — для аудита */
  walkForward: WalkForwardResult;
  /** минимальная длина трек-рекорда для значимости OOS-цепочки (Infinity при SR≤0) */
  minTRL: number;
  /** сколько OOS-сделок реально есть в оценивавшейся цепочке */
  oosTrades: number;
}

export interface AssessOptions {
  /** опции обучения (grid/costs/mode/…) — общие для срезов walk-forward и финального fit */
  trainOptions?: TrainOptions;
  /** опции walk-forward (slices/policy/embargo/…) */
  walkForward?: Omit<WalkForwardOptions, "trainOptions">;
}

export async function assessEdge(
  items: ParserItem[],
  getCandles: GetCandles,
  opts: AssessOptions = {},
): Promise<EdgeAssessment> {
  // один кэш свечей на walk-forward И финальный fit
  const gc = withCandleCache(getCandles, opts.walkForward?.cacheCapacity ?? 1024);

  const wf = await walkForward(items, gc, {
    ...opts.walkForward,
    trainOptions: opts.trainOptions,
  });

  // режим эксплуатации — «торгуем только когда сертификат зелёный»; если ни один
  // срез не сертифицировался, честно оцениваем всю OOS-цепочку, но до "trade"
  // такой вердикт не дотянется по построению.
  const certifiedMode = wf.certifiedOnly.slicesUsed > 0;
  const pnls = certifiedMode ? wf.certifiedOnly.oosPnls : wf.oosPnls;
  const stats = certifiedMode ? wf.certifiedOnly.stats : wf.stats;
  const sharpeOos = certifiedMode ? wf.certifiedOnly.sharpe : wf.sharpe;
  const minTRL = minTrackRecordLength(pnls);

  const reasons: string[] = [];
  reasons.push(certifiedMode
    ? `режим эксплуатации: ${wf.certifiedOnly.slicesUsed} сертифицированных срезов, ${pnls.length} OOS-сделок`
    : `ни один walk-forward срез не сертифицировался — оценка по всей OOS-цепочке (${pnls.length} сделок)`);

  // финальная модель на всей истории — её и деплоят при положительном вердикте
  const model = await PumpMatrix.fit(items, gc, {
    ...opts.trainOptions,
    ignoreCadence: true,
  });

  // ── решение ──
  let verdict: EdgeVerdict;
  const positive = pnls.length > 0 && stats.median > 0 && sharpeOos > 0;
  if (!positive) {
    verdict = "no-edge";
    if (pnls.length === 0) reasons.push("OOS-сделок нет — оценивать нечего");
    else {
      if (stats.median <= 0) reasons.push(`OOS-медиана ${(stats.median * 100).toFixed(3)}% ≤ 0 — эджа в цепочке нет`);
      if (sharpeOos <= 0) reasons.push(`OOS-Sharpe ${sharpeOos.toFixed(3)} ≤ 0`);
    }
  } else {
    const enough = pnls.length >= minTRL;
    const finalCertified = model.certification.certified;
    if (certifiedMode && enough && finalCertified) {
      verdict = "trade";
      reasons.push(`OOS-медиана +${(stats.median * 100).toFixed(3)}%/сделку, Sharpe ${sharpeOos.toFixed(3)}, N=${pnls.length} ≥ minTRL=${minTRL.toFixed(0)}`);
      reasons.push("финальная модель сертифицирована (DSR/PBO/SPA/minTRL/nested)");
    } else {
      verdict = "paper";
      reasons.push(`эдж виден: OOS-медиана +${(stats.median * 100).toFixed(3)}%/сделку, Sharpe ${sharpeOos.toFixed(3)}`);
      if (!certifiedMode) reasons.push("но срезы walk-forward не сертифицируются — режим эксплуатации не подтверждён");
      if (!enough) reasons.push(`но N=${pnls.length} < minTRL=${Number.isFinite(minTRL) ? minTRL.toFixed(0) : "∞"} — выборки мало`);
      if (!finalCertified) {
        reasons.push("но финальный сертификат красный:");
        for (const r of model.certification.reasons) reasons.push(`  ${r}`);
      }
      reasons.push("вердикт: бумага/микро-размер, копить форвард-данные до minTRL");
    }
  }

  return { verdict, reasons, model, walkForward: wf, minTRL, oosTrades: pnls.length };
}
