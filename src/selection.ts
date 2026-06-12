import { ExitParams } from "./replay";

/**
 * Параметры выбора конфигурации и валидации. Вынесены в одно место, чтобы в логике
 * train не было магических литералов — каждое число здесь именовано и объяснено.
 */
export interface SelectionConfig {
  /** множитель SE для коридора one-standard-error (1 = классический Breiman) */
  seMultiplier: number;
  /** число внешних фолдов nested-CV для несмещённой оценки (0 = не делать nested) */
  nestedOuterFolds: number;
}

export const DEFAULT_SELECTION: SelectionConfig = {
  seMultiplier: 1,
  nestedOuterFolds: 4,
};

/**
 * Порядок агрессии реакции на каскад: чем выше, тем агрессивнее вмешательство.
 * none (просто вход) < tighten (ужать) < veto (не входить) < invert (развернуться).
 * Используется как ось консервативности: при near-tie выбираем менее агрессивную.
 */
export const CASCADE_AGGRESSION: Record<string, number> = {
  none: 0,
  tighten: 1,
  veto: 2,
  invert: 3,
};

export const cascadeAggressionOf = (policy: string | undefined): number =>
  CASCADE_AGGRESSION[policy ?? "none"] ?? CASCADE_AGGRESSION.none;

/**
 * Ключ консервативности exit-конфигурации для one-standard-error tie-break.
 * Лексикографический порядок (меньше = консервативнее):
 *   1) hardStop          — меньший риск на сделку
 *   2) staleMinutes      — короче экспозиция
 *   3) cascade aggression— мягче вмешательство в каскад
 *   4) -cvScore          — при полном равенстве выше score (детерминизм)
 *
 * `score` передаётся отдельно, т.к. ExitParams его не содержит.
 */
export function conservatismKey(exit: ExitParams, cvScore: number): number[] {
  return [
    exit.hardStop,
    exit.staleMinutes,
    cascadeAggressionOf(exit.squeezePolicy),
    -cvScore,
  ];
}

/** Сравнение «a консервативнее b» по лексикографическому ключу (true → предпочесть a). */
export function isMoreConservative(
  a: { exit: ExitParams; cvScore: number },
  b: { exit: ExitParams; cvScore: number },
): boolean {
  const ka = conservatismKey(a.exit, a.cvScore);
  const kb = conservatismKey(b.exit, b.cvScore);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return true;
    if (ka[i] > kb[i]) return false;
  }
  return false;
}
