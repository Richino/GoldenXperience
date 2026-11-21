"use client";

import { useMemo, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { tradingDayKey } from "@/lib/format/datetime";
import type { AccountBalanceHistoryPoint } from "@/types/forex";

/**
 * Home's daily win/loss calendar. Every figure comes from the broker's own
 * balance history, so a day is exactly what the account gained or lost on it:
 * closed trades plus overnight interest, on the New York trading day.
 */

type DayResult = { net: number; trades: number; tradePl: number; financing: number };

// No Saturday: forex is shut from Friday's close to Sunday evening, so the
// day never trades. Sunday stays for the evening session.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sun"];

/** Grid column for a date key (Mon 0 … Fri 4, Sun 5); null for Saturday. */
function weekdayColumn(key: string) {
  const day = new Date(`${key}T12:00:00Z`).getUTCDay();
  if (day === 6) return null;
  return day === 0 ? 5 : day - 1;
}

function money(value: number, currency: string, signed = false) {
  const body = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(Math.abs(value));
  return signed ? `${value < 0 ? "−" : "+"}${body}` : body;
}

/** Short cell figure: "+$465", "−$1.2k". */
function compactMoney(value: number, currency: string) {
  const abs = Math.abs(value);
  const body = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: abs >= 1000 ? "compact" : "standard",
    maximumFractionDigits: abs >= 1000 ? 1 : 0,
  }).format(abs);
  return `${value < 0 ? "−" : "+"}${body}`;
}

/** "2026-11" → year, month number and how many days it has. */
function monthLayout(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return { year: year!, monthNumber: monthNumber!, days };
}

function shiftMonth(month: string, delta: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(month: string, length: "long" | "short" = "long") {
  const { year, monthNumber } = monthLayout(month);
  return new Intl.DateTimeFormat("en-US", { month: length, year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, monthNumber - 1, 1));
}

/** A sideways swipe of at least this many pixels changes month. */
const SWIPE_PX = 48;

function dayTitle(key: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
}

export function PnlCalendar({
  history,
  todayKey,
  currency,
  mobile,
}: {
  history: AccountBalanceHistoryPoint[];
  todayKey: string;
  currency: string;
  mobile: boolean;
}) {
  const days = useMemo(() => {
    const byDay = new Map<string, DayResult>();
    for (const point of history) {
      if (!Number.isFinite(point.change)) continue;
      const key = tradingDayKey(point.time);
      const day = byDay.get(key) ?? { net: 0, trades: 0, tradePl: 0, financing: 0 };
      day.net += point.change;
      if (point.type === "DAILY_FINANCING") day.financing += point.change;
      else {
        day.tradePl += point.change;
        if (point.type === "ORDER_FILL") day.trades += 1;
      }
      byDay.set(key, day);
    }
    return byDay;
  }, [history]);

  const currentMonth = todayKey.slice(0, 7);
  const firstMonth = useMemo(() => {
    const keys = [...days.keys()].sort();
    return keys[0]?.slice(0, 7) ?? currentMonth;
  }, [days, currentMonth]);
  const [month, setMonth] = useState(currentMonth);
  const [selected, setSelected] = useState<string | null>(null);
  const dayTrigger = useRef<HTMLButtonElement>(null);

  const { days: daysInMonth } = monthLayout(month);
  const keys = Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  // Saturdays drop out; the grid flows Fri → Sun → next Mon on its own.
  const shownKeys = keys.filter((key) => weekdayColumn(key) !== null);
  const offset = shownKeys.length ? weekdayColumn(shownKeys[0]!)! : 0;
  const monthDays = keys.map((key) => days.get(key)).filter((day): day is DayResult => Boolean(day));
  const monthNet = monthDays.reduce((sum, day) => sum + day.net, 0);
  const greenDays = monthDays.filter((day) => day.trades > 0 && day.net > 0).length;
  const redDays = monthDays.filter((day) => day.trades > 0 && day.net < 0).length;
  const monthTrades = monthDays.reduce((sum, day) => sum + day.trades, 0);
  // Shade against the month's biggest trading day so one quiet month still reads.
  const largest = Math.max(...monthDays.filter((day) => day.trades > 0).map((day) => Math.abs(day.net)), 1);
  const selectedDay = selected ? days.get(selected) ?? null : null;
  const showFinancing = selectedDay && Math.abs(selectedDay.financing) >= 0.005;
  const selectedTone = selectedDay && selectedDay.net !== 0 ? (selectedDay.net > 0 ? "is-up" : "is-down") : "";

  const goTo = (next: string) => { setMonth(next); setSelected(null); };
  const canGoBack = month > firstMonth;
  const canGoForward = month < currentMonth;

  // Phones: swipe the grid left for the next month, right for the previous.
  // Mostly-vertical drags are left to the page so scrolling still works.
  // A ref, not state: a quick flick ends before a state update would render.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: ReactTouchEvent) => {
    const touch = event.changedTouches[0];
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || !touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && canGoForward) goTo(shiftMonth(month, 1));
    if (dx > 0 && canGoBack) goTo(shiftMonth(month, -1));
  };

  return (
    <section className="nl-sec nl-cal" aria-labelledby="nl-cal-title">
      <div className="nl-sec-head">
        <div className="nl-sec-title">
          <h2 id="nl-cal-title">Daily P/L</h2>
        </div>
        <div className="nl-cal-nav">
          <button type="button" className="pressable" aria-label="Previous month" disabled={!canGoBack} onClick={() => goTo(shiftMonth(month, -1))}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <span className="nl-cal-month" aria-live="polite">
            <span className="nl-cal-month-long">{monthTitle(month)}</span>
            <span className="nl-cal-month-short" aria-hidden="true">{monthTitle(month, "short")}</span>
          </span>
          <button type="button" className="pressable" aria-label="Next month" disabled={!canGoForward} onClick={() => goTo(shiftMonth(month, 1))}>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="nl-cal-card">
        <div className="nl-cal-summary">
          <div className="nl-cal-total">
            <span className="nl-cal-total-label">{monthTitle(month).split(" ")[0]} net</span>
            <span className={`nl-cal-net metric-number ${monthNet > 0 ? "is-up" : monthNet < 0 ? "is-down" : ""}`}>
              {monthDays.length ? money(monthNet, currency, true) : "—"}
            </span>
          </div>
          <div className="nl-cal-counts">
            <span className="nl-cal-chip is-up"><i aria-hidden="true" />{greenDays} green</span>
            <span className="nl-cal-chip is-down"><i aria-hidden="true" />{redDays} red</span>
            <span className="nl-cal-chip">{monthTrades} {monthTrades === 1 ? "trade" : "trades"}</span>
          </div>
        </div>

        {mobile ? <p className="nl-cal-mobile-hint">Tap a day to see its breakdown.</p> : null}
        <div className="nl-cal-grid" role="grid" aria-label={`Daily profit and loss, ${monthTitle(month)}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {WEEKDAYS.map((name, i) => (
            <span key={name} className={`nl-cal-weekday${i === 5 ? " is-weekend" : ""}`} aria-hidden="true">{name}</span>
          ))}
          {Array.from({ length: offset }, (_, i) => <span key={`pad-${i}`} className="nl-cal-pad" aria-hidden="true" />)}
          {shownKeys.map((key) => {
            const day = days.get(key);
            const traded = Boolean(day && day.trades > 0);
            const weekend = weekdayColumn(key) === 5;
            const tone = !day ? "is-empty" : traded ? (day.net > 0 ? "is-win" : day.net < 0 ? "is-loss" : "is-flat") : "is-quiet";
            // Four shade steps by size against the month's biggest day.
            const level = traded && day ? Math.min(4, Math.max(1, Math.ceil(4 * Math.abs(day.net) / largest))) : 0;
            const future = key > todayKey;
            const label = day
              ? `${dayTitle(key)}: ${money(day.net, currency, true)}${day.trades ? `, ${day.trades} ${day.trades === 1 ? "trade" : "trades"}` : ", overnight interest only"}`
              : `${dayTitle(key)}: no activity`;
            return (
              <button
                key={key}
                type="button"
                className={`nl-cal-day ${tone}${level ? ` lvl-${level}` : ""}${weekend ? " is-weekend" : ""}${future ? " is-future" : ""}${key === todayKey ? " is-today" : ""}${key === selected ? " is-selected" : ""}`}
                aria-label={label}
                aria-pressed={mobile ? undefined : key === selected}
                aria-haspopup={mobile && day ? "dialog" : undefined}
                disabled={!day}
                onClick={(event) => {
                  dayTrigger.current = event.currentTarget;
                  setSelected(!mobile && key === selected ? null : key);
                }}
              >
                <span className="nl-cal-date">{Number(key.slice(8))}</span>
                {day ? <span className="nl-cal-amount metric-number">{compactMoney(day.net, currency)}</span> : null}
              </button>
            );
          })}
        </div>

        {mobile ? null : selected && selectedDay ? (
          <p className="nl-cal-detail" aria-live="polite">
            <b>{dayTitle(selected)}</b>
            <span className={`metric-number ${selectedTone}`}>{money(selectedDay.net, currency, true)}</span>
            <span>
              {selectedDay.trades} {selectedDay.trades === 1 ? "trade" : "trades"} {money(selectedDay.tradePl, currency, true)}
              {showFinancing ? ` · interest ${money(selectedDay.financing, currency, true)}` : ""}
            </span>
          </p>
        ) : (
          <p className="nl-cal-hint">Tap a day for its trades and interest.</p>
        )}
      </div>
      {mobile ? (
        <MobileSheet
          open={Boolean(selectedDay)}
          title={selected ? dayTitle(selected) : "Daily P/L"}
          onClose={() => {
            setSelected(null);
            dayTrigger.current?.focus({ preventScroll: true });
          }}
        >
          {selectedDay ? (
            <dl className="nl-cal-breakdown">
              <div><dt>Net P/L</dt><dd className={`metric-number ${selectedTone}`}>{money(selectedDay.net, currency, true)}</dd></div>
              <div>
                <dt>{selectedDay.trades} {selectedDay.trades === 1 ? "trade" : "trades"}</dt>
                <dd className="metric-number">{money(selectedDay.tradePl, currency, true)}</dd>
              </div>
              {showFinancing ? (
                <div><dt>Overnight interest</dt><dd className="metric-number">{money(selectedDay.financing, currency, true)}</dd></div>
              ) : null}
            </dl>
          ) : null}
        </MobileSheet>
      ) : null}
    </section>
  );
}
