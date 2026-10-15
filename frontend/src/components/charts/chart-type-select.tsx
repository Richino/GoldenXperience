"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BarChart3,
  CandlestickChart,
  Check,
  ChevronDown,
  Circle,
  Layers,
  LineChart,
  TrendingUp,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { CHART_VARIANTS, type ChartVariant } from "@/lib/chart-utils";

export const VARIANT_ICONS: Record<ChartVariant, LucideIcon> = {
  candle: CandlestickChart,
  hollow: Circle,
  heikin: Layers,
  bar: BarChart3,
  line: LineChart,
  area: TrendingUp,
  baseline: Waves,
};

/** One line on what each style shows, so the menu explains itself. */
const VARIANT_DESCRIPTIONS: Record<ChartVariant, string> = {
  candle: "Open, high, low and close",
  hollow: "Hollow when price closed up",
  heikin: "Averaged candles, smoother trend",
  bar: "Open, high, low, close as bars",
  line: "Closing prices only",
  area: "Line with a shaded fill",
  baseline: "Above or below a set price",
};

export function ChartTypeSelect({
  value,
  onChange,
  compact = false,
  toolbar = false,
}: {
  value: ChartVariant;
  onChange: (value: ChartVariant) => void;
  compact?: boolean;
  toolbar?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const active =
    CHART_VARIANTS.find((option) => option.value === value) ??
    CHART_VARIANTS[0];
  const ActiveIcon = VARIANT_ICONS[active.value];

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Chart type"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={
          toolbar
            ? `gx-toolbar-btn pressable ${open ? "is-active" : ""}`
            : compact
            ? `signals-tool-btn pressable ${open ? "is-active" : ""}`
            : `pressable inline-flex min-h-9 min-w-[132px] items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                open
                  ? "control-active"
                  : "border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--foreground)] hover:border-[color:var(--border-strong)]"
              }`
        }
      >
        <ActiveIcon
          className={`shrink-0 ${compact || toolbar ? "size-3.5" : "size-3.5"}`}
          strokeWidth={2}
        />
        {compact && !toolbar ? null : (
          <>
            <span className={toolbar ? "" : "flex-1 text-left"}>{active.label}</span>
            {toolbar ? null : (
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform ${
                open
                  ? "text-[color:var(--accent)]"
                  : "text-[color:var(--muted)]"
              } ${open ? "rotate-180" : ""}`}
              strokeWidth={2}
            />
            )}
          </>
        )}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="listbox"
            aria-label="Chart type options"
            initial={
              reducedMotion
                ? false
                : { opacity: 0, scale: 0.96, y: -6 }
            }
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.98, y: -4 }
            }
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={`menu-popover opt-menu absolute top-[calc(100%+6px)] z-50 overflow-hidden rounded-2xl ${
              compact || toolbar ? "right-0 left-auto origin-top-right" : "left-0 origin-top-left"
            }`}
          >
            <header className="ind-head">
              <div>
                <b>Chart type</b>
                <span>{active.label}</span>
              </div>
            </header>
            <div className="ind-scroll">
              {CHART_VARIANTS.map((option) => {
                const Icon = VARIANT_ICONS[option.value];
                const selected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={`opt-row pressable${selected ? " is-on" : ""}`}
                  >
                    <span className="opt-icon" aria-hidden="true">
                      <Icon strokeWidth={2} />
                    </span>
                    <span className="ind-copy">
                      <b>{option.label}</b>
                      <small>{VARIANT_DESCRIPTIONS[option.value]}</small>
                    </span>
                    {selected ? <Check className="opt-check" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
