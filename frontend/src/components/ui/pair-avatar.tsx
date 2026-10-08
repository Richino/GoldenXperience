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
  horizontal = false,
  className = "",
}: {
  instrument?: MajorInstrument;
  pair?: string;
  size?: number;
  horizontal?: boolean;
  className?: string;
}) {
  const { base, quote } = instrument
    ? currenciesFromInstrument(instrument)
    : currenciesFromPair(pair ?? "");
  const baseFlag = flagImageUrl(base, 160);
  const quoteFlag = flagImageUrl(quote, 160);
  const [failed, setFailed] = useState(false);

  const badgeSize = horizontal ? size : Math.round(size * 0.66);
  const quoteBadgeSize = horizontal ? Math.round(size * 0.87) : badgeSize;
  const avatarWidth = horizontal ? size * 2 - Math.round(size * 0.3) : size;
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
      style={{ width: avatarWidth, height: size }}
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
        width={quoteBadgeSize}
        height={quoteBadgeSize}
        onError={() => setFailed(true)}
        className="absolute rounded-full object-cover ring-2 ring-[color:var(--background)]"
        style={{
          width: quoteBadgeSize,
          height: quoteBadgeSize,
          right: 0,
          bottom: horizontal ? (size - quoteBadgeSize) / 2 : 0,
        }}
      />
    </div>
  );
}
