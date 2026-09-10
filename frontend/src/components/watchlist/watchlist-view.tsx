"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WatchlistPairsSkeleton } from "@/components/ui/page-skeletons";
import { SelectMenu } from "@/components/ui/select-menu";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { getMarketCondition } from "@/lib/strategy/session";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import {
  watchlistCardStatus,
  type WatchlistCondition,
} from "@/lib/watchlist-status";
import type { CandleSeries } from "@/types/forex";

type Row = {
  instrument: string;
  dataStatus: "connected" | "unavailable" | "stale";
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
  direction: "long" | "short" | null;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  session: string;
  conditions: WatchlistCondition[];
  openTradeId: string | null;
  tradeSequence: string | null;
};
type Day = { change: number | null; high: number | null; low: number | null };

const names: Record<string, string> = {
  AUD: "Australian Dollar",
  CAD: "Canadian Dollar",
  CHF: "Swiss Franc",
  EUR: "Euro",
  GBP: "British Pound",
  JPY: "Japanese Yen",
  NZD: "New Zealand Dollar",
  USD: "US Dollar",
};
const finiteOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const mid = (row: Row) => {
  const bid = finiteOrNull(row.bid),
    ask = finiteOrNull(row.ask);
  return bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
};
const description = (instrument: string) => {
  const [base, quote] = instrument.split("_");
  return `${names[base ?? ""] ?? base} / ${names[quote ?? ""] ?? quote}`;
};
const hasLevels = (row: Row) =>
  row.direction &&
  finiteOrNull(row.entry) !== null &&
  finiteOrNull(row.stop) !== null &&
  finiteOrNull(row.target) !== null;
const status = (row: Row) =>
  row.openTradeId || row.setupStatus === "valid"
    ? ["Active", "active"]
    : row.setupStatus === "developing"
      ? ["Forming", "forming"]
      : ["Watching", "watching"];
const setup = (row: Row) =>
  row.setupStatus === "developing"
    ? "FORMING"
    : row.setupStatus === "valid"
      ? row.direction === "long"
        ? "LONG"
        : "SHORT"
      : "—";
const sessionDisplay = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("london/new york") || normalized.includes("london / new york")) {
    return "London / NY";
  }
  if (normalized.includes("new york")) return "New York";
  if (normalized.includes("london")) return "London";
  if (normalized.includes("asia") || normalized.includes("tokyo") || normalized.includes("sydney")) {
    return "Asia";
  }

  // Runtime sources may express an origin as `11 UTC`, `1100 UTC`, or
  // `PAIR_11_UTC`. Convert every form to the same market-session chip.
  const origin = value.match(/(?:^|[_\s])(\d{1,2})(?::?(\d{2}))?[_\s]*UTC\b/i);
  const originHour = Number(origin?.[1]);
  if (Number.isFinite(originHour)) {
    if (originHour < 7 || originHour >= 22) return "Asia";
    if (originHour < 13) return "London";
    if (originHour < 17) return "London / NY";
    return "New York";
  }
  return "Asia";
};

export function WatchlistView() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Row[]>([]);
  const [daily, setDaily] = useState<Record<string, Day>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [session, setSession] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState(() => getMarketCondition());
  const quotes = useLiveQuotes();
  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/watchlist"), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        watchlist?: Row[];
        error?: string;
      };
      if (!response.ok || !payload.watchlist)
        throw new Error(payload.error ?? "Markets are unavailable.");
      const watchlist = payload.watchlist;
      setSnapshot(watchlist);
      setSelected((current) =>
        current && watchlist.some((row) => row.instrument === current)
          ? current
          : (watchlist[0]?.instrument ?? null),
      );
      void Promise.all(
        watchlist.map(async (row) => {
          try {
            const candleResponse = await fetch(
              apiUrl(
                `/api/oanda/candles?instrument=${row.instrument}&granularity=D&count=2`,
              ),
              { credentials: "include", cache: "no-store" },
            );
            const candlePayload = (await candleResponse.json()) as {
              data?: CandleSeries;
            };
            const current = candlePayload.data?.candles.at(-1),
              previous = candlePayload.data?.candles.at(-2);
            return [
              row.instrument,
              {
                change:
                  current && previous
                    ? ((current.close - previous.close) / previous.close) * 100
                    : null,
                high: current?.high ?? null,
                low: current?.low ?? null,
              },
            ] as const;
          } catch {
            return [
              row.instrument,
              { change: null, high: null, low: null },
            ] as const;
          }
        }),
      ).then((entries) => setDaily(Object.fromEntries(entries)));
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Markets are unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0),
      timer = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    const update = () => setMarket(getMarketCondition()),
      timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useForegroundRefresh(load);
  const rows = useMemo(
    () =>
      snapshot.map((row) => {
        const quote = quotes[row.instrument],
          bid = finiteOrNull(quote?.bid ?? row.bid),
          ask = finiteOrNull(quote?.ask ?? row.ask);
        return {
          ...row,
          bid,
          ask,
          spreadPips:
            bid !== null && ask !== null
              ? (ask - bid) / pipSizeFor(row.instrument)
              : finiteOrNull(row.spreadPips),
          entry: finiteOrNull(row.entry),
          stop: finiteOrNull(row.stop),
          target: finiteOrNull(row.target),
        };
      }),
    [snapshot, quotes],
  );
  const summary = {
    watched: rows.length,
    setups: rows.filter((row) => row.setupStatus === "valid" || row.openTradeId)
      .length,
    bullish: rows.filter((row) => row.direction === "long").length,
    bearish: rows.filter((row) => row.direction === "short").length,
    neutral: rows.filter((row) => !row.direction).length,
  };
  const sessions = Array.from(
    new Set(rows.map((row) => sessionDisplay(row.session))),
  );
  const sessionOptions = [
    { value: "all", label: "All sessions" },
    ...sessions.map((entry) => ({ value: entry, label: entry })),
  ];
  const shown = rows
    .filter((row) => {
      const matches = `${row.instrument} ${description(row.instrument)}`
        .toLowerCase()
        .includes(query.toLowerCase());
      return (
        matches &&
        (session === "all" || sessionDisplay(row.session) === session)
      );
    })
    .sort(
      (left, right) =>
        Number(right.setupStatus === "valid") -
          Number(left.setupStatus === "valid") ||
        left.instrument.localeCompare(right.instrument),
    );
  const active = rows.find((row) => row.instrument === selected);
  const day = active ? daily[active.instrument] : undefined;
  const activeChange = finiteOrNull(day?.change);
  return (
    <div className="markets-workspace">
      <header className="markets-header">
        <div>
          <h1>Markets</h1>
          <p>
            Monitor your forex watchlist and identify pairs worth attention.
          </p>
        </div>
        <span
          className={`markets-market ${market.marketOpen ? "is-open" : ""}`}
        >
          <i />
          Market {market.marketOpen ? "open" : "closed"} · {market.label}
        </span>
      </header>
      <dl className="markets-summary">
        <div>
          <dd>{summary.watched}</dd>
          <dt>Pairs watched</dt>
        </div>
        <div>
          <dd className="is-positive">{summary.setups}</dd>
          <dt>Active setups</dt>
        </div>
        <div>
          <dd className="is-positive">{summary.bullish}</dd>
          <dt>Bullish</dt>
        </div>
        <div>
          <dd className="is-negative">{summary.bearish}</dd>
          <dt>Bearish</dt>
        </div>
        <div>
          <dd>{summary.neutral}</dd>
          <dt>Neutral</dt>
        </div>
      </dl>
      {error ? <p className="research-error">{error}</p> : null}
      {loading && !rows.length ? (
        <WatchlistPairsSkeleton />
      ) : (
        <div className="markets-terminal">
          <section className="markets-scanner">
            <div className="markets-toolbar">
              <label>
                <Search />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search markets..."
                />
              </label>
              <SelectMenu value={session} onChange={setSession} options={sessionOptions} ariaLabel="Filter by session" align="right" className="markets-session-filter" />
              <span>
                Sort: <b>Opportunity</b>
              </span>
            </div>
            <div className="markets-table">
              <div className="markets-head">
                <span>Pair</span>
                <span>Price</span>
                <span>Chg</span>
                <span>Bias</span>
                <span>Session</span>
                <span>Sprd</span>
                <span>Setup</span>
                <span>Status</span>
              </div>
              {shown.map((row) => {
                const [state, tone] = status(row);
                const change = finiteOrNull(daily[row.instrument]?.change),
                  cardStatus = watchlistCardStatus(row);
                return (
                  <button
                    type="button"
                    key={row.instrument}
                    className={`markets-row ${active?.instrument === row.instrument ? "is-selected" : ""}`}
                    onClick={() => {
                      setSelected(row.instrument);
                      router.push(`/chart?instrument=${row.instrument}`);
                    }}
                    aria-label={`View ${displayNameFor(row.instrument)} chart and setup`}
                  >
                    <span className="markets-pair">
                      <span>
                        <b>{displayNameFor(row.instrument)}</b>
                        <small>{description(row.instrument)}</small>
                      </span>
                    </span>
                    <b className="metric-number">
                      {mid(row) === null
                        ? "—"
                        : formatChartPrice(mid(row)!, row.instrument)}
                    </b>
                    <b
                      className={`metric-number ${change === null ? "" : `is-${change >= 0 ? "positive" : "negative"}`}`}
                    >
                      {change === null
                        ? "—"
                        : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                    </b>
                    <span
                      className={`markets-bias is-${row.direction ?? "neutral"}`}
                    >
                      {row.direction === "long" ? (
                        <ArrowUp />
                      ) : row.direction === "short" ? (
                        <ArrowDown />
                      ) : null}
                      {row.direction === "long"
                        ? "Bullish"
                        : row.direction === "short"
                          ? "Bearish"
                          : "Neutral"}
                    </span>
                    <span>{sessionDisplay(row.session)}</span>
                    <span>
                      {row.spreadPips === null
                        ? "—"
                        : row.spreadPips.toFixed(1)}
                    </span>
                    <span
                      className={`markets-setup is-${row.direction ?? "empty"}`}
                    >
                      {setup(row)}
                    </span>
                    <span className={`markets-status is-${tone}`}>
                      <i />
                      {state}
                    </span>
                    <span className={`markets-row-plan is-${cardStatus.state}`}>
                      <span>{cardStatus.label}</span><em>{sessionDisplay(row.session)}</em><b>{cardStatus.progress}%</b>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <aside className="markets-detail">
            {active ? (
              <>
                <div className="markets-detail-head">
                  <p>{displayNameFor(active.instrument)}</p>
                  <strong className="metric-number">
                    {mid(active) === null
                      ? "—"
                      : formatChartPrice(mid(active)!, active.instrument)}
                  </strong>
                  <em
                    className={
                      (activeChange ?? 0) >= 0 ? "is-positive" : "is-negative"
                    }
                  >
                    {activeChange === null
                      ? "—"
                      : `${activeChange >= 0 ? "+" : ""}${activeChange.toFixed(2)}%`}
                  </em>
                </div>
                <dl className="markets-detail-grid">
                  <div>
                    <dt>Session</dt>
                    <dd>{sessionDisplay(active.session)}</dd>
                  </div>
                  <div>
                    <dt>Spread</dt>
                    <dd>
                      {active.spreadPips === null
                        ? "—"
                        : active.spreadPips.toFixed(1)}
                    </dd>
                  </div>
                  <div>
                    <dt>Day high</dt>
                    <dd>
                      {day?.high === null || day?.high === undefined
                        ? "—"
                        : formatChartPrice(day.high, active.instrument)}
                    </dd>
                  </div>
                  <div>
                    <dt>Day low</dt>
                    <dd>
                      {day?.low === null || day?.low === undefined
                        ? "—"
                        : formatChartPrice(day.low, active.instrument)}
                    </dd>
                  </div>
                </dl>
                <section className="markets-setup-detail">
                  <p>GX setup</p>
                  {hasLevels(active) ? (
                    <>
                      <b
                        className={
                          active.direction === "long"
                            ? "is-positive"
                            : "is-negative"
                        }
                      >
                        {active.direction === "long" ? "LONG" : "SHORT"}
                      </b>
                      <dl>
                        <div>
                          <dt>Entry</dt>
                          <dd>
                            {formatChartPrice(active.entry!, active.instrument)}
                          </dd>
                        </div>
                        <div>
                          <dt>SL</dt>
                          <dd className="is-negative">
                            {formatChartPrice(active.stop!, active.instrument)}
                          </dd>
                        </div>
                        <div>
                          <dt>TP</dt>
                          <dd className="is-positive">
                            {formatChartPrice(
                              active.target!,
                              active.instrument,
                            )}
                          </dd>
                        </div>
                      </dl>
                    </>
                  ) : (
                    <span>No active GX setup</span>
                  )}
                </section>
                <Link href={`/chart?instrument=${active.instrument}`}>
                  Open Chart <ArrowRight />
                </Link>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
