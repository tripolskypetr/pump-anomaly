import { EventTable } from "../core/event-table";
import { Edge } from "./jaccard-screen";

export interface DirectedEdge extends Edge {
  /** модальная |задержка|, мс */
  lag: number;
  /** доля задержек в окне остроты пика (0..1) */
  peakShare: number;
  /** инициатор */
  leader: string;
  /** ведомый */
  follower: string;
}

const HORIZON = 6 * 60 * 60 * 1000;

/**
 * Слой 3 — лаговая кросс-корреляция точечных процессов.
 *
 * Для каждой пары-кандидата собирает знаковые задержки Δ = t_b − t_a между
 * ближайшими событиями по общим (symbol,direction). Узкий смещённый пик ⇒
 * братские каналы одного автора; размазанный фон ⇒ совпадение, ребро отбрасывается.
 *
 * Острота пика меряется по peakWindow (= windowK·τ, окно сита), НЕ по голому τ:
 * иначе брат с лагом чуть больше τ ложно выпадает и пара рвётся.
 */
export function lagXCorr(
  tbl: EventTable,
  edges: Edge[],
  peakThreshold: number,
  peakWindow: number,
): DirectedEdge[] {
  const out: DirectedEdge[] = [];

  for (const e of edges) {
    const deltas: number[] = [];

    for (const k of tbl.byKey.keys()) {
      const ta = tbl.byChannelKey.get(`${e.a}|${k}`);
      const tb = tbl.byChannelKey.get(`${e.b}|${k}`);
      if (!ta || !tb) continue;

      for (const t of ta) {
        let best = Infinity;
        for (const s of tb) {
          const d = s - t; // >0: b позже a ⇒ a лидер
          if (Math.abs(d) < Math.abs(best)) best = d;
        }
        if (Number.isFinite(best) && Math.abs(best) <= HORIZON) deltas.push(best);
      }
    }

    if (deltas.length === 0) continue;

    const within = deltas.filter((d) => Math.abs(d) <= peakWindow);
    const peakShare = within.length / deltas.length;
    // ── БИНОМИАЛЬНЫЙ ПОРОГ СЛУЧАЙНОСТИ: острота против равномерного фона ──
    // Под H0 (совпадения, лаги равномерны на ±HORIZON) ожидаемая доля лагов в
    // окне пика p0 = peakWindow/HORIZON; порог = p0 + 2√(p0(1−p0)/n) — та же
    // конвенция «+2σ», что в viability/hawkes. Фикс-порог юзера остаётся ручкой
    // строгости, но НИЖЕ порога случайности пропустить ребро нельзя: маленький
    // n или широкое окно больше не производят «острые» пики из шума.
    const p0 = Math.min(peakWindow / HORIZON, 1);
    const chanceBound = p0 + 2 * Math.sqrt((p0 * (1 - p0)) / deltas.length);
    if (peakShare < Math.max(peakThreshold, chanceBound)) continue;

    const sorted = [...deltas].sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    const aLeads = med >= 0;

    out.push({
      ...e,
      lag: Math.abs(med),
      peakShare,
      leader: aLeads ? e.a : e.b,
      follower: aLeads ? e.b : e.a,
    });
  }

  return out;
}
