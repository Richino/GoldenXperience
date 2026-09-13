/** Shared calendar-event shape, produced by every provider (live or saved). */
export interface RawEvent {
  id: string;
  /** Event time as epoch ms (UTC). Null for all-day / tentative items. */
  timestampMs: number | null;
  currency: string;
  impact: "high" | "medium" | "low" | "holiday" | "none";
  title: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  revised: string | null;
}

export function mapImpact(raw: string): RawEvent["impact"] {
  const s = raw.toLowerCase();
  if (s.includes("red") || s.includes("high")) return "high";
  if (s.includes("ora") || s.includes("med")) return "medium";
  if (s.includes("yel") || s.includes("low")) return "low";
  if (s.includes("gra") || s.includes("gry") || s.includes("holiday")) return "holiday";
  return "none";
}

export function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length && s !== "&nbsp;" ? s : null;
}

/**
 * Map one event object out of FF's `calendarComponentStates` shape. Shared by
 * the live scraper and the saved-HTML provider (both see the same object).
 */
export function eventFromState(ev: Record<string, unknown>): RawEvent | null {
  const id = str(ev.id) ?? str(ev.eventId);
  if (!id) return null;
  // FF `dateline` is unix SECONDS (UTC). All-day items may lack it.
  const dateline = Number(ev.dateline ?? ev.date);
  const timestampMs = Number.isFinite(dateline) && dateline > 0 ? dateline * 1000 : null;
  const impactSource = str(ev.impactClass) ?? str(ev.impactName) ?? str(ev.impactTitle) ?? "";
  return {
    id,
    timestampMs,
    currency: (str(ev.currency) ?? "").toUpperCase(),
    impact: mapImpact(impactSource),
    title: str(ev.name) ?? str(ev.title) ?? "",
    actual: str(ev.actual),
    forecast: str(ev.forecast),
    previous: str(ev.previous),
    revised: str(ev.revision) ?? str(ev.revised),
  };
}

/** Pull every event out of a `calendarComponentStates`-shaped object. */
export function eventsFromCalendarStates(states: Record<string, unknown>): RawEvent[] {
  const out: RawEvent[] = [];
  for (const key of Object.keys(states)) {
    const state = states[key] as { days?: Array<{ events?: unknown[] }> } | undefined;
    if (!state?.days) continue;
    for (const day of state.days) {
      for (const ev of day.events ?? []) {
        const parsed = eventFromState(ev as Record<string, unknown>);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}
