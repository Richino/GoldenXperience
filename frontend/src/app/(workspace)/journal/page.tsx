import type { Metadata } from "next";
import { JournalView } from "@/components/journal/journal-view";
import { journalTrades } from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Journal",
};

export default function JournalPage() {
  return <JournalView trades={journalTrades} />;
}
