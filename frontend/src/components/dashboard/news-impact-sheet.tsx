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

export type NewsImpactPosition = { instrument: string; direction: "long" | "short" };

/** What a pair has actually done since the release, in pips (positive = up). */
type ReleaseMove = { firstReaction: number | null; sinceRelease: number };

const MOVE_REFRESH_MS = 30_000;
const FIRST_REACTION_MINUTES = 15;

/**
 * Price moves since a released event, per pair, from 5-minute candles: the
 * open of the candle at the release time is the reference, the first
 * reaction is the close 15 minutes later, and "since release" is the latest
 * close. Refreshes while the sheet is open, so the outcome keeps updating.
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
          const reactionEnd = release + FIRST_REACTION_MINUTES * 60_000;
          const reaction = candles.slice(start).filter((candle) => Date.parse(candle.time) + 300_000 <= reactionEnd).at(-1);
          const move: ReleaseMove = {
            firstReaction: Date.now() >= reactionEnd && reaction ? (reaction.close - reference) / pip : null,
            sinceRelease: (candles.at(-1)!.close - reference) / pip,
          };
          return [instrument, move] as const;
        } catch {
          return null;
        }
      }));
      if (!cancelled) setMoves(Object.fromEntries(entries.filter((entry) => entry !== null)));
    }
    void load();
    const timer = window.setInterval(() => void load(), MOVE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key, releasedAt]);
  return releasedAt === null ? {} : moves;
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
  const predicted = event ? predictSurprise(event) : null;
  // The currency's expected move: the real one once released, else the lean.
  const currencyMove: TrendDirection | null =
    hint?.kind === "after"
      ? hint.direction === "flat" ? null : hint.direction
      : hint?.kind === "before" && predicted
        ? predicted === "beat" ? hint.beatDirection : hint.missDirection
        : null;
  const currency = event?.currency ?? "";
  const pairs = event ? pairsFor(currency) : [];
  // Pairs you hold come first, so the answer you care about is at the top.
  const held = new Map(positions.map((p) => [p.instrument, p.direction]));
  pairs.sort((a, b) => Number(held.has(b)) - Number(held.has(a)));
  const releasedAt = event && Date.parse(event.timestamp) <= now ? Date.parse(event.timestamp) : null;
  const moves = useReleaseMoves(pairs, releasedAt);
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

          {releasedAt !== null ? (
            <div className="news-impact-outcome">
              <p>
                Released {sinceText(now - releasedAt)} ago. Moves are pips from the price at release and update
                every 30 seconds.
              </p>
              {actualCurrencyMove ? (
                <p>
                  {currency} has {actualCurrencyMove === "up" ? "risen" : "fallen"} against{" "}
                  {actualCurrencyMove === "up" ? currencyGains : measured.length - currencyGains} of {measured.length} currencies
                  {currencyMove ? (
                    <>
                      {hint.kind === "after" ? `; the figure (${hint.outcome}, so ${currency} ${currencyMove}) ` : `; the expected call (${currency} ${currencyMove}) `}
                      <strong className={currencyMove === actualCurrencyMove ? "is-up" : "is-down"}>
                        {currencyMove === actualCurrencyMove ? "is right" : "is wrong"}
                      </strong>
                      {" so far."}
                    </>
                  ) : "."}
                </p>
              ) : null}
              {heldResults.length ? (
                <p>
                  {heldResults.length === 1 ? "Your position: " : `Your ${heldResults.length} positions: `}
                  <strong className={heldNet >= 0 ? "is-up" : "is-down"}>
                    {heldNet >= 0 ? "helped" : "hurt"}, {signedPips(heldNet)} pips
                  </strong>
                  {" since the release."}
                </p>
              ) : null}
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
                        <span className="news-impact-legs">
                          {actual ? (
                            <span className={`news-impact-move is-${actual.sinceRelease >= 0 ? "up" : "down"}`}>
                              {actual.sinceRelease >= 0 ? "▲" : "▼"} {signedPips(actual.sinceRelease)} pips
                            </span>
                          ) : <span>Loading…</span>}
                          {result !== null ? (
                            <em className={result >= 0 ? "is-up" : "is-down"}>
                              {result >= 0 ? "Helped you" : "Hurt you"} {signedPips(result)} pips
                            </em>
                          ) : null}
                          <small className="news-impact-detail">
                            {move ? `Expected ${move === "up" ? "▲ up" : "▼ down"}` : "No call"}
                            {actual && actual.firstReaction !== null ? ` · first ${FIRST_REACTION_MINUTES}m ${signedPips(actual.firstReaction)}` : ""}
                          </small>
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
