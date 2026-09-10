/**
 * A tiny external store for live market data, read through `useSyncExternal
 * Store`. The point is granularity (brief §17): a price tick for EUR_USD wakes
 * only the components subscribed to EUR_USD, not every screen. Connection
 * status is a separate channel so a card's price updating never re-runs the
 * connection banner and vice versa.
 */
import type { MarketPriceTick } from "@/types/market-stream";

export type StreamPhase = "connecting" | "connected" | "reconnecting" | "offline";

export interface StreamStatus {
  phase: StreamPhase;
  /** Live broker feed vs the server's mock fallback. */
  source: "oanda" | "mock" | null;
  message: string;
  /** Epoch ms of the last price/heartbeat, for staleness display. */
  lastMessageAt: number | null;
}

export interface Quote {
  bid: number;
  ask: number;
  mid: number;
  time: string;
  source: "oanda" | "mock";
}

type Listener = () => void;

export class MarketStore {
  private quotes = new Map<string, Quote>();
  private quoteListeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<Listener>();

  private status: StreamStatus = {
    phase: "connecting",
    source: null,
    message: "Connecting to the market stream…",
    lastMessageAt: null,
  };

  // --- Quotes -------------------------------------------------------------

  getQuote = (instrument: string): Quote | undefined => this.quotes.get(instrument);

  /** A stable snapshot of every quote, rebuilt only when a tick lands. */
  private allSnapshot: Record<string, Quote> = {};
  getAllQuotes = (): Record<string, Quote> => this.allSnapshot;

  applyTick(tick: MarketPriceTick): void {
    const quote: Quote = {
      bid: tick.bid,
      ask: tick.ask,
      mid: tick.mid,
      time: tick.time,
      source: tick.source,
    };
    this.quotes.set(tick.instrument, quote);
    this.allSnapshot = { ...this.allSnapshot, [tick.instrument]: quote };
    this.quoteListeners.get(tick.instrument)?.forEach((listener) => listener());
    this.quoteListeners.get("*all*")?.forEach((listener) => listener());
    // A tick is also proof of life for the status channel's staleness clock.
    this.touch(tick.source);
  }

  subscribeQuote = (instrument: string, listener: Listener): (() => void) => {
    let set = this.quoteListeners.get(instrument);
    if (!set) {
      set = new Set();
      this.quoteListeners.set(instrument, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  };

  subscribeAllQuotes = (listener: Listener): (() => void) => {
    // A pseudo-key that receives every tick's notification.
    return this.subscribeQuote("*all*", listener);
  };

  // --- Status -------------------------------------------------------------

  getStatus = (): StreamStatus => this.status;

  subscribeStatus = (listener: Listener): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  setStatus(next: Partial<StreamStatus>): void {
    const previous = this.status;
    this.status = { ...previous, ...next };
    // Only wake status subscribers when a field they render changes. The
    // per-tick `lastMessageAt` bump alone must not re-render the banner.
    if (
      previous.phase !== this.status.phase ||
      previous.source !== this.status.source ||
      previous.message !== this.status.message
    ) {
      this.statusListeners.forEach((listener) => listener());
    }
  }

  private touch(source: "oanda" | "mock"): void {
    this.setStatus({
      phase: "connected",
      source,
      lastMessageAt: Date.now(),
      message: source === "mock" ? "Receiving simulated market data." : "Live market stream connected.",
    });
  }
}
