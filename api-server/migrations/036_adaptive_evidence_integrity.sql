-- Adaptive evidence integrity.
--
-- The prerequisite audit found that the adaptive engine's evidence is not
-- trustworthy yet, for four separate reasons. This migration adds the columns
-- and one table needed to fix them. It is strictly ADDITIVE: no existing column
-- is dropped or rewritten, no historical row is altered here, and no strategy,
-- risk or execution behaviour changes. The repair itself is done by the
-- idempotent `npm run research:repair-forex-adaptive-evidence` command, so the
-- schema change and the data change can be reviewed separately.
--
-- 1. EXECUTED TRADES FILED AS BLOCKED SHADOW CANDIDATES.
--    48 of 55 multi-strategy trades exist in paper_strategy_evaluations with
--    paper_trade_id NULL / trade_created false / execution_status 'blocked',
--    because the evaluation row used to be written AFTER openPaperTrade, so the
--    UPDATE that stamps the execution matched zero rows. resolveShadowCandidates
--    then computed a HYPOTHETICAL outcome for opportunities that were really
--    traded, and loadAdaptiveEvidence counted both copies.
--
--    The link is repaired by giving the trade its own evaluation_id, so "was
--    this opportunity executed?" becomes a foreign key rather than an inference
--    from three matched columns. The stale shadow rows are NOT deleted — they
--    are marked superseded, which keeps the audit trail intact and lets the
--    evidence loader exclude them without destroying anything.
--
-- 2. ORIGINAL vs INVERTED MOMENTUM IS NOT PAIRED.
--    momentum-inversion-v1 REPLACES the direction, so only one arm is ever
--    executed and the other arm gets no counterfactual at all (shadow resolution
--    only labels suppressed/blocked candidates, and the executing path promotes
--    the row to 'selected'). momentum_inversion_arms holds both arms of the same
--    opportunity under one stable pair id: at most one is executed, the other is
--    resolved as a shadow. Deliberately NOT read by the evidence loader, exactly
--    like momentum_short_inversion_pairs, so a research record can never
--    influence live selection.
--
-- 3. NEWS VERDICT NOT PERSISTED STRUCTURALLY.
--    news_status reads 'not_evaluated' on all 55 multi-strategy trades even
--    though the hard news gate ran and passed on all 55 — the verdict only
--    survived inside the conditions JSONB. The forward fix is in
--    strategy-common.ts; these columns record the news EVALUATION STATE beside
--    the tag, so "no news" and "no calendar" stop looking identical.
--
-- 4. COSTS ARE NOT EXPRESSED IN R.
--    spread_pips is stored on every trade but never converted, so nothing can
--    say how much of the loss is friction. The cost columns decompose it. Note
--    what the audit of the resolvers actually showed: the stored result_r is
--    ALREADY net of spread, because entry is taken on the executable side (ask
--    for a long, bid for a short) and labelOutcome resolves the exit against the
--    opposite side of the book. So net_result_r equals result_r by construction
--    and gross_result_r is the reconstruction, not the other way round. These
--    columns make that decomposition explicit and testable rather than implicit.

-- ---------------------------------------------------------------------------
-- 1. Canonical executed link
-- ---------------------------------------------------------------------------

ALTER TABLE paper_strategy_trades
  ADD COLUMN IF NOT EXISTS evaluation_id uuid REFERENCES paper_strategy_evaluations(id) ON DELETE SET NULL;

-- One evaluation can back at most one trade. This is the invariant that makes
-- "executed" and "shadow" mutually exclusive at the database rather than by
-- convention in application code.
CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_trades_evaluation_unique_idx
  ON paper_strategy_trades(evaluation_id) WHERE evaluation_id IS NOT NULL;

-- Marks a shadow outcome that turned out to belong to an opportunity that was
-- really traded. Kept rather than deleted: the row is evidence of the defect and
-- of the repair, and a DELETE would make the repair unauditable.
ALTER TABLE shadow_candidate_outcomes
  ADD COLUMN IF NOT EXISTS superseded_by_trade_id uuid REFERENCES paper_strategy_trades(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_reason text;

CREATE INDEX IF NOT EXISTS shadow_candidate_outcomes_live_idx
  ON shadow_candidate_outcomes(evaluation_id) WHERE superseded_by_trade_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Cost decomposition, in R
-- ---------------------------------------------------------------------------

ALTER TABLE paper_strategy_trades
  -- The spread actually crossed, expressed in the trade's own risk unit:
  -- spread_pips * pipSize / |entry - stop|. Always positive.
  ADD COLUMN IF NOT EXISTS spread_cost_r numeric,
  -- NULL means UNKNOWN, never zero. OANDA's trade endpoint does not report
  -- commission or financing and none is stored, so asserting 0 would be a
  -- fabrication; the repair leaves these null and reports the count.
  ADD COLUMN IF NOT EXISTS commission_cost_r numeric,
  ADD COLUMN IF NOT EXISTS slippage_cost_r numeric,
  ADD COLUMN IF NOT EXISTS total_cost_r numeric,
  ADD COLUMN IF NOT EXISTS gross_result_r numeric,
  ADD COLUMN IF NOT EXISTS net_result_r numeric,
  -- Which components total_cost_r actually contains, so a partial figure is
  -- never mistaken for a complete one.
  ADD COLUMN IF NOT EXISTS cost_basis text,
  -- Where result_r came from. A broker close derives R from the cash OANDA
  -- booked (carrying real exit slippage); a paper close derives it from the
  -- modelled level. Pooling the two without a marker mixes measurement regimes.
  ADD COLUMN IF NOT EXISTS result_basis text;

ALTER TABLE paper_strategy_trades DROP CONSTRAINT IF EXISTS paper_strategy_trades_cost_basis_check;
ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_cost_basis_check
  CHECK (cost_basis IS NULL OR cost_basis IN ('spread_only', 'spread_and_broker', 'unknown'));

ALTER TABLE paper_strategy_trades DROP CONSTRAINT IF EXISTS paper_strategy_trades_result_basis_check;
ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_result_basis_check
  CHECK (result_basis IS NULL OR result_basis IN ('broker', 'model', 'unknown'));

-- The same decomposition on the counterfactual arm, so shadow and executed
-- observations are comparable on cost as well as on outcome.
ALTER TABLE shadow_candidate_outcomes
  ADD COLUMN IF NOT EXISTS spread_cost_r numeric,
  ADD COLUMN IF NOT EXISTS total_cost_r numeric,
  ADD COLUMN IF NOT EXISTS gross_result_r numeric,
  ADD COLUMN IF NOT EXISTS net_result_r numeric,
  ADD COLUMN IF NOT EXISTS cost_basis text;

ALTER TABLE shadow_candidate_outcomes DROP CONSTRAINT IF EXISTS shadow_candidate_outcomes_cost_basis_check;
ALTER TABLE shadow_candidate_outcomes
  ADD CONSTRAINT shadow_candidate_outcomes_cost_basis_check
  CHECK (cost_basis IS NULL OR cost_basis IN ('spread_only', 'spread_and_broker', 'unknown'));

-- ---------------------------------------------------------------------------
-- 3. News evaluation state
-- ---------------------------------------------------------------------------

ALTER TABLE paper_strategy_trades
  -- Whether the news TAG can be believed. Distinct from the tag itself, and
  -- distinct from news_status, which is the decision-time GATE verdict.
  ADD COLUMN IF NOT EXISTS news_evaluation_state text,
  -- How many calendar events were stored anywhere near this trade. 0 with a
  -- NO_NEWS tag is exactly the case that must never read as confirmed quiet.
  ADD COLUMN IF NOT EXISTS news_calendar_events_nearby integer;

ALTER TABLE paper_strategy_trades DROP CONSTRAINT IF EXISTS paper_strategy_trades_news_evaluation_state_check;
ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_news_evaluation_state_check
  CHECK (news_evaluation_state IS NULL OR news_evaluation_state IN
    ('EVALUATED', 'NOT_EVALUATED', 'INSUFFICIENT_CALENDAR_DATA'));

-- Widen the tag domain. NO_NEWS keeps its meaning but now means CONFIRMED no
-- news: a trade the calendar could not speak to is INSUFFICIENT_CALENDAR_DATA,
-- and one never classified at all is NOT_EVALUATED. The three original values
-- are preserved so every existing reader and every stored row stays valid.
ALTER TABLE paper_strategy_trades DROP CONSTRAINT IF EXISTS paper_strategy_trades_news_impact_tag_check;
ALTER TABLE paper_strategy_trades
  ADD CONSTRAINT paper_strategy_trades_news_impact_tag_check
  CHECK (news_impact_tag IS NULL OR news_impact_tag IN
    ('NO_NEWS', 'NEAR_NEWS', 'HIGH_IMPACT_NEWS', 'INSUFFICIENT_CALENDAR_DATA', 'NOT_EVALUATED'));

CREATE INDEX IF NOT EXISTS paper_strategy_trades_news_state_idx
  ON paper_strategy_trades(news_evaluation_state, news_impact_tag);

-- ---------------------------------------------------------------------------
-- 4. Paired original / inverted Momentum arms
-- ---------------------------------------------------------------------------

-- Two rows per eligible Momentum opportunity, sharing one pair_id: the
-- direction Momentum itself concluded ('original') and its exact opposite
-- ('inverted'). AT MOST ONE of them is ever executed — whichever the live
-- inversion policy chose — and it takes its outcome from the real paper trade.
-- The other is resolved deterministically as a shadow. Neither being executed
-- (the candidate was suppressed, blocked, or the instrument was busy) is a
-- normal, expected state: both arms are then shadows.
--
-- RESEARCH ONLY, and deliberately excluded from loadAdaptiveEvidence, which
-- reads paper_strategy_trades and shadow_candidate_outcomes. Recording a pair
-- therefore cannot change what the adaptive engine selects, and cannot
-- double-count the executed arm that already appears in the trade ledger.
--
-- This is a SUPERSET of momentum_short_inversion_pairs (SHORT-only, both arms
-- shadow, frozen hypothesis). That table is left completely untouched.
CREATE TABLE IF NOT EXISTS momentum_inversion_arms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The stable pairing identifier. Derived deterministically from
  -- (experiment, instrument, decision_time) so re-recording the same
  -- opportunity produces the same pair id and the write stays idempotent.
  pair_id uuid NOT NULL,
  arm text NOT NULL CHECK (arm IN ('original', 'inverted')),
  experiment_id text NOT NULL,

  -- Opportunity identity: everything needed to prove both arms came from the
  -- same bar, the same strategy build and the same market context.
  instrument text NOT NULL REFERENCES instruments(code),
  decision_time timestamptz NOT NULL,
  strategy_family text NOT NULL,
  strategy_version text NOT NULL,
  config_version text NOT NULL,
  session text,
  regime text,
  trend_strength numeric,
  volatility_bucket text,
  atr numeric,
  atr_pips numeric,
  -- One spread, shared by both arms: they are priced at the same instant, and
  -- each arm fills its own side of that same book.
  spread_pips numeric,

  -- Geometry for THIS arm. Distances are identical across the pair by
  -- construction; only the side of the book differs.
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  entry numeric NOT NULL,
  stop numeric NOT NULL,
  target numeric NOT NULL,
  stop_distance numeric NOT NULL,
  target_distance numeric NOT NULL,

  -- Execution. At most one arm per pair may carry executed=true.
  executed boolean NOT NULL DEFAULT false,
  paper_trade_id uuid REFERENCES paper_strategy_trades(id) ON DELETE SET NULL,

  -- Outcome, taken from the real trade when executed and from deterministic
  -- shadow resolution otherwise. outcome_source records which, so an actual
  -- result and a hypothetical one can never be silently interchanged.
  outcome text,
  outcome_source text CHECK (outcome_source IS NULL OR outcome_source IN ('executed', 'shadow')),
  result_r numeric,
  gross_result_r numeric,
  spread_cost_r numeric,
  net_result_r numeric,
  max_favorable_r numeric,
  max_adverse_r numeric,
  exit numeric,
  resolved_at timestamptz,
  horizon_ends_at timestamptz,
  exit_reason text,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'excluded')),
  excluded_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per (opportunity, arm): re-evaluating the same bar cannot
  -- double-record, and a pair can never grow a third arm.
  UNIQUE (experiment_id, instrument, decision_time, arm),
  UNIQUE (pair_id, arm)
);

-- The "exactly one real execution at most" invariant, enforced by the database
-- rather than by the caller remembering to check.
CREATE UNIQUE INDEX IF NOT EXISTS momentum_inversion_arms_one_execution_idx
  ON momentum_inversion_arms(pair_id) WHERE executed;

CREATE INDEX IF NOT EXISTS momentum_inversion_arms_pending_idx
  ON momentum_inversion_arms(status, decision_time) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS momentum_inversion_arms_pair_idx
  ON momentum_inversion_arms(pair_id);
