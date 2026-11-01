"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const detail =
    process.env.NODE_ENV === "development"
      ? error.message || error.digest || "Unknown workspace render error."
      : error.digest
        ? `Error digest: ${error.digest}`
        : null;

  return (
    <div className="workspace-error">
      <section className="nl-error" role="alert">
        <div className="nl-error-head">
          <AlertTriangle className="nl-error-icon" strokeWidth={2} aria-hidden="true" />
          <span>Error</span>
        </div>
        <h1>This view could not load</h1>
        <p>This screen failed to load. Tap try again, or come back in a moment.</p>
        {detail ? <code className="nl-error-detail">{detail}</code> : null}
        <button type="button" onClick={reset} className="nl-error-retry pressable">
          <RefreshCw aria-hidden="true" />
          Try again
        </button>
      </section>
    </div>
  );
}
