import type { Metadata } from "next";
import { WatchlistView } from "@/components/watchlist/watchlist-view";

export const metadata: Metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  return <WatchlistView />;
}
