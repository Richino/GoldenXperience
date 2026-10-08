/** Read-only causal replay. Missing historical prices/calendar are UNKNOWN;
 * this deliberately does not replace them with today's spread or news. */
import { config } from "dotenv";
import { writeFile, mkdir } from "node:fs/promises";
import { query, db } from "../src/database.js";
import { selectionMap } from "../src/market-selection-service.js";
import { INSTRUMENT_CATALOG } from "../../frontend/src/lib/instruments/catalog.js";
import { computeSessionTradability, rankQualifiedMarkets } from "../../frontend/src/lib/strategy/ny-tradability.js";
import { sessionHour, NEW_YORK_TIME_ZONE } from "../../frontend/src/lib/strategy/session.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { EconomicCalendarEvent } from "../../frontend/src/lib/oanda/calendar.js";

config({ path: new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), quiet: true });
const dates = (process.argv[2] ?? "2026-10-05,2026-10-06,2026-10-07,2026-10-08").split(",");
const records: Array<Record<string, unknown>> = [];
type Bar = { close_time: Date; open: string; high: string; low: string; close: string; volume: string };
async function history(instrument: string, tf: "M15" | "H1", now: Date) {
  const rows = await query<Bar>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' AND close_time<=$3 ORDER BY close_time DESC LIMIT $4", [instrument, tf, now, tf === "M15" ? 500 : 120]);
  return rows.rows.reverse().map((b): Candle => ({ time: new Date(b.close_time.getTime() - (tf === "M15" ? 900_000 : 3_600_000)).toISOString(), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume), complete: true }));
}
try {
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use comma-separated YYYY-MM-DD dates.");
    const day = Date.parse(`${date}T00:00:00Z`);
    const observations: Array<{ time: string; picks: string[] }> = [];
    for (const minute of [395,420,570]) {
      const at = new Date(sessionHour(day, Math.floor(minute/60), NEW_YORK_TIME_ZONE) + minute%60*60_000);
      const newsRows = await query<{ id: string; title: string; currency: string; impact: number; event_time: Date }>("SELECT id,title,currency,impact,event_time FROM economic_calendar_events WHERE first_seen_at <= $1 AND updated_at <= $1 AND event_time >= $1::timestamptz-interval '30 minutes' AND event_time <= $1::timestamptz+interval '6 hours' ORDER BY event_time", [at]);
      // An event table is not a versioned coverage manifest. Its absence cannot
      // prove the calendar was clear. Report strict replay with UNKNOWN news.
      const news: EconomicCalendarEvent[] | null = null;
      const reads = await selectionMap(INSTRUMENT_CATALOG.map(i=>i.name), async instrument => {
        const [m15, h1, quotes] = await Promise.all([history(instrument,"M15",at),history(instrument,"H1",at),
          query<{ observed_at: Date; bid: string; ask: string }>("SELECT observed_at,bid,ask FROM quote_snapshots WHERE instrument=$1 AND source='oanda' AND observed_at <= $2 AND observed_at >= $2::timestamptz-interval '5 minutes' ORDER BY observed_at DESC LIMIT 1", [instrument,at])]);
        const q = quotes.rows[0];
        return computeSessionTradability({ instrument, now: at, m15: m15.length ? m15 : null, h1: h1.length ? h1 : null, quote: q ? { bid: Number(q.bid), ask: Number(q.ask), time: q.observed_at.toISOString(), tradeable: true } : null, news });
      });
      const shortlist = rankQualifiedMarkets(reads);
      observations.push({ time: at.toISOString(), picks: shortlist.map(p=>p.instrument) });
      records.push({ date, at: at.toISOString(), baselineInstruments: reads.length, instrumentsWithCurrentQuote: reads.filter(p=>p.quoteAsOf).length,
        instrumentsWithScoredStructure: reads.filter(p=>p.factors.length).length, qualified: shortlist.map(p=>p.instrument),
        noCandidates: shortlist.length===0, observedCalendarEventsKnownBeforeCutoff: newsRows.rowCount,
        newsRejections: reads.filter(p=>p.selection!.reasons.some(r=>r.includes("news risk"))).length,
        spreadPips: reads.filter(p=>p.spreadPips !== null).map(p=>({ instrument:p.instrument,spread:p.spreadPips })),
        limitation: "Historical calendar coverage/reschedule versions are not persisted. Strict replay keeps news UNKNOWN; no current quotes or future bars substituted." });
    }
    console.log(JSON.stringify({ date, observations }));
  }
  const report = { label: "HISTORICAL DATA-READINESS REPLAY — causal, read-only, not a profitability study", records,
    zeroCandidateShare: records.filter(r=>r.noCandidates).length/records.length,
    downstreamExpectancy: "Not evaluated: no validated strict shortlist; watchlist selections are not trades.",
    movementComparison: "Not interpreted without a qualifying cohort; baseline is every catalog instrument, including missing-data instruments.",
    recommendation: "Accumulate versioned morning snapshots and use archived quote/calendar coverage before comparing Analyze outcomes." };
  await mkdir(new URL("../../docs/",import.meta.url),{recursive:true});
  await writeFile(new URL("../../docs/morning-scan-historical-readiness.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
} finally { await db().end(); }
