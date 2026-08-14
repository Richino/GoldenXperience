import type { BinaryPrediction, BinaryResult, BinaryStatus } from "@/types/binary";

/** Short human label for a prediction's outcome or its live state. */
export function predictionStatusLabel(prediction: Pick<BinaryPrediction, "status" | "result">) {
  if (prediction.status === "active") return "ACTIVE";
  // 'error' is only used to void a prediction that expired while the market was
  // closed and so has no valid settlement price.
  if (prediction.status === "error") return "VOID";
  return (prediction.result ?? "resolved").toUpperCase();
}

/** Colour tone token for a result, matching the app's win/loss/neutral language. */
export function predictionResultTone(status: BinaryStatus, result: BinaryResult | null) {
  if (status === "active") return "is-open";
  if (result === "won") return "is-win";
  if (result === "lost") return "is-loss";
  return "is-neutral"; // tie / error
}

/** As a fraction 0–1, or null when it is a bare score with no probability meaning. */
export function scorePercent(score: number | null | undefined) {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return Math.round(score * 100);
}
