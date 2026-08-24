/**
 * Recent paper-trade inversion diagnostic. RESEARCH ONLY — DIAGNOSTIC, NOT EVIDENCE.
 *
 * Takes the real recorded paper trades and computes what the exact opposite
 * direction would have done, using the same mirrored geometry and real bid/ask.
 * These trades post-date the stored candle history, so the price paths are
 * fetched fresh from OANDA.
 *
 * OANDA stamps candles with their START time while market_candles is stamped
 * with the CLOSE — a bug found earlier in this programme. +15m is applied here.
 *
 * A handful of trades cannot establish anything. This exists to check whether
 * the recent live behaviour is CONSISTENT with the historical inversion result,
 * nothing more.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("C:/Users/arche/Desktop/code/GoldenXperience/api-server/package.json");
const { Client } = require("pg");

let env = "";
for (const f of [".env", ".env.local"]) {
  const p = path.join("C:/Users/arche/Desktop/code/GoldenXperience/api-server", f);
  if (fs.existsSync(p)) env += "\n" + fs.readFileSync(p, "utf8");
}
const g = (k) => { const m = env.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const TOKEN = g("OANDA_API_KEY") || g("OANDA_API_TOKEN");
const HOST = g("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";

const cl = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await cl.connect();
const tr = await cl.query(
  `SELECT strategy_family, instrument, direction, decision_time, entry::float, stop::float, target::float,
          outcome, result_r::float, status
     FROM paper_strategy_trades
    WHERE experiment_id IS NOT NULL AND strategy_family IS NOT NULL
      AND status='closed' AND result_r IS NOT NULL
    ORDER BY decision_time`);
await cl.end();
console.log(`recorded closed paper trades: ${tr.rows.length}`);
if (!tr.rows.length) { console.log("nothing to analyse"); process.exit(0); }

const pairs = [...new Set(tr.rows.map((r) => r.instrument))];
const from = new Date(Math.min(...tr.rows.map((r) => Date.parse(r.decision_time))) - 3600e3).toISOString();
const bars = {};
for (const p of pairs) {
  const url = `${HOST}/v3/instruments/${p}/candles?price=BA&granularity=M15&count=1200&from=${encodeURIComponent(from)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`${p}: fetch failed ${r.status}`); continue; }
  const j = await r.json();
  bars[p] = (j.candles ?? []).filter((c) => c.complete).map((c) => ({
    // OANDA start-stamp -> close-stamp, matching market_candles
    t: Date.parse(c.time) + 15 * 60_000,
    bh: +c.bid.h, bl: +c.bid.l, bc: +c.bid.c,
    ah: +c.ask.h, al: +c.ask.l, ac: +c.ask.c,
  }));
  console.log(`${p}: ${bars[p].length} M15 bars`);
}

/** Resolve a trade against forward bars; long exits on bid, short on ask. */
function resolve(dir, entry, stop, target, fromMs, series) {
  const fwd = series.filter((b) => b.t > fromMs).slice(0, 192);   // 48h horizon
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !fwd.length) return null;
  for (const b of fwd) {
    if (dir === "long") {
      const hitStop = b.bl <= stop, hitTgt = b.bh >= target;
      if (hitStop && hitTgt) return { outcome: "ambiguous", r: null };
      if (hitStop) return { outcome: "stop_first", r: -1 };
      if (hitTgt) return { outcome: "target_first", r: Math.abs(target - entry) / risk };
    } else {
      const hitStop = b.ah >= stop, hitTgt = b.al <= target;
      if (hitStop && hitTgt) return { outcome: "ambiguous", r: null };
      if (hitStop) return { outcome: "stop_first", r: -1 };
      if (hitTgt) return { outcome: "target_first", r: Math.abs(entry - target) / risk };
    }
  }
  const last = fwd.at(-1);
  const mark = dir === "long" ? last.bc : last.ac;
  const r = dir === "long" ? (mark - entry) / risk : (entry - mark) / risk;
  return { outcome: "timeout", r };
}

const rows = [];
for (const t of tr.rows) {
  const series = bars[t.instrument];
  if (!series) continue;
  const at = Date.parse(t.decision_time);
  const near = series.filter((b) => Math.abs(b.t - at) < 20 * 60_000).sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))[0];
  if (!near) continue;
  const inv = t.direction === "long" ? "short" : "long";
  const stopDist = Math.abs(t.entry - t.stop);
  const tgtDist = Math.abs(t.target - t.entry);
  // inverted fills the OTHER side of the book at the same bar, geometry mirrored
  const invEntry = inv === "long" ? near.ac : near.bc;
  const invStop = inv === "long" ? invEntry - stopDist : invEntry + stopDist;
  const invTarget = inv === "long" ? invEntry + tgtDist : invEntry - tgtDist;
  const res = resolve(inv, invEntry, invStop, invTarget, at, series);
  if (!res || res.r === null) continue;
  rows.push({ date: new Date(at).toISOString().slice(0, 16), family: t.strategy_family, pair: t.instrument,
    origDir: t.direction, origOutcome: t.outcome, origR: t.result_r,
    invDir: inv, invOutcome: res.outcome, invR: res.r });
}

console.log(`\nresolved counterfactuals: ${rows.length}\n`);
console.log("date              family     pair      orig  outcome         origR    inv   outcome         invR");
for (const r of rows) {
  console.log(`${r.date}  ${r.family.padEnd(10)} ${r.pair.padEnd(9)} ${r.origDir.padEnd(5)} ${String(r.origOutcome).padEnd(14)} ${r.origR.toFixed(2).padStart(6)}   ${r.invDir.padEnd(5)} ${r.invOutcome.padEnd(14)} ${r.invR.toFixed(2).padStart(6)}`);
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const oR = rows.map((r) => r.origR), iR = rows.map((r) => r.invR);
console.log(`\n  original: wins=${oR.filter((x) => x > 0).length} losses=${oR.filter((x) => x <= 0).length} ` +
            `netR=${sum(oR).toFixed(2)} expectancy=${(sum(oR) / (oR.length || 1)).toFixed(3)}`);
console.log(`  inverted: wins=${iR.filter((x) => x > 0).length} losses=${iR.filter((x) => x <= 0).length} ` +
            `netR=${sum(iR).toFixed(2)} expectancy=${(sum(iR) / (iR.length || 1)).toFixed(3)}`);
console.log(`\n  DIAGNOSTIC ONLY — ${rows.length} trades cannot establish an edge either way.`);
