"use client";

import { useState } from "react";
import {
  currenciesFromInstrument,
  currenciesFromPair,
  flagImageUrl,
  pairInitials,
} from "@/lib/pair-flags";
import type { MajorInstrument } from "@/types/forex";

export function PairAvatar({
  instrument,
  pair,
  size = 40,
  className = "",
}: {
  instrument?: MajorInstrument;
  pair?: string;
  size?: number;
  className?: string;
}) {
  const { base, quote } = instrument
    ? currenciesFromInstrument(instrument)
    : currenciesFromPair(pair ?? "");
  const baseFlag = flagImageUrl(base);
  const quoteFlag = flagImageUrl(quote);
  const [failed, setFailed] = useState(false);

  const badgeSize = Math.round(size * 0.66);
  const showFlags = baseFlag && quoteFlag && !failed;

  if (!showFlags) {
    return (
      <div
        className={`grid shrink-0 place-items-center rounded-full bg-[color:var(--surface)] text-xs font-bold text-[color:var(--foreground)] ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        {pairInitials(base)}
      </div>
    );
  }

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={baseFlag}
        width={badgeSize}
        height={badgeSize}
        onError={() => setFailed(true)}
        className="absolute left-0 top-0 rounded-full object-cover ring-2 ring-[color:var(--background)]"
        style={{ width: badgeSize, height: badgeSize }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={quoteFlag}
        width={badgeSize}
        height={badgeSize}
        onError={() => setFailed(true)}
        className="absolute rounded-full object-cover ring-2 ring-[color:var(--background)]"
        style={{
          width: badgeSize,
          height: badgeSize,
          right: 0,
          bottom: 0,
        }}
      />
    </div>
  );
}
