/**
 * Event / session-timing proxies until historical economic calendar is ingested.
 * These are NOT substitutes for CPI/NFP calendars — only schedule-structure features.
 */

import { localMinutes, NEW_YORK_TIME_ZONE, LONDON_TIME_ZONE } from "../../../../frontend/src/lib/strategy/session.js";

export function eventFeatures(_instrument: string, closeTime: string): Record<string, number> {
  const at = new Date(closeTime);
  const ny = localMinutes(at, NEW_YORK_TIME_ZONE);
  const ldn = localMinutes(at, LONDON_TIME_ZONE);
  // Tokyo approx via London clock early hours
  const nearTokyoOpen = ldn >= 0 && ldn < 120 ? 1 : 0;
  const nearLondonOpen = ldn >= 7 * 60 && ldn < 9 * 60 ? 1 : 0;
  const nearNyOpen = ny >= 8 * 60 && ny < 10 * 60 ? 1 : 0;
  // US data dump cluster often 08:30 ET
  const nearUsData = ny >= 8 * 60 + 15 && ny < 9 * 60 + 15 ? 1 : 0;
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIME_ZONE,
    weekday: "short",
  }).format(at);
  const isFri = weekday === "Fri" ? 1 : 0;
  const isMon = weekday === "Mon" ? 1 : 0;

  return {
    evt_minutes_to: 0,
    evt_minutes_since: 0,
    evt_importance: 0,
    evt_surprise: 0,
    evt_pre_vol: 0,
    evt_post_vol: 0,
    evt_available: 0, // real calendar not ingested
    evt_proxy_tokyo_open: nearTokyoOpen,
    evt_proxy_london_open: nearLondonOpen,
    evt_proxy_ny_open: nearNyOpen,
    evt_proxy_us_data_hour: nearUsData,
    evt_proxy_monday: isMon,
    evt_proxy_friday: isFri,
  };
}

/**
 * Macro / rates adapters — clean stubs until yield data is ingested.
 * Set macro_available=0 so models can learn to ignore empty channels.
 */
export function macroFeatures(instrument: string, _closeTime: string): Record<string, number> {
  const jpy = instrument.includes("JPY") ? 1 : 0;
  const usd = instrument.includes("USD") ? 1 : 0;
  const eur = instrument.includes("EUR") ? 1 : 0;
  return {
    macro_us_2y: 0,
    macro_foreign_2y: 0,
    macro_yield_spread: 0,
    macro_yield_spread_chg: 0,
    macro_carry_diff: 0,
    macro_policy_diff: 0,
    macro_available: 0,
    macro_pair_us_jp: usd && jpy ? 1 : 0,
    macro_pair_eu_jp: eur && jpy ? 1 : 0,
  };
}
