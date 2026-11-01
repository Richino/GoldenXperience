import type { Metadata } from "next";
import { TechnicalAnalyzer } from "@/components/technical-analyzer/technical-analyzer";

export const metadata: Metadata = { title: "GX Technical Analyzer" };
export default function TechnicalAnalyzerPage() { return <TechnicalAnalyzer />; }
