# EURUSD Analyze hold V1

Research-only test of the owner's theory: join the current Analyze trend, hold
losers for up to two weeks without a stop, exit winners on a major pullback.
No broker orders, database writes, automation, or changes to live Analyze.

## Run

From the repository root:

```powershell
npm --workspace api-server run eurusd:analyze-hold:test
npm --workspace api-server run eurusd:analyze-hold -- --since=2025-10-13 --until=2026-10-13
```

The runner reads `api-server/.env` using the existing OANDA history client.
It never uses the client's generated demo candle fallback. Candle snapshots
are kept in this directory's ignored `cache/`; subsequent runs with identical
dates reuse them. To prohibit network access, repeat the exact dates with
`--offline`. `--help` lists every option.

For independently supplied data, use `--input=ABSOLUTE_DIRECTORY`. Files
`M15.json`, `H1.json`, `H4.json`, and `D.json` must contain arrays of the existing
`ResearchCandle` type: timestamp, completion, volume, and numeric mid/bid/ask
OHLC. Include at least 300 preceding primary and higher timeframe candles.
The runner checks requested M15 edge coverage, drops incomplete bars, validates
OHLC, and records input hashes. Interior missing market-open M15 bars are
reported, not filled with synthetic candles.

## Frozen initial interpretation

These are starting assumptions, not optimized or validated parameters:

- **Trend:** import `readMarketFoundation`, the same function used by live
  `analyzeV2`. Buy `UPTREND`, sell `DOWNTREND`; no trade otherwise. Require its
  usable history/quote/timeframe checks. Higher alignment is saved, but does
  not override the primary direction. This does not require Analyze's full
  LONG/SHORT execution checklist, pullback entry, stop, target, or news filter.
- **Modes:** independent accounts. Normal reads M15 structure with H1 context;
  Swing reads H4 structure with daily context. Direction is evaluated only
  while flat at completed primary candles. One position per account; no
  pyramiding, hedging, averaging down, or exit on a trend flip.
- **Entry:** next contiguous M15 opening quote after the trend signal. An
  entry signal expires across a weekend or missing-candle gap. Buy ask, sell
  bid, plus 0.2 pips adverse slippage per side. Daily bars use the next 17:00
  New York roll including DST; unclosed higher candles never enter a snapshot.
- **Loss:** at every M15 close at/after 14 calendar days from the actual fill,
  queue an exit if estimated net P&L is zero or negative. Fill at the next
  available M15 open. Prior profits do not introduce a protective stop. If
  profitable at day 14, keep holding; if it later becomes losing, exit at the
  next available open following detection. Weekend/data gaps can delay exits.
- **Win:** at primary closes, track the best favorable executable close since
  entry. A retreat of at least 1.5 times the primary ATR frozen at the entry
  signal is a major pullback. Exit only if estimated net P&L is still positive,
  at the next M15 open. No fixed target. A gap/slippage can turn the realized
  exit into a loss. Favorable intrabar highs/lows do not create fictitious
  pullback peaks when the ordering within an OHLC bar is unknown.
- **Size:** fixed 10,000 EUR units and $10,000 initial USD equity, independently
  per mode. No compounding and no stop-based risk sizing.
- **Financing:** illustrative 5% annual charge on opening USD notional for
  each direction, accrued by calendar days / 365 including weekends. Both
  rates are configurable; a negative rate represents a credit. This is not
  historical OANDA swaps, rollover timing, or Wednesday triple financing.
- **Commission:** configurable USD per million USD notional per side, default
  zero. Observed bid/ask spreads and configured slippage remain included.
- **Margin:** require opening notional / 30 at entry. A simplified closeout
  occurs when estimated NAV reaches half that opening margin requirement.
  Check every M15 adverse extreme, solve the threshold, and use a worse open
  when a gap crosses it. Margin takes precedence over a queued strategy exit.
  Halt the account afterward; do not conceal negative gap equity. This is a
  scenario model, not a replication of broker jurisdiction/account rules.
- **End:** mark the remaining position to market with estimated exit costs.
  Report it separately; do not count it in closed win rate or profit factor.

The [OANDA candle definitions](https://developer.oanda.com/rest-live-v20/instrument-df/)
and [alignment parameters](https://developer.oanda.com/rest-live-v20/pricing-ep/)
describe timestamps/alignment. Broker NAV, margin, and financing are distinct
fields in [OANDA's account definitions](https://developer.oanda.com/rest-live-v20/account-df/).
The configurable cost/margin assumptions above are estimates, not values
retrieved from a live account.

## Outputs and interpretation

- `REPORT.md`: human-readable results, configuration, and limitations.
- `RESULTS.json`: exact configuration, code/input hashes, complete trade
  ledger with entry trend evidence, cost decomposition, maximum adverse
  excursion, hold duration, realized results, and separate terminal marks.
- `equity-normal.csv` / `equity-swing.csv`: regenerable M15 equity series,
  ignored by Git. Maximum drawdown also includes adverse intrabar NAV against
  prior close-equity peaks, rather than only realized losses.

Profit factor uses **closed net wins / absolute closed net losses**. A null
ratio means no loss denominator; it is accompanied by an explanation.
Win rate can be high while expectancy is negative. Judge net P&L, floating
drawdown, tail losses, and capital tied up alongside win rate.

The first sample runs October 13, 2025 through October 13, 2026 UTC. It is
retrospective and overlaps Analyze's development history; it is not unseen
validation. No threshold selection or parameter sweep is performed. Review
the initial results before changing rules, preserve a separate output
directory for comparisons, and reserve new history for forward evaluation.

## Verification

The focused tests cover long/short symmetry, next-open fills, net costs,
temporary profits followed by losses, exact calendar deadline, delayed fills,
profitable holds past day 14, unclosed/future data exclusion through the actual
Analyze foundation, DST daily closes, margin priority and gap losses,
floating drawdown, and terminal mark accounting.

```powershell
npm --workspace api-server run typecheck
npm --workspace api-server run eurusd:analyze-hold -- --since=2025-10-13 --until=2026-10-13 --offline
```

For a manual ledger check, select a `loss_timeout` trade in `RESULTS.json`:
its exit signal should be at least 14 days after entry and its fill should be
the next available M15 opening bid/ask plus slippage. For `major_pullback`,
the peak-close retreat must reach the fixed entry-ATR threshold while net
P&L at detection is positive. Realized profitability is not guaranteed.

## Stop-loss comparison

The original runner above still defaults to **no stop**. The shared replay
also supports optional fixed pip or entry-ATR stops for research. A separate
sweep preserves this baseline and writes comparisons to
`research-v2/eurusd-analyze-stop-sweep-v1/`:

```powershell
npm --workspace api-server run eurusd:analyze-stop-sweep
```

It tests 1–500 pips in one-pip increments and 0.1–70 entry ATR in 0.1-ATR
increments, in both modes. Every stopped account may reenter on the next
completed primary trend signal, so this is a full strategy replay rather
than trimming the losses from the original trade list. Stops use executable
bid/ask, include slippage and worse gap opens, and are checked on the fill
bar. Drawdown does not include adverse moves after a stop has closed a trade.

The first 75% of the historical period selects a stop by net profit; the
last 25% evaluates that selection in a new flat account. Both portions have
already been viewed in prior research, so these are retrospective stability
checks. Full-sample rankings are explicitly in-sample. New history is needed
before any claim of forward profitability.
