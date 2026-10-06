"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { apiUrl } from "@/lib/api/url";
import { currenciesOf, displayNameFor, isKnownInstrument, pipSizeFor } from "@/lib/instruments/catalog";
import type { CandleSeries } from "@/types/forex";
import { newsSurpriseHint, predictSurprise, type CalendarValueFields, type TrendDirection } from "@/lib/news/surprise-hint";

/** The eight majors; every pair between them that OANDA lists is shown. */
const MAJOR_CURRENCIES = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"];

function pairsFor(currency: string): string[] {
  const pairs: string[] = [];
  for (const other of MAJOR_CURRENCIES) {
    if (other === currency) continue;
    for (const name of [`${currency}_${other}`, `${other}_${currency}`]) {
      if (isKnownInstrument(name)) pairs.push(name);
    }
  }
  return pairs;
}

/** A currency rising lifts pairs where it is the base and drops pairs where it is the quote. */
function pairDirection(instrument: string, currency: string, currencyMove: TrendDirection): TrendDirection {
  const { base } = currenciesOf(instrument);
  if (base === currency) return currencyMove;
  return currencyMove === "up" ? "down" : "up";
}

function Arrow({ direction }: { direction: TrendDirection }) {
  return (
    <span className={`news-impact-move is-${direction}`}>
      {direction === "up" ? "▲ Up" : "▼ Down"}
    </span>
  );
}

export type NewsImpactPosition = { instrument: string; direction: "long" | "short"; openedAt?: string };

/** What a pair has actually done since the release, in pips (positive = up). */
type ReleaseMove = { firstReaction: number | null; sinceRelease: number };

const MOVE_REFRESH_MS = 30_000;
const FIRST_REACTION_MINUTES = 15;
/**
 * A release's effect is measured over this window, then frozen. Hours later
 * the price is mostly moving on other things, so calling that the news
 * helping or hurting a trade would mislead.
 */
const NEWS_WINDOW_MINUTES = 60;

/**
 * Price moves after a released event, per pair, from 5-minute candles: the
 * open of the candle at the release time is the reference, the first
 * reaction is the close 15 minutes later, and the move is the latest close
 * inside the news window. Refreshes while the window is open, then stops.
 */
function useReleaseMoves(pairs: string[], releasedAt: number | null) {
  const [moves, setMoves] = useState<Record<string, ReleaseMove>>({});
  const key = pairs.join(",");
  useEffect(() => {
    if (releasedAt === null || !key) return;
    const release = releasedAt;
    let cancelled = false;
    async function load() {
      const count = Math.min(5_000, Math.ceil((Date.now() - release) / 300_000) + 3);
      const entries = await Promise.all(key.split(",").map(async (instrument) => {
        try {
          const response = await fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=M5&count=${count}`), { credentials: "include", cache: "no-store" });
          const series = response.ok ? (await response.json() as { data?: CandleSeries }).data : undefined;
          const candles = series?.source === "oanda" ? series.candles : [];
          const start = candles.findIndex((candle) => Date.parse(candle.time) >= release - 60_000);
          if (start < 0) return null;
          const pip = pipSizeFor(instrument);
          const reference = candles[start]!.open;
          const closedBy = (end: number) =>
            candles.slice(start).filter((candle) => Date.parse(candle.time) + 300_000 <= end).at(-1);
          const reactionEnd = release + FIRST_REACTION_MINUTES * 60_000;
          const reaction = closedBy(reactionEnd);
          const windowEnd = release + NEWS_WINDOW_MINUTES * 60_000;
          // Inside the window the latest candle; after it, the last one that closed by its end.
          const last = Date.now() >= windowEnd ? closedBy(windowEnd) ?? candles.at(-1)! : candles.at(-1)!;
          const move: ReleaseMove = {
            firstReaction: Date.now() >= reactionEnd && reaction ? (reaction.close - reference) / pip : null,
            sinceRelease: (last.close - reference) / pip,
          };
          return [instrument, move] as const;
        } catch {
          return null;
        }
      }));
      if (!cancelled) setMoves(Object.fromEntries(entries.filter((entry) => entry !== null)));
    }
    void load();
    // Once the window has closed the numbers are final: one read, no polling.
    const windowEnd = release + NEWS_WINDOW_MINUTES * 60_000;
    const timer = Date.now() < windowEnd
      ? window.setInterval(() => {
        void load();
        if (Date.now() >= windowEnd + 300_000) window.clearInterval(timer);
      }, MOVE_REFRESH_MS)
      : undefined;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key, releasedAt]);
  return releasedAt === null ? {} : moves;
}

type SavedPrediction = { event_key: string; call: "beat" | "miss" | null; chosen_signal: string | null };
type PredictionJournal = { predictions: SavedPrediction[]; record: { calls: number; correct: number } };

/** Same key the server journal stores each call under. */
function eventKey(event: { currency: string; title: string; timestamp: string }) {
  return `${event.currency}|${event.title}|${new Date(event.timestamp).toISOString()}`;
}

/** The server's frozen calls and their live track record, loaded when the sheet opens. */
function usePredictionJournal(open: boolean) {
  const [journal, setJournal] = useState<PredictionJournal | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(apiUrl("/api/news/predictions"), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() as Promise<PredictionJournal> : null))
      .then((payload) => { if (!cancelled && payload) setJournal(payload); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);
  return journal;
}

function signedPips(value: number) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`;
}

function sinceText(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function NewsImpactSheet({
  event,
  positions,
  onClose,
  now,
}: {
  event: (CalendarValueFields & { id: string; timestamp: string }) | null;
  positions: NewsImpactPosition[];
  onClose: () => void;
  /** The page clock, ticking; decides whether the event has been released. */
  now: number;
}) {
  const hint = event ? newsSurpriseHint(event) : null;
  const journal = usePredictionJournal(event !== null);
  const saved = event ? journal?.predictions.find((row) => row.event_key === eventKey(event)) : undefined;
  // The journal's frozen call wins; the simple local rule covers events it has
  // not seen (e.g. before its first run).
  const predicted = saved ? saved.call : event ? predictSurprise(event) : null;
  // The expected move is the pre-release call and never changes: it comes only
  // from forecast vs previous, so the actual cannot rewrite it after the fact.
  const preRelease = event ? newsSurpriseHint({ ...event, actual: null }) : null;
  const currencyMove: TrendDirection | null =
    preRelease?.kind === "before" && predicted
      ? predicted === "beat" ? preRelease.beatDirection : preRelease.missDirection
      : null;
  const currency = event?.currency ?? "";
  const pairs = event ? pairsFor(currency) : [];
  // Pairs you hold come first, so the answer you care about is at the top. A
  // trade opened after the news window closed was never exposed to it.
  const eventTime = event ? Date.parse(event.timestamp) : null;
  const held = new Map(positions
    .filter((p) => eventTime === null || !p.openedAt || Date.parse(p.openedAt) < eventTime + NEWS_WINDOW_MINUTES * 60_000)
    .map((p) => [p.instrument, p.direction]));
  pairs.sort((a, b) => Number(held.has(b)) - Number(held.has(a)));
  const releasedAt = event && Date.parse(event.timestamp) <= now ? Date.parse(event.timestamp) : null;
  const moves = useReleaseMoves(pairs, releasedAt);
  const windowClosed = releasedAt !== null && now >= releasedAt + NEWS_WINDOW_MINUTES * 60_000;
  // How the currency itself reacted: against how many others it gained.
  const measured = pairs.filter((instrument) => moves[instrument]);
  const currencyGains = measured.filter((instrument) => {
    const pairUp = moves[instrument]!.sinceRelease > 0;
    return currenciesOf(instrument).base === currency ? pairUp : !pairUp;
  }).length;
  const actualCurrencyMove: TrendDirection | null = measured.length === 0 ? null
    : currencyGains * 2 > measured.length ? "up" : currencyGains * 2 < measured.length ? "down" : null;
  const heldResults = pairs
    .filter((instrument) => held.has(instrument) && moves[instrument])
    .map((instrument) => (held.get(instrument) === "long" ? 1 : -1) * moves[instrument]!.sinceRelease);
  const heldNet = heldResults.reduce((sum, value) => sum + value, 0);

  return (
    <MobileSheet
      open={event !== null}
      onClose={onClose}
      title={event?.title ?? "News"}
      eyebrow={currency ? `${currency} news impact` : undefined}
      className="news-impact-sheet"
    >
      {event && hint ? (
        <div className="news-impact-drawer">
          <dl className="news-impact-values">
            <div><dt>Forecast</dt><dd className="metric-number">{event.forecast || "—"}</dd></div>
            <div><dt>Previous</dt><dd className="metric-number">{event.previous || "—"}</dd></div>
            <div><dt>Actual</dt><dd className="metric-number">{event.actual || "—"}</dd></div>
          </dl>

          {journal && journal.record.calls > 0 ? (
            <p className="news-impact-note">
              Prediction record: {journal.record.correct} of {journal.record.calls} right
              ({Math.round((journal.record.correct / journal.record.calls) * 100)}%)
            </p>
          ) : null}

          {releasedAt !== null ? (
            // A short summary: one line of context, then up to three figures.
            <div className="news-impact-outcome">
              <p>
                Released {sinceText(now - releasedAt)} ago ·{" "}
                {windowClosed ? "final, first hour only" : "live for the first hour"}
              </p>
              <dl className="news-impact-summary">
                {heldResults.length ? (
                  <div>
                    <dt>{heldResults.length === 1 ? "Your trade" : `Your ${heldResults.length} trades`}</dt>
                    <dd className={heldNet >= 0 ? "is-up" : "is-down"}>{signedPips(heldNet)} pips</dd>
                  </div>
                ) : null}
                {currencyMove && actualCurrencyMove ? (
                  <div>
                    <dt>Prediction</dt>
                    <dd className={currencyMove === actualCurrencyMove ? "is-up" : "is-down"}>
                      {currencyMove === actualCurrencyMove ? "✓ Right" : "✗ Wrong"}
                    </dd>
                  </div>
                ) : null}
                {actualCurrencyMove ? (
                  <div>
                    <dt>{currency}</dt>
                    <dd>
                      {actualCurrencyMove === "up" ? "▲ Up" : "▼ Down"} vs{" "}
                      {actualCurrencyMove === "up" ? currencyGains : measured.length - currencyGains}/{measured.length}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}

          {hint.kind === "unknown" && releasedAt === null ? (
            <p className="news-impact-note">
              No clear better/worse reading for this event (speeches and similar), so its effect on
              {` ${currency}`} pairs can&apos;t be called in advance.
            </p>
          ) : (
            <ul className="news-impact-pairs">
              {pairs.map((instrument) => {
                const position = held.get(instrument);
                const move = currencyMove ? pairDirection(instrument, currency, currencyMove) : null;
                const actual = moves[instrument];
                // Released: judge by what price actually did; before: by the call.
                const result = actual && position ? (position === "long" ? 1 : -1) * actual.sinceRelease : null;
                const helpsByCall = move && position ? (move === "up") === (position === "long") : null;
                return (
                  <li key={instrument} className={position ? "is-held" : undefined}>
                    <Link href={`/chart?instrument=${instrument}`} onClick={onClose} className="news-impact-pair">
                      <span className="news-impact-pair-name">
                        {displayNameFor(instrument)}
                        {position ? (
                          <small className={`home-side is-${position}`}>{position === "long" ? "LONG" : "SHORT"}</small>
                        ) : null}
                      </span>
                      {releasedAt !== null ? (
                        // Three lines, most important first: what it did to
                        // your trade, what the price did, and whether the
                        // forecast was right. Green / red always mean good /
                        // bad for you on a held pair, so the price line stays
                        // neutral there instead of contradicting the result.
                        <span className="news-impact-legs is-released">
                          {result !== null ? (
                            <strong className={`news-impact-result ${result >= 0 ? "is-up" : "is-down"}`}>
                              {result >= 0 ? "Helped you" : "Hurt you"} {signedPips(result)} pips
                            </strong>
                          ) : null}
                          {actual ? (
                            <span className={`news-impact-move${result !== null ? " is-plain" : ` is-${actual.sinceRelease >= 0 ? "up" : "down"}`}`}>
                              Price {actual.sinceRelease >= 0 ? "▲ up" : "▼ down"} {Math.abs(actual.sinceRelease).toFixed(1)} pips
                              {windowClosed ? " in 1st hour" : ""}
                            </span>
                          ) : <span>Loading…</span>}
                          <span className="news-impact-tags">
                            {move ? (
                              <span
                                className={`news-impact-call${actual && actual.sinceRelease !== 0
                                  ? (actual.sinceRelease > 0) === (move === "up") ? " is-right" : " is-wrong"
                                  : ""}`}
                              >
                                Forecast {move}
                                {actual && actual.sinceRelease !== 0
                                  ? (actual.sinceRelease > 0) === (move === "up") ? " ✓ right" : " ✗ wrong"
                                  : ""}
                              </span>
                            ) : <span className="news-impact-call">No forecast</span>}
                            {actual && actual.firstReaction !== null ? (
                              <span className="news-impact-first">
                                First {FIRST_REACTION_MINUTES} min: {signedPips(actual.firstReaction)} pips
                              </span>
                            ) : null}
                          </span>
                        </span>
                      ) : (
                        <span className="news-impact-legs">
                          {move ? <Arrow direction={move} /> : <span>No call</span>}
                          {helpsByCall !== null ? (
                            <em className={helpsByCall ? "is-up" : "is-down"}>
                              {helpsByCall ? "Helps you" : "Hurts you"}
                            </em>
                          ) : null}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </MobileSheet>
  );
}
