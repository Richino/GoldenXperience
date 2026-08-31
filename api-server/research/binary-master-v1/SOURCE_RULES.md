# Binary Master — Source Rules Audit

Rules gathered from public Binary Master / MT4 bundle descriptions (fxprosystems.com, mickey-kom-lab.com, binarneopcijezarada.com, kuroda-yuusuke.com). **No PinBar.mq4 or SMA CrossOver_Justin.mq4 source exists in GoldenXperience.**

## Classification key

| Tag | Meaning |
|-----|---------|
| **VERIFIED** | Stated consistently across multiple independent write-ups |
| **AMBIGUOUS** | Described but timing/parameters differ |
| **UNVERIFIED** | Not documented; implementation choice required |

---

## Binary Master (combined strategy)

| Rule | Status |
|------|--------|
| Uses exactly two indicators: PinBar + SMA CrossOver Justin | **VERIFIED** |
| CALL when both show bullish arrows | **VERIFIED** |
| PUT when both show bearish arrows | **VERIFIED** |
| Advertised ~70% single-trade win rate | **VERIFIED** (marketing claim; not independently verified) |
| Expiry 3–5 minutes | **VERIFIED** |
| Chart timeframe M5 in most English sources | **VERIFIED** |
| Also described as M1–M5 usable | **AMBIGUOUS** |
| PinBar arrow first, SMA arrow within a few seconds after | **AMBIGUOUS** |
| Entry on overlapping arrows / next candle after overlap | **AMBIGUOUS** (Japanese review: entry on candle after yellow+green/red overlap) |
| Martingale suggested by author (≤3 losses) | **VERIFIED** (secondary; excluded from primary test) |
| Avoid high-impact news | **VERIFIED** (discretionary filter; not automated here) |

---

## PinBar indicator

| Rule | Status |
|------|--------|
| Shows yellow up / down arrows on pin bars | **VERIFIED** (visual only) |
| Exact wick/body thresholds in .ex4 | **UNVERIFIED** (binary only; no .mq4 in repo) |
| Standard pin bar: long rejection wick, small body, close near opposite end | **VERIFIED** (generic pin bar definition) |

### Frozen implementation (pre-registered, not optimized on results)

Applied to **completed** bar `i`:

- `range = high - low`; require `range >= 0.30 × ATR(14)`
- `body = |close - open|`; require `body / range <= 0.35`
- Bullish pin: `lowerWick / range >= 0.55` AND `closeLocation >= 0.60`
- Bearish pin: `upperWick / range >= 0.55` AND `closeLocation <= 0.40`

---

## SMA CrossOver Justin

| Rule | Status |
|------|--------|
| Arrow indicator based on two SMAs crossing | **VERIFIED** |
| Green up arrow = bullish / CALL | **VERIFIED** |
| Red down arrow = bearish / PUT | **VERIFIED** |
| Default periods 12 and 26 (multiple FX sites) | **AMBIGUOUS** (common default, not in Binary Master bundle docs) |
| Alternative user report: fast=1, slow=240, period=5 | **AMBIGUOUS** |
| Some MT4 builds may repaint (alert without arrow) | **VERIFIED** (forum reports) |

### Frozen primary implementation (STRICT_NON_REPAINTING)

- SMA type: **Simple** moving average on **close**
- Fast period: **12**, slow period: **26**
- Bullish signal at bar `i` close iff `SMA12[i-1] <= SMA26[i-1]` AND `SMA12[i] > SMA26[i]`
- Bearish signal at bar `i` close iff `SMA12[i-1] >= SMA26[i-1]` AND `SMA12[i] < SMA26[i]`
- Signal never revised after bar `i` completes

---

## Combined signal timing (STRICT_NON_REPAINTING primary)

| Step | Status |
|------|--------|
| PinBar and SMA signals evaluated on same completed bar `T` | **AMBIGUOUS** vs “few seconds later”; chosen as strict causal default |
| Entry at **open of bar T+1** | **VERIFIED** (causal; no use of T's forming wick/body) |
| Settlement at entry + expiry minutes using M1 close | **VERIFIED** (standard binary replay) |

---

## This experiment vs original marketing

| Aspect | Original claim | This test |
|--------|----------------|-----------|
| Timeframe | M5 | **M1** (per experiment spec) |
| Pairs | Any | 12 GoldenXperience majors |
| Data | Broker chart | OANDA M1 mid OHLC |
| 70% WR | Stated | **Tested**, not assumed |
