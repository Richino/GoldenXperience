"use client";

import { useState } from "react";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { VARIANT_ICONS } from "@/components/charts/chart-type-select";
import {
  CHART_INDICATORS,
  CHART_VARIANTS,
  type ChartIndicator,
  type ChartVariant,
} from "@/lib/chart-utils";

const INDICATOR_GROUPS = [
  {
    title: "Overlays",
    options: CHART_INDICATORS.filter((indicator) => indicator.group === "overlay"),
  },
  {
    title: "Filters",
    options: CHART_INDICATORS.filter((indicator) => indicator.group === "filter"),
  },
];

/**
 * `iconOnly` keeps all four triggers on one row at 375px. The icon carries the
 * current value for those, and the aria-label and sheet header still name it.
 */
function SheetTrigger({
  label,
  open,
  onOpen,
  ariaLabel,
  active = false,
  icon,
  badge,
  iconOnly = false,
}: {
  label: string;
  open: boolean;
  onOpen: () => void;
  ariaLabel: string;
  active?: boolean;
  icon?: React.ReactNode;
  badge?: number;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={ariaLabel}
      className={`sheet-trigger pressable ${open ? "is-open" : ""} ${
        active ? "has-active" : ""
      }`}
    >
      {icon}
      {iconOnly ? null : <span className="sheet-trigger-label">{label}</span>}
      {badge ? <span className="sheet-trigger-badge">{badge}</span> : null}
      <ChevronDown className="sheet-trigger-caret size-3.5" strokeWidth={2} />
    </button>
  );
}

function SheetOption({
  label,
  selected,
  onSelect,
  icon,
  multi = false,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  multi?: boolean;
}) {
  return (
    <button
      type="button"
      role={multi ? "menuitemcheckbox" : "option"}
      aria-selected={multi ? undefined : selected}
      aria-checked={multi ? selected : undefined}
      onClick={onSelect}
      className={`sheet-option pressable ${selected ? "is-selected" : ""}`}
    >
      {multi ? (
        <span className={`sheet-option-check ${selected ? "is-on" : ""}`}>
          {selected ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
      ) : (
        icon ?? null
      )}
      <span className="flex-1 text-left">{label}</span>
      {!multi && selected ? (
        <Check className="size-4 shrink-0 text-[color:var(--accent)]" strokeWidth={2.5} />
      ) : null}
    </button>
  );
}

/** Single-select sheet for the plain string option lists (timeframe, range). */
export function ChartOptionSheet<T extends string>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SheetTrigger
        label={value}
        open={open}
        onOpen={() => setOpen(true)}
        ariaLabel={`${title} · ${value}`}
      />
      <MobileSheet open={open} onClose={() => setOpen(false)} title={title}>
        <div role="listbox" aria-label={title} className="sheet-option-list">
          {options.map((option) => (
            <SheetOption
              key={option}
              label={option}
              selected={option === value}
              onSelect={() => {
                onChange(option);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </MobileSheet>
    </>
  );
}

export function ChartTypeSheet({
  value,
  onChange,
}: {
  value: ChartVariant;
  onChange: (next: ChartVariant) => void;
}) {
  const [open, setOpen] = useState(false);
  const active =
    CHART_VARIANTS.find((option) => option.value === value) ?? CHART_VARIANTS[0];
  const ActiveIcon = VARIANT_ICONS[active.value];

  return (
    <>
      <SheetTrigger
        iconOnly
        label={active.label}
        open={open}
        onOpen={() => setOpen(true)}
        ariaLabel={`Chart type · ${active.label}`}
        icon={<ActiveIcon className="size-4 shrink-0" strokeWidth={2} />}
      />
      <MobileSheet open={open} onClose={() => setOpen(false)} title="Chart type">
        <div role="listbox" aria-label="Chart type" className="sheet-option-list">
          {CHART_VARIANTS.map((option) => {
            const Icon = VARIANT_ICONS[option.value];
            return (
              <SheetOption
                key={option.value}
                label={option.label}
                selected={option.value === value}
                icon={<Icon className="size-4 shrink-0" strokeWidth={2} />}
                onSelect={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              />
            );
          })}
        </div>
      </MobileSheet>
    </>
  );
}

/**
 * Indicators toggle several values at once, so this sheet stays open on tap and
 * is dismissed by the handle, the close button, or the backdrop.
 */
export function IndicatorSheet({
  enabled,
  onChange,
}: {
  enabled: ChartIndicator[];
  onChange: (next: ChartIndicator[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(indicator: ChartIndicator) {
    onChange(
      enabled.includes(indicator)
        ? enabled.filter((item) => item !== indicator)
        : [...enabled, indicator],
    );
  }

  return (
    <>
      <SheetTrigger
        iconOnly
        label="Indicators"
        open={open}
        onOpen={() => setOpen(true)}
        ariaLabel={`Chart indicators · ${enabled.length} on`}
        active={enabled.length > 0}
        badge={enabled.length}
        icon={<SlidersHorizontal className="size-4 shrink-0" strokeWidth={2} />}
      />
      <MobileSheet open={open} onClose={() => setOpen(false)} title="Indicators">
        <div role="menu" aria-label="Chart indicators">
          {INDICATOR_GROUPS.map((group) => (
            <div key={group.title} className="sheet-option-group">
              <p className="sheet-option-group-title">{group.title}</p>
              <div className="sheet-option-list">
                {group.options.map((option) => (
                  <SheetOption
                    multi
                    key={option.value}
                    label={option.label}
                    selected={enabled.includes(option.value)}
                    onSelect={() => toggle(option.value)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </MobileSheet>
    </>
  );
}
