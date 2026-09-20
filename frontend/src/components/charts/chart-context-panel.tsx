"use client";

import { PendingEntryDialog } from "@/components/charts/pending-entry-dialog";
import type { PendingManualEntry } from "@/types/pending-entry";

export type ChartOverlayPreferences = {
  levels: boolean;
  signalMarkers: boolean;
  positionMarkers: boolean;
};

export function ChartContextPanel({
  instrument,
  bid,
  ask,
  selectedEntry,
  initialProposal = null,
  composerKey,
  onClearSelection,
  onChanged,
}: {
  instrument: string;
  bid: number | null;
  ask: number | null;
  selectedEntry: PendingManualEntry | null;
  initialProposal?: {
    direction: "long" | "short";
    entry: number;
    stop: number;
    target: number;
    confidence: number | null;
    rationale: string;
    preferredEntryTime: string;
  } | null;
  composerKey: string;
  onClearSelection: () => void;
  onChanged: (message: string) => void;
}) {
  return (
    <aside className="gx-chart-context" aria-label="Add entry">
      <PendingEntryDialog
        key={composerKey}
        layout="panel"
        open
        instrument={instrument}
        bid={bid}
        ask={ask}
        selectedEntry={selectedEntry}
        initialProposal={selectedEntry ? null : initialProposal}
        onClose={onClearSelection}
        onChanged={onChanged}
      />
    </aside>
  );
}
