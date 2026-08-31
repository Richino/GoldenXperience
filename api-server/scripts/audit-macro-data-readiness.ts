/** Read-only inventory of the historical inputs required for a macro-surprise test. */
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");

const events = await query<{
  events: string; first_event: string | null; last_event: string | null; eur_usd_high_impact: string;
  with_forecast_and_actual: string; eur_usd_high_impact_with_forecast_and_actual: string;
}>(`
  SELECT count(*)::text AS events, min(event_time)::text AS first_event, max(event_time)::text AS last_event,
         count(*) FILTER (WHERE impact >= 3 AND currency IN ('EUR','USD'))::text AS eur_usd_high_impact,
         count(*) FILTER (WHERE forecast IS NOT NULL AND actual IS NOT NULL)::text AS with_forecast_and_actual,
         count(*) FILTER (WHERE impact >= 3 AND currency IN ('EUR','USD') AND forecast IS NOT NULL AND actual IS NOT NULL)::text AS eur_usd_high_impact_with_forecast_and_actual
    FROM economic_calendar_events
`);
const byCurrency = await query<{ currency: string; events: string; complete_surprises: string; first_event: string; last_event: string }>(`
  SELECT currency, count(*)::text AS events,
         count(*) FILTER (WHERE forecast IS NOT NULL AND actual IS NOT NULL)::text AS complete_surprises,
         min(event_time)::text AS first_event, max(event_time)::text AS last_event
    FROM economic_calendar_events
   WHERE currency IN ('EUR','USD')
   GROUP BY currency ORDER BY currency
`);
console.log(JSON.stringify({
  calendar: events.rows[0] ?? null,
  eurUsdCurrencies: byCurrency.rows,
  fredApiKeyConfigured: Boolean(process.env.FRED_API_KEY),
  rateLayerLimitation: "The existing rate module uses monthly OECD long-term government-rate series; it cannot by itself support a timestamped four-hour rate-expectations signal.",
}, null, 2));
