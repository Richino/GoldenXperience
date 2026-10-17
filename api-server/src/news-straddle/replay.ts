/** Research only: explicit executable bid/ask samples, never broker execution. */
export type ReplayQuote = { at: number; bid: number; ask: number };
export type ReplayConfig = { pip: number; offsetPips: number; stopPips: number; maxSpreadPips: number; boundPips: number; adverseSlippagePips: number; activationPips: number; trailPips: number; activationLatencyMs: number; windowMs: number };
export type ReplayEntry = { side: "long" | "short"; at: number; price: number; index: number; spreadPips: number; slippagePips: number };
export type ReplayExit = { reason: string; at: number; pips: number; r: number; mfePips: number };
export function replayNewsExits(anchor: ReplayQuote, releaseAt: number, quotes: ReplayQuote[], c: ReplayConfig) {
  if (!(c.pip > 0 && c.stopPips > 0) || !quotes.length || quotes.some((q, i) => q.ask < q.bid || ![q.at, q.bid, q.ask].every(Number.isFinite) || i > 0 && q.at < quotes[i - 1]!.at)) throw new Error("Ordered, valid bid/ask samples are required.");
  const buy = anchor.ask + c.offsetPips * c.pip, sell = anchor.bid - c.offsetPips * c.pip;
  let entry: ReplayEntry | null = null;
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i]!; if (q.at < releaseAt - 2000) continue;
    if (q.at >= releaseAt + c.windowMs) break;
    if ((q.ask - q.bid) / c.pip > c.maxSpreadPips + 1e-8) return { entry: null, skipped: "SPREAD_CANCEL", fixed: null, trailing: null };
    const up = q.ask >= buy, down = q.bid <= sell;
    if (up && down) return { entry: null, skipped: "AMBIGUOUS_BOTH_ENTRIES", fixed: null, trailing: null };
    if (!up && !down) continue;
    const price = up ? Math.max(buy, q.ask) + c.adverseSlippagePips * c.pip : Math.min(sell, q.bid) - c.adverseSlippagePips * c.pip;
    const slip = (up ? price - buy : sell - price) / c.pip;
    if (slip > c.boundPips + 1e-8) return { entry: null, skipped: "PRICE_BOUND_CANCEL", fixed: null, trailing: null };
    entry = { side: up ? "long" : "short", at: q.at, price, index: i, spreadPips: (q.ask - q.bid) / c.pip, slippagePips: slip }; break;
  }
  if (!entry) return { entry: null, skipped: "NO_FILL", fixed: null, trailing: null };
  const e = entry, sign = e.side === "long" ? 1 : -1;
  const exit = (mode: "fixed" | "trailing"): ReplayExit => {
    let stopPips = -c.stopPips, mfe = 0, activateAt: number | null = null, active = false;
    for (const q of quotes.slice(e.index)) {
      const pips = sign * ((sign === 1 ? q.bid : q.ask) - e.price) / c.pip;
      mfe = Math.max(mfe, pips);
      const finish = (reason: string, value: number) => ({ reason, at: q.at, pips: value, r: value / c.stopPips, mfePips: mfe });
      // Model a second fill inside the cancellation latency as an exception,
      // exclude its P/L from strategy comparisons rather than assume atomic OCO.
      if (q.at < e.at + 250 && (sign === 1 ? q.bid <= sell : q.ask >= buy)) return finish("DOUBLE_FILL_EXCEPTION", NaN);
      if (pips <= stopPips) return finish(active ? "TRAIL_STOP" : "INITIAL_STOP", Math.min(stopPips, pips) - c.adverseSlippagePips);
      if (mode === "fixed" && pips >= c.stopPips * 2) return finish("FIXED_2R", c.stopPips * 2);
      if (mode === "trailing") {
        if (activateAt === null && pips >= c.activationPips) activateAt = q.at + c.activationLatencyMs;
        if (activateAt !== null && q.at >= activateAt) active = true;
        if (active) stopPips = Math.max(stopPips, pips - c.trailPips);
      }
    }
    const last = quotes.at(-1)!; const pips = sign * ((sign === 1 ? last.bid : last.ask) - e.price) / c.pip - c.adverseSlippagePips;
    return { reason: "REPLAY_HORIZON_EXIT", at: last.at, pips, r: pips / c.stopPips, mfePips: mfe };
  };
  return { entry, skipped: null, fixed: exit("fixed"), trailing: exit("trailing") };
}
