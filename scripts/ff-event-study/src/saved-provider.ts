/**
 * Saved-file provider — parses Forex Factory data you exported/saved yourself
 * from a normal, trusted browser. Nothing here touches the network, so there is
 * no Cloudflare wall to fight: you already loaded the page as a human.
 *
 * Drop any of these into the input folder (mix freely, one run reads them all):
 *   - *.html  "Save Page As" of forexfactory.com/calendar (any week/day view).
 *             The saved HTML still embeds FF's `calendarComponentStates`, which
 *             carries the unix `dateline`, actual/forecast/previous, impact.
 *             Falls back to parsing the visible table if the state is absent.
 *   - *.json  FF's own calendar export, or the faireconomy weekly feed
 *             (ff_calendar_thisweek.json), or a dumped calendarComponentStates.
 *   - *.csv   FF's calendar CSV export.
 *
 * Everything is normalised to the same RawEvent shape the live scraper emits, so
 * the rest of the pipeline (related-before, OANDA enrichment) is identical.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import {
  eventsFromCalendarStates,
  eventFromState,
  mapImpact,
  str,
  type RawEvent,
} from "./types.js";

function dedupe(events: RawEvent[]): RawEvent[] {
  const byKey = new Map<string, RawEvent>();
  for (const e of events) {
    // FF ids are stable; synthetic keys fall back to time+currency+title.
    const key =
      e.id && !e.id.startsWith("syn:")
        ? e.id
        : `${e.timestampMs ?? "na"}|${e.currency}|${e.title}`;
    byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
}

function synthId(currency: string, title: string, timestampMs: number | null): string {
  return `syn:${timestampMs ?? "na"}:${currency}:${title}`.slice(0, 120);
}

/** Epoch ms from a variety of shapes FF exports use. */
function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // Heuristic: seconds vs milliseconds.
    return value > 1e12 ? value : value * 1000;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// JSON inputs
// ---------------------------------------------------------------------------

/** One item of the faireconomy / FF-export array form. */
export function eventFromFeedItem(item: Record<string, unknown>): RawEvent | null {
  const title = str(item.title) ?? str(item.name) ?? str(item.event);
  const currency = (str(item.country) ?? str(item.currency) ?? "").toUpperCase();
  if (!title || !currency) return null;
  const timestampMs = toMs(item.date ?? item.dateline ?? item.timestamp ?? item.time);
  const impact = mapImpact(str(item.impact) ?? str(item.impactClass) ?? "");
  const id = str(item.id) ?? synthId(currency, title, timestampMs);
  return {
    id,
    timestampMs,
    currency,
    impact,
    title,
    actual: str(item.actual),
    forecast: str(item.forecast),
    previous: str(item.previous),
    revised: str(item.revised) ?? str(item.revision),
  };
}

function parseJson(text: string): RawEvent[] {
  const data = JSON.parse(text) as unknown;

  // a) faireconomy feed / export: a plain array of event items.
  if (Array.isArray(data)) {
    return data
      .map((item) => eventFromFeedItem(item as Record<string, unknown>))
      .filter((e): e is RawEvent => e !== null);
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // b) dumped calendarComponentStates (possibly nested under a key).
    const states =
      "days" in obj || Object.values(obj).some((v) => v && typeof v === "object" && "days" in (v as object))
        ? (obj.calendarComponentStates as Record<string, unknown> | undefined) ?? obj
        : (obj.calendarComponentStates as Record<string, unknown> | undefined);
    if (states) {
      const events = eventsFromCalendarStates(states);
      if (events.length) return events;
    }
    // c) export wrapped as { events: [...] } / { data: [...] }.
    const arr = (obj.events ?? obj.data ?? obj.items) as unknown;
    if (Array.isArray(arr)) {
      return arr
        .map((item) => eventFromFeedItem(item as Record<string, unknown>))
        .filter((e): e is RawEvent => e !== null);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// HTML inputs
// ---------------------------------------------------------------------------

/** Pull the `calendarComponentStates = {...}` object literal out of saved HTML. */
function extractStatesFromHtml(html: string): Record<string, unknown> | null {
  const marker = html.indexOf("calendarComponentStates");
  if (marker === -1) return null;
  const braceStart = html.indexOf("{", marker);
  if (braceStart === -1) return null;

  // Bracket-match to the closing brace, skipping over string literals so a `}`
  // inside a value does not end the object early.
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const literal = html.slice(braceStart, i + 1);
        try {
          return JSON.parse(literal) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** DOM fallback: read the visible calendar table. Loses exact UTC time, so it
 * derives a timestamp from the visible date/time in UTC — less precise than the
 * embedded state, and used only when the state literal cannot be parsed. */
function parseHtmlTable(root: HTMLElement): RawEvent[] {
  const rows = root.querySelectorAll("tr.calendar__row, tr.calendar_row");
  const events: RawEvent[] = [];
  let currentDateMs: number | null = null;
  let currentTime = "";

  const cellText = (row: HTMLElement, sel: string) =>
    str(row.querySelector(sel)?.textContent ?? row.querySelector(sel)?.getAttribute("title") ?? "");

  for (const row of rows) {
    const dateCell = row.querySelector(".calendar__date, .calendar_date");
    if (dateCell) {
      const parsed = Date.parse(`${dateCell.textContent?.trim()} UTC`);
      if (Number.isFinite(parsed)) currentDateMs = parsed;
    }

    const title = cellText(row, ".calendar__event, .calendar_event");
    const currency = (cellText(row, ".calendar__currency, .calendar_currency") ?? "").toUpperCase();
    if (!title || !currency) continue;

    const time = cellText(row, ".calendar__time, .calendar_time");
    if (time && !/^(all day|tentative)$/i.test(time)) currentTime = time;

    let timestampMs = currentDateMs;
    const hm = currentTime.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (timestampMs !== null && hm) {
      let h = Number(hm[1]) % 12;
      if (hm[3]?.toLowerCase() === "pm") h += 12;
      timestampMs += (h * 60 + Number(hm[2])) * 60_000;
    }

    const impactEl = row.querySelector(".calendar__impact span, .calendar_impact span");
    const impact = mapImpact(
      impactEl?.getAttribute("title") ?? impactEl?.getAttribute("class") ?? "",
    );

    events.push({
      id: synthId(currency, title, timestampMs),
      timestampMs,
      currency,
      impact,
      title,
      actual: cellText(row, ".calendar__actual, .calendar_actual"),
      forecast: cellText(row, ".calendar__forecast, .calendar_forecast"),
      previous: cellText(row, ".calendar__previous, .calendar_previous"),
      revised: null,
    });
  }
  return events;
}

function parseHtmlFile(html: string): RawEvent[] {
  const states = extractStatesFromHtml(html);
  if (states) {
    const events = eventsFromCalendarStates(states);
    if (events.length) return events;
  }
  return parseHtmlTable(parseHtml(html));
}

// ---------------------------------------------------------------------------
// CSV inputs
// ---------------------------------------------------------------------------

/** Split a CSV line honouring simple double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): RawEvent[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;

  const iTitle = col(["title", "event", "name"]);
  const iCur = col(["currency", "country"]);
  const iImpact = col(["impact"]);
  const iActual = col(["actual"]);
  const iForecast = col(["forecast"]);
  const iPrevious = col(["previous"]);
  const iDate = col(["date", "datetime", "start"]);
  const iTime = col(["time"]);

  const events: RawEvent[] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const title = str(f[iTitle]);
    const currency = (str(f[iCur]) ?? "").toUpperCase();
    if (!title || !currency) continue;
    const dateStr = [iDate >= 0 ? f[iDate] : "", iTime >= 0 ? f[iTime] : ""].join(" ").trim();
    const timestampMs = toMs(dateStr);
    events.push({
      id: synthId(currency, title, timestampMs),
      timestampMs,
      currency,
      impact: mapImpact(iImpact >= 0 ? f[iImpact] ?? "" : ""),
      title,
      actual: iActual >= 0 ? str(f[iActual]) : null,
      forecast: iForecast >= 0 ? str(f[iForecast]) : null,
      previous: iPrevious >= 0 ? str(f[iPrevious]) : null,
      revised: null,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Folder loader
// ---------------------------------------------------------------------------

export interface LoadSavedResult {
  events: RawEvent[];
  files: Array<{ file: string; parsed: number }>;
}

export async function loadSavedEvents(
  inputDir: string,
  log: (msg: string) => void = () => {},
): Promise<LoadSavedResult> {
  const entries = await readdir(inputDir);
  const files: LoadSavedResult["files"] = [];
  const all: RawEvent[] = [];

  for (const name of entries.sort()) {
    const ext = extname(name).toLowerCase();
    if (![".html", ".htm", ".json", ".csv"].includes(ext)) continue;
    const full = join(inputDir, name);
    const text = await readFile(full, "utf8");

    let parsed: RawEvent[] = [];
    try {
      if (ext === ".json") parsed = parseJson(text);
      else if (ext === ".csv") parsed = parseCsv(text);
      else parsed = parseHtmlFile(text);
    } catch (err) {
      log(`  ! failed to parse ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }

    log(`  ${name}: ${parsed.length} events`);
    files.push({ file: name, parsed: parsed.length });
    all.push(...parsed);
  }

  return { events: dedupe(all), files };
}
