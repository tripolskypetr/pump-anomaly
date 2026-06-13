/**
 * Прогрессбар обучения. Train делает вложенные циклы: фаза разметки (медленная,
 * каждый кандидат = await getCandles по 1m-свечам) и фаза grid-скоринга (быстрая,
 * чистый CPU по кэшу). Бар отражает РЕАЛЬНУЮ работу — тики разметки, где идёт IO.
 *
 * Передаётся в train как опция onProgress; по умолчанию пишет в stdout в стиле,
 * заданном пользователем. В тестах подменяется на no-op или сборщик, чтобы не
 * засорять вывод.
 */

const BAR_LENGTH = 30;
const BAR_FILLED_CHAR = "\u2588";
const BAR_EMPTY_CHAR = "\u2591";
/** \u0424\u0438\u043a\u0441. \u0448\u0438\u0440\u0438\u043d\u0430 \u0441\u0442\u0440\u043e\u043a\u0438 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441\u0430: \u0431\u0430\u0440(30) + \u043f\u0440\u043e\u0446\u0435\u043d\u0442\u044b/\u0441\u0447\u0451\u0442\u0447\u0438\u043a/\u0444\u0430\u0437\u0430 + \u043c\u0435\u0442\u043a\u0430-\u0442\u0438\u043a\u0435\u0440. */
const LINE_WIDTH = 80;

export interface ProgressEvent {
  /** сколько единиц обработано */
  done: number;
  /** всего единиц в текущей фазе */
  total: number;
  /** метка фазы: "label" (разметка свечами) | "score" (grid-скоринг) */
  phase: "label" | "score" | "nested";
  /** что сейчас обрабатывается (символ/ключ кластеризации) — для контекста */
  label: string;
}

export type ProgressFn = (e: ProgressEvent) => void;

/** Дефолтный stdout-бар в стиле пользователя. */
export const stdoutProgress: ProgressFn = (e) => {
  if (e.total <= 0) return;
  const ratio = Math.min(e.done / e.total, 1);
  const percent = Math.round(ratio * 100);
  const filled = Math.round(ratio * BAR_LENGTH);
  const empty = BAR_LENGTH - filled;
  const bar = BAR_FILLED_CHAR.repeat(filled) + BAR_EMPTY_CHAR.repeat(empty);
  // фикс. ширина: pad пробелами + slice. Иначе при более короткой новой метке
  // (SOLUSDT после FARTCOINUSDT) \r не стирает хвост → "BTCUSDTTUSDT".
  const line = `[${bar}] ${percent}% (${e.done}/${e.total}) ${e.phase} ${e.label}`;
  process.stdout.write("\r" + line.padEnd(LINE_WIDTH).slice(0, LINE_WIDTH));
  if (e.done >= e.total) process.stdout.write("\n");
};

/** No-op для тестов/тихого режима. */
export const silentProgress: ProgressFn = () => {};
