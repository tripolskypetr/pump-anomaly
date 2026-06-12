import { ExitParams } from "./replay";
import { Direction } from "./types";
import { VolRegime } from "./volume";

/**
 * Tensor exit-параметров: mode → channel → symbol → direction → volRegime → ExitParams.
 *
 * Математика выхода НЕ смешивается между источниками: каждая ячейка обучается
 * только на своих replay-результатах. Каскад ликвидаций симметричен, но long-trap
 * и short-trap получают РАЗНЫЕ ячейки (разная динамика разворота), и режим объёма
 * (calm/anomalous) тоже разделён — short в аномальном объёме это накопленное
 * топливо для сквиза, exit там должен быть туже.
 *
 * Иерархический fallback при пустой ячейке:
 *   [mode][channel][symbol][direction][volRegime]
 *     → схлопнуть volRegime: [mode][channel][symbol][direction]
 *     → схлопнуть direction: [mode][channel][symbol]
 *     → [mode]  →  global
 */

type RegimeCell = Partial<Record<VolRegime, ExitParams>>;
type DirCell = Partial<Record<Direction, RegimeCell>>;
type SymbolCell = Record<string, DirCell>;
type ChannelCell = Record<string, SymbolCell>;

export interface ExitTensor {
  cells: {
    matrix: ChannelCell;
    single: ChannelCell;
  };
  /** уровень символа+направления (схлопнут volRegime) */
  bySymbolDir: {
    matrix: Record<string, Partial<Record<Direction, ExitParams>>>;
    single: Record<string, Partial<Record<Direction, ExitParams>>>;
  };
  /** уровень режима (схлопнуты канал/символ/направление) */
  byMode: {
    matrix: ExitParams;
    single: ExitParams;
  };
  /** корень дерева */
  global: ExitParams;
}

export type ResolveSource =
  | "cell"        // точное попадание [mode][channel][symbol][direction][volRegime]
  | "symbol-dir"  // схлопнут volRegime
  | "mode"        // уровень режима
  | "global";     // корень

export interface ResolvedExit {
  exit: ExitParams;
  source: ResolveSource;
}

/**
 * Иерархический резолвер. Возвращает exit + уровень, с которого он разрешён,
 * чтобы прод видел, обучен ли он персонально под (канал,символ,направление,режим)
 * или это fallback.
 */
export function resolveExit(
  tensor: ExitTensor,
  mode: "matrix" | "single",
  channel: string,
  symbol: string,
  direction: Direction,
  volRegime: VolRegime,
): ResolvedExit {
  const cell = tensor.cells[mode]?.[channel]?.[symbol]?.[direction]?.[volRegime];
  if (cell) return { exit: cell, source: "cell" };

  const sd = tensor.bySymbolDir[mode]?.[symbol]?.[direction];
  if (sd) return { exit: sd, source: "symbol-dir" };

  const modeLevel = tensor.byMode[mode];
  if (modeLevel) return { exit: modeLevel, source: "mode" };

  return { exit: tensor.global, source: "global" };
}

/**
 * Резолв БЕЗ volRegime (свечей нет): пропускаем cell-уровень (требует режима),
 * начинаем с symbol-dir → mode → global.
 */
export function resolveExitNoRegime(
  tensor: ExitTensor,
  mode: "matrix" | "single",
  symbol: string,
  direction: Direction,
): ResolvedExit {
  const sd = tensor.bySymbolDir[mode]?.[symbol]?.[direction];
  if (sd) return { exit: sd, source: "symbol-dir" };

  const modeLevel = tensor.byMode[mode];
  if (modeLevel) return { exit: modeLevel, source: "mode" };

  return { exit: tensor.global, source: "global" };
}
