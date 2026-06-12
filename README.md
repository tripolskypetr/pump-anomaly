<p align="center">
  <img src="https://github.com/tripolskypetr/volume-anomaly/raw/master/assets/logo.png" height="115px" alt="pump-anomaly" />
</p>

<p align="center">
  <strong>Black-box detector for synchronized Telegram pump signals</strong><br>
  Author-cluster deduplication · Path-aware exit replay · Liquidation-cascade detection<br>
  TypeScript. Single entry point: <code>PumpAnomaly</code>.
</p>

## Installation

```bash
npm i
npm run build   # tsc / rollup -> build/
npm test        # vitest run — 387 tests files
```

Stack: TypeScript + vitest, no CLI, no monorepo. The only public high-level entry point is the `PumpMatrix` class.

## Overview

A black box for detecting **synchronized pump signals** in a stream of trading recommendations from Telegram channels, and turning that detection into a ready-to-execute trade plan.

It solves three problems:

1. **Separates real capital inflow** — several independent authors hitting the same ticker in sync — from a single actor manipulating multiple anonymous channels.
2. **Separates a pump from stop hunting** — traps where a signal leads the crowd into leverage so it can be wiped out by a liquidation cascade. The training label comes from a simulation of *your* prod exit on 1m candles, not close-to-close.
3. **Produces a ready-to-trade plan** with trained exit parameters (trailing take / hard stop / impact horizon), tuned separately per source.

Compatible with the `parser-items` schema (`channel`, `symbol`, `direction`, `entry: {from, to}`, …).

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

// with candles, adds volRegime + cascade detection:
const trades = model.plan(liveItems, { SOLUSDT: solCandles, TRXUSDT: trxCandles });

for (const s of trades) {
  openPosition(s.symbol, s.direction, s.exit); // direction is already inverted if needed; exit is ready
}
```

`signals`/`plan` do the thinking: they pick the mode, compute `volRegime`, evaluate the cascade, filter veto, and apply inversion. The application just executes `s.direction` with `s.exit` — no `if` statements about veto, inversion, or mode.

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
  [extra: string]: unknown;  // targets/stoploss/… are allowed and ignored
}
```

`channel` is required — it is the key into the exit tensor. The entry zone (`entryFromPrice`/`entryToPrice`) maps from `entry: {from, to}` of your parser-items; if absent, entry is at the open of the first candle.

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
(limit)               → [align(now) − limit·step, align(now))
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
- **trailing take** — pullback from peak PnL once `currentProfit ≥ 0`.
- **peak staleness** — peak reached the profit threshold, but went stale for `stalenessSinceMinutes` without a new high (price may never reach the target at all).
- **life-cap** (`staleMinutes`) — ceiling on position lifetime = **empirical impact horizon**, tuned by the grid.
- A stop-out **rolls the metric back to the last positive trailing peak**.

Why this catches stop hunts: a wick into the trap never reaches `trailingTake`, and the pullback hits the hard stop → the label is negative **even if** `close[t+H]` happens to be positive. Path-aware replay sees the whole OHLC path, not just two points.

**Candles and chop.** For each candidate, `labelBurst` requests `1m` candles forward from the event for `staleMinutes·2+5` (buffer for a late entry into the zone). If this exceeds the chunk limit (500), the library **chunks the request itself** (`fetchCandlesChunked`), advancing `since` and deduplicating by timestamp — independent of whether your adapter paginates. Two safety nets:

- **Adapter error** (look-ahead guard at the end of history, a data gap for the symbol — common for meme-coins) is caught: the candidate is skipped, training does not crash. One broken symbol does not bring down the whole `fit`.
- **Truncated horizon.** In a long chop, entry can happen late, and there may not be enough candles left for the full life-cap. Such a label is marked `truncated` and **dropped per-exit** — otherwise a 24h horizon would be compared against a 1h one on a clipped path, corrupting `impactHorizonMinutes`. Shorter horizons of the same candidate are kept.

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
}
```

Default grid (everything is searched empirically — minimal analytical math):

```ts
const DEFAULT_GRID = {
  // detector (authorship matrix)
  windowK:          [2, 3, 5],
  minClusters:      [2, 3],
  jaccardThreshold: [0.2, 0.3, 0.4],
  lagPeakThreshold: [0.4, 0.5, 0.6],
  // prod exit (label set by replay)
  trailingTake:         [0.5, 1.0, 2.0],
  hardStop:             [1.0, 2.0, 3.0],
  stalenessSinceProfit: [1.0],
  stalenessSinceMinutes:[240],
  staleMinutes:         [60, 240, 720, 1440],   // impact horizon: 1h / 4h / 12h / 24h
  // liquidation-cascade detector
  volZThreshold:    [1.5, 2.5],                 // when volume is anomalous
  squeezePolicy:    ["none", "tighten", "veto", "invert"],
  squeezeThreshold: [0.55, 0.7],
  volBaselineWindow:[20],
  cascadeWindowMinutes: [15, 30, 60],           // cascade-detection window — NOT the holding horizon
  // stationarity window (long horizon)
  stationarityWindowMs: [Infinity, 28*24*3600_000, 56*24*3600_000],
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

## Exit tensor `[mode][channel][symbol][direction][volRegime]`

The model does NOT duplicate the stoploss/targets from the post, and does NOT mix exit math across sources. trailing/hardStop/impact-horizon are trained **separately per cell** of the tensor — every channel moves every symbol differently, a long-trap and a short-trap have different dynamics, and anomalous volume requires a tighter trailing.

Per-signal resolution with hierarchical fallback:

```
[mode][channel][symbol][direction][volRegime]   (cell)
  → [mode][symbol][direction]                    (symbol-dir, volRegime collapsed)
  → [mode]                                        (mode)
  → global                                        (root)
```

- **matrix and single are kept separate** — different entry expectancy → different exit.
- **long and short are different cells** (cascade symmetry).
- **calm and anomalous are kept separate** — trailing is tighter in anomalous volume.
- **a new channel with no history** falls back to mode/global — the fallback is trained too, no magic constants.

`p.exitSource` shows which level the exit was resolved from: `cell` | `symbol-dir` | `mode` | `global`.

---

## Liquidation-cascade detector (symmetric long/short)

Stop hunting is symmetric: a short squeeze and a long cascade are mirrors of the same mechanism.

- **short squeeze:** the crowd shorts on leverage → a wall of liquidations above → a cascade of forced buys pushes the price up (against the short).
- **long cascade:** the crowd longs on leverage → a wall of liquidations below → a cascade of forced sells pushes the price down (against the long).

No need to parse leverage — the cumulative effect is visible in `volume`:

- **`volZ`** — the z-score of the entry candle's volume against the baseline. High = the crowd synchronously entered on leverage (fuel accumulated).
- **`squeezePressure`** — the share of volume on candles where price moves **against** the position. Symmetric: for long, "against" = down (a sell cascade); for short, = up (a buy cascade). High = the move is fed by liquidations, not honest flow → a trap.

The reaction (`squeezePolicy`) is tuned by training via CV, or fixed in the grid:

- **none** — a normal entry.
- **tighten** — tighten the trailing, exit before the reversal (`p.trailingTake` is returned already tightened).
- **veto** — don't enter when squeeze pressure is high.
- **invert** — enter AGAINST the post (the strategy from 1028592): a channel posted short → the cascade squeezes upward → `signals` returns a signal with `action: "invert"`, `direction: "long"` (already flipped), and the exit from the inverse cell of the tensor. `origin.invertedFrom` holds the original channel direction.

The calm/anomalous threshold (`volZThreshold`) and the firing threshold (`squeezeThreshold`) are both grid axes.

**Cascade detection window** (`cascadeWindowMinutes`) is a separate axis, NOT tied to the holding horizon `staleMinutes`. A squeeze is a fast event (minutes): measuring it over a 24h window is wrong — a long window smears out a sharp reversal. Previously the detection window was derived from `staleMinutes`, conflating two unrelated concerns (position lifetime and detector sensitivity); now they're independent.

---

## Prod API — single contract

`signals()` returns **only what's executable**. veto (liquidation cascade) never makes it into the output — it's filtered internally. Prod code never writes `if (veto) continue` or looks at flags.

```ts
for (const s of model.signals(liveItems)) {
  openPosition(s.symbol, s.direction, s.exit); // direction is already flipped if inverted
}
```

One signal = one decision. Discriminator `action`, provenance in a single `origin` (not flags):

```ts
interface TradeSignal {
  symbol: string;
  direction: "long" | "short";        // FINAL (inversion already applied)
  action: "enter" | "invert" | "tighten";
  ts: number;
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
  };
}
```

Methods:

```ts
model.signals(items, policy?)                       // no candles: action is always "enter"
model.plan(items, candlesBySymbol, policy?)          // with candles: volRegime, cascade
model.planFor(symbol, dir, channel, candles, policy?)        // live, null on veto
model.planForAt(symbol, dir, channel, candles, ts, policy?)  // backtest, null on veto
```

### Permissions — allow-list, serialized at training time, readonly at runtime

What's allowed (entries/inversions) is fixed at `fit` time and **baked into model.json**. In prod this is readonly — the second argument to `signals()` can only NARROW it, never widen it:

```ts
// at training time — bake the policy into the model:
fit(history, getCandles, { policy: { allow: ["enter", "tighten"] } }); // no inversion

// in prod — narrow it for one call (never wider than trained):
model.signals(items, { allow: ["enter"] });  // direct entries only
```

`allow` without `"invert"` → inversion signals are never returned (treated like veto — don't walk into the trap). This replaced the runtime flags `disableInvert`/`disableSqueeze`: instead of state smeared across training-and-prod, there's one serializable policy with the invariant "execution never permits what training forbade."

---

## Risk-reward (research output + runtime filter)

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

A symbol with no RR statistics is cut conservatively (nothing to confirm it with). `rrMetric`: `mean` (default), `p95`, `p99` — p99 filters by the right tail, keeping symbols with explosive upside.

---

## Stationarity window (long horizon)

On 5 months of data, statistics get corrupted: τ and the author matrix are aggregated over the ENTIRE history, while the regime drifts over that time — channels appear/go quiet, "sibling" pairs break up. One global set averages incomparable periods, and the matrix "remembers" a January correlation in May.

The fix needs no new math: statistics are computed over a local window ending at the current moment. The window size is a grid axis, tuned by `train` via CV:

```ts
stationarityWindowMs: [Infinity, 28*24*3600_000, 56*24*3600_000]
```

`Infinity` = the whole history (old behavior, fine on short data). On a long horizon a finite window wins — it drops stale connections. In `predict`/live, the window is applied automatically to the most recent period up to the latest event. Affects only matrix mode (author matrix); single mode is independent of it.

---

## Training progress bar

`fit`/`train` write progress to stdout **by default** (casual API):

```ts
await PumpMatrix.fit(history, getCandles); // bar is on automatically
// [██████████████░░░░░░░░░░░░░░░░] 47% (42/90) label TRXUSDT
// [██████████████████████████████] 100% (27/27) score 5|0.4|0.6|all
```

Two phases: `label` (slow per-candle labeling, IO-bound) and `score` (grid scoring from cache). Silence or replace it:

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

All five are computed over the stationarity window. In single mode the matrix isn't needed — every post becomes an entry directly.

**Honest auto-diagnostics.** `model.modeReason` explains WHY `single` or `matrix` was chosen — no guessing. Examples: `auto → single: one channel — correlation impossible`, `auto → matrix: 3 strong edges, overlap 5, clusters >1: 2`. Matrix requires ≥2 INDEPENDENT author clusters on the same ticker; echo channels (always firing together) correctly collapse into 1 cluster and don't produce a false matrix signal. On single-channel data it's always single fallback.

---

## License

MIT
