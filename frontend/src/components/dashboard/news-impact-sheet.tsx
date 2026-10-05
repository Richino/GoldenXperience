"use client";

import Link from "next/link";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { currenciesOf, displayNameFor, isKnownInstrument } from "@/lib/instruments/catalog";
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

export function NewsImpactSheet({
  event,
  positions,
  onClose,
}: {
  event: (CalendarValueFields & { id: string; timestamp: string }) | null;
  positions: NewsImpactPosition[];
  onClose: () => void;
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

          {hint.kind === "unknown" ? (
            <p className="news-impact-note">
              No clear better/worse reading for this event (speeches and similar), so its effect on
              {` ${currency}`} pairs can&apos;t be called in advance.
            </p>
          ) : (
            <>
              <ul className="news-impact-pairs">
                {pairs.map((instrument) => {
                  const position = held.get(instrument);
                  const move = currencyMove ? pairDirection(instrument, currency, currencyMove) : null;
                  const helps = (move: TrendDirection | null) =>
                    move && position ? (move === "up") === (position === "long") : null;
                  return (
                    <li key={instrument} className={position ? "is-held" : undefined}>
                      <Link href={`/chart?instrument=${instrument}`} onClick={onClose} className="news-impact-pair">
                        <span className="news-impact-pair-name">
                          {displayNameFor(instrument)}
                          {position ? (
                            <small className={`home-side is-${position}`}>{position === "long" ? "LONG" : "SHORT"}</small>
                          ) : null}
                        </span>
                        <span className="news-impact-legs">
                          {move ? <Arrow direction={move} /> : <span>No call</span>}
                          {move && position ? (
                            <em className={helps(move) ? "is-up" : "is-down"}>
                              {helps(move) ? "Helps you" : "Hurts you"}
                            </em>
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </MobileSheet>
  );
}
