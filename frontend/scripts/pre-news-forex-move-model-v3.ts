/**
 * PRE-NEWS FOREX MOVE MODEL V3  —  out-of-sample validation
 * =========================================================
 * ONE goal: before scheduled news, flag whether a popular major will make a
 * LARGE move. No direction in the primary model. Deliberately simpler than V2.
 *
 * V3 MOVE_SCORE = 40*IMPORTANCE + 35*SIMULTANEOUS + 25*ACTIVITY   (0..100)
 *   - removed vs V2: srCompression, compression, extension, trend, rel-strength,
 *     S/R, direction (extension/compression/spread still RECORDED as diagnostics
 *     with ZERO weight). Compression is NOT inverted — it is simply dropped.
 * All three feature formulas are FROZEN below BEFORE any validation outcome.
 *
 * Validation window: 2026-01-01 .. 2026-05-10  — strictly BEFORE the V2
 * development sample (2026-05-11 .. 2026-09-11). Zero timestamp overlap.
 *
 * Benchmarks: A HIGH-impact-only, B V2 frozen MOVE_SCORE>=80 (computed with the
 * UNCHANGED V2 core), C V3>=60, D V3>=80.
 *
 * No-lookahead: candles must close <= T; outcomes read only after scores frozen.
 * Outputs are written to SEPARATE v3 files; V2 and the live forward CSV untouched.
 */
import fs from "node:fs"; import path from "node:path";
import * as core from "./pre-news-v2-core";
type RC = core.RC;

const CAL = path.resolve(__dirname, "../../api-server/research-v2/pre-news-prediction-v1/data/calendar_raw.json");
const CACHE = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/bbd27bdc-fb8b-46fd-8b2a-16a19b8f1dfe/scratchpad/majors-m1-v3";
const OUT = path.resolve(__dirname, "../research-output");
const WIN_START = "2026-01-01T00:00:00.000Z";
const WIN_END = "2026-05-10T22:59:00.000Z"; // last cached candle 23:59Z -> T+60m must fit
const CCYS = new Set(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "NZD", "CHF"]);
const MAJORS = ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD", "NZD_USD", "USD_CHF"];
const CCY_TO_PAIR: Record<string, string> = { EUR: "EUR_USD", GBP: "GBP_USD", JPY: "USD_JPY", CAD: "USD_CAD", AUD: "AUD_USD", NZD: "NZD_USD", CHF: "USD_CHF" };

// ================= FROZEN V3 CONSTANTS (set before validation) =================
const V3 = {
  W_IMPORTANCE: 40, W_SIMULTANEOUS: 35, W_ACTIVITY: 25,
  IMPORTANCE: { HIGH: 1.0, MEDIUM: 0.5 } as Record<string, number>,
  SIMULT_SECONDARY_WEIGHT: 0.5,   // opposing-currency leg counts half
  SIMULT_CAP: 4,                  // saturating cap: weighted>=4 -> 1.0
  ACT_RATIO_LO: 0.75,             // activity ratio -> 0 at/below
  ACT_RATIO_HI: 2.0,              // activity ratio -> 1 at/above
  ACT_RECENT_MIN: 30,             // recent window (M1 candles)
  ACT_BASELINE_MIN: 7200,         // ~5 trading days baseline (M1 candles)
  ACT_BASELINE_GAP_MIN: 60,       // baseline ends 60m before T
  CLASS: [[0, 39, "LOW"], [40, 59, "MODERATE"], [60, 79, "BIG"], [80, 100, "VERY_BIG"]] as const,
};
const v3Class = (s: number) => (V3.CLASS.find(([lo, hi]) => s >= (lo as number) && s <= (hi as number))?.[2] ?? "LOW");
// ==============================================================================

// -------- event-type classifier (CLEANED; diagnostic only, no score effect) --------
function classifyType(indicator: string, title: string): string {
  const s = `${indicator} ${title}`.toLowerCase();
  if (/(speech|speaks|testimony|press conference|remarks|governor speaks|chair speaks|panel|q&a)/.test(s)) return "CENTRAL_BANK_SPEECH";
  if (/(rate decision|interest rate decision|official bank rate|cash rate|policy rate|fed interest rate|rate statement)/.test(s)) return "RATE_DECISION";
  if (/(monetary policy statement|monetary policy summary|policy report|minutes|economic projections|mpc|rate vote)/.test(s)) return "CENTRAL_BANK_STATEMENT";
  if (/(cpi|inflation|price index|pce|ppi|core prices|producer price)/.test(s)) return "INFLATION";
  if (/(payroll|unemployment|employment|jobless|jobs|labou?r|jolts|claims|adp)/.test(s)) return "EMPLOYMENT";
  if (/(gdp|gross domestic)/.test(s)) return "GDP";
  if (/(manufactur|pmi|ism|factory|durable goods|industrial|business confidence|philly|empire)/.test(s)) return "MANUFACTURING";
  if (/(home|hous|building permit|construction|mortgage|building approvals)/.test(s)) return "HOUSING";
  if (/(retail|consumer|confidence|sentiment|personal spending|personal income|spending)/.test(s)) return "CONSUMER";
  if (/(trade balance|exports|imports|current account|foreign securities)/.test(s)) return "TRADE";
  return "OTHER";
}
// V2 event-type volatility mapping (needed to reproduce the FROZEN V2 score for benchmark B)
function v2TypeVol(indicator: string, title: string): number {
  const s = `${indicator} ${title}`.toLowerCase();
  const V2TYPE: Record<string, number> = { CENTRAL_BANK: 1.0, EMPLOYMENT: 0.9, INFLATION: 0.8, GDP: 0.8, MANUFACTURING: 0.6, TRADE: 0.5, CONSUMER: 0.5, HOUSING: 0.4, OTHER: 0.3 };
  let t = "OTHER";
  if (/(interest rate|rate decision|monetary policy|fomc|press conference|rate statement|boe|boj|ecb|rba|rbnz|boc|snb|cash rate|bank rate|economic projection|minutes)/.test(s)) t = "CENTRAL_BANK";
  else if (/(cpi|inflation|price index|pce|ppi|prices)/.test(s)) t = "INFLATION";
  else if (/(payroll|unemployment|employment|jobless|jobs|labou?r|jolts|claims|adp)/.test(s)) t = "EMPLOYMENT";
  else if (/(gdp|gross domestic)/.test(s)) t = "GDP";
  else if (/(manufactur|pmi|ism|factory|durable goods|industrial|business confidence|philly|empire)/.test(s)) t = "MANUFACTURING";
  else if (/(home|hous|building permit|construction|mortgage|building approvals)/.test(s)) t = "HOUSING";
  else if (/(retail|consumer|confidence|sentiment|personal spending|personal income|spending)/.test(s)) t = "CONSUMER";
  else if (/(trade balance|exports|imports|current account|foreign securities)/.test(s)) t = "TRADE";
  return V2TYPE[t]!;
}

type CalEv = { T: number; ccy: string; impact: "HIGH" | "MEDIUM"; v3type: string; v2typeVol: number };
function loadCalendar() {
  const raw = JSON.parse(fs.readFileSync(CAL, "utf8")) as any[];
  const byT = new Map<number, CalEv[]>();
  const typeCounts: Record<string, number> = {};
  for (const r of raw) {
    if (!CCYS.has(r.currency)) continue;
    if (!(r.importance === 0 || r.importance === 1)) continue;
    if (!(r.date >= WIN_START && r.date <= WIN_END)) continue;
    const v3type = classifyType(r.indicator || "", r.title || "");
    typeCounts[v3type] = (typeCounts[v3type] || 0) + 1;
    const ev: CalEv = { T: core.ms(r.date), ccy: r.currency, impact: r.importance === 1 ? "HIGH" : "MEDIUM", v3type, v2typeVol: v2TypeVol(r.indicator || "", r.title || "") };
    byT.set(ev.T, [...(byT.get(ev.T) ?? []), ev]);
  }
  return { byT, typeCounts };
}

function loadMajors() {
  const data = new Map<string, RC[]>(); const epochs = new Map<string, number[]>(); const cumRange = new Map<string, number[]>();
  for (const inst of MAJORS) {
    const rows = JSON.parse(fs.readFileSync(`${CACHE}/${inst}.json`, "utf8")) as any[];
    const cs: RC[] = rows.map((c) => ({ time: (c.t.endsWith("Z") ? c.t : c.t + "Z").replace(/(\.\d{3})\d*Z$/, "$1Z"), volume: 0, complete: true,
      mid: { open: c.mo, high: c.mh, low: c.ml, close: c.mc }, bid: { open: c.bc, high: c.bh, low: c.bl, close: c.bc }, ask: { open: c.ac, high: c.ah, low: c.al, close: c.ac } }));
    data.set(inst, cs);
    epochs.set(inst, cs.map((c) => core.ms(c.time)));
    const cum = [0]; for (let i = 0; i < cs.length; i++) cum.push(cum[i]! + (cs[i]!.mid.high - cs[i]!.mid.low));
    cumRange.set(inst, cum);
  }
  return { data, epochs, cumRange };
}
const lb = (arr: number[], x: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]! < x) lo = m + 1; else hi = m; } return lo; };
const ub = (arr: number[], x: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]! <= x) lo = m + 1; else hi = m; } return lo; };
function sliceWin(cs: RC[], ep: number[], a: number, b: number) { return cs.slice(lb(ep, a), ub(ep, b)); }

// FROZEN V3 activity ratio + score (prefix-sum, no-lookahead)
function activityV3(inst: string, ep: number[], cum: number[], T: number) {
  const idx = ub(ep, T - 60_000) - 1;                 // last candle closing <= T
  if (idx < V3.ACT_RECENT_MIN) return { ratio: NaN, score: 0 };
  const recentMean = (cum[idx + 1]! - cum[idx + 1 - V3.ACT_RECENT_MIN]!) / V3.ACT_RECENT_MIN;
  const baseEnd = ub(ep, T - V3.ACT_BASELINE_GAP_MIN * 60_000) - 1; // candle closing <= T-60m
  const baseStart = baseEnd - V3.ACT_BASELINE_MIN;
  if (baseStart < 0 || baseEnd <= baseStart) return { ratio: NaN, score: 0 };
  const baseMean = (cum[baseEnd + 1]! - cum[baseStart + 1]!) / (baseEnd - baseStart);
  const ratio = baseMean ? recentMean / baseMean : NaN;
  const score = Number.isFinite(ratio) ? core.clamp((ratio - V3.ACT_RATIO_LO) / (V3.ACT_RATIO_HI - V3.ACT_RATIO_LO), 0, 1) : 0;
  return { ratio, score };
}

async function main() {
  const { byT: cal, typeCounts } = loadCalendar();
  const { data, epochs, cumRange } = loadMajors();

  // ---- event-type sanity BEFORE price test ----
  console.log("===== V3 event-type classifier counts (diagnostic, pre price-test) =====");
  Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${t.padEnd(24)} ${n}`));
  const cbShare = ((typeCounts["CENTRAL_BANK_SPEECH"] || 0) + (typeCounts["RATE_DECISION"] || 0) + (typeCounts["CENTRAL_BANK_STATEMENT"] || 0));
  console.log(`  (central-bank family total ${cbShare}; speeches split out separately now)`);

  const WIN_BEFORE = 10 * 3600_000, WIN_AFTER = 70 * 60_000; // for the frozen V2 core call
  const pairRows: any[] = []; const eventRows: any[] = [];
  let skipped = 0;

  for (const T of [...cal.keys()].sort((a, b) => a - b)) {
    const evs = cal.get(T)!;
    const affected = new Set(evs.map((e) => e.ccy));
    const pairs = new Set<string>();
    for (const c of affected) { if (c === "USD") MAJORS.forEach((m) => pairs.add(m)); else if (CCY_TO_PAIR[c]) pairs.add(CCY_TO_PAIR[c]); }
    const per: { pair: string; max30: number; v3: number; v2: number }[] = [];
    const winData = new Map<string, RC[]>(); for (const inst of MAJORS) winData.set(inst, sliceWin(data.get(inst)!, epochs.get(inst)!, T - WIN_BEFORE, T + WIN_AFTER));

    for (const pair of pairs) {
      const cs = winData.get(pair)!; const base = pair.slice(0, 3), quote = pair.slice(4, 7);
      const rels = evs.filter((e) => e.ccy === base || e.ccy === quote);
      if (!rels.length) continue;
      const preCount = cs.reduce((n, c) => (core.ms(c.time) > T - 9 * 3600_000 && core.ms(c.time) <= T - 60_000 ? n + 1 : n), 0);
      const postCount = cs.reduce((n, c) => (core.ms(c.time) > T && core.ms(c.time) <= T + 30 * 60_000 ? n + 1 : n), 0);
      if (preCount < 300 || postCount < 25) { skipped++; continue; }

      // ---- V3 features ----
      const baseCount = evs.filter((e) => e.ccy === base).length;
      const quoteCount = evs.filter((e) => e.ccy === quote).length;
      const primary = Math.max(baseCount, quoteCount), secondary = Math.min(baseCount, quoteCount);
      const weighted = primary + V3.SIMULT_SECONDARY_WEIGHT * secondary;
      const simScore = core.clamp(weighted, 0, V3.SIMULT_CAP) / V3.SIMULT_CAP;
      const impScore = rels.reduce((m, r) => Math.max(m, V3.IMPORTANCE[r.impact]!), 0);
      const impactLabel = rels.some((r) => r.impact === "HIGH") ? "HIGH" : "MEDIUM";
      const act = activityV3(pair, epochs.get(pair)!, cumRange.get(pair)!, T);
      const moveScoreV3 = Math.round(V3.W_IMPORTANCE * impScore + V3.W_SIMULTANEOUS * simScore + V3.W_ACTIVITY * act.score);
      const classV3 = v3Class(moveScoreV3);
      const primaryType = rels.slice().sort((a, b) => b.v2typeVol - a.v2typeVol)[0]!.v3type;

      // ---- frozen V2 score (benchmark B) + outcomes + diagnostics, via UNCHANGED core ----
      const importanceV2 = rels.reduce((m, r) => Math.max(m, core.FROZEN.IMPORTANCE[r.impact]!), 0);
      const typeVolV2 = rels.reduce((m, r) => Math.max(m, r.v2typeVol), 0);
      const row = await core.computeRow({ pair, cs, data: winData, T, importance: importanceV2, typeVol: typeVolV2, simultaneous: rels.length, fBase: 0, fQuote: 0 });
      const p = row.post;

      pairRows.push({
        sampleType: "V3_OOS_VALIDATION", date: new Date(T).toISOString().slice(0, 10), utc: new Date(T).toISOString(),
        currency: [...affected].join("+"), pair, impact: impactLabel, eventType: primaryType, affectedMajors: pairs.size,
        baseCount, quoteCount, totalCount: baseCount + quoteCount,
        impScore: core.round(impScore, 2), simScore: core.round(simScore, 3), actRatio: core.round(act.ratio, 2), actScore: core.round(act.score, 3),
        moveScoreV3, classV3, moveScoreV2: row.moveScore,
        // diagnostics (zero weight in V3)
        pre15: core.round(row.v.pre15), pre30: core.round(row.v.pre30), pre60: core.round(row.v.pre60),
        pre30atr: core.round(row.v.pre30atr, 2), pre60atr: core.round(row.v.pre60atr, 2),
        extensionDiag: core.round(Math.max(row.v.pre15atr || 0, row.v.pre30atr || 0, row.v.pre60atr || 0), 2),
        compressionDiag: core.round(row.v.compressionScore * 100), spreadDiag: core.round(row.spr.current, 2),
        directionDiag: row.direction, directionScoreDiag: row.directionScore,
        post5max: core.round(p["5m"].maxAbs), post15max: core.round(p["15m"].maxAbs), post30max: core.round(p["30m"].maxAbs), post60max: core.round(p["60m"].maxAbs),
        post30net: core.round(p["30m"].net),
        h15_10: p["15m"].maxAbs >= 10 ? 1 : 0, h15_15: p["15m"].maxAbs >= 15 ? 1 : 0, h15_20: p["15m"].maxAbs >= 20 ? 1 : 0, h15_30: p["15m"].maxAbs >= 30 ? 1 : 0, h15_40: p["15m"].maxAbs >= 40 ? 1 : 0,
        hit10: p["30m"].maxAbs >= 10 ? 1 : 0, hit15: p["30m"].maxAbs >= 15 ? 1 : 0, hit20: p["30m"].maxAbs >= 20 ? 1 : 0, hit30: p["30m"].maxAbs >= 30 ? 1 : 0, hit40: p["30m"].maxAbs >= 40 ? 1 : 0,
        h60_10: p["60m"].maxAbs >= 10 ? 1 : 0, h60_15: p["60m"].maxAbs >= 15 ? 1 : 0, h60_20: p["60m"].maxAbs >= 20 ? 1 : 0, h60_30: p["60m"].maxAbs >= 30 ? 1 : 0, h60_40: p["60m"].maxAbs >= 40 ? 1 : 0,
      });
      per.push({ pair, max30: p["30m"].maxAbs, v3: moveScoreV3, v2: row.moveScore });
    }
    if (per.length) {
      const mx = per.map((x) => x.max30).filter(Number.isFinite);
      eventRows.push({ sampleType: "V3_OOS_VALIDATION", utc: new Date(T).toISOString(), currency: [...affected].join("+"), affectedMajors: per.length,
        anyHigh: evs.some((e) => e.impact === "HIGH") ? 1 : 0, maxV3: Math.max(...per.map((x) => x.v3)), maxV2: Math.max(...per.map((x) => x.v2)),
        medianPairMax30: core.round(core.median(mx)), avgPairMax30: core.round(core.mean(mx)), largestPairMax30: core.round(Math.max(...mx)) });
    }
  }

  // ---------- outputs ----------
  fs.mkdirSync(OUT, { recursive: true });
  const writeCsv = (file: string, rows: any[]) => { if (!rows.length) return; const cols = Object.keys(rows[0]); const esc = (x: any) => { const s = x == null ? "" : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; fs.writeFileSync(file, cols.join(",") + "\n" + rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n") + "\n"); };
  writeCsv(path.join(OUT, "pre-news-move-v3-oos-pairs.csv"), pairRows);
  writeCsv(path.join(OUT, "pre-news-move-v3-oos-events.csv"), eventRows);

  const L: string[] = []; const say = (s = "") => { L.push(s); console.log(s); };
  const avg = (a: any[], k: string) => core.round(core.mean(a.map((r) => r[k])));
  const med = (a: any[], k: string) => core.round(core.median(a.map((r) => r[k])));
  const pctv = (a: any[], k: string) => (a.length ? core.round(100 * core.mean(a.map((r) => r[k]))) : NaN);
  const univ = pairRows;
  const reach = (thr: number, hz = "hit") => univ.filter((r) => r[`${hz}${thr}`] === 1).length;
  const prec = (sel: any[], thr: number, hz = "hit") => (sel.length ? core.round(100 * sel.filter((r) => r[`${hz}${thr}`] === 1).length / sel.length) : NaN);
  const cover = (sel: any[], thr: number, hz = "hit") => { const t = reach(thr, hz); return t ? core.round(100 * sel.filter((r) => r[`${hz}${thr}`] === 1).length / t) : NaN; };

  say(`\n===== V3 OUT-OF-SAMPLE VALIDATION — ${WIN_START.slice(0, 10)} … ${WIN_END.slice(0, 10)} (UNSEEN) =====`);
  say(`independent timestamps: ${eventRows.length}   pair rows: ${pairRows.length}   (skipped thin: ${skipped})`);
  say(`HIGH-impact timestamps: ${eventRows.filter((e) => e.anyHigh).length}   pair-rows HIGH: ${pairRows.filter((r) => r.impact === "HIGH").length}  MEDIUM: ${pairRows.filter((r) => r.impact === "MEDIUM").length}`);

  const A = pairRows.filter((r) => r.impact === "HIGH");
  const Bv = pairRows.filter((r) => r.moveScoreV2 >= 80);
  const C = pairRows.filter((r) => r.moveScoreV3 >= 60);
  const D = pairRows.filter((r) => r.moveScoreV3 >= 80);
  const eA = eventRows.filter((e) => e.anyHigh), eB = eventRows.filter((e) => e.maxV2 >= 80), eC = eventRows.filter((e) => e.maxV3 >= 60), eD = eventRows.filter((e) => e.maxV3 >= 80);

  const rowLine = (nm: string, sel: any[], esel: any[]) => `${nm.padEnd(14)} ${String(esel.length).padStart(4)} ${String(sel.length).padStart(5)}  ${String(avg(sel, "post30max")).padStart(5)} ${String(med(sel, "post30max")).padStart(5)}  ${["10", "15", "20", "30", "40"].map((t) => String(prec(sel, +t)).padStart(4)).join(" ")}  ${["10", "15", "20", "30", "40"].map((t) => String(cover(sel, +t)).padStart(4)).join(" ")}`;
  say(`\n----- FINAL COMPARISON @30m (P=precision%, C=coverage%) -----`);
  say(`system         indN pairN  avg30 med30   P10  P15  P20  P30  P40   C10  C15  C20  C30  C40`);
  say(rowLine("HIGH_ONLY", A, eA));
  say(rowLine("V2_80_PLUS", Bv, eB));
  say(rowLine("V3_60_PLUS", C, eC));
  say(rowLine("V3_80_PLUS", D, eD));
  say(`universe=${univ.length}: reach10=${reach(10)} reach15=${reach(15)} reach20=${reach(20)} reach30=${reach(30)} reach40=${reach(40)}`);

  for (const hz of ["h15_", "hit", "h60_"] as const) {
    const label = hz === "hit" ? "30m" : hz === "h15_" ? "15m" : "60m";
    const mxk = hz === "hit" ? "post30max" : hz === "h15_" ? "post15max" : "post60max";
    say(`\n--- @${label}: avg/med max & precision ---`);
    for (const [nm, sel] of [["HIGH_ONLY", A], ["V2_80", Bv], ["V3_60", C], ["V3_80", D]] as const)
      say(`${nm.padEnd(10)} avg=${String(avg(sel, mxk)).padStart(5)} med=${String(med(sel, mxk)).padStart(5)}  P15=${prec(sel, 15, hz)} P20=${prec(sel, 20, hz)} P30=${prec(sel, 30, hz)}   C15=${cover(sel, 15, hz)} C20=${cover(sel, 20, hz)}`);
  }

  say(`\n----- V3 CLASS LADDER (30m max) -----`);
  say(`class         n   avg  med   %10  %15  %20  %30  %40`);
  for (const [lo, hi, nm] of [[40, 59, "MOD 40-59"], [60, 79, "BIG 60-79"], [80, 100, "VBIG 80-100"]] as const) {
    const g = pairRows.filter((r) => r.moveScoreV3 >= lo && r.moveScoreV3 <= hi);
    if (!g.length) { say(`${nm.padEnd(13)} 0`); continue; }
    say(`${nm.padEnd(13)} ${String(g.length).padStart(3)} ${String(avg(g, "post30max")).padStart(5)} ${String(med(g, "post30max")).padStart(4)}  ${["hit10", "hit15", "hit20", "hit30", "hit40"].map((k) => String(pctv(g, k)).padStart(4)).join(" ")}`);
  }

  const bandReport = (title: string, subset: any[]) => {
    say(`\n----- ${title} -----`);
    for (const [lo, hi, nm] of [[0, 59, "<60"], [60, 79, "60-79"], [80, 100, ">=80"]] as const) {
      const g = subset.filter((r) => r.moveScoreV3 >= lo && r.moveScoreV3 <= hi);
      if (!g.length) { say(`${nm.padEnd(6)} n=0`); continue; }
      say(`${nm.padEnd(6)} n=${String(g.length).padStart(3)} avg30=${String(avg(g, "post30max")).padStart(5)} med30=${String(med(g, "post30max")).padStart(4)} %>=15=${pctv(g, "hit15")} %>=20=${pctv(g, "hit20")} %>=30=${pctv(g, "hit30")}`);
    }
  };
  bandReport("HIGH-impact by V3 score (info beyond HIGH flag?)", A);
  bandReport("MEDIUM-impact by V3 score (surface hidden movers?)", pairRows.filter((r) => r.impact === "MEDIUM"));

  say(`\n----- pair breakdown (30m max) -----`);
  for (const ppair of MAJORS) { const g = pairRows.filter((r) => r.pair === ppair); if (!g.length) continue; say(`${ppair} n=${String(g.length).padStart(3)} avg30=${String(avg(g, "post30max")).padStart(4)} med30=${String(med(g, "post30max")).padStart(4)} %>=15=${pctv(g, "hit15")} %>=20=${pctv(g, "hit20")} %>=30=${pctv(g, "hit30")}`); }

  say(`\n----- diagnostic: component corr with post30max -----`);
  const corr = (xs: number[], ys: number[]) => { const n = xs.length; const mx = core.mean(xs), my = core.mean(ys); let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; a += dx * dy; b += dx * dx; c += dy * dy; } return b && c ? core.round(a / Math.sqrt(b * c), 3) : NaN; };
  const ys = pairRows.map((r) => (Number.isFinite(r.post30max) ? r.post30max : 0));
  for (const k of ["impScore", "simScore", "actScore", "moveScoreV3", "moveScoreV2", "extensionDiag", "compressionDiag"]) say(`${k.padEnd(15)} r=${corr(pairRows.map((r) => r[k]), ys)}`);

  fs.writeFileSync(path.join(OUT, "pre-news-move-v3-oos-summary.txt"), L.join("\n"));
  say(`\nsaved: pre-news-move-v3-oos-pairs.csv (${pairRows.length}), -events.csv (${eventRows.length}), -summary.txt  [SAMPLE_TYPE=V3_OOS_VALIDATION]`);
}
main().catch((e) => { console.error(e); process.exit(1); });
