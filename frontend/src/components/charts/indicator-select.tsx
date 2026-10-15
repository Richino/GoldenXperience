"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Activity, Check, ChevronDown } from "lucide-react";
import {
  CHART_INDICATORS,
  type ChartIndicator,
} from "@/lib/chart-utils";

type IndicatorOption = (typeof CHART_INDICATORS)[number];
const byValue = new Map<string, IndicatorOption>(CHART_INDICATORS.map((indicator) => [indicator.value, indicator]));

/** What each one draws, in a line, so the menu explains itself. */
const DESCRIPTIONS: Partial<Record<ChartIndicator, string>> = {
  "support-resistance": "Key price levels from past turns",
  "swing-trend-lines": "Lines through swing highs and lows",
  "fibonacci-retracement": "Retracement levels of the last swing",
  amd: "Asia, London and New York to noon",
  "amd-range": "Accumulation box on any range",
  "amd-fvg": "Fair value gaps",
  atr14: "Average candle range, 14 bars",
  rsi14: "Momentum, 14 bars",
  "spread-filter": "Badge when the spread is over 2 pips",
  "session-filter": "Session reminder badge on the chart",
  "news-filter": "News reminder badge on the chart",
};

/** Short chip labels for the moving averages row. */
const CHIP_LABELS: Partial<Record<ChartIndicator, string>> = {
  ema21: "21",
  ema50: "50",
  "ema-50-100-200": "50/100/200",
  ema200: "200",
};

const SECTIONS: { title: string; chips?: boolean; items: ChartIndicator[] }[] = [
  { title: "Levels", items: ["support-resistance", "swing-trend-lines", "fibonacci-retracement"] },
  { title: "Sessions", items: ["amd", "amd-range", "amd-fvg"] },
  { title: "Moving averages · EMA", chips: true, items: ["ema21", "ema50", "ema-50-100-200", "ema200"] },
  { title: "Momentum & volatility", items: ["atr14", "rsi14"] },
  { title: "Filters", items: ["spread-filter", "session-filter", "news-filter"] },
];

function IndicatorSection({
  section,
  enabled,
  onToggle,
}: {
  section: (typeof SECTIONS)[number];
  enabled: ChartIndicator[];
  onToggle: (indicator: ChartIndicator) => void;
}) {
  const options = section.items.map((value) => byValue.get(value)).filter((option): option is IndicatorOption => Boolean(option));
  if (!options.length) return null;
  const onCount = options.filter((option) => enabled.includes(option.value)).length;
  return (
    <section className="ind-section">
      <h4 className="ind-section-title">
        {section.title}
        {onCount > 0 ? <span className="metric-number">{onCount} on</span> : null}
      </h4>
      {section.chips ? (
        <div className="ind-chips">
          {options.map((option) => {
            const selected = enabled.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={selected}
                aria-label={option.label}
                className={`ind-chip pressable${selected ? " is-on" : ""}`}
                onClick={() => onToggle(option.value)}
              >
                {selected ? <Check aria-hidden="true" /> : null}
                {CHIP_LABELS[option.value] ?? option.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="ind-rows">
          {options.map((option) => {
            const selected = enabled.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={selected}
                className={`ind-row pressable${selected ? " is-on" : ""}`}
                onClick={() => onToggle(option.value)}
              >
                <span className="ind-copy">
                  <b>{option.label}</b>
                  {DESCRIPTIONS[option.value] ? <small>{DESCRIPTIONS[option.value]}</small> : null}
                </span>
                <span className="ind-switch" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function IndicatorSelect({
  enabled,
  onChange,
  compact = false,
  toolbar = false,
}: {
  enabled: ChartIndicator[];
  onChange: (enabled: ChartIndicator[]) => void;
  compact?: boolean;
  toolbar?: boolean;
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
          toolbar
            ? `gx-toolbar-btn pressable ${isOpen || hasActive ? "is-active" : ""}`
            : compact
            ? `signals-tool-btn pressable ${compactTriggerClassName}`
            : `pressable inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${triggerClassName}`
        }
      >
        <Activity className={`${toolbar ? "size-3.5" : "size-4"} shrink-0`} strokeWidth={2} />
        {compact && !toolbar ? (
          activeCount > 0 ? (
            <span className="signals-tool-badge">{activeCount}</span>
          ) : null
        ) : (
          <>
            <span>
              Indicators{activeCount > 0 ? ` · ${activeCount}` : ""}
            </span>
            {toolbar ? null : (
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform ${
                isOpen || hasActive
                  ? "text-[color:var(--accent)]"
                  : "text-[color:var(--muted)]"
              } ${isOpen ? "rotate-180" : ""}`}
              strokeWidth={2}
            />
            )}
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
            className="menu-popover ind-menu absolute right-0 left-auto top-[calc(100%+6px)] z-50 origin-top-right overflow-hidden rounded-2xl"
          >
            <header className="ind-head">
              <div>
                <b>Indicators</b>
                <span>{activeCount > 0 ? `${activeCount} on` : "None on"}</span>
              </div>
              {activeCount > 0 ? (
                <button type="button" className="ind-clear pressable" onClick={() => onChange([])}>
                  Clear all
                </button>
              ) : null}
            </header>
            <div className="ind-scroll">
              {SECTIONS.map((section) => (
                <IndicatorSection key={section.title} section={section} enabled={enabled} onToggle={toggleIndicator} />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
