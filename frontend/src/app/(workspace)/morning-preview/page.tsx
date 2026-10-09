import { notFound } from "next/navigation";
import { MorningPicksDisplay } from "@/components/dashboard/morning-market-picks";
import { computeSessionTradability, MARKET_SELECTION_VERSION, rankQualifiedMarkets } from "@/lib/strategy/ny-tradability";
import type { MorningPicksSnapshot } from "@/lib/strategy/morning-scan";
import { fixtureInput, fixtureNews, FIXTURE_TIME } from "./fixture";

export default function MorningPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  const pairs = ["EUR_USD", "GBP_USD", "USD_JPY"].map(name => computeSessionTradability(fixtureInput(name)));
  pairs.push(computeSessionTradability({ ...fixtureInput("AUD_USD"), news: [fixtureNews("AUD", 45)] }));
  pairs.push(computeSessionTradability({ ...fixtureInput("NZD_USD"), news: [fixtureNews("NZD", 10)] }));
  const expensive = fixtureInput("EUR_GBP");
  expensive.quote!.ask += .002;
  pairs.push(computeSessionTradability(expensive));
  const at = FIXTURE_TIME.toISOString();
  const snapshot: MorningPicksSnapshot = {
    state: "READY", refreshing: false, checkedAt: at, lastAttempt: null,
    current: {
      id: "demo-only", dateEt: "2026-10-07", version: MARKET_SELECTION_VERSION, mode: "Normal",
      startedAt: at, completedAt: at, evaluatedAt: at, durationMs: 1800, status: "SUCCESS",
      pairs, shortlist: rankQualifiedMarkets(pairs).map(pair => pair.instrument), sharedCurrencies: ["USD"],
      newsFetchedAt: at, newsCoverageUntil: "2026-10-08T00:00:00Z", failures: [], error: null,
    },
  };
  return <main style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px 110px" }}>
    <p style={{ color: "var(--muted)", fontSize: 12, marginBottom: 16 }}>DEMO PREVIEW · Sample data, not live market picks</p>
    <MorningPicksDisplay snapshot={snapshot} now={FIXTURE_TIME.getTime()} />
  </main>;
}
