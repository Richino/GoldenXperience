import { ServiceNotice } from "@/components/ui/service-notice";

export function MarketDataNotice({
  message,
  demo,
  className = "",
}: {
  message: string;
  demo: boolean;
  className?: string;
}) {
  const maintenance = /maintenance/i.test(message);
  return (
    <ServiceNotice
      className={`market-data-notice ${className}`}
      title={maintenance ? "OANDA maintenance" : "Live data unavailable"}
      description={`${maintenance ? "Live updates are temporarily paused." : "Unable to refresh market data."} ${demo ? "Showing demo candles." : "Showing the last available chart."}`}
    />
  );
}
