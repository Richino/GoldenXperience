import { LIVE_EXECUTABLE_FAMILIES } from "@/lib/strategy/strategies";
import {
  getPaperTradingAvailability,
  type PaperTradingAvailability,
} from "@/lib/strategy/strategy-engine";
import { MAJOR_INSTRUMENTS } from "@/types/forex";
import type { ConnectionStatus } from "@/types/forex";

export type GxStatusModel = {
  live: boolean;
  availability: PaperTradingAvailability;
  marketsMonitored: number;
  strategiesActive: number;
  oandaConnected: boolean | null;
  monitoringActive: boolean | null;
};

export function buildGxStatus(
  connection: ConnectionStatus | null,
  now = new Date(),
): GxStatusModel {
  const availability = getPaperTradingAvailability(now);
  const oandaConnected = connection ? connection.state === "connected" && connection.source === "oanda" : null;
  const monitoringActive =
    oandaConnected === null ? null : oandaConnected && availability.marketOpen;

  return {
    live: oandaConnected === true,
    availability,
    marketsMonitored: MAJOR_INSTRUMENTS.length,
    strategiesActive: LIVE_EXECUTABLE_FAMILIES.length,
    oandaConnected,
    monitoringActive,
  };
}
function headline(hasActiveSetups: boolean, availability: PaperTradingAvailability) {
  if (hasActiveSetups) return "Setups in view";
  switch (availability.state) {
    case "entry_window_open":
      return "No active setups";
    case "waiting_for_entry_window":
      return "Waiting for the entry window";
    case "market_closed":
      return "Market closed";
    default: {
      const _never: never = availability.state;
      return _never;
    }
  }
}

export function GxStatus({
  status,
  hasActiveSetups,
}: {
  status: GxStatusModel;
  hasActiveSetups: boolean;
}) {
  return (
    <section className="home-idle-section" aria-label="GX status">
      <div className="home-section-head">
        <h2>Status</h2>
        {status.live ? (
          <span className="home-live">
            <span className="home-live-dot" aria-hidden="true" />
            Live
          </span>
        ) : null}
      </div>
      <p className="home-idle-lead">{headline(hasActiveSetups, status.availability)}</p>
    </section>
  );
}
