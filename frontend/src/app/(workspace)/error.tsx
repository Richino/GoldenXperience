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
    <div className="workspace-error flex min-h-[calc(100dvh-7rem)] flex-col justify-center px-4 py-6 pb-32 sm:px-6 lg:min-h-0 lg:py-10">
      <div className="app-card mx-auto w-full max-w-md p-5 sm:p-7">
        <div className="flex flex-col items-center text-center">
          <div className="grid size-11 place-items-center rounded-2xl bg-[color:var(--danger-soft)] text-[color:var(--danger)] sm:size-12 sm:rounded-3xl">
            <AlertTriangle className="size-5" strokeWidth={2} />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-[-0.04em] sm:mt-5 sm:text-display">
            This view could not load
          </h1>
          <p className="mt-2 max-w-sm text-sm leading-6 text-[color:var(--muted)]">
            This screen failed to load. Tap try again, or come back in a moment.
          </p>
        </div>

        {detail ? (
          <p className="mt-4 break-words rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-raised)] px-3 py-2.5 text-left font-mono text-xs leading-5 text-[color:var(--muted-strong)]">
            {detail}
          </p>
        ) : null}

        <button
          type="button"
          onClick={reset}
          className="accent-button pressable mt-5 flex w-full min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold sm:mt-6 sm:min-h-12 sm:w-auto sm:px-6"
        >
          <RefreshCw className="size-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
