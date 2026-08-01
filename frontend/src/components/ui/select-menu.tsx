"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";

export type SelectMenuOption<T extends string | number> = {
  value: T;
  label: string;
};

export function SelectMenu<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
  align = "left",
  fullWidth = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectMenuOption<T>[];
  ariaLabel: string;
  className?: string;
  align?: "left" | "right";
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const active = options.find((option) => option.value === value) ?? options[0];

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
    <div ref={rootRef} className={`relative ${fullWidth ? "w-full" : ""} ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`pressable inline-flex h-9 min-w-[7.25rem] items-center gap-2 rounded-[10px] border px-3 text-sm transition-colors ${
          fullWidth ? "w-full" : ""
        } ${
          open
            ? "control-active"
            : "border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--foreground)] hover:border-[color:var(--border-strong)]"
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{active.label}</span>
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform ${
            open ? "rotate-180 text-[color:var(--accent)]" : "text-[color:var(--muted)]"
          }`}
          strokeWidth={2}
        />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="listbox"
            aria-label={ariaLabel}
            initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={`menu-popover absolute top-[calc(100%+6px)] z-50 min-w-full overflow-hidden rounded-2xl p-1.5 ${
              align === "right" ? "right-0 left-auto origin-top-right" : "left-0 origin-top-left"
            }`}
          >
            {options.map((option, index) => {
              const selected = option.value === value;

              return (
                <motion.button
                  key={String(option.value)}
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
                  className={`pressable flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium ${
                    selected
                      ? "menu-item-active"
                      : "text-[color:var(--muted-strong)] hover:bg-[color:var(--surface-raised)] hover:text-[color:var(--foreground)]"
                  }`}
                >
                  <span className="flex-1">{option.label}</span>
                  {selected ? <Check className="size-3.5 shrink-0" strokeWidth={2.5} /> : null}
                </motion.button>
              );
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
