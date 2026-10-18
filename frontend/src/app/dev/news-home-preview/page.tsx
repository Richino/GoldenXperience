import { notFound } from "next/navigation";
import { NewsHomePreview } from "./preview";

export default function NewsHomePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // One server snapshot timestamp is serialized to the client for this preview.
  // eslint-disable-next-line react-hooks/purity
  return <NewsHomePreview now={Date.now()} />;
}
