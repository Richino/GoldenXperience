import type { Metadata } from "next";
import { WatchlistTabs } from "@/components/watchlist/watchlist-tabs";

export const metadata: Metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  return <WatchlistTabs />;
}
