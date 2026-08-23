import { redirect } from "next/navigation";

export default async function LegacySignalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    instrument?: string;
    trade?: string;
    prediction?: string;
  }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();

  if (params.instrument) query.set("instrument", params.instrument);
  if (params.trade) query.set("trade", params.trade);
  if (params.prediction) query.set("prediction", params.prediction);

  redirect(`/chart${query.size ? `?${query.toString()}` : ""}`);
}
