/**
 * PRE-NEWS FOREX TEST V2 — HISTORICAL VALIDATION
 * ==============================================
 * Runs the FROZEN V2 core (scripts/pre-news-v2-core.ts, proven identical to the
 * live day-1 script by _v2-core-regression.ts) across a large historical sample
 * to answer ONE question: does MOVE_SCORE identify large news moves better than
 * the plain HIGH-impact calendar label?
 *
 * NOTHING about V2 is tuned here. The only new code is (a) a data-labelling
 * layer mapping the TradingView calendar's importance/indicator fields onto V2's
 * frozen impact/type inputs, and (b) analysis/reporting. No formula, weight,
 * threshold, normalization, class cutoff, S/R or vol logic is changed.
 *
 * Data: TradingView economic calendar (api-server/research-v2/.../calendar_raw.json,
 * forecast/previous only — never actual) + cached OANDA M1 for the 7 majors
 * (scratchpad/majors-m1). Strength basket is majors-only, so DIRECTION's
 * non-USD-leg currency-strength is degraded vs the day-1 run (documented; it is
 * SECONDARY and not the verdict). MOVE_SCORE uses only the pair's own M1 and is
 * unaffected.
 *
 * No-lookahead: preserved by the frozen core (candles must close <= T; post read
 * only after scores are built). Outputs are marked SAMPLE_TYPE=HISTORICAL_VALIDATION
 * and written to SEPARATE files — the forward/live CSV is never touched.
 */
import fs from "node:fs"; import path from "node:path";
import * as core from "./pre-news-v2-core";
type RC = core.RC;

const CAL = path.resolve(__dirname, "../../api-server/research-v2/pre-news-prediction-v1/data/calendar_raw.json");
const CACHE = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/bbd27bdc-fb8b-46fd-8b2a-16a19b8f1dfe/scratchpad/majors-m1";
const OUT = path.resolve(__dirname, "../research-output");
const WIN_START = "2026-05-11T00:00:00.000Z";
const WIN_END = "2026-09-11T19:59:00.000Z"; // last cached candle 20:59Z -> require T+60m within cache
const CCYS = new Set(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "NZD", "CHF"]);
const MAJORS = ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD", "NZD_USD", "USD_CHF"];
const CCY_TO_PAIR: Record<string, string> = { EUR: "EUR_USD", GBP: "GBP_USD", JPY: "USD_JPY", CAD: "USD_CAD", AUD: "AUD_USD", NZD: "NZD_USD", CHF: "USD_CHF" };

// ---- data-labelling layer (NOT part of frozen V2 math) ----
function classifyType(indicator: string, title: string): keyof typeof core.FROZEN.TYPE_VOL {
  const s = `${indicator} ${title}`.toLowerCase();
  if (/(interest rate|rate decision|monetary policy|fomc|press conference|rate statement|boe|boj|ecb|rba|rbnz|boc|snb|cash rate|bank rate|economic projection|minutes)/.test(s)) return "CENTRAL_BANK";
  if (/(cpi|inflation|price index|pce|ppi|prices)/.test(s)) return "INFLATION";
  if (/(payroll|unemployment|employment|jobless|jobs|labou?r|jolts|claims|adp)/.test(s)) return "EMPLOYMENT";
  if (/(gdp|gross domestic)/.test(s)) return "GDP";
  if (/(manufactur|pmi|ism|factory|durable goods|industrial|business confidence|philly|empire)/.test(s)) return "MANUFACTURING";
  if (/(home|hous|building permit|construction|mortgage|building approvals)/.test(s)) return "HOUSING";
  if (/(retail|consumer|confidence|sentiment|personal spending|personal income|spending)/.test(s)) return "CONSUMER";
  if (/(trade balance|exports|imports|current account|foreign securities)/.test(s)) return "TRADE";
  return "OTHER";
}
function polarityFor(type: string, indicator: string, title: string): 1 | -1 {
  const s = `${indicator} ${title}`.toLowerCase();
  if (/(unemployment rate|jobless|claims)/.test(s)) return -1; // higher = currency-negative
  return 1; // default: higher = currency-positive (CPI, GDP, NFP, PMI, rate, retail, ...)
}
function parseNum(v: any): number | undefined {
  if (v == null) return undefined;
  const s = String(v).trim().replace(/,/g, "").replace(/%/g, "");
  const m = /^(-?\d*\.?\d+)\s*([KMB])?$/i.exec(s);
  if (!m) { const f = parseFloat(s); return Number.isFinite(f) ? f : undefined; }
  let n = parseFloat(m[1]!); const suf = (m[2] || "").toUpperCase();
  if (suf === "K") n *= 1e3; else if (suf === "M") n *= 1e6; else if (suf === "B") n *= 1e9;
  return Number.isFinite(n) ? n : undefined;
}

type CalEv = { T: number; ccy: string; impact: "HIGH" | "MEDIUM"; type: keyof typeof core.FROZEN.TYPE_VOL; forecast?: number; previous?: number; polarity: 1 | -1 };

function loadCalendar(): Map<number, CalEv[]> {
  const raw = JSON.parse(fs.readFileSync(CAL, "utf8")) as any[];
  const byT = new Map<number, CalEv[]>();
  for (const r of raw) {
    if (!CCYS.has(r.currency)) continue;
    if (!(r.importance === 0 || r.importance === 1)) continue; // MEDIUM or HIGH only (skip LOW/holiday)
    if (!(r.date >= WIN_START && r.date <= WIN_END)) continue;
    const T = core.ms(r.date);
    const type = classifyType(r.indicator || "", r.title || "");
    const ev: CalEv = { T, ccy: r.currency, impact: r.importance === 1 ? "HIGH" : "MEDIUM", type,
      forecast: parseNum(r.forecast ?? r.forecastRaw), previous: parseNum(r.previous ?? r.previousRaw),
      polarity: polarityFor(type, r.indicator || "", r.title || "") };
    byT.set(T, [...(byT.get(T) ?? []), ev]);
  }
  return byT;
}

function loadMajors(): Map<string, RC[]> {
  const data = new Map<string, RC[]>();
  for (const inst of MAJORS) {
    const rows = JSON.parse(fs.readFileSync(`${CACHE}/${inst}.json`, "utf8")) as any[];
    data.set(inst, rows.map((c) => ({ time: c.t.endsWith("Z") ? c.t : c.t + "Z", volume: 0, complete: true,
      mid: { open: c.mo, high: c.mh, low: c.ml, close: c.mc }, bid: { open: c.bc, high: c.bh, low: c.bl, close: c.bc }, ask: { open: c.ac, high: c.ah, low: c.al, close: c.ac } })));
  }
  return data;
}

const countWin = (cs: RC[], a: number, b: number) => cs.reduce((n, c) => (core.ms(c.time) > a && core.ms(c.time) <= b ? n + 1 : n), 0);

// precomputed epoch index per instrument for fast windowed slicing (identical math, just faster)
function sliceWin(cs: RC[], epochs: number[], a: number, b: number): RC[] {
  // first index with epoch >= a  (lowerBound), last with epoch <= b
  let lo = 0, hi = epochs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (epochs[mid]! < a) lo = mid + 1; else hi = mid; }
  let lo2 = 0, hi2 = epochs.length;
  while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (epochs[mid]! <= b) lo2 = mid + 1; else hi2 = mid; }
  return cs.slice(lo, lo2);
}

async function main() {
  const cal = loadCalendar();
  const data = loadMajors();
  // normalize cached time strings (cache uses "...T..:..:00" without Z sometimes) — ensure Z & no nanoseconds
  for (const [k, v] of data) data.set(k, v.map((c) => ({ ...c, time: c.time.replace(/(\.\d{3})\d*Z$/, "$1Z") })));
  // epoch index per instrument for windowed slicing
  const epochs = new Map<string, number[]>();
  for (const [k, v] of data) epochs.set(k, v.map((c) => core.ms(c.time)));
  const WIN_BEFORE = 10 * 3600_000, WIN_AFTER = 70 * 60_000; // covers 8h baseline + 2h pre + 60m post
  const slicedData = (T: number) => { const m = new Map<string, RC[]>(); for (const inst of MAJORS) m.set(inst, sliceWin(data.get(inst)!, epochs.get(inst)!, T - WIN_BEFORE, T + WIN_AFTER)); return m; };

  const pairRows: any[] = [];
  const eventRows: any[] = [];
  const timestamps = [...cal.keys()].sort((a, b) => a - b);
  let skipped = 0;

  for (const T of timestamps) {
    const evs = cal.get(T)!;
    const affected = new Set(evs.map((e) => e.ccy));
    const pairs = new Set<string>();
    for (const c of affected) { if (c === "USD") MAJORS.forEach((m) => pairs.add(m)); else if (CCY_TO_PAIR[c]) pairs.add(CCY_TO_PAIR[c]); }
    const perPairMax: { pair: string; max30: number; moveScore: number }[] = [];
    const winData = slicedData(T);

    for (const pair of pairs) {
      const cs = winData.get(pair)!;
      const base = pair.slice(0, 3), quote = pair.slice(4, 7);
      const rels = evs.filter((e) => e.ccy === base || e.ccy === quote);
      if (!rels.length) continue;
      // data guards (no-lookahead preserved by core; here we just ensure enough liquid candles)
      const preCount = countWin(cs, T - 9 * 3600_000, T - 60_000);
      const postCount = countWin(cs, T, T + 30 * 60_000);
      if (preCount < 300 || postCount < 25) { skipped++; continue; }

      const importance = rels.reduce((m, r) => Math.max(m, core.FROZEN.IMPORTANCE[r.impact]!), 0);
      const impactLabel = rels.some((r) => r.impact === "HIGH") ? "HIGH" : "MEDIUM";
      const typeVol = rels.reduce((m, r) => Math.max(m, core.FROZEN.TYPE_VOL[r.type]!), 0);
      const primaryType = rels.slice().sort((a, b) => core.FROZEN.TYPE_VOL[b.type]! - core.FROZEN.TYPE_VOL[a.type]!)[0]!.type;
      const fB = core.fundamentalScoreFromReleases(rels.filter((r) => r.ccy === base).map((r) => ({ forecast: r.forecast, previous: r.previous, polarity: r.polarity })));
      const fQ = core.fundamentalScoreFromReleases(rels.filter((r) => r.ccy === quote).map((r) => ({ forecast: r.forecast, previous: r.previous, polarity: r.polarity })));

      const row = await core.computeRow({ pair, cs, data: winData, T, importance, typeVol, simultaneous: rels.length, fBase: fB, fQuote: fQ });
      const p = row.post;
      const rec = {
        sampleType: "HISTORICAL_VALIDATION", date: new Date(T).toISOString().slice(0, 10), utc: new Date(T).toISOString(),
        currency: [...affected].join("+"), pair, impact: impactLabel, eventType: primaryType, simultaneous: rels.length, affectedMajors: pairs.size,
        pre5: core.round(row.v.pre5), pre15: core.round(row.v.pre15), pre30: core.round(row.v.pre30), pre60: core.round(row.v.pre60),
        pre30atr: core.round(row.v.pre30atr, 2), pre60atr: core.round(row.v.pre60atr, 2),
        activityRatio: core.round(row.v.activityRatio, 2), compressionScore: core.round(row.v.compressionScore * 100), srCompression: core.round(row.sr.srCompScore * 100),
        spreadCur: core.round(row.spr.current, 2),
        c_imp: core.round(row.cImp, 3), c_type: core.round(row.cType, 3), c_sim: core.round(row.cSim, 3), c_act: core.round(row.cAct, 3), c_ext: core.round(row.cExt, 3), c_comp: core.round(row.cComp, 3), c_sr: core.round(row.cSr, 3),
        moveScore: row.moveScore, moveClass: row.moveClass,
        direction: row.direction, directionScore: row.directionScore,
        post5net: core.round(p["5m"].net), post5max: core.round(p["5m"].maxAbs),
        post15net: core.round(p["15m"].net), post15max: core.round(p["15m"].maxAbs),
        post30net: core.round(p["30m"].net), post30max: core.round(p["30m"].maxAbs),
        post60net: core.round(p["60m"].net), post60max: core.round(p["60m"].maxAbs),
        hit10: row.hits.hit10, hit15: row.hits.hit15, hit20: row.hits.hit20, hit30: row.hits.hit30, hit40: row.hits.hit40,
        dir5: row.dirCorr("5m"), dir15: row.dirCorr("15m"), dir30: row.dirCorr("30m"), dir60: row.dirCorr("60m"),
      };
      pairRows.push(rec);
      perPairMax.push({ pair, max30: p["30m"].maxAbs, moveScore: row.moveScore });
    }

    if (perPairMax.length) {
      const maxes = perPairMax.map((x) => x.max30).filter(Number.isFinite);
      eventRows.push({
        sampleType: "HISTORICAL_VALIDATION", utc: new Date(T).toISOString(),
        currency: [...affected].join("+"), affectedMajors: perPairMax.length,
        anyHigh: evs.some((e) => e.impact === "HIGH") ? 1 : 0,
        maxMoveScore: Math.max(...perPairMax.map((x) => x.moveScore)),
        medianPairMax30: core.round(core.median(maxes)), avgPairMax30: core.round(core.mean(maxes)), largestPairMax30: core.round(Math.max(...maxes)),
      });
    }
  }

  // ---------- write outputs ----------
  fs.mkdirSync(OUT, { recursive: true });
  const writeCsv = (file: string, rows: any[]) => { if (!rows.length) return; const cols = Object.keys(rows[0]); const esc = (x: any) => { const s = x == null ? "" : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; fs.writeFileSync(file, cols.join(",") + "\n" + rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n") + "\n"); };
  writeCsv(path.join(OUT, "pre-news-forex-test-v2-historical-pairs.csv"), pairRows);
  writeCsv(path.join(OUT, "pre-news-forex-test-v2-historical-events.csv"), eventRows);

  // ---------- analysis ----------
  const L: string[] = [];
  const say = (s = "") => { L.push(s); console.log(s); };
  const pct = (arr: any[], k: string) => (arr.length ? core.round(100 * core.mean(arr.map((r) => r[k]))) : NaN);
  const avg = (arr: any[], k: string) => core.round(core.mean(arr.map((r) => r[k])));
  const med = (arr: any[], k: string) => core.round(core.median(arr.map((r) => r[k])));

  say(`\n===== V2 HISTORICAL VALIDATION — ${WIN_START.slice(0, 10)} … ${WIN_END.slice(0, 10)} =====`);
  say(`independent timestamps: ${eventRows.length}   pair-level rows: ${pairRows.length}   (rows skipped for thin data: ${skipped})`);
  say(`HIGH-impact timestamps: ${eventRows.filter((e) => e.anyHigh).length}   pair-rows HIGH: ${pairRows.filter((r) => r.impact === "HIGH").length}  MEDIUM: ${pairRows.filter((r) => r.impact === "MEDIUM").length}`);

  // ----- systems A/B/C -----
  const A = pairRows.filter((r) => r.impact === "HIGH");
  const B = pairRows.filter((r) => r.moveScore >= 60);
  const C = pairRows.filter((r) => r.moveScore >= 80);
  const evA = eventRows.filter((e) => e.anyHigh);
  const evB = eventRows.filter((e) => e.maxMoveScore >= 60);
  const evC = eventRows.filter((e) => e.maxMoveScore >= 80);
  const univ = pairRows;
  const reach = (thr: number) => univ.filter((r) => r.post30max >= thr).length;
  const cover = (sel: any[], thr: number) => { const tot = reach(thr); return tot ? core.round(100 * sel.filter((r) => r.post30max >= thr).length / tot) : NaN; };
  const prec = (sel: any[], thr: number) => (sel.length ? core.round(100 * sel.filter((r) => r.post30max >= thr).length / sel.length) : NaN);

  const sysRow = (name: string, sel: any[], evsel: any[]) => `${name.padEnd(20)} ${String(evsel.length).padStart(4)} ${String(sel.length).padStart(5)}  ${String(avg(sel, "post30max")).padStart(7)} ${String(med(sel, "post30max")).padStart(7)}  ${String(pct(sel, "hit10")).padStart(4)} ${String(pct(sel, "hit15")).padStart(4)} ${String(pct(sel, "hit20")).padStart(4)} ${String(pct(sel, "hit30")).padStart(4)}   ${String(prec(sel, 15)).padStart(4)} ${String(prec(sel, 20)).padStart(4)} ${String(prec(sel, 30)).padStart(4)}   ${String(cover(sel, 15)).padStart(4)} ${String(cover(sel, 20)).padStart(4)} ${String(cover(sel, 30)).padStart(4)}`;
  say(`\n----- PRIMARY: SYSTEM COMPARISON (post-30m MAX move, pip units) -----`);
  say(`system               indN pairN  avg30m  med30m   %10  %15  %20  %30   P15  P20  P30   C15  C20  C30`);
  say(sysRow("HIGH_IMPACT_ONLY", A, evA));
  say(sysRow("MOVE_SCORE_60_PLUS", B, evB));
  say(sysRow("MOVE_SCORE_80_PLUS", C, evC));
  say(`(P=precision: % of selected reaching threshold. C=coverage: % of ALL >=thr moves selected. universe=${univ.length} rows; reach15=${reach(15)} reach20=${reach(20)} reach30=${reach(30)})`);

  // horizon breakdown for each system
  say(`\n----- systems at 15m / 30m / 60m (avg max, %>=15) -----`);
  for (const [nm, sel] of [["HIGH", A], ["MOVE60+", B], ["MOVE80+", C]] as const) {
    const h = (mx: string, hit15flagHorizon: string) => `${String(avg(sel, mx)).padStart(6)}`;
    say(`${nm.padEnd(9)} avg15max=${avg(sel, "post15max")}  avg30max=${avg(sel, "post30max")}  avg60max=${avg(sel, "post60max")}   %>=15@30m=${pct(sel, "hit15")}`);
  }

  // ----- information above the calendar: within HIGH, by MOVE_SCORE band -----
  say(`\n----- INFORMATION ABOVE CALENDAR: HIGH-impact rows split by MOVE_SCORE -----`);
  for (const [lo, hi, nm] of [[0, 59, "HIGH & <60"], [60, 79, "HIGH & 60-79"], [80, 100, "HIGH & >=80"]] as const) {
    const g = A.filter((r) => r.moveScore >= lo && r.moveScore <= hi);
    say(`${nm.padEnd(14)} n=${String(g.length).padStart(3)}  avg30max=${avg(g, "post30max")}  med30max=${med(g, "post30max")}  %>=15=${pct(g, "hit15")}  %>=20=${pct(g, "hit20")}  %>=30=${pct(g, "hit30")}`);
  }
  // ----- MEDIUM test -----
  say(`\n----- MEDIUM-impact: can MOVE_SCORE find big movers HIGH-only misses? -----`);
  const M = pairRows.filter((r) => r.impact === "MEDIUM");
  for (const [lo, hi, nm] of [[0, 59, "MEDIUM & <60"], [60, 100, "MEDIUM & >=60"]] as const) {
    const g = M.filter((r) => r.moveScore >= lo && r.moveScore <= hi);
    say(`${nm.padEnd(16)} n=${String(g.length).padStart(3)}  avg30max=${avg(g, "post30max")}  med30max=${med(g, "post30max")}  %>=15=${pct(g, "hit15")}  %>=20=${pct(g, "hit20")}`);
  }

  // ----- MOVE_SCORE class groups -----
  say(`\n----- MOVE_SCORE class groups vs actual max move -----`);
  say(`class                        n  avg5  avg15 avg30 avg60  med30  %10 %15 %20 %30 %40`);
  for (const [lo, hi, nm] of [[0, 39, "LOW 0-39"], [40, 59, "MOD 40-59"], [60, 79, "BIG 60-79"], [80, 100, "VBIG 80-100"]] as const) {
    const g = pairRows.filter((r) => r.moveScore >= lo && r.moveScore <= hi);
    if (!g.length) { say(`${nm.padEnd(26)} 0`); continue; }
    say(`${nm.padEnd(26)} ${String(g.length).padStart(3)} ${String(avg(g, "post5max")).padStart(5)} ${String(avg(g, "post15max")).padStart(5)} ${String(avg(g, "post30max")).padStart(5)} ${String(avg(g, "post60max")).padStart(5)} ${String(med(g, "post30max")).padStart(6)}  ${String(pct(g, "hit10")).padStart(3)} ${String(pct(g, "hit15")).padStart(3)} ${String(pct(g, "hit20")).padStart(3)} ${String(pct(g, "hit30")).padStart(3)} ${String(pct(g, "hit40")).padStart(3)}`);
  }

  // ----- event type -----
  say(`\n----- event type (primary) vs max move -----`);
  const types = [...new Set(pairRows.map((r) => r.eventType))];
  for (const t of types.sort()) { const g = pairRows.filter((r) => r.eventType === t); say(`${t.padEnd(13)} n=${String(g.length).padStart(3)} avg30max=${String(avg(g, "post30max")).padStart(5)} med30max=${String(med(g, "post30max")).padStart(5)} %>=15=${pct(g, "hit15")} %>=20=${pct(g, "hit20")} %>=30=${pct(g, "hit30")}`); }

  // ----- pair -----
  say(`\n----- major pair vs news move -----`);
  for (const p of MAJORS) { const g = pairRows.filter((r) => r.pair === p); if (!g.length) continue; say(`${p} n=${String(g.length).padStart(3)} avg15=${String(avg(g, "post15max")).padStart(4)} avg30=${String(avg(g, "post30max")).padStart(4)} avg60=${String(avg(g, "post60max")).padStart(4)} med30=${String(med(g, "post30max")).padStart(4)} %>=15=${pct(g, "hit15")} %>=20=${pct(g, "hit20")} %>=30=${pct(g, "hit30")}`); }

  // ----- extension buckets: continuation vs reversal -----
  say(`\n----- pre-30m extension (ATR) buckets: continuation vs reversal (30m net) -----`);
  for (const [lo, hi, nm] of [[0, 0.5, "<0.5"], [0.5, 1.0, "0.5-1.0"], [1.0, 1.5, "1.0-1.5"], [1.5, 2.0, "1.5-2.0"], [2.0, 3.0, "2.0-3.0"], [3.0, 1e9, ">3.0"]] as const) {
    const g = pairRows.filter((r) => Number.isFinite(r.pre30atr) && r.pre30atr >= lo && r.pre30atr < hi && Math.abs(r.pre30) > 0.5);
    if (!g.length) { say(`${nm.padEnd(9)} n=0`); continue; }
    const cont = g.filter((r) => core.sign(r.post30net) === core.sign(r.pre30) && core.sign(r.post30net) !== 0).length;
    const rev = g.filter((r) => core.sign(r.post30net) === -core.sign(r.pre30) && core.sign(r.post30net) !== 0).length;
    say(`${nm.padEnd(9)} n=${String(g.length).padStart(3)} cont=${String(Math.round(100 * cont / g.length)).padStart(3)}% rev=${String(Math.round(100 * rev / g.length)).padStart(3)}% avg30max=${avg(g, "post30max")}`);
  }

  // ----- component discrimination (Pearson corr with post30max) -----
  const corr = (xs: number[], ys: number[]) => { const n = xs.length; if (n < 3) return NaN; const mx = core.mean(xs), my = core.mean(ys); let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; a += dx * dy; b += dx * dx; c += dy * dy; } return b && c ? core.round(a / Math.sqrt(b * c), 3) : NaN; };
  say(`\n----- component discrimination: corr(component, post30max) -----`);
  const ys = pairRows.map((r) => r.post30max).map((v) => (Number.isFinite(v) ? v : 0));
  for (const comp of ["c_imp", "c_type", "c_sim", "c_act", "c_ext", "c_comp", "c_sr"]) say(`${comp.padEnd(7)} r=${corr(pairRows.map((r) => r[comp]), ys)}`);
  say(`moveScore r=${corr(pairRows.map((r) => r.moveScore), ys)}`);

  // ----- S/R compression distribution -----
  const srs = pairRows.map((r) => r.srCompression).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => core.round(srs[Math.min(srs.length - 1, Math.floor(p * srs.length))]!);
  const sd = core.round(Math.sqrt(core.mean(srs.map((x) => (x - core.mean(srs)) ** 2))));
  say(`\n----- SPECIAL: srCompression distribution -----`);
  say(`mean=${avg(pairRows, "srCompression")} median=${core.round(core.median(srs))} sd=${sd} p10=${q(0.1)} p25=${q(0.25)} p75=${q(0.75)} p90=${q(0.9)}`);
  say(srs.length && (q(0.9) - q(0.1) < 15) ? "-> LOW_INFORMATION_FEATURE (barely varies)" : "-> varies across sample");

  // ----- simultaneous -----
  say(`\n----- simultaneous releases vs max move -----`);
  for (const [lo, hi, nm] of [[1, 1, "1"], [2, 2, "2"], [3, 3, "3"], [4, 99, "4+"]] as const) {
    const g = pairRows.filter((r) => r.simultaneous >= lo && r.simultaneous <= hi);
    if (!g.length) { say(`sim ${nm}: n=0`); continue; }
    say(`sim ${nm.padEnd(3)} n=${String(g.length).padStart(3)} avg30max=${avg(g, "post30max")} med30max=${med(g, "post30max")} %>=15=${pct(g, "hit15")}`);
  }

  // ----- direction (secondary) -----
  say(`\n----- DIRECTION accuracy (SECONDARY; strength basket = majors-only, degraded) -----`);
  const dc = pairRows.filter((r) => r.direction !== "UNKNOWN");
  const dacc = (h: string) => { const g = dc.filter((r) => r[h] === "Y" || r[h] === "N"); const w = g.filter((r) => r[h] === "Y").length; return g.length ? `${w}/${g.length}=${core.round(100 * w / g.length)}%` : "n/a"; };
  say(`calls=${dc.length} (LONG ${dc.filter((r) => r.direction === "LONG").length}, SHORT ${dc.filter((r) => r.direction === "SHORT").length}, UNKNOWN ${pairRows.length - dc.length})`);
  say(`5m ${dacc("dir5")}  15m ${dacc("dir15")}  30m ${dacc("dir30")}  60m ${dacc("dir60")}`);

  fs.writeFileSync(path.join(OUT, "pre-news-forex-test-v2-historical-summary.txt"), L.join("\n"));
  fs.writeFileSync(path.join(OUT, "pre-news-forex-test-v2-historical-summary.json"), JSON.stringify({ window: [WIN_START, WIN_END], independentEvents: eventRows.length, pairRows: pairRows.length,
    systems: { A: { indN: evA.length, pairN: A.length, avg30: avg(A, "post30max"), p15: prec(A, 15), p20: prec(A, 20), c15: cover(A, 15), c20: cover(A, 20) },
      B: { indN: evB.length, pairN: B.length, avg30: avg(B, "post30max"), p15: prec(B, 15), p20: prec(B, 20), c15: cover(B, 15), c20: cover(B, 20) },
      C: { indN: evC.length, pairN: C.length, avg30: avg(C, "post30max"), p15: prec(C, 15), p20: prec(C, 20), c15: cover(C, 15), c20: cover(C, 20) } } }, null, 2));
  say(`\nsaved: pairs.csv (${pairRows.length}), events.csv (${eventRows.length}), summary.txt/json  [SAMPLE_TYPE=HISTORICAL_VALIDATION]`);
}
main().catch((e) => { console.error(e); process.exit(1); });
