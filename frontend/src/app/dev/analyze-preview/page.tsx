import { notFound } from "next/navigation";
import { AnalyzePreview } from "./preview";

/** Development-only preview of every Analyze V2 card state (synthetic data). */
export default function AnalyzePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AnalyzePreview />;
}
