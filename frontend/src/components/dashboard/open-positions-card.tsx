import { PairAvatar } from "@/components/ui/pair-avatar";
import { SectionLabel } from "@/components/ui/section-label";
import { formatChartPrice } from "@/lib/chart-utils";
import type { OpenPosition } from "@/types/forex";

function formatUnits(units: number) {
  return new Intl.NumberFormat("en-US").format(units);
}

function formatDuration(openedAt: string) {
  const openedMs = Date.parse(openedAt);
  if (!Number.isFinite(openedMs)) return "—";

  const minutes = Math.max(0, Math.round((Date.now() - openedMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    value,
  );
}

export function OpenPositionsCard({
  positions,
  accountCurrency,
}: {
  positions: OpenPosition[];
  accountCurrency: string;
}) {
  const netPL = positions.reduce(
    (sum, position) => sum + position.unrealizedPL,
    0,
  );

  return (
    <section className="app-card overflow-hidden">
      <div className="flex items-end justify-between gap-3 px-5 py-5 md:px-6">
        <SectionLabel title="Open positions" variant="minimal" />
        {positions.length ? (
          <div className="text-right">
            <div className="text-xs text-[color:var(--muted)]">Unrealized</div>
            <div
              className={`metric-number text-lg font-semibold tracking-[-0.03em] ${
                netPL >= 0
                  ? "text-[color:var(--success)]"
                  : "text-[color:var(--danger)]"
              }`}
            >
              {netPL >= 0 ? "+" : ""}
              {formatCurrency(netPL, accountCurrency)}
            </div>
          </div>
        ) : null}
      </div>

      {positions.length ? (
        <div>
          {positions.map((position) => {
            const positive = position.unrealizedPL >= 0;

            return (
              <div
                key={position.id}
                className="dashboard-row flex items-center justify-between gap-3 px-5 py-3.5 md:px-6"
              >
                <div className="flex items-center gap-3">
                  <PairAvatar instrument={position.instrument} size={32} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {position.pair}
                      </span>
                      <span
                        className={`text-xs ${
                          position.direction === "long"
                            ? "text-[color:var(--success)]"
                            : "text-[color:var(--danger)]"
                        }`}
                      >
                        {position.direction}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[color:var(--muted)]">
                      {formatUnits(position.units)} units ·{" "}
                      {formatDuration(position.openedAt)}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={`metric-number text-sm font-medium ${
                      positive
                        ? "text-[color:var(--success)]"
                        : "text-[color:var(--danger)]"
                    }`}
                  >
                    {positive ? "+" : ""}
                    {formatCurrency(position.unrealizedPL, accountCurrency)}
                  </div>
                  <div className="mt-0.5 text-xs text-[color:var(--muted)]">
                    {formatChartPrice(position.entryPrice, position.instrument)}{" "}
                    →{" "}
                    {formatChartPrice(
                      position.currentPrice,
                      position.instrument,
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="border-t border-[color:var(--border)] px-5 py-6 md:px-6">
          <p className="empty-state">
            <span className="empty-state-dot" />
            No open positions.
          </p>
        </div>
      )}
    </section>
  );
}
