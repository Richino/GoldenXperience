import { cashCloseTrigger, type CashCloseConditions } from "../../frontend/src/lib/trade-close-conditions.js";

export interface CashCloseObservation {
  open: boolean;
  instrument: string | null;
  currency: string;
  unrealizedPL: number | null;
}

export interface CashCloseActions {
  observe(): Promise<CashCloseObservation>;
  save(conditions: CashCloseConditions): Promise<void>;
  close(): Promise<unknown>;
  now(): number;
}

/** No estimated, cached, aggregate, or quote-currency amounts can trigger a close. */
export async function checkCashClose(
  saved: CashCloseConditions,
  identity: { accountKey: string; brokerTradeId: string; instrument: string },
  actions: CashCloseActions,
): Promise<void> {
  if (saved.state === "closed") return;
  if (saved.nextAttemptAt && Date.parse(saved.nextAttemptAt) > actions.now()) return;
  let conditions = { ...saved };
  try {
    if (saved.accountKey !== identity.accountKey || saved.brokerTradeId !== identity.brokerTradeId) {
      throw new Error("The broker account or trade changed. Review and save these conditions again.");
    }
    const started = actions.now();
    const observation = await actions.observe();
    if (actions.now() - started > 5_000) throw new Error("Broker data was delayed. Automatic closing will retry with fresh data.");
    if (observation.currency !== saved.currency) throw new Error("The account currency changed. Review and save these conditions again.");
    conditions.lastCheckedAt = new Date(actions.now()).toISOString();
    if (!observation.open) {
      await actions.save({ ...conditions, state: "closed", lastError: null, nextAttemptAt: null });
      return;
    }
    if (observation.instrument !== identity.instrument) throw new Error("The broker trade does not match this pair. Automatic closing is paused.");
    if (observation.unrealizedPL === null || !Number.isFinite(observation.unrealizedPL)) {
      throw new Error("Broker P/L is unavailable. Automatic closing will retry.");
    }
    const trigger = conditions.state === "closing" ? conditions.trigger : cashCloseTrigger(conditions, observation.unrealizedPL);
    if (!trigger) {
      await actions.save({ ...conditions, lastError: null, nextAttemptAt: null });
      return;
    }
    // Persist the trigger BEFORE requesting the close. A restart or rejection
    // must not forget that the limit was reached if the price moves back.
    conditions = {
      ...conditions, state: "closing", trigger,
      triggeredPL: conditions.triggeredPL ?? observation.unrealizedPL,
      triggeredAt: conditions.triggeredAt ?? new Date(actions.now()).toISOString(),
      lastError: null, nextAttemptAt: null,
    };
    await actions.save(conditions);
  } catch (error) {
    await actions.save({ ...conditions, lastError: error instanceof Error ? error.message : "Broker monitoring is unavailable. Automatic closing will retry.", nextAttemptAt: new Date(actions.now() + 15_000).toISOString() });
    return;
  }
  // Closing is separate from observation so broker failures never overwrite
  // the durable trigger or masquerade as a successful close.
  try {
    await actions.close();
    await actions.save({ ...conditions, state: "closed", lastError: null, nextAttemptAt: null });
  } catch {
    await actions.save({ ...conditions, lastError: "The broker close is not confirmed. Retrying after checking the trade again.", nextAttemptAt: new Date(actions.now() + 15_000).toISOString() });
  }
}
