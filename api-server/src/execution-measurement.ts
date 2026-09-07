import type { PracticeTradeState } from '../../frontend/src/lib/oanda/client.js';
import { precisionFor } from '../../frontend/src/lib/instruments/catalog.js';
import type { MajorInstrument } from '../../frontend/src/types/forex.js';

export const EXECUTION_MEASUREMENT_VERSION = 'execution-price-risk-v2';
export const ADAPTIVE_EVIDENCE_VERSION = 'four-family-policy-price-risk-v2';
export type ExecutionPolicy = 'follow-v1' | 'momentum-inversion-v1';

/** A broker-backed or indeterminate order cannot be booked from candle prices. */
export function requiresBrokerCloseConfirmation(intent: {status:string;broker_trade_id:string|null}|undefined): boolean {
  return !!intent && (['pending','sending','unknown'].includes(intent.status)
    || (intent.status==='submitted' && !!intent.broker_trade_id));
}

export interface ExecutionMeasurement {
  version: typeof EXECUTION_MEASUREMENT_VERSION;
  source: 'broker';
  policy: ExecutionPolicy;
  entry: number;
  initialStop: number;
  exit: number;
  initialUnits: number;
  initialRiskQuote: number;
  /** Same units as bid/ask model R, independent of order-size caps. */
  priceResultR: number;
  /** Cash values are preserved separately; priceResultR never substitutes for P&L. */
  realizedPL: number | null;
  financing: number | null;
  nominalBudgetR: number | null;
  sizingSnapshotRiskHome: number | null;
  cashRiskR: number | null;
  cashRiskBasis: 'entry_sizing_conversion' | 'unavailable';
  closedAt: string;
  costBasis: 'executable_fill_prices';
}

export interface MeasurementInput {
  instrument: MajorInstrument;
  direction: 'long' | 'short';
  signalEntry: number;
  stop: number;
  requestedUnits: number;
  nominalRiskAmount: number;
  inverted: boolean;
}

export function measureBrokerExecution(input: MeasurementInput, state: PracticeTradeState | null): ExecutionMeasurement | null {
  if (!state?.closed || !state.closeTime || !Number.isFinite(Date.parse(state.closeTime))) return null;
  const entry = state.entryPrice, exit = state.averageClosePrice, signedUnits = state.initialUnits;
  if (entry === null || exit === null || signedUnits === null ||
      ![entry, exit, signedUnits, input.stop].every(Number.isFinite) || entry <= 0 || exit <= 0 || signedUnits === 0) return null;
  if ((signedUnits > 0) !== (input.direction === 'long')) return null;
  // submitPracticeMarketOrder rounds the resting stop to instrument precision.
  const stop = Number(input.stop.toFixed(precisionFor(input.instrument)));
  const risk = input.direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
  const initialUnits = Math.abs(signedUnits);
  const priceResultR = (input.direction === 'long' ? exit - entry : entry - exit) / risk;
  const originalRisk = Math.abs(input.signalEntry - input.stop);
  const conversion = input.nominalRiskAmount > 0 && input.requestedUnits > 0 && originalRisk > 0
    ? input.nominalRiskAmount / (input.requestedUnits * originalRisk) : null;
  const riskHome = conversion !== null && Number.isFinite(conversion) ? initialUnits * risk * conversion : null;
  return {
    version: EXECUTION_MEASUREMENT_VERSION, source: 'broker',
    policy: input.inverted ? 'momentum-inversion-v1' : 'follow-v1',
    entry, initialStop: stop, exit, initialUnits, initialRiskQuote: initialUnits * risk, priceResultR,
    realizedPL: state.realizedPL, financing: state.financing,
    nominalBudgetR: state.realizedPL !== null && input.nominalRiskAmount > 0 ? state.realizedPL / input.nominalRiskAmount : null,
    sizingSnapshotRiskHome: riskHome,
    cashRiskR: state.realizedPL !== null && riskHome !== null && riskHome > 0 ? state.realizedPL / riskHome : null,
    cashRiskBasis: riskHome !== null ? 'entry_sizing_conversion' : 'unavailable',
    closedAt: state.closeTime, costBasis: 'executable_fill_prices',
  };
}

/** Missing broker reconciliation is not permission to reuse a model close. */
export function comparableExecutedR(input: {
  resultBasis: string | null; modelR: number | null; orderStatus: string | null;
  measurement: ExecutionMeasurement | null; policy: ExecutionPolicy; asOf: string;
}): number | null {
  const m = input.measurement;
  if (m?.version === EXECUTION_MEASUREMENT_VERSION) {
    if (m.policy !== input.policy || Date.parse(m.closedAt) > Date.parse(input.asOf)) return null;
    // Until a cash-charge conversion is measured consistently for model and broker,
    // nonzero or unknown financing cannot be treated as a cost-free price return.
    return Number.isFinite(m.priceResultR) && m.financing === 0 ? m.priceResultR : null;
  }
  if (input.resultBasis === 'broker' || ['pending','sending','submitted','unknown'].includes(input.orderStatus ?? '')) return null;
  return input.modelR !== null && Number.isFinite(input.modelR) ? input.modelR : null;
}
