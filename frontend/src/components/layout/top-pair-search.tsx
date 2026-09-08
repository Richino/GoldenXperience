"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { INSTRUMENT_CATALOG } from "@/lib/instruments/catalog";

function clean(value: string) {
  return value.toLowerCase().replace(/[\s/_-]/g, "");
}

export function TopPairSearch() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const needle = clean(query);

  const matches = useMemo(() => {
    if (!needle) return INSTRUMENT_CATALOG.slice(0, 8);
    return INSTRUMENT_CATALOG.filter((item) =>
      clean(`${item.name} ${item.displayName}`).includes(needle),
    ).slice(0, 8);
  }, [needle]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  function go(instrument: string) {
    setOpen(false);
    setQuery("");
    router.push(`/chart?instrument=${encodeURIComponent(instrument)}`);
  }

  return (
    <div ref={rootRef} className="app-topbar-search">
      <label className="app-topbar-search-field">
        <Search className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              go(matches[0].name);
            }
          }}
          placeholder="Search pairs"
          aria-label="Search pairs"
        />
        {query ? (
          <button
            type="button"
            className="app-topbar-search-clear"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        ) : null}
      </label>
      {open ? (
        <div className="app-topbar-search-menu" role="listbox" aria-label="Matching pairs">
          {matches.length ? (
            matches.map((item) => (
              <button
                key={item.name}
                type="button"
                role="option"
                className="app-topbar-search-option"
                onMouseDown={(event) => {
                  event.preventDefault();
                  go(item.name);
                }}
              >
                {item.displayName}
              </button>
            ))
          ) : (
            <p className="app-topbar-search-empty">No matching pair</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
