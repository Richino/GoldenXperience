import type { Metadata } from "next";
import { SignalWorkspace } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import { signals } from "@/lib/mock-data";
import type { CandleSeries, ConnectionStatus } from "@/types/forex";

export const metadata: Metadata = {
  title: "Signals",
};

export default async function SignalsPage() {
  const candleResult = await getApiData<{ data: CandleSeries; status: ConnectionStatus }>("/api/oanda/candles?instrument=EUR_USD&granularity=M15&count=120");

  return (
    <SignalWorkspace
      signals={signals}
      primarySeries={candleResult.data}
      initialStatus={candleResult.status}
    />
  );
}
