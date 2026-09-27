"use client";

import { Check, ChevronRight } from "lucide-react";
import { MobileSheet } from "@/components/ui/mobile-sheet";

/**
 * Phone Settings building blocks, matching the app's Settings tab: a tappable
 * row (label left, value + chevron right) and a picker drawer whose options
 * carry a one-line detail and a tick on the current choice.
 */
export function PhoneSettingsRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="phone-settings-row-label">{label}</span>
      <span className="phone-settings-row-end">
        <span className="phone-settings-row-value">{value}</span>
        {onClick ? <ChevronRight className="phone-settings-row-chevron" strokeWidth={2} aria-hidden="true" /> : null}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className="phone-settings-row pressable" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="phone-settings-row">{content}</div>
  );
}

export function PhoneSettingsPicker<T extends string>({
  open,
  onClose,
  eyebrow,
  title,
  options,
  selected,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  title: string;
  options: readonly { value: T; label: string; detail: string }[];
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <MobileSheet open={open} onClose={onClose} eyebrow={eyebrow} title={title}>
      <div role="radiogroup" aria-label={title} className="phone-settings-options">
        {options.map((option) => {
          const isSelected = option.value === selected;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`phone-settings-option pressable${isSelected ? " is-selected" : ""}`}
              onClick={() => onSelect(option.value)}
            >
              <span className="phone-settings-option-copy">
                <span className="phone-settings-option-label">{option.label}</span>
                <span className="phone-settings-option-detail">{option.detail}</span>
              </span>
              {isSelected ? <Check className="phone-settings-option-check" strokeWidth={2.5} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </MobileSheet>
  );
}
