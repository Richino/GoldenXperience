/**
 * The one place Analyze's timeframe hierarchy is defined. Each trading mode
 * assigns a job to each timeframe:
 *
 *   context    broad backdrop; reported, never overrides the primary read
 *   primary    decides the regime (UPTREND / DOWNTREND / RANGE / TRANSITION)
 *   setup      where inside that regime to enter: pullbacks, zones, location
 *   execution  optional entry timing; never decides direction
 *
 *   NORMAL  H4 context · H1 primary · M15 setup · M5 execution
 *   SWING   D1 context · H4 primary · H1 setup  · M15 execution
 *
 * LEGACY_NORMAL is the hierarchy NORMAL used before this split (M15 primary,
 * H1 context, no separate setup timeframe). It is kept so replays can compare
 * the two before the old behaviour is retired.
 */

export type RoleTimeframe = "M5" | "M15" | "H1" | "H4" | "D1";
export type AnalysisMode = "NORMAL" | "SWING";
/** Which hierarchy NORMAL runs; SWING always runs ROLES. */
export type NormalHierarchy = "ROLES" | "LEGACY";

export interface TimeframeRoles {
  context: RoleTimeframe;
  primary: RoleTimeframe;
  /** Null when the primary timeframe also finds the setup (legacy). */
  setup: RoleTimeframe | null;
  execution: RoleTimeframe | null;
  holding: string;
}

export const TIMEFRAME_ROLES: Record<AnalysisMode, TimeframeRoles> = {
  NORMAL: { context: "H4", primary: "H1", setup: "M15", execution: "M5", holding: "Day trade: sized to finish within the day" },
  SWING: { context: "D1", primary: "H4", setup: "H1", execution: "M15", holding: "Multi-session swing: about 2–4 days" },
};

export const LEGACY_NORMAL_ROLES: TimeframeRoles = {
  context: "H1", primary: "M15", setup: null, execution: null, holding: "Intraday: a few hours, within the session",
};

export function rolesFor(mode: AnalysisMode, normalHierarchy: NormalHierarchy = "ROLES"): TimeframeRoles {
  return mode === "NORMAL" && normalHierarchy === "LEGACY" ? LEGACY_NORMAL_ROLES : TIMEFRAME_ROLES[mode];
}

/** Every timeframe a mode needs candles for, for callers that fetch them. */
export function timeframesFor(mode: AnalysisMode, normalHierarchy: NormalHierarchy = "ROLES"): RoleTimeframe[] {
  const roles = rolesFor(mode, normalHierarchy);
  return [roles.context, roles.primary, roles.setup, roles.execution].filter((timeframe): timeframe is RoleTimeframe => timeframe !== null);
}
