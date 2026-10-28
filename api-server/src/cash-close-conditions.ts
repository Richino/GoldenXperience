import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPracticeTradeState, oandaEnvironment, requestPracticeAccount } from "../../frontend/src/lib/oanda/client.js";
import { parseCashCloseAmounts, readCashCloseConditions, type CashCloseConditions } from "../../frontend/src/lib/trade-close-conditions.js";
import { databaseConfigured, query } from "./database.js";
import { withManualTradeLock } from "./manual-trade-lock.js";
import { closeActiveManualTrade } from "./pending-manual-entries.js";
import { checkCashClose } from "./cash-close-policy.js";

const INTERVAL_MS = 5_000;
const accountKey = () => createHash("sha256").update(`${oandaEnvironment()}:${process.env.OANDA_ACCOUNT_ID ?? ""}`).digest("hex");

type Entry = { id: string; user_id: string; instrument: string; status: string; paper_trade_status: string | null; metadata: Record<string, unknown> };
async function readEntry(id: string, userId?: string, client?: PoolClient): Promise<Entry> {
  const sql = `SELECT e.id,e.user_id,e.instrument,e.status,e.metadata,t.status AS paper_trade_status
       FROM pending_manual_entries e LEFT JOIN paper_trades t ON t.id=e.paper_trade_id
      WHERE e.id=$1 AND ($2::uuid IS NULL OR e.user_id=$2::uuid)`;
  const values = [id, userId ?? null];
  const result = client ? await client.query<Entry>(sql, values) : await query<Entry>(sql, values);
  const entry = result.rows[0];
  if (!entry) throw new Error("Trade not found.");
  return entry;
}

function brokerId(entry: Entry) {
  const id = entry.metadata.brokerTradeId;
  return typeof id === "string" && /^\d+$/.test(id) ? id : null;
}

export function cashCloseMonitorStatus() {
  const reason = !databaseConfigured() ? "Trade storage is unavailable."
    : oandaEnvironment() !== "practice" ? "Automatic close conditions require an OANDA practice account."
    : process.env.ENABLE_SCHEDULERS === "false" ? "Background trade monitoring is disabled on this server."
    : process.env.CASH_CLOSE_MONITOR_ENABLED === "false" ? "Automatic close monitoring is disabled on this server." : null;
  return { monitoringEnabled: reason === null, unavailableReason: reason, checkIntervalSeconds: INTERVAL_MS / 1000 };
}

async function accountCurrency() {
  const { account } = await requestPracticeAccount<{ account: { currency: string } }>("/summary");
  if (!/^[A-Z]{3}$/.test(account.currency)) throw new Error("The broker account currency is unavailable.");
  return account.currency;
}

export async function cashCloseSettings(userId: string, id: string) {
  const entry = await readEntry(id, userId);
  const conditions = readCashCloseConditions(entry.metadata.cashCloseConditions);
  let currency: string | null = null;
  let unavailableReason = cashCloseMonitorStatus().unavailableReason;
  if (entry.status !== "TRIGGERED" || entry.paper_trade_status !== "open") unavailableReason = "Close conditions are available for open trades only.";
  else if (!brokerId(entry)) unavailableReason = "Waiting for the broker to confirm this trade.";
  try { currency = await accountCurrency(); }
  catch { unavailableReason = "The broker account currency could not be verified. Try again."; }
  return { ...cashCloseMonitorStatus(), conditions, currency, unavailableReason };
}

async function saveConditions(client: PoolClient, id: string, conditions: CashCloseConditions | null) {
  await client.query(
    `UPDATE pending_manual_entries SET metadata = CASE WHEN $2::jsonb IS NULL THEN metadata - 'cashCloseConditions'
      ELSE jsonb_set(metadata,'{cashCloseConditions}',$2::jsonb) END,updated_at=now() WHERE id=$1`,
    [id, conditions === null ? null : JSON.stringify(conditions)],
  );
}

/** Complete replacement: blank fields disable their side; both blank remove the rule. */
export async function updateCashCloseSettings(userId: string, id: string, payload: Record<string, unknown>) {
  const amounts = parseCashCloseAmounts(payload);
  const removing = amounts.profitAmount === null && amounts.lossAmount === null;
  await withManualTradeLock(id, async client => {
    const entry = await readEntry(id, userId, client);
    const previous = readCashCloseConditions(entry.metadata.cashCloseConditions);
    if (previous?.state === "closing") throw new Error("A close has already been requested. Wait for broker confirmation.");
    if (removing) { await saveConditions(client, id, null); return; }
    const status = cashCloseMonitorStatus();
    if (!status.monitoringEnabled) throw new Error(status.unavailableReason!);
    if (entry.status !== "TRIGGERED" || entry.paper_trade_status !== "open") throw new Error("Close conditions are available for open trades only.");
    const idAtBroker = brokerId(entry);
    if (!idAtBroker) throw new Error("The broker has not confirmed this trade yet.");
    const [currency, state] = await Promise.all([accountCurrency(), getPracticeTradeState(idAtBroker)]);
    if (!state || state.closed || state.state !== "OPEN" || state.instrument !== entry.instrument) throw new Error("The broker trade is not open on this pair. Refresh before saving.");
    await saveConditions(client, id, {
      ...amounts, version: 1, currency, accountKey: accountKey(), brokerTradeId: idAtBroker,
      state: "armed", trigger: null, triggeredPL: null, triggeredAt: null,
      lastCheckedAt: null, nextAttemptAt: null, lastError: null,
    });
  });
  return cashCloseSettings(userId, id);
}

export async function sweepCashCloseConditions() {
  if (!cashCloseMonitorStatus().monitoringEnabled) return;
  const candidates = await query<{ id: string }>(
    `SELECT id FROM pending_manual_entries WHERE status='TRIGGERED'
      AND metadata->'cashCloseConditions'->>'state' IN ('armed','closing')`,
  );
  for (const candidate of candidates.rows) {
    try {
      await withManualTradeLock(candidate.id, async client => {
        const entry = await readEntry(candidate.id, undefined, client);
        const conditions = readCashCloseConditions(entry.metadata.cashCloseConditions);
        if (!conditions || conditions.state === "closed") return;
        if (entry.paper_trade_status === "closed") {
          await saveConditions(client, entry.id, { ...conditions, state: "closed", lastError: null, nextAttemptAt: null });
          return;
        }
        if (entry.paper_trade_status !== "open") return;
        await checkCashClose(conditions, { accountKey: accountKey(), brokerTradeId: brokerId(entry) ?? "", instrument: entry.instrument }, {
          now: Date.now,
          observe: async () => {
            const [currency, state] = await Promise.all([accountCurrency(), getPracticeTradeState(conditions.brokerTradeId)]);
            if (!state) throw new Error("The broker trade could not be verified. Automatic closing will retry.");
            if (!state.closed && state.state !== "OPEN") throw new Error("The broker trade is not currently tradeable. Automatic closing will retry.");
            return { currency, open: !state.closed, instrument: state.instrument ?? null, unrealizedPL: state.unrealizedPL ?? null };
          },
          save: rules => saveConditions(client, entry.id, rules),
          close: () => closeActiveManualTrade(entry.user_id, entry.id, null),
        });
      });
    } catch (error) {
      // Lock contention is expected when another instance or a manual action wins.
      if (!(error instanceof Error) || !error.message.startsWith("This trade is being updated")) {
        console.warn("[cash-close] A condition check failed; the next sweep will retry.");
      }
    }
  }
}

export function startCashCloseMonitor() {
  if (!cashCloseMonitorStatus().monitoringEnabled) return () => {};
  let busy = false;
  let stopped = false;
  const sweep = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await sweepCashCloseConditions(); }
    catch { console.warn("[cash-close] Monitoring temporarily unavailable; the next sweep will retry."); }
    finally { busy = false; }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), INTERVAL_MS);
  return () => { stopped = true; clearInterval(timer); };
}
