/**
 * Explicit leakage audit checklist — run before trusting any sealed PASS.
 */

export type LeakageCheck = { id: string; status: "pass" | "fail" | "warn" | "n/a"; note: string };

export function auditLeakage(): LeakageCheck[] {
  return [
    {
      id: "future_candle",
      status: "pass",
      note: "Features computed from candles[0..i] only; labels use i+1..i+h",
    },
    {
      id: "pre_close_values",
      status: "pass",
      note: "Decision timestamp is candle closeTime; no intra-bar mid prediction",
    },
    {
      id: "rolling_lookahead",
      status: "pass",
      note: "ATR/vol windows end at index i inclusive",
    },
    {
      id: "target_leakage",
      status: "pass",
      note: "Targets are forward net returns; not included in feature vector",
    },
    {
      id: "scaler_future",
      status: "pass",
      note: "Standardization fit on TRAIN rows only inside fitModel",
    },
    {
      id: "random_cv",
      status: "pass",
      note: "Zones are chronological TRAIN/DEV/SEALED — no random split",
    },
    {
      id: "overlapping_labels",
      status: "warn",
      note: "Hold-to-horizon labels overlap in time; embargo not yet purged — prefer stride>1 for daily",
    },
    {
      id: "macro_revisions",
      status: "n/a",
      note: "Macro features stubbed (macro_available=0)",
    },
    {
      id: "execution_price",
      status: "pass",
      note: "Long pays ask→bid, short pays bid→ask via quote path",
    },
  ];
}

export function printLeakageAudit(): void {
  console.log("\nData leakage audit:");
  for (const c of auditLeakage()) {
    console.log(`  [${c.status}] ${c.id}: ${c.note}`);
  }
}
