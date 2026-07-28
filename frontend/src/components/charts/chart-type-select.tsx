"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BarChart3,
  CandlestickChart,
  ChevronDown,
  Circle,
  Layers,
  LineChart,
  TrendingUp,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { CHART_VARIANTS, type ChartVariant } from "@/lib/chart-utils";

const VARIANT_ICONS: Record<ChartVariant, LucideIcon> = {
  candle: CandlestickChart,
  hollow: Circle,
  heikin: Layers,
  bar: BarChart3,
  line: LineChart,
  area: TrendingUp,
  baseline: Waves,
};

export function ChartTypeSelect({
  value,
  onChange,
  compact = false,
}: {
  value: ChartVariant;
  onChange: (value: ChartVariant) => void;
  compact?: boolean;
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
          compact
            ? `signals-tool-btn pressable ${open ? "is-active" : ""}`
            : `pressable inline-flex min-h-9 min-w-[132px] items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                open
                  ? "control-active"
                  : "border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--foreground)] hover:border-[color:var(--border-strong)]"
              }`
        }
      >
        <ActiveIcon
          className={`shrink-0 ${compact ? "size-4" : "size-3.5"}`}
          strokeWidth={2}
        />
        {compact ? null : (
          <>
            <span className="flex-1 text-left">{active.label}</span>
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform ${
                open
                  ? "text-[color:var(--accent)]"
                  : "text-[color:var(--muted)]"
              } ${open ? "rotate-180" : ""}`}
              strokeWidth={2}
            />
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
            className={`menu-popover absolute top-[calc(100%+6px)] z-50 min-w-[188px] overflow-hidden rounded-2xl p-1.5 ${
              compact ? "right-0 left-auto origin-top-right" : "left-0 origin-top-left"
            }`}
          >
            {CHART_VARIANTS.map((option, index) => {
              const Icon = VARIANT_ICONS[option.value];
              const selected = option.value === value;

              return (
                <motion.button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  initial={reducedMotion ? false : { opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    duration: 0.18,
                    delay: reducedMotion ? 0 : index * 0.025,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`pressable flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-medium ${
                    selected
                      ? "menu-item-active"
                      : "text-[color:var(--muted-strong)] hover:bg-[color:var(--surface-raised)] hover:text-[color:var(--foreground)]"
                  }`}
                >
                  <Icon className="size-3.5 shrink-0" strokeWidth={selected ? 2.1 : 1.8} />
                  {option.label}
                </motion.button>
              );
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
