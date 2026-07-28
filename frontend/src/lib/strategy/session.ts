export interface ForexSessionStatus {
  marketOpen: boolean;
  entrySessionOpen: boolean;
  label: string;
}

/**
 * Forex has a Sunday 17:00 ET open and Friday 17:00 ET close. Entries are
 * deliberately narrower than market hours: London or New York only.
 */
export function getForexSessionStatus(now = new Date()): ForexSessionStatus {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  const marketOpen = Boolean(
    weekday && Number.isFinite(hour) &&
      weekday !== "Sat" &&
      !(weekday === "Sun" && hour < 17) &&
      !(weekday === "Fri" && hour >= 17),
  );

  if (!marketOpen) {
    return { marketOpen: false, entrySessionOpen: false, label: "Forex market closed" };
  }
  if (hour >= 8 && hour < 12) {
    return { marketOpen: true, entrySessionOpen: true, label: "London/New York overlap" };
  }
  if (hour >= 3 && hour < 8) {
    return { marketOpen: true, entrySessionOpen: true, label: "London" };
  }
  if (hour >= 12 && hour < 17) {
    return { marketOpen: true, entrySessionOpen: true, label: "New York" };
  }
  return { marketOpen: true, entrySessionOpen: false, label: "Outside London/New York sessions" };
}
