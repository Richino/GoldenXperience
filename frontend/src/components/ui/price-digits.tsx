"use client";

import { useEffect, useRef, useState } from "react";
import { findInstrument } from "@/lib/instruments/catalog";

type Tick = { id: number; direction: "up" | "down"; from: number };

/**
 * A quote split the way dealing screens show it: the quiet big figure, the two
 * pip digits that actually move, and a small pipette. When the price changes,
 * the digits from the first changed one onward flash up or down once.
 */
export function PriceDigits({ value, instrument, className = "" }: { value: number; instrument: string; className?: string }) {
  const info = findInstrument(instrument);
  const precision = info?.displayPrecision ?? 5;
  const pipDecimals = -(info?.pipLocation ?? -4);
  const text = Number.isFinite(value) ? value.toFixed(precision) : "—";

  const previous = useRef<{ text: string; value: number; instrument: string } | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);

  useEffect(() => {
    const last = previous.current;
    previous.current = { text, value, instrument };
    // A new pair is a new quote, not a move.
    if (!last || last.instrument !== instrument || last.text.length !== text.length) {
      setTick(null);
      return;
    }
    if (last.text === text) return;
    let from = 0;
    while (from < text.length && text[from] === last.text[from]) from += 1;
    setTick((current) => ({ id: (current?.id ?? 0) + 1, direction: value > last.value ? "up" : "down", from }));
  }, [instrument, text, value]);

  const dot = text.indexOf(".");
  if (dot < 0 || pipDecimals < 1) return <span className={`gx-price ${className}`}>{text}</span>;

  // "5.59776" with pips at the 4th decimal → "5.59" · "77" · "6".
  const pipEnd = Math.min(text.length, dot + 1 + pipDecimals);
  const pipStart = Math.max(0, pipEnd - 2);
  const parts = [
    { key: "big", start: 0, end: pipStart },
    { key: "pips", start: pipStart, end: pipEnd },
    { key: "pipette", start: pipEnd, end: text.length },
  ].filter((part) => part.end > part.start);

  return (
    <span className={`gx-price ${className}`} aria-label={text}>
      {parts.map((part) => {
        const moved = tick && part.end > tick.from;
        return (
          <span
            key={moved ? `${part.key}-${tick.id}` : part.key}
            className={`gx-price-${part.key}${moved ? ` is-tick-${tick.direction}` : ""}`}
            aria-hidden
          >
            {text.slice(part.start, part.end)}
          </span>
        );
      })}
    </span>
  );
}
