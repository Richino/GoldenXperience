import type { Metadata } from "next";
import { JournalTabs } from "@/components/journal/journal-tabs";

export const metadata: Metadata = {
  title: "Journal",
};

export default function JournalPage() {
  return <JournalTabs />;
}
