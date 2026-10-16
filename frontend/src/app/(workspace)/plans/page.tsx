import type { Metadata } from "next";
import { TradePlansView } from "@/components/trade-plans/trade-plans-view";

export const metadata: Metadata = {
  title: "Plans",
};

export default function PlansPage() {
  return <TradePlansView />;
}
