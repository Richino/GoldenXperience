import { notFound } from "next/navigation";
import { PlansPreview } from "./preview";

/** Development-only preview of trade plan cards in each state (synthetic data, no API calls until a button is pressed). */
export default function PlansPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PlansPreview />;
}
