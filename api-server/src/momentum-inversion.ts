import { query } from "./database.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { StrategyDirection } from "../../frontend/src/lib/strategy/types.js";

/**
 * Momentum direction inversion — the single authoritative inversion policy.
 *
 * THE EXPERIMENT. Momentum still inspects the market and independently concludes
 * LONG, SHORT or WAIT exactly as before; not one of its conditions, thresholds,
 * indicators or distances is touched. Only AFTER an executable signal exists does
 * this layer flip it:
 *
 *      momentum LONG   -> paper trade SHORT
 *      momentum SHORT  -> paper trade LONG
 *      momentum WAIT   -> WAIT            (never turned into a trade)
 *
 * EMA, Breakout and MeanRev are not eligible and pass through untouched.
 *
 * WHY IT IS BUILT AS A TRANSFORM, NOT A STRATEGY EDIT. The independent variable
 * has to be direction and nothing else. Editing Momentum to "go the other way"
 * would change which bars it fires on, because its own gates are directional
 * (the ATR run, the body, the consecutive closes). Flipping afterwards keeps the
 * firing set identical and isolates the variable.
 *
 * WHY GEOMETRY IS REBUILT, NOT NEGATED. A long fills at the ASK and a short at
 * the BID. Reusing the original side's entry price, or negating P&L, would hand
 * the inverted trade a spread it never paid and manufacture an edge. The
 * inverted trade is constructed as a legitimate trade on the opposite side and
 * pays the identical real cost.
 *
 * SL and TP DISTANCES are preserved exactly and mirrored around the new entry,
 * so reward-to-risk is unchanged. This experiment tests direction; it does not
 * simultaneously re-tune exits.
 */

/** Kill switch. Set to false and Momentum behaves normally again; nothing else changes. */
export const MOMENTUM_DIRECTION_INVERSION = true;

export const MOMENTUM_INVERSION_EXPERIMENT = "momentum-inversion-v1";

/** Only this family is eligible. Naming it here keeps the policy in one place. */
const ELIGIBLE_FAMILY = "momentum";

export interface InversionResult {
  /** The candidate the engine should actually trade. Unchanged when not inverted. */
  candidate: StrategyCandidate;
  inverted: boolean;
  originalDirection: StrategyDirection;
  executedDirection: StrategyDirection;
  experimentId: string | null;
}

/**
 * Apply the inversion policy to one candidate.
 *
 * `quote` supplies the executable sides. A long must fill at the ask and a short
 * at the bid; without both, the candidate is returned untouched rather than
 * traded on a price it could not have got.
 */
export function applyMomentumInversion(
  candidate: StrategyCandidate,
  quote: { bid: number; ask: number } | undefined,
): InversionResult {
  const passthrough: InversionResult = {
    candidate, inverted: false,
    originalDirection: candidate.direction, executedDirection: candidate.direction,
    experimentId: null,
  };

  if (!MOMENTUM_DIRECTION_INVERSION) return passthrough;
  if (candidate.family !== ELIGIBLE_FAMILY) return passthrough;
  // WAIT stays WAIT. An invalid or directionless candidate is never turned into
  // a trade by this layer — inversion changes direction, never participation.
  if (candidate.status !== "valid" || candidate.direction === null) return passthrough;
  if (candidate.entry === null || candidate.stop === null || candidate.target === null) return passthrough;
  if (!quote || !(quote.bid > 0) || !(quote.ask > 0)) return passthrough;

  const original = candidate.direction;
  const executed: "long" | "short" = original === "long" ? "short" : "long";

  // Distances come from the ORIGINAL plan and are preserved exactly.
  const stopDistance = Math.abs(candidate.entry - candidate.stop);
  const targetDistance = Math.abs(candidate.target - candidate.entry);
  if (!(stopDistance > 0) || !(targetDistance > 0)) return passthrough;

  // Rebuilt as a genuine trade on the opposite side of the book.
  const entry = executed === "long" ? quote.ask : quote.bid;
  const stop = executed === "long" ? entry - stopDistance : entry + stopDistance;
  const target = executed === "long" ? entry + targetDistance : entry - targetDistance;

  return {
    candidate: {
      ...candidate,
      direction: executed,
      entry, stop, target,
      // distances are preserved, so reward-to-risk is unchanged by construction
      riskReward: targetDistance / stopDistance,
      // position size is recomputed downstream from entry/stop by openPaperTrade;
      // leaving the original here would describe the wrong side
      positionSize: null,
      summary: candidate.summary,
    },
    inverted: true,
    originalDirection: original,
    executedDirection: executed,
    experimentId: MOMENTUM_INVERSION_EXPERIMENT,
  };
}

/**
 * Stamp the activation boundary once, so "before inversion" and "after
 * inversion" is answerable by query rather than by recollection.
 */
export async function ensureMomentumInversionActivation(): Promise<string | null> {
  if (!MOMENTUM_DIRECTION_INVERSION) return null;
  const r = await query<{ activated_at: string }>(
    `INSERT INTO experiment_activations (experiment_id, description)
     VALUES ($1, $2)
     ON CONFLICT (experiment_id) DO UPDATE SET experiment_id = EXCLUDED.experiment_id
     RETURNING activated_at::text`,
    [MOMENTUM_INVERSION_EXPERIMENT,
     "Momentum only: executable LONG/SHORT signals are flipped before paper trade geometry is built. "
     + "EMA, Breakout and MeanRev unaffected. WAIT is never converted into a trade."]);
  return r.rows[0]?.activated_at ?? null;
}
