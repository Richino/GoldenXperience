import type { MajorInstrument } from "@/types/forex";

export type CalendarDataSource = "forex_factory" | "mock";

export interface EconomicCalendarEvent {
  id: string;
  title: string;
  currency: string;
  region: string;
  impact: number;
  timestamp: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  unit: string | null;
}

export interface CalendarWarning {
  tone: "danger" | "accent" | "success";
  message: string;
}

export interface EconomicCalendarSnapshot {
  events: EconomicCalendarEvent[];
  source: CalendarDataSource;
  connected: boolean;
  sessionLabel: string;
  highImpactNewsWithinMinutes: number | null;
  warnings: CalendarWarning[];
  /**
   * How far ahead the underlying feed actually reaches. Null when unknown.
   * A quiet calendar only means "no events" out to here — past this point the
   * absence of warnings is missing data, not an all-clear.
   */
  coverageUntil: string | null;
}

export interface OandaCalendarEvent {
  impact: number;
  currency: string;
  actual?: string;
  market?: string;
  title: string;
  timestamp: number;
  region: string;
  previous?: string;
  unit?: string;
  forecast?: string;
}

const HIGH_IMPACT_THRESHOLD = 3;
const ENTRY_BUFFER_MINUTES = 30;
/** The window the "no high-impact events" message implicitly claims to cover. */
const LOOKAHEAD_MINUTES = 24 * 60;

function formatMinutesUntil(minutes: number) {
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function getActiveSessionLabel(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/New_York",
    }).format(now),
  );

  if (hour >= 8 && hour < 17) {
    return "New York session active";
  }

  if (hour >= 3 && hour < 8) {
    return "London session active";
  }

  if (hour >= 19 || hour < 3) {
    return "Tokyo session active";
  }

  return "Sydney session active";
}

function eventKey(event: Pick<OandaCalendarEvent, "title" | "timestamp" | "currency">) {
  return `${event.currency}:${event.title}:${event.timestamp}`;
}

function normalizeOandaEvent(event: OandaCalendarEvent): EconomicCalendarEvent {
  return {
    id: eventKey(event),
    title: event.title,
    currency: event.currency,
    region: event.region,
    impact: event.impact,
    timestamp: new Date(event.timestamp * 1000).toISOString(),
    forecast: event.forecast ?? null,
    previous: event.previous ?? null,
    actual: event.actual ?? null,
    unit: event.unit ?? null,
  };
}

export function mergeOandaCalendarEvents(
  batches: OandaCalendarEvent[][],
): EconomicCalendarEvent[] {
  const byKey = new Map<string, EconomicCalendarEvent>();

  for (const batch of batches) {
    for (const event of batch) {
      byKey.set(eventKey(event), normalizeOandaEvent(event));
    }
  }

  return [...byKey.values()].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}

export function buildCalendarSnapshot({
  events,
  source,
  connected,
  coverageUntil = null,
  now = new Date(),
}: {
  events: EconomicCalendarEvent[];
  source: CalendarDataSource;
  connected: boolean;
  coverageUntil?: string | null;
  now?: Date;
}): EconomicCalendarSnapshot {
  const upcoming = events.filter(
    (event) => Date.parse(event.timestamp) >= now.getTime(),
  );
  const highImpactUpcoming = upcoming.filter(
    (event) => event.impact >= HIGH_IMPACT_THRESHOLD,
  );
  const nextHighImpact = highImpactUpcoming[0] ?? null;
  const highImpactNewsWithinMinutes = nextHighImpact
    ? Math.max(
        0,
        Math.round(
          (Date.parse(nextHighImpact.timestamp) - now.getTime()) / 60_000,
        ),
      )
    : null;

  let warnings: CalendarWarning[];

  if (!connected) {
    warnings = [
      {
        tone: "danger",
        message:
          "News calendar is not connected — verify high-impact events manually.",
      },
    ];
  } else if (highImpactUpcoming.length === 0) {
    // A quiet feed that stops before the buffer window is missing data, not an
    // all-clear. Saying "nothing scheduled" there would be a false negative on
    // a gate whose whole job is to keep entries away from news.
    const coverageMs = coverageUntil ? Date.parse(coverageUntil) : NaN;
    const coversLookahead =
      Number.isFinite(coverageMs) &&
      coverageMs - now.getTime() >= LOOKAHEAD_MINUTES * 60_000;

    warnings = coverageUntil && !coversLookahead
      ? [
          {
            tone: "accent",
            message:
              "Calendar data ends soon — confirm high-impact events manually beyond it.",
          },
        ]
      : [
          {
            tone: "success",
            message: "No high-impact events in the next 24 hours.",
          },
        ];
  } else {
    warnings = highImpactUpcoming.slice(0, 4).map((event) => {
      const minutes = Math.max(
        0,
        Math.round(
          (Date.parse(event.timestamp) - now.getTime()) / 60_000,
        ),
      );
      const inEntryBuffer = minutes <= ENTRY_BUFFER_MINUTES;

      return {
        tone: inEntryBuffer ? "danger" : "accent",
        message:
          minutes === 0
            ? `${event.title} is releasing now — avoid entries`
            : `${event.title} in ${formatMinutesUntil(minutes)} — avoid entries`,
      };
    });
  }

  return {
    events: upcoming,
    source,
    connected,
    sessionLabel: getActiveSessionLabel(now),
    highImpactNewsWithinMinutes,
    warnings,
    coverageUntil,
  };
}

export function createMockCalendarEvents(now = new Date()): EconomicCalendarEvent[] {
  return [
    {
      id: "mock-cpi",
      title: "CPI",
      currency: "USD",
      region: "americas",
      impact: 3,
      timestamp: new Date(now.getTime() + 42 * 60_000).toISOString(),
      forecast: "0.3",
      previous: "0.2",
      actual: null,
      unit: "% m/m",
    },
  ];
}

export const DEFAULT_CALENDAR_INSTRUMENTS: MajorInstrument[] = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
];
