/**
 * Entry-location audit, analysis pass.
 *
 * Reads the record produced by _entry-audit-collect.ts and answers one
 * question: are these strategies losing because they pick the wrong direction,
 * or because they pick a bad place to enter a direction that was right?
 *
 * DEV ONLY by default. The sealed holdout is untouched unless HOLDOUT=1 is
 * passed, which is meant to happen exactly once, after a rule has been frozen.
 * Bucket edges here are round numbers chosen up front; the point is to look for
 * a broad monotonic relationship, not to hunt for a threshold that happens to
 * pay. A single bucket winning is noise. A gradient across all of them is a
 * finding.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.env.AUDIT ?? path.join(serviceRoot, "..", "entry-audit.jsonl");
const USE_HOLDOUT = process.env.HOLDOUT === "1";
const FAMILIES = ["ema", "breakout", "momentum", "meanrev"];

type Row = Record<string, number | string | boolean | null>;
const all: Row[] = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = all.filter((r) => (USE_HOLDOUT ? !r.dev : r.dev));
const num = (r: Row, k: string) => Number(r[k] ?? 0);

console.log("=".repeat(72));
console.log("GOLDENXPERIENCE — ENTRY LOCATION FAILURE AUDIT");
console.log((USE_HOLDOUT ? "SEALED HOLDOUT" : "DEVELOPMENT") + " set — " + rows.length + " entries of " + all.length + " total");
console.log("=".repeat(72));

function stats(set: Row[]) {
  const n = set.length;
  if (!n) return { n: 0, win: "-", exp: "-", ci95: "-", mfe: "-", mae: "-", pf: "-" };
  const rs = set.map((r) => num(r, "resultR"));
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = sd / Math.sqrt(n);
  const gross = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const bad = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const avg = (k: string) => set.reduce((a, r) => a + num(r, k), 0) / n;
  return {
    n, win: (100 * rs.filter((r) => r > 0).length / n).toFixed(0) + "%",
    exp: mean.toFixed(3),
    ci95: "[" + (mean - 1.96 * se).toFixed(3) + "," + (mean + 1.96 * se).toFixed(3) + "]",
    mfe: avg("mfeR").toFixed(2), mae: avg("maeR").toFixed(2),
    pf: bad > 0 ? (gross / bad).toFixed(2) : "inf",
  };
}

function bucketed(title: string, set: Row[], key: string, edges: number[]) {
  const label = (v: number) => {
    for (let i = 0; i < edges.length; i += 1) if (v < edges[i]!) return (i === 0 ? "<" + edges[0] : edges[i - 1] + "–" + edges[i]);
    return ">=" + edges.at(-1);
  };
  const groups = new Map<string, Row[]>();
  for (const r of set) { const g = label(num(r, key)); groups.set(g, [...(groups.get(g) ?? []), r]); }
  const order = ["<" + edges[0], ...edges.slice(1).map((e, i) => edges[i] + "–" + e), ">=" + edges.at(-1)];
  console.log("\n--- " + title + " ---");
  console.table(order.filter((o) => groups.has(o)).map((o) => ({ bucket: o, ...stats(groups.get(o)!) })));
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };

// ===========================================================================
console.log("\n\n### 0. BASELINE BY STRATEGY");
console.table(FAMILIES.map((f) => ({ family: f, ...stats(rows.filter((r) => r.family === f)) })));

console.log("\n### 0b. BY DIRECTION");
console.table(FAMILIES.flatMap((f) => ["long", "short"].map((d) => ({
  family: f, dir: d, ...stats(rows.filter((r) => r.family === f && r.direction === d)),
}))));

// ===========================================================================
console.log("\n\n### 3. LATE ENTRY — expectancy vs how far price had already moved (3-bar, ATR)");
for (const f of FAMILIES) bucketed(f, rows.filter((r) => r.family === f), "preMove3", [0.25, 0.5, 0.75, 1.0, 1.5]);

// ===========================================================================
console.log("\n\n### 4. LOCAL EXTREME — expectancy vs distance from the 20-bar extreme being traded into (ATR)");
for (const f of FAMILIES) bucketed(f, rows.filter((r) => r.family === f), "distToExtreme20", [0.1, 0.25, 0.5, 1.0]);

console.log("\n\n### 2. RANGE POSITION — 1.0 = entering at the extreme in the trade direction (20-bar)");
for (const f of FAMILIES) bucketed(f, rows.filter((r) => r.family === f), "rangePos20", [0.2, 0.4, 0.6, 0.8]);

// ===========================================================================
console.log("\n\n### 5. EXPANSION CHASING — expectancy vs signal-candle body size (ATR)");
for (const f of FAMILIES) bucketed(f, rows.filter((r) => r.family === f), "bodyAtr", [0.5, 1.0, 1.5, 2.0]);

// ===========================================================================
console.log("\n\n### 6. BREAKOUT QUALITY (level = the 20-bar range edge, as breakout defines it)");
function breakoutClass(r: Row): string {
  const beyond = num(r, "beyondAtr");
  const back = num(r, "barsBackInside");
  if (beyond <= 0) return "NO_BREAK";
  if (r.retested === true && r.retestHeld === true) return "RETEST_HOLD";
  if (r.retested === true && r.retestHeld === false) return "RETEST_FAIL";
  if (back > 0 && back <= 3) return "FAILED_BREAKOUT";
  if (beyond < 0.25) return "WEAK_BREAKOUT";
  return "CLEAN_BREAKOUT";
}
for (const f of FAMILIES) {
  const set = rows.filter((r) => r.family === f);
  const groups = new Map<string, Row[]>();
  for (const r of set) { const g = breakoutClass(r); groups.set(g, [...(groups.get(g) ?? []), r]); }
  console.log("\n--- " + f + " ---");
  console.table([...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([g, s]) => ({ classification: g, ...stats(s) })));
}

// ===========================================================================
console.log("\n\n### 7 & 12. FOLLOW-THROUGH vs THE CONFIGURED TARGET");
console.table(FAMILIES.map((f) => {
  const set = rows.filter((r) => r.family === f);
  const mfe = set.map((r) => num(r, "mfeR"));
  const reach = (x: number) => (100 * mfe.filter((m) => m >= x).length / (mfe.length || 1)).toFixed(0) + "%";
  return {
    family: f, n: set.length,
    median_MFE: median(mfe).toFixed(2), p75_MFE: pct(mfe, 0.75).toFixed(2), p90_MFE: pct(mfe, 0.90).toFixed(2),
    configured_TP: median(set.map((r) => num(r, "plannedR"))).toFixed(2),
    reach_025R: reach(0.25), reach_05R: reach(0.5), reach_1R: reach(1.0), reach_2R: reach(2.0),
  };
}));

console.log("\n### 7b. EARLY FOLLOW-THROUGH — average MFE in R at fixed bar horizons");
console.table(FAMILIES.map((f) => {
  const set = rows.filter((r) => r.family === f);
  const avg = (k: string) => (set.reduce((a, r) => a + num(r, k), 0) / (set.length || 1)).toFixed(3);
  return { family: f, bar1: avg("mfe1R"), bar2: avg("mfe2R"), bar3: avg("mfe3R"), bar6: avg("mfe6R"), full: avg("mfeR"), full_MAE: avg("maeR") };
}));

// ===========================================================================
console.log("\n\n### 8. WINNERS vs LOSERS — median values");
console.table(FAMILIES.flatMap((f) => {
  const set = rows.filter((r) => r.family === f);
  const w = set.filter((r) => num(r, "resultR") > 0);
  const l = set.filter((r) => num(r, "resultR") < 0);
  const m = (s: Row[], k: string) => median(s.map((r) => num(r, k))).toFixed(2);
  return [{
    family: f, group: "WIN (n=" + w.length + ")",
    rangePos20: m(w, "rangePos20"), preMove3: m(w, "preMove3"), distToExtreme20: m(w, "distToExtreme20"),
    bodyAtr: m(w, "bodyAtr"), mfe1R: m(w, "mfe1R"), mae1R: m(w, "mae1R"), consec: m(w, "consecutive"), volPct: m(w, "volPct"), spread: m(w, "spreadPips"),
  }, {
    family: f, group: "LOSS (n=" + l.length + ")",
    rangePos20: m(l, "rangePos20"), preMove3: m(l, "preMove3"), distToExtreme20: m(l, "distToExtreme20"),
    bodyAtr: m(l, "bodyAtr"), mfe1R: m(l, "mfe1R"), mae1R: m(l, "mae1R"), consec: m(l, "consecutive"), volPct: m(l, "volPct"), spread: m(l, "spreadPips"),
  }];
}));

// ===========================================================================
console.log("\n\n### 13. FAILURE CLASSIFICATION (losing trades only)");
function failureClass(r: Row): string {
  const mfe = num(r, "mfeR"); const post = num(r, "postExitBestR"); const pre = num(r, "preMove3");
  const back = num(r, "barsBackInside"); const beyond = num(r, "beyondAtr");
  if (beyond > 0 && back > 0 && back <= 3) return "FAILED_BREAKOUT";
  if (pre >= 1.0 && mfe < 0.25) return "LATE_ENTRY_REVERSAL";
  if (post >= 1.0) return "RIGHT_DIRECTION_BAD_TIMING";
  if (mfe >= 0.5) return "RIGHT_DIRECTION_INSUFFICIENT_MFE";
  if (mfe < 0.25 && post < 0.5) return "WRONG_DIRECTION";
  return "OTHER";
}
console.table(FAMILIES.flatMap((f) => {
  const losers = rows.filter((r) => r.family === f && num(r, "resultR") < 0);
  const counts = new Map<string, number>();
  for (const r of losers) counts.set(failureClass(r), (counts.get(failureClass(r)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ family: f, classification: k, n: v, share: (100 * v / (losers.length || 1)).toFixed(0) + "%" }));
}));

console.log("\n### 13b. Did the direction come good AFTER the stop? (losing trades)");
console.table(FAMILIES.map((f) => {
  const l = rows.filter((r) => r.family === f && num(r, "resultR") < 0);
  const post = l.map((r) => num(r, "postExitBestR"));
  return {
    family: f, losers: l.length,
    median_postExit_R: median(post).toFixed(2),
    pct_reaching_1R_after_exit: (100 * post.filter((p) => p >= 1).length / (post.length || 1)).toFixed(0) + "%",
    pct_reaching_2R_after_exit: (100 * post.filter((p) => p >= 2).length / (post.length || 1)).toFixed(0) + "%",
  };
}));

// ===========================================================================
console.log("\n\n### 11. BY SESSION");
const sessions = [...new Set(rows.map((r) => String(r.session)))];
console.table(FAMILIES.flatMap((f) => sessions.map((s) => ({ family: f, session: s, ...stats(rows.filter((r) => r.family === f && r.session === s)) }))));

// ===========================================================================
console.log("\n\n### 18. DATA INTEGRITY AT THE DECISION BAR");
console.table(FAMILIES.map((f) => {
  const set = rows.filter((r) => r.family === f);
  const gapped = set.filter((r) => num(r, "gapMinutes") > 15.5);
  const windowGaps = set.filter((r) => num(r, "missingInWindow") > 0);
  return {
    family: f, n: set.length,
    entries_after_a_gap: gapped.length, share: (100 * gapped.length / (set.length || 1)).toFixed(1) + "%",
    entries_with_gaps_in_50bar_window: windowGaps.length,
    exp_clean: stats(set.filter((r) => num(r, "missingInWindow") === 0)).exp,
    exp_gapped: stats(windowGaps).exp,
  };
}));
process.exit(0);
