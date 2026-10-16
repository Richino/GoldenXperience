import { notFound } from "next/navigation";
import { PlanAnalyzePreview } from "./preview";

/** Development-only preview of the chart's plan Analyze card and the plan mascot (synthetic plans, no API writes). */
export default function PlanAnalyzePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PlanAnalyzePreview />;
}
