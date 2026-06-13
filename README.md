# 🧿 Pump Anomaly

> Pump signals detection · Author-cluster deduplication · Path-aware exit replay · Liquidation-cascade detection.

<p align="center">
  <br>
  <img src="https://github.com/tripolskypetr/pump-anomaly/raw/master/assets/logo.png" height="325px" alt="pump-anomaly" />
</p>

<p align="center">
  <b>Demons to some angels to others</b>
</p>

## Overview

> **Emergency!** [The box. You opened it. We Came.](https://hellraiser.fandom.com/wiki/Lament_Configuration) — Be aware of meeting the Tax Officers or Telegram channel owner while using it

A black box for detecting **synchronized pump signals** in a stream of trading recommendations from Telegram channels, and turning that detection into a ready-to-execute trade plan.

It solves three problems:

1. **Separates real capital inflow** — several independent authors hitting the same ticker in sync — from a single actor manipulating multiple anonymous channels.
2. **Separates a pump from stop hunting** — traps where a signal leads the crowd into leverage so it can be wiped out by a liquidation cascade. The training label comes from a simulation of *your* prod exit on 1m candles, not close-to-close.
3. **Produces a ready-to-trade plan** with trained exit parameters (trailing take / hard stop / impact horizon), tuned separately per source.

---

## Installation

```bash
npm install pump-anomaly
```

---

## Quick start

```ts
import { PumpMatrix } from "pump-anomaly";
import * as fs from "fs";

// 1) train once on history (the label comes from a replay of your prod exit)
const model = await PumpMatrix.fit(history, getCandles);
fs.writeFileSync("model.json", model.save());

// 2) in prod — no training needed
const model = PumpMatrix.load(fs.readFileSync("model.json", "utf8"));

// signals() returns ONLY what's executable — veto is already filtered out
const trades = model.signals(liveItems);

// plan() is the live decision (no look-ahead): adds volRegime + cascade detection
// from candles STRICTLY BEFORE the signal. Source = a getCandles (async) or a
// preloaded { symbol: candles } map (sync).
const trades = await model.plan(liveItems, getCandles);

for (const s of trades) {
  // direction is already inverted if needed; exit is ready; entry zone for the live order
  openPosition(s.symbol, s.direction, { from: s.entryFromPrice, to: s.entryToPrice }, s.exit);
}
```

`signals`/`plan` do the thinking: they pick the mode, compute `volRegime`, evaluate the cascade, filter veto, and apply inversion. The application just executes `s.direction` with `s.exit` — no `if` statements about veto, inversion, or mode.

Three execution methods, by what candles they're allowed to see:

| method | candles | use |
|---|---|---|
| `signals(items, policy?)` | none | fast path; cascade not evaluated → every outcome is `enter` |
| `plan(items, source, policy?)` | **before** the signal | **live** decision, no look-ahead (`squeezePressureBefore`) |
| `backtest(items, source, policy?)` | **after** the signal | replay forward over closed history (realized pnl/cascade) |

`plan` and `backtest` each accept either a `getCandles` (async → returns a `Promise`) or a `{ symbol: candles }` map (sync). A broken symbol (data gap) degrades gracefully to a no-candle signal instead of crashing the whole call.

---

## Per-asset grids

Tuned `TrainGrid`s per asset live in [`config/`](config/) — one `*-grid.mjs` each, set from how that coin actually pumps. See [config/README.md](config/README.md) for the full rationale. Summary (fastest → slowest):

| Asset | Pump speed | `staleMinutes` | `hardStop` % | `trailingTake` % | `stalenessSinceProfit` % | Noise | Matrix strictness |
|---|---|---|---|---|---|---|---|
| [Fartcoin](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/fartcoin-grid.mjs) | Very fast | 25m – 4h | 0.65–2.0 | 0.5–2.4 | 0.3–1.0 | Very high | Low |
| [HYPE](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/hype-grid.mjs) | Very fast | 30m – 4h | 0.7–2.0 | 0.5–2.5 | 0.3–1.0 | High | Low |
| [Solana](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/solana-grid.mjs) | Fast | 45m – 8h | 0.8–2.5 | 0.6–2.2 | 0.4–1.3 | High | Low–Med |
| [TRX](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/tron-grid.mjs) | Medium | 1.5h – 15h | 1.0–3.0 | 0.7–3.5 | 0.5–1.4 | Medium | Medium |
| [TON](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/gram-grid.mjs) | Medium-fast | 1h – 12h | 1.0–3.0 | 0.7–3.5 | 0.5–1.4 | Medium | Medium |
| [DOGE](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/doge-grid.mjs) | Medium | 1.5h – 16h | 1.1–3.2 | 0.8–4.0 | 0.5–1.5 | Medium+ | Medium+ |
| [BNB](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/bnb-grid.mjs) | Medium | 3h – 24h | 1.2–3.5 | 0.9–4.5 | 0.6–1.6 | Medium | Medium+ |
| [Ethereum](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/ethereum-grid.mjs) | Slow | 2h – 24h | 1.2–3.5 | 0.5–2.5 | 0.3–1.0 | Low | High |
| [Ripple (XRP)](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/ripple-grid.mjs) | Medium-slow | 3h – 24h | 1.3–4.0 | 0.9–5.0 | 0.6–1.7 | Low–Med | High |
| [Litecoin (LTC)](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/litecoin-grid.mjs) | Medium-slow | 4h – 30h | 1.3–3.8 | 0.9–5.0 | 0.7–1.8 | Low–Med | High |
| [Zcash (ZEC)](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/zec-grid.mjs) | Medium-slow | 4h – 28h | 1.4–4.2 | 0.9–5.5 | 0.6–1.7 | Low–Med | High |
| [Stellar (XLM)](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/stellar-grid.mjs) | Medium-slow | 4h – 30h | 1.4–4.0 | 1.0–5.0 | 0.7–1.8 | Low | High |
| [Chainlink (LINK)](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/link-grid.mjs) | Medium-slow | 5h – 32h | 1.4–4.0 | 1.0–5.5 | 0.7–1.8 | Low–Med | High |
| [Polkadot (DOT)](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/dot-grid.mjs) | Medium-slow | 5h – 36h | 1.5–4.2 | 1.0–5.5 | 0.7–1.9 | Low–Med | High |
| [Bitcoin (BTC)](https://github.com/tripolskypetr/pump-anomaly/blob/master/config/btc-grid.mjs) | Slow | 6h – 48h+ | 1.8–5.0 | 1.2–7.0 | 0.8–2.2 | Low | Very high |

`staleMinutes` / `hardStop` / `trailingTake` / `stalenessSinceProfit` show the **range spanned by the grid** for that asset — `fit` picks within it.

---

## Input contract

### `ParserItem` (channel signal)

```ts
interface ParserItem {
  channel: string;
  symbol: string;
  direction: "long" | "short";
  ts: number;               // unix time of publication, ms
  entryFromPrice?: number;   // lower bound of the entry zone (entry.from)
  entryToPrice?: number;     // upper bound of the entry zone (entry.to)
  id?: string | number;      // optional source id — threaded through to dump() for traceback
  [extra: string]: unknown;  // targets/stoploss/… are allowed and ignored
}
```

`channel` is required — it is the key into the exit tensor. The entry zone (`entryFromPrice`/`entryToPrice`) maps from `entry: {from, to}` of your parser-items; if absent, entry is at the open of the first candle. An optional `id` (string or number → normalized to string) is carried untouched all the way to each `dump()` record, so a realized trade can be traced back to the exact post it came from.

### `getCandles` (candle source)

```ts
type CandleInterval = "1m"|"3m"|"5m"|"15m"|"30m"|"1h"|"2h"|"4h"|"6h"|"8h"|"1d";

interface ICandleData {
  timestamp: number; // unix ms, candle OPEN time
  open: number; high: number; low: number; close: number; volume: number;
}

type GetCandles = (
  symbol: string,
  interval: CandleInterval,
  limit?: number,
  sDate?: number,  // inclusive
  eDate?: number,  // exclusive
) => Promise<ICandleData[]>;
```

Range semantics:

```
(limit)               → [align(when) − limit·step, align(when))
(limit, sDate)        → [align(sDate), align(sDate) + limit·step)
(limit, _, eDate)     → [align(eDate) − limit·step, eDate)
(_, sDate, eDate)     → [align(sDate), eDate), limit from range
(limit, sDate, eDate) → [align(sDate), …), exactly limit candles
```

Training labels on `1m` candles, so your `getCandles` must be able to serve them.

---

## How the label is set (stop hunting won't slip through)

The training label comes from an **exact replay of your prod exit on 1m candles** (`replayExit`), not close-to-close. Ported from your code one-to-one:

- **moonbag** (long) — hard stop below entry; **gravebag** (short) — above.
- **trailing take** — pullback from peak PnL once `currentProfit ≥ 0`, fixed at the achieved peak.
- **peak staleness** — peak reached the profit threshold, but went stale for `stalenessSinceMinutes` without a new high (price may never reach the target at all).
- **life-cap** (`staleMinutes`) — ceiling on position lifetime = **empirical impact horizon**, tuned by the grid. Exits at the close of the last candle in the window (the realized pnl can be negative).
- A stop-out realizes the **honest `-hardStop%`** — the actual result of the trade. The peak is kept separately for diagnostics, but the pnl is the loss. (An earlier version rolled the metric back to the last positive peak, which meant a stop-out never showed a loss and silently inflated pnl/RR — fixed.)

Why this catches stop hunts: a wick into the trap never reaches `trailingTake`, and the pullback hits the hard stop → the label is negative **even if** `close[t+H]` happens to be positive. Path-aware replay sees the whole OHLC path, not just two points, so the optimizer actually sees the risk of stops.

**Entry without look-ahead.** The candle that *contains* the signal is still forming — its close/high/low are only known at the end of the minute, after the signal. Entering it would be peeking ahead. So the entry search starts at the next fully-closed candle (`entryStartTs`); a signal exactly on a candle boundary is tradeable and not skipped.

**Candles and chop.** For each candidate, `labelBurst` requests `1m` candles forward from the event for `staleMinutes·2+5` (buffer for a late entry into the zone). If this exceeds the chunk limit (500), the library **chunks the request itself** (`fetchCandlesChunked`), advancing `since` and deduplicating by timestamp — independent of whether your adapter paginates. Two safety nets:

- **Adapter error** (look-ahead guard at the end of history, a data gap for the symbol — common for meme-coins) is caught: the candidate is skipped, training does not crash. One broken symbol does not bring down the whole `fit`.
- **Truncated horizon.** In a long chop, entry can happen late, and there may not be enough candles left for the full life-cap. Such a label is marked `truncated` and **dropped per-exit** (only for entered trades) — otherwise a 24h horizon would be compared against a 1h one on a clipped path, corrupting `impactHorizonMinutes`. Shorter horizons of the same candidate are kept; a clean `no-entry` is kept as a valid "didn't enter" label.

---

## Training

`PumpMatrix.fit(history, getCandles, opts)` tunes the detector thresholds AND the prod-exit parameters in a single grid, validated by time-series K-fold (expanding window). The objective is **shrinkage-expectancy** `mean · N/(N+k)` (k=5 by default): shrinkage toward zero on small samples prevents falling in love with one fat outlier.

```ts
interface TrainOptions {
  grid?: Partial<TrainGrid>;
  folds?: number;                       // K-fold folds, default 4
  shrinkageK?: number;                  // objective shrinkage strength, default 5
  maxBurstWindowMs?: number;            // burst window ceiling
  reliability?: Partial<ReliabilityConfig>;
  mode?: "auto" | "matrix" | "single";  // entry-selection mode
  viability?: Partial<ViabilityConfig>; // matrix-viability thresholds
  onProgress?: ProgressFn;              // defaults to a stdout bar
  policy?: SignalPolicy;                // allowed outcomes, baked into the model
  selection?: Partial<SelectionConfig>; // SE corridor + nested-CV (see selection.ts)
}
```

Default grid (everything is searched empirically — minimal analytical math):

```ts
const DEFAULT_GRID = {
  // detector (authorship matrix)
  windowK:          [2, 3, 5],
  minClusters:      [2, 3],
  jaccardThreshold: [0.3, 0.4],                 // 0.2 almost never won — dropped to shrink the grid
  lagPeakThreshold: [0.4, 0.5],                 // 0.6 rarely better — dropped to shrink the grid
  // prod exit (label set by replay)
  trailingTake:         [0.5, 1.0, 2.0],
  hardStop:             [1.0, 2.0, 3.0],
  stalenessSinceProfit: [0.5, 1.0, 2.0],        // profit threshold that arms the staleness exit — searched, not fixed
  stalenessSinceMinutes:[60, 120, 240],         // minutes without a new high before a staleness exit
  staleMinutes:         [60, 240, 720],         // impact horizon: 1h / 4h / 12h (24h rarely optimal for short pumps)
  // liquidation-cascade detector
  volZThreshold:    [1.5, 2.5],                 // when volume is anomalous
  squeezePolicy:    ["none", "tighten", "veto", "invert"],
  squeezeThreshold: [0.55, 0.7],
  volBaselineWindow:[20],
  cascadeWindowMinutes: [15, 30, 60],           // cascade-detection window — NOT the holding horizon
  // stationarity window (long horizon)
  stationarityWindowMs: [7 * 24 * 3600_000, 14 * 24 * 3600_000, 28 * 24 * 3600_000, 56 * 24 * 3600_000],
};
```

**Winner selection** uses the **one-standard-error rule** (Breiman), not argmax over the CV score. A pure maximum over thousands of configurations is systematically inflated (winner's curse): the max of noisy estimates is biased upward by roughly `sigma·sqrt(2·ln N)`, and the larger the grid, the worse the overfit to noise. The rule picks the most **conservative** configuration among those whose score is within 1 SE of the maximum — a difference within 1 SE is not statistically significant, so robustness beats luck. "More conservative" = smaller `hardStop`, shorter holding horizon, softer reaction to a cascade. This makes a larger grid less dangerous: extra points don't drag the choice toward a lucky outlier.

**Nested CV** (`selection.nestedOuterFolds`, default 4) gives an unbiased out-of-sample estimate of the chosen configuration in `meta.nestedScore` — an honest "what to expect in prod" without winner's curse. Model selection itself still uses 1-SE; nested CV only evaluates. On 3 months of data, full grid + nested takes ~50s, with progress ticking on every outer fold (the terminal doesn't go silent). Selection parameters (conservatism ordering, SE corridor, number of folds) live in `selection.ts` — no magic literals in the logic.

`fit` returns a trained model: `save()` → JSON string, `PumpMatrix.load(json)` restores it without retraining. The params format is version 3; old v1/v2 won't load (the exit structure is incompatible — retrain).

---

## Two entry-selection modes

The mode changes the **entry condition**, but the exit is **not shared** — it's tuned separately per cell of the tensor (see below).

- **matrix** — entry = synchronous burst across independent author clusters (filters out single-actor manipulation). Requires ≥2 channels and a viable correlation.
- **single** (fallback) — correlation isn't available (one channel), but even a single post moves the market: the audience enters. Every post is an entry; the trained exit decides the outcome.
- **auto** (default) — matrix kicks in only if the correlation is viable AND actually produced a signal; otherwise → single.

```ts
predict(items, { mode: "auto" });    // default
predict(items, { mode: "matrix" });  // force correlation
predict(items, { mode: "single" });  // force fallback
// result.usedMode  — which mode actually ran
// result.viability — why: { viable, maxSharedEvents, strongEdges, multiChannelClusters, reason }
```

### Matrix viability: two channels ≠ matrix mode

Two channels do **not** guarantee matrix mode. If their overlap is noisy (Jaccard randomly crossed the threshold on 1-2 events, no sharp edges, a trivial graph) — `viability.viable = false`, and `auto` falls back to `single` so it doesn't emit a false signal from a random coincidence. Strict criterion (`DEFAULT_VIABILITY`):

```ts
{ minSharedEvents: 3, minPeakShare: 0.6, minStrongEdges: 1, minStructure: 2 }
```

Override via `viability` in `fit`/`predict`. All conditions must hold simultaneously: sufficient event overlap, non-random edge sharpness, a non-trivial graph (siblings found, or ≥2 independent clusters).

---

## Training reliability

```
confidence = support × stability × significance   (each in [0, 1])
reliable   = confidence ≥ 0.6 AND totalN ≥ 40
```

| axis | grows when |
|---|---|
| support | more trades (shrinkage `N/(N+30)`) |
| stability | edge holds in every fold, not just one |
| significance | edge is statistically ≠ 0 |

On a small sample, `reliable: false` — the library still works, but honestly warns you. As data grows, all three axes grow → `confidence → 1`, `reliable` flips to `true` **without code changes**. A single channel → empty authorship matrix → the matrix itself is `reliable: false` by construction, but single mode still produces tradeable signals. Thresholds (`supportK: 30`, `confidenceThreshold: 0.6`, `minN: 40`) are configurable via `reliability` in `fit`.

---

## Statistical certificate — edge vs. brute-force artifact

`reliable` answers "did training have enough stable, significant data?". It does **not** answer the harder question: a grid search is `argmax` over thousands of CV scores, and **the max of N noisy estimates is biased upward by ≈ σ·√(2·ln N) even when the true edge is zero.** The 1-SE rule (winner selection) softens this, but it does not *prove* the surviving edge is real. The certificate does — it is an independent **judge applied to the already-selected configuration**, never an input to selection (using it to pick configs would make it overfittable, defeating the point).

Five barriers from the literature (López de Prado, White, Hansen, Politis-Romano). `certified: true` only if the edge survives **all** of them:

| barrier | function | catches | threshold |
|---|---|---|---|
| **DSR** (Deflated Sharpe) | `deflatedSharpe` | edge doesn't survive the correction for N trials + skew/kurtosis/length | ≥ 0.95 |
| **PBO** (CSCV overfit) | `probabilityOfBacktestOverfitting` | the IS-best config is systematically poor OOS | ≤ 0.10 |
| **SPA / Reality Check** | `realityCheckPValue` | the whole edge is explainable by data-snooping (stationary bootstrap) | p ≤ 0.05 |
| **minTRL** | `minTrackRecordLength` | the sample is physically too small for significance | N ≥ minTRL |
| **nested OOS** | (from `train`) | the unbiased out-of-sample forecast isn't positive | > 0 |

```ts
model.certification;
// {
//   certified: boolean;        // false → the model should NOT trade
//   dsr: number;               // ≥ 0.95
//   pbo: number;               // ≤ 0.10
//   spaPValue: number;         // ≤ 0.05
//   minTRL: number; actualN: number;   // actualN ≥ minTRL
//   nestedScore: number | null;        // > 0
//   reasons: string[];         // WHY it was not certified (empty when certified)
// }
```

`certified: false` is the **honest refusal**: training still ran and `argmax` still picked a winner, but the certificate says the winner is a brute-force artifact, not a real edge. The e2e test `fit-noise-rejection` proves it — a full `fit` on a pure random walk *does* learn a "best" config, yet `certified: false`. This is the layer `reliable` cannot provide, because `reliable` never sees the winner's curse of the search itself.

All functions are pure over arrays of per-trade returns, no external dependencies, and exported from the package: `sharpe`, `deflatedSharpe`, `expectedMaxSharpe`, `minTrackRecordLength`, `probabilityOfBacktestOverfitting`, `realityCheckPValue`, `stationaryBootstrapResample`, `mulberry32`, plus moment stats (`mean`/`variance` via Welford/`skewness`/`kurtosis`) and `normalCdf`/`normalInv`. `certifyStrategy(input, thresholds?)` composes them; thresholds (`dsr`/`pbo`/`spa`) are overridable.

---

## Toward a self-learning loop

The engine is a **stateless learner + judge**, not a running system — which is exactly what makes it safe to wrap in an automation loop (e.g. a scheduled agent + MCP data/broker adapters). The pieces line up:

- **`fit` → `save()` → `load()`** — training is separated from inference; the model is a JSON blob.
- **`signals`/`plan`/`backtest`** — pure, no hidden state; `plan` is look-ahead-free by construction.
- **`dump()`** — full signal history (including non-entered) for the loop's own analytics.
- **`certification`** — the automatable gate: re-fit on a rolling window, and **only promote to live when `certified: true`**; otherwise hold and surface `reasons[]`.

A loop then closes itself: a scheduler ticks → fresh `ParserItem[]` + `getCandles` arrive (e.g. via MCP) → `fit` retrains on the recent window → `certification` decides whether the model may trade → if so, `plan()` emits ready signals → execution → `dump()` feeds the next tick. The system **retrains itself and refuses to trade when the edge has decayed** (a previously-certified model going `certified: false` is a regime-shift alarm).

Two invariants keep this honest rather than dangerous:

1. **The certificate stays out of the optimization loop.** An orchestrator (or LLM operator) may decide *whether* to retrain or escalate, but must never tune the grid/thresholds to *pass* the certificate — that would turn the independent judge back into an overfitter.
2. **Re-fitting multiplies trials at the meta level.** DSR penalizes N *within* one `fit`, but not the fact that a loop runs `fit` hundreds of times and trades only when one comes back certified — each "certified" run can itself be the outlier among, say, 720 monthly attempts. A single-`fit` certificate is blind to this chain.

### Meta-overfitting guard (`meta-ledger.ts`)

Invariant 2 is **enforced in code**, not left to operator discipline. A serializable `MetaLedgerState` records *every* `fit` attempt (the loop's state between ticks), and two mechanisms close the meta-curse:

- **Cadence guard** — `canRefit(ledger, now, policy?)` refuses a `fit` that comes too soon after the last one (`minRefitMs`, default **1 week**). Frequent re-fitting *is* trial multiplication, so it is simply disallowed, with a human-readable `reason` and `nextAllowedTs`.
- **Family-wise correction** — pass `metaLedger` to `fit` and DSR's N becomes `effectiveTrials` = Σ configs across **all** past attempts, not just the current grid. The denominator is honest only because **every** attempt is logged (`recordAttempt` stores `certifiedNaive: false` runs too) — logging only the successes would understate N and make the correction lie.

```ts
import { emptyLedger, recordAttempt, canRefit, effectiveTrials } from "pump-anomaly";

let ledger = emptyLedger();                       // persist between ticks (loop state)
const gate = canRefit(ledger, Date.now());        // too-frequent refit? → { allowed, reason, nextAllowedTs }
if (gate.allowed) {
  const model = await PumpMatrix.fit(history, getCandles, { metaLedger: ledger });
  ledger = recordAttempt(ledger, {                // log EVERY attempt, certified or not
    ts: Date.now(),
    innerTrials: model.innerTrials,          // grid size of this fit
    certifiedNaive: model.certification.certified,
  });
  // model.effectiveTrials / model.fitAttempts expose the meta-trial count for audit
}
```

The guarantee is verified: 720 `fit` runs on pure noise produce false naive certificates, and the family-wise correction drops them to **0** — while a genuine 0.75σ edge survives the same correction (`meta-ledger.test.ts`). So the loop *cannot* "click" its way to a certificate by re-running, and the engine becomes safe-by-construction rather than safe-by-discipline.

---

## Exit tensor `[mode][channel][symbol][direction][volRegime]`

The model does NOT duplicate the stoploss/targets from the post, and does NOT mix exit math across sources. trailing/hardStop/impact-horizon are trained **separately per cell** of the tensor — every channel moves every symbol differently, a long-trap and a short-trap have different dynamics, and anomalous volume requires a tighter trailing.

Per-signal resolution with hierarchical fallback:

```
[mode][channel][symbol][direction][volRegime]   (cell)
  → [mode][symbol][direction]                    (symbol-dir, volRegime collapsed)
  → [mode]                                        (mode)
  → global                                        (root)
```

- **matrix and single are kept separate** — different entry expectancy → different exit. In matrix mode the burst is cross-channel (no single owner), so cells are stored under the canonical `_matrix` channel key.
- **long and short are different cells** (cascade symmetry).
- **calm and anomalous are kept separate** — trailing is tighter in anomalous volume.
- **a new channel with no history** falls back to mode/global — the fallback is trained too, no magic constants.

`origin.exitSource` shows which level the exit was resolved from: `cell` | `symbol-dir` | `mode` | `global`.

---

## Liquidation-cascade detector (symmetric long/short)

Stop hunting is symmetric: a short squeeze and a long cascade are mirrors of the same mechanism.

- **short squeeze:** the crowd shorts on leverage → a wall of liquidations above → a cascade of forced buys pushes the price up (against the short).
- **long cascade:** the crowd longs on leverage → a wall of liquidations below → a cascade of forced sells pushes the price down (against the long).

No need to parse leverage — the cumulative effect is visible in `volume`:

- **`volZ`** — the z-score of the entry candle's volume against the baseline. High = the crowd synchronously entered on leverage (fuel accumulated).
- **`squeezePressure`** — the share of volume on candles where price moves **against** the position. Symmetric: for long, "against" = down (a sell cascade); for short, = up (a buy cascade). High = the move is fed by liquidations, not honest flow → a trap. The **live** variant (`squeezePressureBefore`) measures it over candles strictly *before* the entry, since in live there are no candles after the signal yet.

The reaction (`squeezePolicy`) is tuned by training via CV, or fixed in the grid:

- **none** — a normal entry.
- **tighten** — tighten the trailing, exit before the reversal (`p.trailingTake` is returned already tightened by `tightenFactor`, 0.5 by default).
- **veto** — don't enter when squeeze pressure is high (the signal never makes it into the output).
- **invert** — enter AGAINST the post (the strategy from 1028592): a channel posted short → the cascade squeezes upward → `signals` returns a signal with `action: "invert"`, `direction: "long"` (already flipped), and the exit from the inverse cell of the tensor. `origin.invertedFrom` holds the original channel direction. The exit `reason` keeps the real mechanism (hard-stop/trailing-take/life-cap) of the inverted position; the fact of inversion is carried by a flag, not by overwriting the reason.
- **ignore** — the cascade is noticed but **deliberately not acted on**: enter in the original direction anyway, realizing the real (usually bad) pnl. This gives the counterfactual "what if we don't react to the cascade" directly in the output, not only in offline analysis. Behaves like `none` for entry, but is labeled distinctly.

The calm/anomalous threshold (`volZThreshold`) and the firing threshold (`squeezeThreshold`) are both grid axes.

**Cascade detection window** (`cascadeWindowMinutes`) is a separate axis, NOT tied to the holding horizon `staleMinutes`. A squeeze is a fast event (minutes): measuring it over a 24h window is wrong — a long window smears out a sharp reversal. Previously the detection window was derived from `staleMinutes`, conflating two unrelated concerns (position lifetime and detector sensitivity); now they're independent (it falls back to `staleMinutes` only for backward compatibility when unset).

---

## Prod API — single contract

`signals()` returns **only what's executable**. veto (liquidation cascade) never makes it into the output — it's filtered internally. Prod code never writes `if (veto) continue` or looks at flags.

```ts
for (const s of model.signals(liveItems)) {
  // direction is already flipped if inverted; entry zone + exit are ready for the order
  openPosition(s.symbol, s.direction, { from: s.entryFromPrice, to: s.entryToPrice }, s.exit);
}
```

One signal = one decision. Discriminator `action`, provenance in a single `origin` (not flags):

```ts
interface TradeSignal {
  symbol: string;
  direction: "long" | "short";        // FINAL (inversion already applied)
  action: "enter" | "invert" | "tighten";
  ts: number;
  entryFromPrice?: number;            // entry zone from the parser-item (for opening the live position)
  entryToPrice?: number;              // undefined → enter at market
  exit: {                              // flat, ready for openPosition
    trailingTake: number;             // tightened if action="tighten"
    hardStop: number;
    impactHorizonMinutes: number;
    stalenessSinceProfit: number;
    stalenessSinceMinutes: number;
  };
  origin: {                           // audit, not for branching
    detector: "matrix" | "single";
    channel: string | null;
    invertedFrom: "long" | "short" | null; // what the channel said (null = no inversion)
    exitSource: "cell" | "symbol-dir" | "mode" | "global";
    volRegime: "calm" | "anomalous" | null;
    confidence: number;
    independentClusters: number;
    modelConfidence: number;
    modelReliable: boolean;
    id?: string;                        // anchor parser-item id (traceback to the source post)
    ids?: string[];                     // all parser-item ids folded into this signal
  };
}
```

### Execution methods

```ts
// no candles — cascade not evaluated, every outcome is "enter":
model.signals(items, policy?)                                // TradeSignal[]

// LIVE — candles strictly BEFORE the signal (no look-ahead), source = getCandles | map:
await model.plan(items, getCandles, policy?)                 // Promise<TradeSignal[]>
model.plan(items, { SOLUSDT: candles }, policy?)             // TradeSignal[]

// BACKTEST — replay forward over closed history, source = getCandles | map:
await model.backtest(items, getCandles, policy?)             // Promise<BacktestSignal[]>
model.backtest(items, { SOLUSDT: candles }, policy?)         // BacktestSignal[]

// single-position helpers:
model.planFor(symbol, dir, channel, candles, policy?)        // live → TradeSignal, null on veto
model.planForAt(symbol, dir, channel, candles, ts, policy?)  // backtest → BacktestSignal, null on veto

// full report (all verdicts + author map) for debugging:
model.explain(items)
```

`plan` and `backtest` differ in two ways. **(1) Which candles they see:** `plan` measures the cascade from candles *before* the entry (live-safe, no look-ahead); `backtest` from candles *after* the entry (forward replay over already-closed history). **(2) What they return:** `plan` returns a `TradeSignal` (a decision — the position isn't closed yet, so there's no pnl); `backtest` returns a **`BacktestSignal`** — the same signal plus a `result` that *replays the exit plan forward* and reports the realized pnl. That replayed `result` is the whole point of `backtest`:

```ts
interface BacktestResult {     // present ONLY on BacktestSignal (backtest / planForAt)
  entered: boolean;            // false → entry zone never touched on the candle window
  pnl: number;                 // realized, fraction (hard-stop = honest -hardStop%)
  peak: number;                // peak pnl over the position's life
  reason: string;              // hard-stop | trailing-take | peak-staleness | life-cap | …
  heldMinutes: number;
  entryPrice: number;          // 0 if not entered
  exitPrice: number;           // 0 if not entered
  truncated: boolean;          // not enough candles after entry for the full life-cap
}
interface BacktestSignal extends TradeSignal { result: BacktestResult }

for (const s of model.backtest(items, getCandles)) {
  console.log(s.symbol, s.direction, s.result.pnl, s.result.reason); // realized, no join with dump()
}
```

The replay uses the signal's FINAL direction (inversion already applied) and its resolved exit plan; the entry zone comes from the parser-item (`entryFromPrice`/`entryToPrice`), falling back to the first candle's open. `dump()` still holds the training-time history; `backtest` is the same machinery applied to whatever items/candles you pass now.

### Permissions — allow-list, serialized at training time, readonly at runtime

What's allowed (entries/inversions) is fixed at `fit` time and **baked into model.json**. In prod this is readonly — the second argument to `signals()`/`plan()`/`backtest()` can only NARROW it, never widen it:

```ts
// at training time — bake the policy into the model:
fit(history, getCandles, { policy: { allow: ["enter", "tighten"] } }); // no inversion

// in prod — narrow it for one call (never wider than trained):
model.signals(items, { allow: ["enter"] });  // direct entries only
```

`allow` without `"invert"` → inversion signals are never returned (treated like veto — don't walk into the trap). This replaced the runtime flags `disableInvert`/`disableSqueeze`: instead of state smeared across training-and-prod, there's one serializable policy with the invariant "execution never permits what training forbade."

### Model introspection

```ts
model.reliable;              // did training have enough data
model.confidence;            // 0..1 trust in the model
model.certification;         // five-barrier edge certificate (DSR/PBO/SPA/minTRL/nested)
model.effectiveTrials;       // family-wise meta-trial count (Σ configs over all fit attempts)
model.innerTrials;           // grid size of this fit
model.fitAttempts;           // how many times fit has run in the chain
model.labeling;              // labeling diagnostics — WHY a fit came out empty
model.impactHorizonMinutes;  // empirical post impact horizon (global level)
model.mode;                  // "matrix" | "single" — how the model was trained
model.modeReason;            // honest diagnostics: WHY this mode was chosen
model.minClusters;           // min independent clusters for a matrix burst
model.minSharedEvents;       // min shared events for a viable author matrix
model.lookbackMinutes;       // how many 1m candles BEFORE the signal plan() needs
model.exit;                  // the full exit tensor (audit)
model.policy;                // the baked-in allow-list (readonly copy)
```

`lookbackMinutes` = `max(volBaselineWindow, cascadeWindowMinutes) + 5` — the amount of pre-signal 1m history `plan()` pulls per signal (strictly in the past, no look-ahead). In prod, keep at least this much history available for every fresh signal.

### Troubleshoot

A `fit` that produces `totalSamples: 0` is otherwise mute — "no data" and "no entries" look identical. `model.labeling` makes it speak: per **unique** candidate burst, what its labeling outcome was (and the raw `getCandles` exception text, deduped):

```ts
model.labeling;
// {
//   candidates: number;                     // unique bursts seen
//   outcomes: {                             // only non-zero outcomes present
//     ok?: number;                          // labeled, has an entry
//     "adapter-error"?: number;             // getCandles threw (look-ahead guard / gap / symbol)
//     "no-candles"?: number;                // getCandles returned empty (symbol/range gave nothing)
//     "no-entry"?: number;                  // candles exist, but no exit-set entered the zone
//   };
//   errors: Record<string, number>;         // unique getCandles exception messages → count
// }
```

So when a trained model is empty, `labeling.outcomes` tells you whether to fix `getCandles` (`adapter-error`), the symbol/range (`no-candles`), or accept there were no entries — and `labeling.errors` carries the exact thrown message (e.g. `{ "ccxt: symbol not found": 32 }`) instead of swallowing it.

---

## Signal history (`dump`) — for external analytics

`fit` records the full signal history of the selected configuration — one record per candidate, labeled with the chosen exit: entry/exit price, realized pnl, peak, reason, held minutes, inversion flag, volRegime, independent clusters. It includes signals that did NOT enter (`no-entry` / `cascade-veto`, `entered: false`), so analytics can count skips, not just realized trades. Serialized in `save()`/`load()`.

```ts
model.dump();        // SignalRecord[]  (array of plain objects)
model.dump(true);    // JSON string
model.historySize;   // number of records (0 if loaded without history)
```

```ts
interface SignalRecord {
  id?: string;           // anchor parser-item id (traceback to the source post)
  ids?: string[];        // all parser-item ids in the burst (matrix may have several)
  symbol: string;
  direction: "long" | "short";
  channel: string;
  ts: number;            // signal time (burst ts), ms
  entered: boolean;      // false for no-entry / cascade-veto
  entryPrice: number;
  exitPrice: number;
  pnl: number;           // realized pnl, fraction (0.05 = +5%)
  peak: number;          // peak pnl over the position's life
  reason: string;
  heldMinutes: number;
  inverted: boolean;
  volRegime: "calm" | "anomalous";
  independentClusters: number;
}
```

---

## Risk-reward & PnL (research output + runtime filter)

### Risk-reward

RR per trade = `pnl / hardStop` — realized in units of risk (how many R were captured). Computed on the backtest across folds and baked into the model: **per-symbol** (for the runtime filter) and **global** (report), alongside `impactHorizonMinutes`.

```ts
model.riskReward.global;            // { mean, p95, p99, n }
model.riskReward.bySymbol.SOLUSDT;  // { mean, p95, p99, n }
```

At runtime — a **readonly filter following the same pattern as `allow`**: it cuts symbols whose backtest RR is below the threshold. It does not recompute RR in prod, only compares against the saved statistics:

```ts
model.signals(items, { minRiskReward: 1.5 });                  // mean RR >= 1.5
model.signals(items, { minRiskReward: 5.0, rrMetric: "p99" }); // tail P99 >= 5.0
```

A symbol with no RR statistics is cut conservatively (nothing to confirm it with). `rrMetric`: `mean` (default), `p95`, `p99` — p99 filters by the right tail, keeping symbols with explosive upside. A runtime `minRiskReward` can only *tighten* the baked-in threshold (the max of the two is taken), never loosen it.

### PnL (outlier-robust)

Realized-pnl statistics complement the mean with the median and percentiles, so a single bad (or single fat) trade doesn't define the system's edge:

```ts
model.pnl.global;            // { mean, median, p5, p95, p99, n }
model.pnl.bySymbol.SOLUSDT;  // { mean, median, p5, p95, p99, n }
```

`median` is the outlier-immune center, `p5` is the lower tail (how bad the worst 5% are), `p95`/`p99` the upper tail.

---

## Stationarity window (long horizon)

On 5 months of data, statistics get corrupted: τ and the author matrix are aggregated over the ENTIRE history, while the regime drifts over that time — channels appear/go quiet, "sibling" pairs break up. One global set averages incomparable periods, and the matrix "remembers" a January correlation in May.

The fix needs no new math: statistics are computed over a local window ending at the current moment. The window size is a grid axis, tuned by `train` via CV:

```ts
stationarityWindowMs: [7*24*3600_000, 14*24*3600_000, 28*24*3600_000, 56*24*3600_000]
```

`Infinity` = the whole history. On a long horizon a finite window wins — it drops stale connections. In `predict`/live, the window is applied automatically to the most recent period up to the latest event. Affects only matrix mode (author matrix); single mode is independent of it.

---

## Training progress bar

`fit`/`train` write progress to stdout **by default** (casual API):

```ts
await PumpMatrix.fit(history, getCandles); // bar is on automatically
// [██████████████░░░░░░░░░░░░░░░░] 47% (42/90) label TRXUSDT
// [██████████████████████████████] 100% (27/27) score 5|0.4|0.6|all
```

Three phases: `label` (slow per-candle labeling, IO-bound), `score` (grid scoring from cache), and `nested` (one tick per outer nested-CV fold). Silence or replace it:

```ts
import { silentProgress } from "pump-anomaly";
fit(history, getCandles, { onProgress: silentProgress });               // silent
fit(history, getCandles, { onProgress: (e) => log(`${e.done}/${e.total}`) }); // custom
```

---

## Architecture (matrix-mode detector layers)

1. **selfTuneLag** — self-estimates the characteristic lag τ from the histogram of pairwise delays between channels. No magic constants.
2. **jaccardScreen** — coarse sieve of channel proximity over a sliding window of raw timestamps.
3. **lagXCorr** — directed graph of "who follows whom" from a sharp cross-correlation peak.
4. **clusterAuthors** — union-find: merges channels belonging to the same author.
5. **earlyWarning** — density over INDEPENDENT clusters (deduplicating N channels of one actor).

All five are computed over the stationarity window. In single mode the matrix isn't needed — every post becomes an entry directly (`singleChannelSignals`).

**Honest auto-diagnostics.** `model.modeReason` explains WHY `single` or `matrix` was chosen — no guessing. Examples: `auto → single: one channel — correlation impossible`, `auto → matrix: 3 strong edges, overlap 5, clusters >1: 2`. Matrix requires ≥2 INDEPENDENT author clusters on the same ticker; echo channels (always firing together) correctly collapse into 1 cluster and don't produce a false matrix signal. On single-channel data it's always single fallback.

---

## Tests

**531 tests** across **52 test files**. All passing.

| File | Tests | What is covered |
|------|-------|-----------------|
| `predict.test.ts` | 10 | Public facade: τ self-estimation, author-cluster merging, catching a real pump vs skipping a single-actor pump, determinism, garbage-input robustness |
| `layers.test.ts` | 10 | Detector layers in isolation: `buildTable` indexing, `jaccardPair` sliding window, `selfTuneLag` peak/default, `lagXCorr` leadership + peak sharpness, `clusterAuthors` union-find |
| `viability.test.ts` | 6 | Two channels ≠ matrix: noisy pair falls back to single, systematic siblings stay matrix, strict-threshold override, single channel not viable |
| `fallback.test.ts` | 6 | Mode resolution: auto/forced single & matrix, post deduplication in window, single-channel history training into a reliable model |
| `modes-synthetic.test.ts` | 16 | `enumerateBursts` clustering, honest auto single/matrix choice + diagnostics, single fallback out of the box, matrix on known clusters (not just a flag) |
| `reliability.test.ts` | 6 | Confidence axes: small→low, large/stable→high, monotonic growth, reliable false→true flip, zero/noisy/negative edge stays unreliable |
| `exit-tensor.test.ts` | 8 | Hierarchical resolution: exact cell hit, long/short symmetry as different cells, calm vs anomalous, volRegime→symbol-dir→mode→global fallbacks |
| `matrix-cell.test.ts` | 2 | Regression: matrix cell-exit resolves via the canonical `_matrix` channel key |
| `replay.test.ts` | 14 | `replayExit` over all window sequences (long), short (gravebag), priorities and window edges |
| `volume.test.ts` | 10 | `volumeZScore` anomaly, `squeezePressure` long/short symmetry, veto/tighten cascade symmetry in replay, `volRegimeOf` threshold |
| `volume-metrics.test.ts` | 34 | Deterministic volZ across per-symbol baselines, volZ regime threshold boundary, squeezePressure against-position shares |
| `entry-zone.test.ts` | 8 | Entry-price resolution: close-in-zone refinement vs clamped midpoint of the entry zone |
| `label-robustness.test.ts` | 6 | `labelBurst` survives adapter throw / empty result; `replayExit` truncated horizon in chop; truncated exit dropped, full kept |
| `chunked-candles.test.ts` | 9 | `fetchCandlesChunked` pagination, since-advance, timestamp dedup keeping the first (authoritative) occurrence |
| `train.test.ts` | 9 | `shrinkageExpectancy` objective, v-params with tuned exit + impact horizon, JSON round-trip, version guard, casual fit→save→load→signals flow |
| `one-se.test.ts` | 14 | `standardError`, one-standard-error rule against winner's curse, integration: train picks the robust configuration within the SE corridor |
| `nested-cv.test.ts` | 13 | Conservatism ordering (no magic literals), nested-CV unbiased out-of-sample estimate + progress ticking |
| `pump-objective.test.ts` | 6 | Honest pump up — deterministic positive outcome through the replay label |
| `stophunt-objective.test.ts` | 11 | Stop hunting: deterministic stop on a wick against the position, cascade squeeze + policy reaction, inversion (strategy 1028592) |
| `stophunt-vs-falsepositive.test.ts` | 11 | Inversion saves on a real cascade but hurts on a false one; live decision is identical on the past, correctness lives in the future |
| `matrix-signal-objective.test.ts` | 5 | Matrix signals — objective outcomes by price shape |
| `matrix-signal-timing.test.ts` | 7 | Matrix signals under extreme time distance between events |
| `matrix-signal-long-short.test.ts` | 12 | Long & short matrix signals across price/trend/time spread; long↔short symmetry on the same shape |
| `honest-pnl.test.ts` | 13 | Regression: hard-stop realizes an honest loss (not a fictitious peak), inversion keeps the real exit reason, percentile NaN/Inf-robust, facade veto depends on volRegime |
| `pnl-stats.test.ts` | 10 | `pnlStats` outlier robustness (one trade doesn't define the edge) + integration into the model |
| `risk-reward.test.ts` | 11 | `percentile`, `riskRewardStats` (pnl/hardStop), runtime RR-filter readonly pattern |
| `invert.test.ts` | 9 | `replayExit` invert (stop hunt → reversal), inversion transparent to prod via signals/plan, allow-policy turning inversion off without retraining |
| `invert-edge.test.ts` | 10 | Invert edges: squeezePressure threshold, losing inverse position, no forward candles (live), ambiguous cascade via `planForAt`, detection window decoupled from holding horizon |
| `squeeze-ignore.test.ts` | 8 | `squeezePolicy=ignore`: replay enters despite the cascade (takes the bad pnl), facade keeps the signal (unlike veto/invert), conservatism-axis placement |
| `plan.test.ts` | 5 | `planFor` candles-in/plan-out, `plan` batch + candle dictionary, `signals` still works with no candles |
| `plan-getcandles.test.ts` | 4 | `plan(getCandles)` overload: candles fetched via getCandles, no dictionary |
| `live-vs-backtest.test.ts` | 11 | `squeezePressureBefore` (cascade from candles before entry), live vs backtest cascade window, `lookbackMinutes`, `minClusters`/`minSharedEvents` from config |
| `no-lookahead.test.ts` | 6 | `entryStartTs` excludes the forming signal candle; fit and live both request candles strictly without look-ahead |
| `lookahead-adversarial.test.ts` | 7 | Future cascade with calm past (guessable only by peeking); swapping the future doesn't change the live decision; live never requests a candle with `ts ≥ entryStart` |
| `lookahead-intervals.test.ts` | 16 | Look-ahead guard across intervals (3/5/15m + sub-minute): intra-minute signals never enter the still-forming candle |
| `stationarity.test.ts` | 5 | Stationarity window vs regime drift: `windowEvents` Infinity vs slice, a false A↔C link persists without a window but disappears with a 4-week one, real links preserved early |
| `dump.test.ts` | 8 | `dump()` signal-history export (including non-entered no-entry/veto records) |
| `contract.test.ts` | 10 | Single `TradeSignal` contract, allow-policy, `intersectPolicy` readonly invariant, backward compatibility |
| `boundary.test.ts` | 43 | Boundary conditions across every module: degenerate replay paths, tensor fallback on holes, selfTuneLag clamps, objective numeric edges, volume thresholds, reliability exactly at thresholds, windowEvents strict bounds, chunked pagination, facade degenerate inputs |
| `coverage-gaps.test.ts` | 17 | `resolveExitNoRegime` fallback, `volumeFeatures` combined helper, facade getters/methods, `planFor` live path, facade tighten path, `??` default branches, RR-filter branches |
| `progress.test.ts` | 5 | Training progress: both phases with monotonic `done`, score phase reaches 100%, default stdout writer, `silentProgress` no-op, `stdoutProgress` ignores `total ≤ 0` |
| `attack-round3.test.ts` | 11 | Regression: significance not maximized on zero variance, `intersectPolicy` minRiskReward only tightens |
| `statistics-attack.test.ts` | 31 | Adversarial stats: `normalCdf`/`normalInv` vs tables, float-dust on a constant series → Sharpe 0 (not astronomical), `minTRL`=∞ for a losing strategy, PBO NaN on odd folds / empty matrix (no false 0.5), Welford catastrophic-cancellation, NaN/Inf fail-closed across DSR/skew/kurt, out-of-bounds `entryIdx` doesn't crash volume |
| `statistics-robustness.test.ts` | 5 | Not seed-tuned: real +0.4σ edge certifies on ≥22/30 independent seeds, pure noise 0/30 false positives, monotone edge→certification rate, brute-force N=280k penalized stricter than N=50, `minTRL` grows as edge weakens |
| `e2e/certification.test.ts` | 14 | 500-signal scenarios with known truth: DSR certifies a real edge, rejects noise / single-outlier edge / regime-shift; `minTRL`, PBO, SPA, full `certifyStrategy` five-barrier gate |
| `e2e/fit-certification.test.ts` | 3 | `fit` attaches the certificate: small sample (17 trades) → `certified:false` with reasons, survives `save`/`load`, present on the model facade |
| `e2e/fit-noise-rejection.test.ts` | 1 | Full `fit` on a pure random walk → `certified:false` even though grid argmax picks a "best" config (the certificate catches the brute-force artifact `reliable` alone would miss) |
| `meta-ledger.test.ts` | 9 | Meta-overfitting guard: cadence guard blocks too-frequent refits, `effectiveTrials` sums ALL fit attempts (not only certified ones), family-wise DSR drops false certificates from 720 noise refits to 0 while a strong edge survives the correction |
| `staleness-and-id.test.ts` | 7 | `stalenessSinceProfit`/`stalenessSinceMinutes` are searched in `DEFAULT_GRID` (not pinned); a parser-item `id` threads through to every `dump()` record (numeric→string, matches the source post by `ts`, survives save/load, `undefined` without an id) |
| `id-threading-attack.test.ts` | 6 | `id` threading is leak-proof: time-separated bursts on one symbol both survive (no best-per-symbol loss), collapsed posts keep their `id` in `ids` (`enumeratePosts` + `singleChannelSignals`), and `id`/`ids` reach the LIVE `plan` signal's `origin` (not only `dump`) |
| `labeling-diagnostics.test.ts` | 8 | `model.labeling` makes an empty `fit` speak: outcomes per unique burst (ok / adapter-error / no-candles / no-entry), counts not inflated by grid size, sum of outcomes = candidates, and the raw `getCandles` exception text is captured in `errors` (incl. non-`Error` throws) |
| `backtest-result.test.ts` | 5 | `backtest()` returns `BacktestSignal` with a replayed `result` (realized pnl/reason/prices); no candles → `entered:false` not a crash; `planForAt` carries `result` too; `plan()`/`signals()` do NOT carry `result` |

```bash
npm test
```

---

## License

MIT
