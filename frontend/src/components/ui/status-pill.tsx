import { Circle } from "lucide-react";
import type { ConnectionStatus } from "@/types/forex";

export function ConnectionPill({
  status,
  compact = false,
}: {
  status: ConnectionStatus;
  compact?: boolean;
}) {
  const stateColor =
    status.state === "connected"
      ? "text-[color:var(--success)]"
      : status.state === "error"
        ? "text-[color:var(--danger)]"
        : "text-[color:var(--accent)]";

  return (
    <div
      className="connection-pill inline-flex min-h-9 items-center gap-2 rounded-full bg-[color:var(--surface-raised)] px-3 text-xs font-medium text-[color:var(--muted-strong)]"
      title={status.message}
    >
      <Circle className={`size-2 fill-current ${stateColor}`} strokeWidth={0} />
      {compact ? status.environment : status.label}
    </div>
  );
}
