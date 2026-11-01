import { query } from "./database.js";
import { getAccountSnapshot } from "../../frontend/src/lib/oanda/client.js";
import { observeRiskExcursions } from "./risk-reporting.js";

/** Read-only broker observation. Only new versioned analytics metadata is
 * updated; no order, stop, position, P/L or legacy R is changed. */
export function startRiskExcursionObserver() {
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const active = await query<{ user_id: string }>(`SELECT DISTINCT e.user_id FROM pending_manual_entries e
        JOIN paper_trades t ON t.id=e.paper_trade_id WHERE t.status='open' AND e.metadata->>'riskReportingVersion'='1'`);
      if (!active.rows.length) return;
      const snapshot = await getAccountSnapshot();
      if (stopped) return;
      for (const user of active.rows) await observeRiskExcursions(user.user_id, snapshot.positions, snapshot.checkedAt, snapshot.data.currency, snapshot.data.id);
    } catch { /* Unknown observations remain unknown; never fabricate extrema. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
