# Per-asset training grids

This folder holds one `*-grid.mjs` per asset — a tuned `TrainGrid` plus the `PumpMatrix.fit(...)` call it was meant to be run with. The defaults in [`src/train.ts`](../src/train.ts) (`DEFAULT_GRID`) are a deliberately small, asset-agnostic grid; these files specialize it to **how each coin actually pumps**.

> These grids are an **informed starting point**, not backtested optimal values. The grid only defines *what the search may try*; the winner is still chosen by `fit` via time-series K-fold + the one-standard-error rule, and whether the result is tradeable is decided by `model.certification`. A grid tuned to an asset's regime makes the search look in the right place — it does not bypass the statistical gates.

---

## How the grids were derived

The model groups everything by ticker (`symbol|direction`) and searches the **Cartesian product** of the grid. So the grid's job is to bracket, per asset, the ranges where that asset's pumps live. Each axis was set from one observable property of the asset's behavior:

| Axis | What it controls | Tuned by |
|---|---|---|
| `staleMinutes` | holding horizon / life-cap (impact horizon) | **how long pumps last** — minutes for memecoins, many hours/days for BTC |
| `hardStop` / `trailingTake` | exit tightness | **volatility & depth of pullbacks** — tight for memes, wide for majors |
| `cascadeWindowMinutes` | liquidation-cascade detection window | **how fast squeezes develop** — instant on memes, slow on majors |
| `jaccardThreshold` / `lagPeakThreshold` / `windowK` | author-matrix strictness | **channel noise** — loose where there's spam, strict where channels are few but clean |
| `volZThreshold` / `volBaselineWindow` | volume-anomaly sensitivity | **how quickly real volume shows up** |
| `stationarityWindowMs` | author-matrix lookback | **how fast the channel regime drifts** — days for memes, months for BTC |
| `squeezePolicy` | reaction to a cascade | memes keep `invert` (aggressive squeezes); majors drop it (`none/tighten/veto`) |

Two `fit`-level knobs track the same axis:
- `shrinkageK` (objective shrinkage toward zero) — **higher for noisy/fat-tailed assets** (Fartcoin 8, HYPE 7) so a few lucky trades don't win.
- `viability` (`minSharedEvents` / `minPeakShare` / `minStrongEdges`) — **stricter for clean assets** with few-but-good channels (BTC 5/0.62/2), looser for noisy memes (3/0.50).

The unifying axis is **pump speed → everything else follows**: faster asset ⇒ shorter horizons, tighter stops, shorter cascade windows, shorter stationarity, looser matrix, more aggressive squeeze handling. The files are sorted below from fastest to slowest.

---

## Summary — behavior & grid per asset

| File | Asset | Pump speed | `staleMinutes` | `hardStop` % | `cascadeWindow` | Noise | Matrix strictness | Notes on behavior |
|---|---|---|---|---|---|---|---|---|
| [`fartcoin-grid.mjs`](fartcoin-grid.mjs) | Fartcoin | Very fast | 25m – 4h | 0.65–2.0 | 8–40m | Very high | Low | Solana memecoin; spikes and dumps in minutes, brutal stop-hunts. Tightest stops, highest squeeze sensitivity, `shrinkageK: 8`. |
| [`hype-grid.mjs`](hype-grid.mjs) | HYPE | Very fast | 30m – 4h | 0.7–2.0 | 8–40m | High | Low | Fast volatile Solana meme; frequent squeezes. Short horizons, sensitive detector, `shrinkageK: 7`. |
| [`solana-grid.mjs`](solana-grid.mjs) | Solana (SOL) | Fast | 45m – 8h | 0.8–2.5 | 10–40m | High | Low–Med | Many channels, many "sibling" families (easily deduped), fast moves; added `hardStop: 0.8` for sharp dumps. |
| [`tron-grid.mjs`](tron-grid.mjs) | TRX | Medium | 1.5h – 15h | 1.0–3.0 | 18–110m | Medium | Medium | Reacts to news & broad market; fewer junk channels than pure memes. |
| [`gram-grid.mjs`](gram-grid.mjs) | TON | Medium-fast | 1h – 12h | 1.0–3.0 | 15–90m | Medium | Medium | Telegram-native ⇒ many channels, often high synchrony; regime drifts faster than ETH. |
| [`doge-grid.mjs`](doge-grid.mjs) | DOGE | Medium | 1.5h – 16h | 1.1–3.2 | 20–120m | Medium+ | Medium+ | Large liquid asset, social-media driven (X/Twitter); powerful but longer pumps, deeper pullbacks. |
| [`bnb-grid.mjs`](bnb-grid.mjs) | BNB | Medium | 3h – 24h | 1.2–3.5 | 25–160m | Medium | Medium+ | Binance-linked, often news-driven (burn/launchpad); big real volume, moderate volatility. |
| [`ethereum-grid.mjs`](ethereum-grid.mjs) | Ethereum | Slow | 2h – 24h | 1.2–3.5 | 20–90m | Low | High | Real capital, less manipulative noise; fewer but better channels. `invert` dropped by default. |
| [`ripple-grid.mjs`](ripple-grid.mjs) | Ripple (XRP) | Medium-slow | 3h – 24h | 1.3–4.0 | 30–180m | Low–Med | High | Institutional tilt, news/regulation driven (SEC, partnerships); deeper but smoother moves. |
| [`litecoin-grid.mjs`](litecoin-grid.mjs) | Litecoin (LTC) | Medium-slow | 4h – 30h | 1.3–3.8 | 35–220m | Low–Med | High | BTC-correlated, mature; long holds, less chaotic noise. |
| [`zec-grid.mjs`](zec-grid.mjs) | Zcash (ZEC) | Medium-slow | 4h – 28h | 1.4–4.2 | 30–200m | Low–Med | High | Privacy coin, news-driven (listings/regulation); moves can be sharp, decent reaction to broad market. |
| [`stellar-grid.mjs`](stellar-grid.mjs) | Stellar (XLM) | Medium-slow | 4h – 30h | 1.4–4.0 | 40–240m | Low | High | Mature, Ripple-like; mostly news/fundamental pumps, little spam. Long horizons. |
| [`link-grid.mjs`](link-grid.mjs) | Chainlink (LINK) | Medium-slow | 5h – 32h | 1.4–4.0 | 35–240m | Low–Med | High | Oracle project, integration/partnership driven; "quality" moves with visible pullbacks. |
| [`dot-grid.mjs`](dot-grid.mjs) | Polkadot (DOT) | Medium-slow | 5h – 36h | 1.5–4.2 | 40–260m | Low–Med | High | Layer-0, governance/parachain driven; slow-developing, long-lived pumps. |
| [`btc-grid.mjs`](btc-grid.mjs) | Bitcoin (BTC) | Slow | 6h – 48h+ | 1.8–5.0 | 45–300m | Low | Very high | Most mature; macro/fundamental, almost no meme noise. Widest stops, longest stationarity (1–6 months), strictest matrix (`minSharedEvents: 5`). |

`hardStop` / `staleMinutes` columns show the **range spanned by the grid** for that asset, not a single value — `fit` picks within it.

---

## Reading the speed → parameter logic

- **Memecoins (Fartcoin, HYPE, SOL):** pumps die in minutes, squeezes are instant, channels are noisy and full of sibling spam. → short `staleMinutes`, short `cascadeWindowMinutes`, tight `hardStop`, **loose** matrix thresholds (to catch fast bursts through the noise), short `stationarityWindowMs` (days), `invert` kept, high `shrinkageK`, refit every few days.
- **Mid-tier (TRX, TON, DOGE, BNB):** hours-long pumps, moderate noise. → balanced everything; matrix "medium".
- **Majors / fundamentals (ETH, XRP, LTC, ZEC, XLM, LINK, DOT, BTC):** slow news-driven moves, deep-but-smooth pullbacks, few clean channels. → long `staleMinutes` (up to 24–48h), wide `hardStop`, long `cascadeWindowMinutes`, **strict** matrix (high `jaccard`/`lagPeak`, `minSharedEvents` 4–5, `minStrongEdges` 2), long `stationarityWindowMs` (weeks–months), `invert` usually dropped (`["none","tighten","veto"]`), refit every 2–8 weeks.

---

## Fartcoin ([`fartcoin-grid.mjs`](fartcoin-grid.mjs))

A classic HYPE-style Solana memecoin: very fast, noisy, highly volatile, with sharp pumps and frequent dumps/stop-hunts. The grid is aggressive and short-lived.

**Why this grid for Fartcoin:**
- Very short horizons — Fartcoin pumps often spike and collapse within minutes to hours.
- Low detector thresholds — so fast bursts aren't missed in the noise.
- Hard reaction to squeeze — on such coins liquidation cascades happen in a flash.
- Fine step on takes and stops — for a better fit to the extreme volatility.

**In prod:** `minRiskReward` 2.0–2.5 (very risky asset); refit every 3–5 days (Fartcoin lives fast); always use `plan()` with `getCandles` — squeeze detection is critical; expect a lot of veto/invert. `folds: 5`, `shrinkageK: 8` (strong shrinkage due to outliers), `maxBurstWindowMs` 1.5h.

---

## HYPE ([`hype-grid.mjs`](hype-grid.mjs))

A classic fast Solana memecoin with high volatility, sharp bursts, and frequent stop-hunts. Needs a more aggressive and fast grid.

**Why this grid for HYPE:**
- Short horizons (`staleMinutes` 30–240 min) — HYPE pumps often live from 20 minutes to 3–4 hours.
- More sensitive detector — HYPE has a lot of noise and fast bursts.
- Harder reaction to cascade — the squeeze on memecoins is very aggressive.
- Fine step on `trailingTake` and `hardStop` — lets it tune better to HYPE's volatility.
- Smaller stationarity window — channel behavior around HYPE changes very fast.

**In prod:** refit more often — every 3–7 days (but not more often, the meta-ledger won't allow it); use `plan()`, not `signals()` — the cascade is critical on HYPE; monitor `model.certification` — if `certified: false`, better not to trade HYPE with this model; filter `minRiskReward: 1.8` or higher. `folds: 5`, `shrinkageK: 7` (fat outliers), `maxBurstWindowMs` 45 min.

---

## Solana ([`solana-grid.mjs`](solana-grid.mjs))

The baseline Solana grid (my balance for Solana memecoins). Solana has very many channels and high pump speed, many "sibling" channels (easily filtered out), fast moves → synchronous bursts are clearly visible.

**Why this grid:**
- `staleMinutes` — added 45 and 480 min: catches fast and medium pumps better.
- `hardStop` — added 0.8: protection against strong dumps on a very volatile Solana.
- `cascadeWindowMinutes` shifted down (10–40) — cascades on Solana happen fast.
- `jaccardThreshold` extended down to 0.25 — more noise → needs to filter more softly.
- `volBaselineWindow` — added 15: reacts to a volume spike faster.
- `stationarityWindowMs` — added 4 days: Solana changes very fast.

**In prod:** `folds: 4`, `shrinkageK: 6` (slightly stronger shrinkage), `mode: "auto"`, `viability` slightly stricter on matrix quality (`minSharedEvents: 4`, `minPeakShare: 0.55`). The grid yields ~4500–6500 combinations; training on 3–4 months of data ~40–90 seconds.

---

## TRX / Tron ([`tron-grid.mjs`](tron-grid.mjs))

A medium-speed asset. Not as frantic as Fartcoin/HYPE, but not as calm as Ethereum either. Pumps usually last from 1 to 12–18 hours, with good volume and moderate noise.

**Why this grid for TRX:**
- Duration — `staleMinutes` from 1.5 to 15 hours, covers most real TRX pumps.
- Balanced tightness — stops and takes wider than Fartcoin's, but tighter than Ethereum's.
- Medium sensitivity — TRX has fewer junk channels than pure Solana memes, so thresholds are a bit higher.
- Good cascade reaction — liquidations happen on TRX but don't develop instantly.

**In prod:** `minRiskReward` 1.8–2.3; refit every 7–10 days; use `plan()` — squeeze detection works well on TRX; TRX often reacts to news and the broad market, so matrix mode usually triggers reliably with 3+ channels. `folds: 4`, `shrinkageK: 6`, `maxBurstWindowMs` 5h.

---

## TON ([`gram-grid.mjs`](gram-grid.mjs))

An intermediate case between Solana (very fast) and Ethereum (slower).

**TON specifics:**
- Strong Telegram integration → many channels, but quality varies.
- Pumps often last from 1 to 12 hours (rarely 30 minutes, rarely several days).
- Good liquidity on some tokens, but there can be sharp cascades.
- Many Telegram-oriented projects, so channel synchrony is often high.
- The regime changes faster than on Ethereum, but slower than on Solana.

**Why this grid for TON:**
- `staleMinutes` 1h–12h — the main pump duration on TON.
- `hardStop` 1.0–3.0% — balance between protection and room.
- `cascadeWindowMinutes` 15–90 min — cascades are faster than on ETH.
- `jaccardThreshold` 0.25–0.45 — medium noise level.
- `stationarityWindowMs` 5–42 days — TON changes faster than ETH but slower than Solana.
- `trailingTake` — a denser step, good granularity for different move types.

**In prod:** `minRiskReward` 1.7–2.0 (TON less explosive than Solana); refit every 5–10 days; always use `plan()` + `getCandles`; watch `model.mode` — on TON matrix mode should trigger more often than on Ethereum. `folds: 4`, `shrinkageK: 6`, `maxBurstWindowMs` 3h.

---

## DOGE ([`doge-grid.mjs`](doge-grid.mjs))

No longer a small memecoin but a large, liquid asset with strong social-media influence (especially Twitter/X). Pumps can be very powerful, but last longer (from several hours to 1–3 days), with large volumes and less sharp but deeper moves.

**Why this grid for DOGE:**
- Pump duration — `staleMinutes` from 1.5 to 16 hours. DOGE pumps rarely end in 30–60 minutes.
- Wider stops and takes — DOGE can make strong pullbacks even during a rally.
- Medium detector sensitivity — DOGE has fewer "junk" channels than Solana, but more than Ethereum.
- Longer cascade windows — liquidations on DOGE don't develop as instantly as on small Solana tokens.
- Stationarity — DOGE is relatively stable compared to new memecoins.

**In prod:** `minRiskReward` 1.8–2.2 (DOGE gives more stable moves); refit every 7–12 days; always use `plan()` (candle analysis is very useful on DOGE). `folds: 4`, `shrinkageK: 6`, `maxBurstWindowMs` 6h.

---

## BNB / Binance Coin ([`bnb-grid.mjs`](bnb-grid.mjs))

A large, liquid coin strongly tied to Binance. Medium-duration pumps (from 4–6 hours to 1–2 days), often news-driven (burn, launchpad, Binance updates), less chaotic spam than on Solana but more influence from large players, good volumes, moderate volatility.

**Why this grid for BNB:**
- Medium horizons — BNB pumps are rarely as ultra-fast as on memecoins, but also not as long as on Ethereum.
- Wide stops and takes — the coin can make deep but relatively smooth pullbacks.
- Balanced strictness — BNB has less noise than Solana, but more than XRP/Stellar.
- Good volume sensitivity — BNB has high real volumes, so `volZ` thresholds are a bit higher.
- Fairly long stationarity — behavior around BNB changes not very fast.

**In prod:** `minRiskReward` 2.0–2.6; refit every 10–14 days; both matrix mode and single work well (single on strong news); `plan()` is especially useful — squeeze detection helps avoid false entries before big dumps. `folds: 4`, `shrinkageK: 6`, `maxBurstWindowMs` 8h.

---

## Ethereum ([`ethereum-grid.mjs`](ethereum-grid.mjs))

A completely different story than HYPE/Solana.

**Why Ethereum is a different story:**
- Pumps go slower and last longer (hours, not minutes).
- More real capital, less pure manipulative noise.
- Fewer channels, but usually higher quality.
- Liquidation cascades are less sharp, but can be deeper.
- Requires a more conservative, longer-term approach.

**Key differences from Solana/HYPE:** `staleMinutes` 2–24h (vs 30–240 min) — longer-term moves; `hardStop` 1.2–3.5% (vs 0.7–2.0%) — more room for pullbacks; `cascadeWindowMinutes` 20–90 min (vs 8–40) — cascades develop slower; `jaccardThreshold` higher (0.28+) — a stronger match is required; `stationarityWindowMs` 2–12 weeks — the regime changes slower; `squeezePolicy` without `invert` by default — inversion works well less often.

**In prod:** `minRiskReward` from 2.0 and up; refit every 10–14 days; use `plan()` with real candles more often — volume and squeeze matter; watch `model.modeReason` — on Ethereum matrix mode should trigger more often given several quality sources. `folds: 4`, `shrinkageK: 5`, stricter `viability` (`minSharedEvents: 4`, `minPeakShare: 0.58`, `minStrongEdges: 2`), `maxBurstWindowMs` 4h.

---

## Ripple / XRP ([`ripple-grid.mjs`](ripple-grid.mjs))

A large, relatively calm coin with an institutional tilt. Pumps are longer and smoother (from several hours to 1–3 days), more often tied to news, partnerships, or regulation, less pure spam and manipulation than on Solana, deeper but less sharp moves. The grid is conservative and long-term.

**Why this grid for Ripple:**
- Long horizons — XRP pumps rarely end in 1–2 hours.
- Wider stops and takes — the coin can make significant pullbacks even in a rising trend.
- Stricter detector — XRP has fewer channels, but they're usually higher quality, so thresholds go up.
- Softer reaction to squeeze — cascades on a large coin are less sudden.
- Long stationarity — behavior around Ripple changes slower.

**In prod:** `minRiskReward` 2.0–2.5+; refit every 10–20 days; `signals()` (no candles) can be used more often, but `plan()` is still preferable; matrix mode works especially well on strong news drivers (SEC, partnerships). `folds: 4`, `shrinkageK: 5`, `viability` (`minSharedEvents: 4`, `minPeakShare: 0.60`, `minStrongEdges: 2`), `maxBurstWindowMs` 12h.

---

## Stellar / XLM ([`stellar-grid.mjs`](stellar-grid.mjs))

A mature, relatively calm coin, similar in character to Ripple (XRP).

**Stellar specifics:**
- Pumps are more often news-driven / fundamental.
- Moves are slower and longer than on Solana.
- Less noise and spam in Telegram channels.
- Moderate volatility, less sharp cascades.
- Long holding horizons work better.

**Why this grid for Stellar:**
- Long horizons — XLM pumps often last from 4 hours to a day or more.
- Wide stops and takes — lets it ride out normal pullbacks.
- High detector thresholds — Stellar has fewer channels, but their signals are higher quality.
- Soft reaction to cascade — there are fewer sharp liquidation squeezes than on memecoins.
- Long stationarity — behavior around Stellar changes slowly.

**In prod:** `minRiskReward` 2.2–2.8 (one of the "cleanest" assets on the list); refit every 2–3 weeks; `signals()` (no candles) can be relied on more often, but `plan()` is still better; matrix mode works well on strong news (partnerships, protocol upgrades). `folds: 4`, `shrinkageK: 5`, `viability` (`minSharedEvents: 4`, `minPeakShare: 0.62`, `minStrongEdges: 2`), `maxBurstWindowMs` 18h.

---

## Litecoin / LTC ([`litecoin-grid.mjs`](litecoin-grid.mjs))

A classic, mature coin behaving closer to Bitcoin than to memecoins. Pumps are fairly long (from 6–12 hours to 1–3 days), often move in tandem with BTC, less chaotic noise, more real capital, moderate volatility but possibly deep pullbacks.

**Why this grid for Litecoin:**
- Long holding horizons — LTC pumps rarely end fast.
- Wide stops and takes — lets it withstand normal corrections.
- Strict detector — LTC has less spam, so signal-quality thresholds go up.
- Soft reaction to cascade — fewer sharp liquidation squeezes than on memecoins.
- Long stationarity — behavior around LTC changes slowly.

**In prod:** `minRiskReward` 2.1–2.7 (one of the most "reliable" altcoins); refit every 2–4 weeks; matrix mode works well on strong BTC moves; always use `plan()` — volume and squeeze analysis help filter out false breakouts. `folds: 4`, `shrinkageK: 5`, `viability` (`minSharedEvents: 4`, `minPeakShare: 0.60`, `minStrongEdges: 2`), `maxBurstWindowMs` 18h.

---

## Zcash / ZEC ([`zec-grid.mjs`](zec-grid.mjs))

A privacy coin with medium liquidity and fairly high volatility. Pumps are more often news-driven (protocol upgrades, listings, regulatory news), duration usually from 4–8 hours to 1–2 days, less spam than on Solana but moves can be sharp, good reaction to the broad crypto market.

**Why this grid for Zcash:**
- Medium-long horizons — ZEC pumps are rarely ultra-fast.
- Wide stops — ZEC can make fairly deep pullbacks.
- Strict detector — there aren't many channels, so signal-quality requirements go up.
- Moderate squeeze sensitivity — cascades happen but aren't as instant as on memecoins.
- Long stationarity — behavior around ZEC changes relatively slowly.

**In prod:** `minRiskReward` 2.0–2.6; refit every 12–20 days; matrix mode works well on strong news; always use `plan()` — volume analysis helps filter out weak moves. `folds: 4`, `shrinkageK: 6`, `viability` (`minSharedEvents: 4`, `minPeakShare: 0.58`, `minStrongEdges: 2`), `maxBurstWindowMs` 12h.

---

## Chainlink / LINK ([`link-grid.mjs`](link-grid.mjs))

A serious fundamental project (oracle) with mid-cap. Pumps are tied to news (partnerships, upgrades, integrations), last from 6–12 hours to 1–3 days, good liquidity, less pure spam, more "quality" moves but with noticeable pullbacks.

**Why this grid for Chainlink:**
- Long horizons — LINK pumps rarely explode and fade in 1–2 hours.
- Wide exit parameters — lets it ride out normal corrections.
- High quality thresholds — LINK has fewer junk channels, signals usually from more reliable sources.
- Moderate cascade sensitivity — sharp liquidations happen but aren't as frequent or aggressive as on memecoins.
- Long stationarity — behavior around Chainlink changes relatively slowly.

**In prod:** `minRiskReward` 2.2–2.8 (one of the most "quality" assets); refit every 2–4 weeks; matrix mode works especially well on strong news (new integrations, CCIP); always use `plan()` — volume and squeeze analysis help filter weak moves. `folds: 4`, `shrinkageK: 5`, `viability` (`minSharedEvents: 4`, `minPeakShare: 0.60`, `minStrongEdges: 2`), `maxBurstWindowMs` 24h.

---

## Polkadot / DOT ([`dot-grid.mjs`](dot-grid.mjs))

A large fundamental project (Layer-0). Pumps are news-driven and fundamental (parachains, auctions, upgrades, governance), duration from 8–12 hours to 2–3 days, good liquidity, less spam, more meaningful capital, moves are often accompanied by pullbacks but less chaotic than on memecoins.

**Why this grid for Polkadot:**
- Long horizons — DOT pumps usually develop slowly and live long.
- Wide stops and takes — the coin can make significant corrections.
- High quality thresholds — Polkadot has fewer junk channels, signals more often from serious sources.
- Soft reaction to cascade — fewer sharp liquidation squeezes.
- Very long stationarity — the Polkadot ecosystem changes relatively slowly.

**In prod:** `minRiskReward` 2.2–2.8 (a fairly quality asset); refit every 3–5 weeks; matrix mode works especially well on important ecosystem events (new parachains, governance votes); always use `plan()` — volume analysis helps filter out weak news. `folds: 4`, `shrinkageK: 5`, `viability` (`minSharedEvents: 4`, `minPeakShare: 0.61`, `minStrongEdges: 2`), `maxBurstWindowMs` 36h.

---

## Bitcoin / BTC ([`btc-grid.mjs`](btc-grid.mjs))

The most mature and largest asset. Practically no "meme" noise; moves are more often fundamental and macroeconomic.

**BTC specifics:**
- Pumps/rallies last from 12 hours to several days/weeks.
- Very high liquidity.
- Deep but relatively smooth corrections.
- Channel signals are usually less spammy, but may lag.
- Requires the most conservative, longest-term approach.

**Why this grid for Bitcoin:**
- Very long horizons — BTC moves rarely end in a few hours.
- Wide stops and takes — lets it ride out normal 5–10% market corrections.
- High thresholds — on BTC signals must be genuinely strong and aligned.
- Soft reaction to cascade — liquidations on BTC happen, but not as sharply as on altcoins.
- Maximum stationarity — the BTC regime changes slowly.

**In prod:** `minRiskReward` 2.3–3.0+ (one of the "cleanest" assets); refit every 4–8 weeks; matrix mode works great on strong macro news; `plan()` is especially useful — volume analysis helps tell a real impulse from a false breakout. `folds: 5`, `shrinkageK: 6`, the strictest `viability` (`minSharedEvents: 5`, `minPeakShare: 0.62`, `minStrongEdges: 2`), `maxBurstWindowMs` 48h.

---

## Running a grid

Each `.mjs` defines a grid and the intended `fit(...)` options (`folds`, `shrinkageK`, `mode`, `maxBurstWindowMs`, `viability`). They assume `PumpMatrix`, `history`, and `getCandles` are in scope — wire in your own data source:

```ts
import { PumpMatrix } from "pump-anomaly";
// ... build history: ParserItem[] and getCandles for the asset ...
// then run the grid + options from the matching *-grid.mjs

const model = await PumpMatrix.fit(history, getCandles, {
  grid: SOLANA_GRID,
  folds: 4, shrinkageK: 6, mode: "auto",
  viability: { minSharedEvents: 4, minPeakShare: 0.55 },
});

if (!model.certification.certified) {
  console.warn("not certified — do NOT trade this model:", model.certification?.reasons);
}
```

The unifying principle across all grids is **pump speed → everything else**: the faster the asset, the shorter the horizons (`staleMinutes`), the tighter the stops (`hardStop`), the shorter the cascade window (`cascadeWindowMinutes`), the shorter the stationarity (`stationarityWindowMs`), the looser the matrix thresholds (more noise → catch through it), the more aggressive the squeeze reaction (`invert` kept on memes, dropped on majors), the stronger the `shrinkageK` on noisy assets, and the more frequent the refit.
