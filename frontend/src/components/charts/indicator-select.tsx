"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  CHART_INDICATORS,
  type ChartIndicator,
} from "@/lib/chart-utils";

const OVERLAY_INDICATORS = CHART_INDICATORS.filter(
  (indicator) => indicator.group === "overlay",
);
const FILTER_INDICATORS = CHART_INDICATORS.filter(
  (indicator) => indicator.group === "filter",
);

function IndicatorGroup({
  title,
  options,
  enabled,
  onToggle,
  reducedMotion,
}: {
  title: string;
  options: ReadonlyArray<(typeof CHART_INDICATORS)[number]>;
  enabled: ChartIndicator[];
  onToggle: (indicator: ChartIndicator) => void;
  reducedMotion: boolean | null;
}) {
  return (
    <div className="px-1">
      <div className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--muted)]">
        {title}
      </div>
      <div className="flex flex-col gap-1">
        {options.map((option, index) => {
          const selected = enabled.includes(option.value);

          return (
            <motion.button
              key={option.value}
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected}
              initial={reducedMotion ? false : { opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                duration: 0.18,
                delay: reducedMotion ? 0 : index * 0.02,
                ease: [0.22, 1, 0.36, 1],
              }}
              onClick={() => onToggle(option.value)}
              className={`pressable flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left text-xs font-medium ${
                selected
                  ? "menu-item-active"
                  : "text-[color:var(--muted-strong)] hover:bg-[color:var(--surface-raised)] hover:text-[color:var(--foreground)]"
              }`}
            >
              <span
                className={`grid size-4 shrink-0 place-items-center rounded-md border ${
                  selected
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--background)]"
                    : "border-[color:var(--border-strong)] bg-[color:var(--surface)]"
                }`}
              >
                {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
              </span>
              {option.label}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

export function IndicatorSelect({
  enabled,
  onChange,
  compact = false,
}: {
  enabled: ChartIndicator[];
  onChange: (enabled: ChartIndicator[]) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const activeCount = enabled.length;

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

  function toggleIndicator(indicator: ChartIndicator) {
    onChange(
      enabled.includes(indicator)
        ? enabled.filter((item) => item !== indicator)
        : [...enabled, indicator],
    );
  }

  const isOpen = open;
  const hasActive = activeCount > 0;

  const triggerClassName = isOpen
    ? "control-active"
    : hasActive
      ? "border-[color:color-mix(in_srgb,var(--accent)_32%,var(--border-strong))] bg-[color:var(--surface)] text-[color:var(--accent)] hover:border-[color:color-mix(in_srgb,var(--accent)_48%,var(--border-strong))]"
      : "border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--foreground)] hover:border-[color:var(--border-strong)]";

  const compactTriggerClassName = isOpen
    ? "is-active"
    : hasActive
      ? "has-active"
      : "";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Chart indicators"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={
          compact
            ? `signals-tool-btn pressable ${compactTriggerClassName}`
            : `pressable inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${triggerClassName}`
        }
      >
        <SlidersHorizontal className="size-4 shrink-0" strokeWidth={2} />
        {compact ? (
          activeCount > 0 ? (
            <span className="signals-tool-badge">{activeCount}</span>
          ) : null
        ) : (
          <>
            <span>
              Indicators{activeCount > 0 ? ` · ${activeCount}` : ""}
            </span>
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform ${
                isOpen || hasActive
                  ? "text-[color:var(--accent)]"
                  : "text-[color:var(--muted)]"
              } ${isOpen ? "rotate-180" : ""}`}
              strokeWidth={2}
            />
          </>
        )}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            aria-label="Chart indicator options"
            initial={
              reducedMotion ? false : { opacity: 0, scale: 0.96, y: -6 }
            }
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={
              reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }
            }
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="menu-popover absolute right-0 left-auto top-[calc(100%+6px)] z-50 min-w-[220px] origin-top-right overflow-hidden rounded-2xl p-2"
          >
            <IndicatorGroup
              title="Overlays"
              options={OVERLAY_INDICATORS}
              enabled={enabled}
              onToggle={toggleIndicator}
              reducedMotion={reducedMotion}
            />
            <div className="my-2 h-px bg-[color:var(--border)]" />
            <IndicatorGroup
              title="Filters"
              options={FILTER_INDICATORS}
              enabled={enabled}
              onToggle={toggleIndicator}
              reducedMotion={reducedMotion}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
