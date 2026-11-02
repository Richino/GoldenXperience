/** Financial R only. Price-distance strategy scores are not financial R. */
export type RiskDataQuality = "verified" | "estimated" | "missing" | "legacy_unverified";
export type InitialRiskPlan = Readonly<{
  version: 1; positionKey: string; recordedAt: string; currency: "USD";
  initialPlannedRiskUsd: number; entryEquityUsd: number | null;
  plannedNetRewardUsd: number | null; source: "explicit_budget" | "initial_protective_stop" | "sizing_policy";
  brokerAccountId?: string;
  sizingBalanceUsd?: number;
  sizingRiskPercent?: number;
}>;
export const MISSING_INITIAL_RISK = "N/A — initial risk not recorded";
export const R_EXPLANATION = "Net profit or loss divided by the monetary risk established before trade entry. A risk budget without a protective stop does not cap the loss.";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;

// Divide decimal monetary inputs as scaled integers, avoiding decimal addition
// drift. Round only the output, never the denominator or the source P/L.
function decimal(value: number) {
  const [mantissa, exponent = "0"] = value.toString().toLowerCase().split("e");
  const digits = mantissa.replace(".", "");
  const scale = (mantissa.split(".")[1]?.length ?? 0) - Number(exponent);
  return scale >= 0 ? { n: BigInt(digits), scale } : { n: BigInt(digits) * BigInt(10) ** BigInt(-scale), scale: 0 };
}
export function monetaryRatio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (!finite(numerator) || !positive(denominator)) return null;
  const a = decimal(numerator), b = decimal(denominator);
  const numeratorUnits = a.n * BigInt(10) ** BigInt(b.scale);
  const denominatorUnits = b.n * BigInt(10) ** BigInt(a.scale);
  if (numeratorUnits === BigInt(0)) return 0;
  const negative = numeratorUnits < BigInt(0);
  const absoluteUnits = negative ? -numeratorUnits : numeratorUnits;
  let exponent = absoluteUnits.toString().length - denominatorUnits.toString().length;
  if (exponent >= 0 ? absoluteUnits < denominatorUnits * BigInt(10) ** BigInt(exponent)
    : absoluteUnits * BigInt(10) ** BigInt(-exponent) < denominatorUnits) exponent -= 1;
  // Retain significant digits rather than imposing a fixed decimal-place
  // cutoff: a valid tiny gain/loss must not become a zero-R observation.
  const shift = 16 - exponent;
  const quotient = shift >= 0 ? absoluteUnits * BigInt(10) ** BigInt(shift) / denominatorUnits
    : absoluteUnits / (denominatorUnits * BigInt(10) ** BigInt(-shift));
  const result = Number(`${negative ? "-" : ""}${quotient}e${-shift}`);
  return Number.isFinite(result) && result !== 0 ? result : null;
}
export function createPlannedRiskBudget(input: { value: number; unit: "usd" | "percent"; equityBeforeEntryUsd: number; recordedAt: string; positionKey: string; brokerAccountId: string; plannedNetRewardUsd: number | null }): InitialRiskPlan {
  if (!positive(input.value) || !positive(input.equityBeforeEntryUsd) || !["usd", "percent"].includes(input.unit) || (input.unit === "percent" && input.value > 100) || !Number.isFinite(Date.parse(input.recordedAt))) throw new Error("Invalid pre-entry risk budget.");
  const risk = input.unit === "percent" ? monetaryRatio(input.equityBeforeEntryUsd * input.value, 100) : input.value;
  if (!positive(risk) || (input.plannedNetRewardUsd !== null && !positive(input.plannedNetRewardUsd))) throw new Error("Invalid risk or reward budget.");
  return Object.freeze({ version: 1, positionKey: input.positionKey, recordedAt: input.recordedAt, currency: "USD", initialPlannedRiskUsd: risk,
    entryEquityUsd: null, plannedNetRewardUsd: input.plannedNetRewardUsd, brokerAccountId: input.brokerAccountId, source: "explicit_budget" });
}
export function verifiedInitialRisk(plan: InitialRiskPlan | null | undefined, openedAt: string, positionKey: string) {
  if (!plan || plan.version !== 1 || plan.currency !== "USD" || plan.positionKey !== positionKey || !positive(plan.initialPlannedRiskUsd) ||
    !["explicit_budget", "initial_protective_stop", "sizing_policy"].includes(plan.source) || !Number.isFinite(Date.parse(plan.recordedAt)) ||
    !Number.isFinite(Date.parse(openedAt)) || Date.parse(plan.recordedAt) > Date.parse(openedAt)) return null;
  return plan.initialPlannedRiskUsd;
}
export function riskMetrics(input: {
  plan?: InitialRiskPlan | null; positionKey: string; openedAt: string;
  realizedNetPnlUsd?: number | null; unrealizedNetPnlUsd?: number | null;
  legacyR?: number | null; maxAdverseExcursionUsd?: number | null; maxFavorableExcursionUsd?: number | null;
}) {
  const risk = verifiedInitialRisk(input.plan, input.openedAt, input.positionKey);
  const mae = input.maxAdverseExcursionUsd, mfe = input.maxFavorableExcursionUsd;
  return {
    initialPlannedRiskUsd: risk,
    realizedRMultiple: monetaryRatio(input.realizedNetPnlUsd, risk),
    unrealizedRMultiple: monetaryRatio(input.unrealizedNetPnlUsd, risk),
    plannedRewardRiskRatio: risk !== null && positive(input.plan?.plannedNetRewardUsd) ? monetaryRatio(input.plan.plannedNetRewardUsd, risk) : null,
    realizedReturnPct: input.plan && risk !== null ? multiply(monetaryRatio(input.realizedNetPnlUsd, input.plan.entryEquityUsd), 100) : null,
    maeR: finite(mae) && mae >= 0 ? monetaryRatio(mae, risk) : null,
    mfeR: finite(mfe) && mfe >= 0 ? monetaryRatio(mfe, risk) : null,
    drawdownAdjustedResult: monetaryRatio(input.realizedNetPnlUsd, positive(mae) ? mae : null),
    legacyR: finite(input.legacyR) ? input.legacyR : null,
    riskDataQuality: (risk !== null ? "verified" : finite(input.legacyR) ? "legacy_unverified" : "missing") as RiskDataQuality,
  };
}
function multiply(value: number | null, factor: number) { return value === null ? null : value * factor; }
export function formatRMultiple(value: number | null | undefined, unavailableReason = MISSING_INITIAL_RISK) {
  if (!finite(value)) return unavailableReason;
  const shown = Math.abs(value) < 0.005 ? 0 : value;
  return `${shown > 0 ? "+" : shown < 0 ? "−" : ""}${Math.abs(shown).toFixed(2)}R`;
}
export type HistoricalRiskEstimate = Readonly<{
  version: 1; currency: "USD"; positionKey: string; riskUsd: number;
  basis: string; evidenceAt: string;
}>;
/** Historical sizing is an explicitly labeled comparison, not proof of an
 * agreed pre-entry budget. Reported P/L may not contain all financing/costs. */
export function estimatedRiskMetrics(estimate: HistoricalRiskEstimate | null | undefined, positionKey: string, reportedPnlUsd: number | null | undefined) {
  const risk = estimate?.version === 1 && estimate.currency === "USD" && estimate.positionKey === positionKey &&
    Number.isFinite(Date.parse(estimate.evidenceAt)) && typeof estimate.basis === "string" && estimate.basis.trim() && positive(estimate.riskUsd) ? estimate.riskUsd : null;
  return { estimatedRMultiple: monetaryRatio(reportedPnlUsd, risk), estimatedRiskUsd: risk,
    estimatedRBasis: risk === null ? null : estimate!.basis,
    estimatedRPnlBasis: "Reported USD P/L; financing and cost completeness not verified" };
}
type DisplayRTrade = { resultR?: number | null; riskDataQuality?: RiskDataQuality; estimatedRMultiple?: number | null; initialPlannedRiskUsd?: number | null; legacyR?: number | null };
/** The R a closed trade shows: verified, else estimated from historical
 * sizing, else the stored price-distance R. Display only; verified-R
 * statistics still count only verified trades. */
export function displayTradeR(trade: DisplayRTrade): number | null {
  if (trade.riskDataQuality === "verified" && finite(trade.resultR)) return trade.resultR;
  if (finite(trade.estimatedRMultiple)) return trade.estimatedRMultiple;
  return finite(trade.legacyR) ? trade.legacyR : null;
}
export function formatTradeR(trade: DisplayRTrade) {
  const value = displayTradeR(trade);
  if (value !== null) return formatRMultiple(value);
  return trade.riskDataQuality === "verified" && trade.initialPlannedRiskUsd != null ? "N/A — net P/L not verified" : MISSING_INITIAL_RISK;
}
/** Read projection only: the original stored R remains available for audits. */
export function verifiedTradeR<T extends { id: string; openedAt: string; resultR: number | null; legacyR?: number | null; paperPl?: number | null; initialRiskPlan?: InitialRiskPlan | null; riskPositionKey?: string; realizedNetPnlUsd?: number | null; maxAdverseExcursionUsd?: number | null; maxFavorableExcursionUsd?: number | null }>(trade: T) {
  const metrics = riskMetrics({ plan: trade.initialRiskPlan, positionKey: trade.riskPositionKey ?? trade.id, openedAt: trade.openedAt,
    realizedNetPnlUsd: trade.realizedNetPnlUsd, legacyR: trade.legacyR === undefined ? trade.resultR : trade.legacyR,
    maxAdverseExcursionUsd: trade.maxAdverseExcursionUsd, maxFavorableExcursionUsd: trade.maxFavorableExcursionUsd });
  return { ...trade, ...metrics, resultR: metrics.realizedRMultiple };
}
/** Portfolio R is risk weighted; every independent component must be documented. */
export function aggregateR(components: Array<{ key: string; netPnlUsd: number | null; initialRiskUsd: number | null }>) {
  if (!components.length || new Set(components.map(c => c.key)).size !== components.length || components.some(c => !finite(c.netPnlUsd) || !positive(c.initialRiskUsd))) return null;
  return monetaryRatio(components.reduce((s, c) => s + c.netPnlUsd!, 0), components.reduce((s, c) => s + c.initialRiskUsd!, 0));
}

/** Partial allocations sum to the original denominator, never re-risking the
 * remaining units. Additions must be separate components with separate plans. */
export function partialCloseR(initialRiskUsd: number | null, originalUnits: number, closes: Array<{ units: number; netPnlUsd: number }>) {
  if (!positive(initialRiskUsd) || !positive(originalUnits) || closes.some(c => !positive(c.units) || !finite(c.netPnlUsd))) return null;
  const units = closes.reduce((s, c) => s + c.units, 0);
  if (units > originalUnits || units === 0) return null;
  return monetaryRatio(closes.reduce((s, c) => s + c.netPnlUsd, 0), initialRiskUsd * units / originalUnits);
}
/** Unknown costs/conversion remain unknown, never zero. Financing is signed. */
export function netPnlUsd(gross: number | null, financing: number | null, commission: number | null, fees: number | null, usdPerCurrencyUnit: number | null) {
  if (![gross, financing, commission, fees].every(finite) || !positive(usdPerCurrencyUnit)) return null;
  return (gross! + financing! - commission! - fees!) * usdPerCurrencyUnit;
}
export type ExcursionObservation = { at: string; units: number; bid: number; ask: number; netFloatingPnlUsd: number | null };
/** Use observed exposure and broker account-currency cash at each instant.
 * Never apply final units to an earlier path; missing cash cannot be rebuilt. */
export function observedExcursions(entry: number, direction: "long" | "short", pipSize: number, samples: ExcursionObservation[]) {
  const valid = samples.filter(s => positive(s.units) && positive(s.bid) && positive(s.ask) && s.bid <= s.ask && Number.isFinite(Date.parse(s.at)));
  if (!valid.length || !positive(entry) || !positive(pipSize)) return { maxAdverseExcursionUsd: null, maxFavorableExcursionUsd: null, maePips: null, mfePips: null, quality: "missing" as const };
  const moves = valid.map(s => (direction === "long" ? s.bid - entry : entry - s.ask) / pipSize);
  const complete = valid.every(s => finite(s.netFloatingPnlUsd));
  return { maxAdverseExcursionUsd: complete ? Math.max(0, ...valid.map(s => -s.netFloatingPnlUsd!)) : null,
    maxFavorableExcursionUsd: complete ? Math.max(0, ...valid.map(s => s.netFloatingPnlUsd!)) : null,
    maePips: Math.max(0, ...moves.map(n => -n)), mfePips: Math.max(0, ...moves), quality: "estimated" as const };
}
export function verifiedRStatistics(trades: Array<{ resultR: number | null; paperPl?: number | null; riskDataQuality?: RiskDataQuality }>, minSample = 5) {
  const included = trades.filter(t => t.riskDataQuality === "verified" && finite(t.resultR));
  const values = included.map(t => t.resultR!);
  const wins = values.filter(n => n > 0), losses = values.filter(n => n < 0);
  const average = (xs: number[]) => xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : null;
  const cash = trades.flatMap(t => finite(t.paperPl) ? [t.paperPl] : []);
  const grossLoss = -cash.filter(n => n < 0).reduce((s, n) => s + n, 0);
  return { included: included.length, excluded: trades.length - included.length, coveragePct: trades.length ? included.length / trades.length * 100 : 0,
    exclusionReason: "Initial risk or cost-complete net P/L not verified", insufficientData: included.length < minSample,
    expectancyR: included.length >= minSample ? average(values) : null,
    averageWinningR: included.length >= minSample ? average(wins) : null, averageLosingR: included.length >= minSample ? average(losses) : null,
    // Sum of independent unit outcomes, explicitly not portfolio aggregate R.
    sumIndependentUnitR: included.length >= minSample ? values.reduce((s, n) => s + n, 0) : null,
    realizedPnlUsd: cash.length ? cash.reduce((s, n) => s + n, 0) : null,
    winRate: cash.length ? cash.filter(n => n > 0).length / cash.length : null,
    profitFactor: grossLoss > 0 ? cash.filter(n => n > 0).reduce((s, n) => s + n, 0) / grossLoss : null };
}

/** Equity drawdown needs an actual equity path, adjusted for external cash
 * flows. A trade list or cash-balance ledger is not an equity history. */
export function equityDrawdownUsd(observations: Array<{ at: string; adjustedEquityUsd: number }>) {
  if (observations.length < 2 || observations.some(p => !finite(p.adjustedEquityUsd) || !Number.isFinite(Date.parse(p.at)))) return null;
  let peak = -Infinity, drawdown = 0;
  for (const point of [...observations].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    peak = Math.max(peak, point.adjustedEquityUsd); drawdown = Math.max(drawdown, peak - point.adjustedEquityUsd);
  }
  return drawdown;
}
