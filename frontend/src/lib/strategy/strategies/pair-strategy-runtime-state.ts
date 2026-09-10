/** Runtime-owned state; entries are isolated by the compound strategy/symbol key. */
export interface PairRuntimePosition { entryTimestamp: string; frozenAtr: number; stop: number; target: number; maxHoldBars: number; cooldownUntil: string | null; lastTradeAt: string | null; enabled: boolean; }
export class PairStrategyRuntimeState {
  private readonly positions = new Map<string, PairRuntimePosition>();
  private key(strategyId: string, symbol: string) { return `${strategyId}:${symbol}`; }
  setEnabled(strategyId: string, symbol: string, enabled: boolean) { const key = this.key(strategyId, symbol); const old = this.positions.get(key); this.positions.set(key, { entryTimestamp: old?.entryTimestamp ?? "", frozenAtr: old?.frozenAtr ?? 0, stop: old?.stop ?? 0, target: old?.target ?? 0, maxHoldBars: old?.maxHoldBars ?? 3, cooldownUntil: old?.cooldownUntil ?? null, lastTradeAt: old?.lastTradeAt ?? null, enabled }); }
  open(strategyId: string, symbol: string, position: PairRuntimePosition) { this.positions.set(this.key(strategyId, symbol), position); }
  close(strategyId: string, symbol: string) { this.positions.delete(this.key(strategyId, symbol)); }
  get(strategyId: string, symbol: string) { return this.positions.get(this.key(strategyId, symbol)) ?? null; }
  hasOpen(strategyId: string, symbol: string) { const state = this.get(strategyId, symbol); return Boolean(state?.entryTimestamp); }
}
