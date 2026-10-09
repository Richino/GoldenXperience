// Why the S/R 8–12 NY trades lose: path after the touch, stop timing, and the spread's share.
import fs from "node:fs";
const M1 = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const PIP = 1e-4;
const raw: any[] = JSON.parse(fs.readFileSync(M1, "utf8"));
const idx = new Map<number, number>(); const T: number[] = [], H: number[] = [], L: number[] = [], C: number[] = [];
raw.forEach((r, i) => { const t = Date.parse(r[0].slice(0, 19) + "Z"); T.push(t); H.push((r[1] + r[3]) / 2); L.push((r[2] + r[4]) / 2); C.push((r[5] + r[6]) / 2); idx.set(t, i); });
const rows = fs.readFileSync("TRADES.csv", "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
for (const variant of ["M15 touch       SL7.5/TP15", "M15 sweep+reclaim SL7.5/TP15"]) {
  const tr = rows.filter((r) => r[0] === variant);
  let firstMoveAgainst = 0, n = 0, stopped = 0, stoppedThenTarget = 0, wins = 0, winsFirstDipped = 0;
  const minsToStop: number[] = [], minsToTp: number[] = [], maeBeforeTp: number[] = [];
  const firstHit = { against3: 0, for3: 0 };
  for (const r of tr) {
    const dir = Number(r[2]); const i0 = idx.get(Date.parse(r[4]))!; const entry = C[i0]!; // mid reference
    const end = Math.min(T.length, i0 + 8 * 60);
    let mae = 0, hitTp = -1, hitSl = -1, first3 = 0;
    for (let i = i0 + 1; i < end; i++) {
      const fav = dir === 1 ? (H[i]! - entry) / PIP : (entry - L[i]!) / PIP;
      const adv = dir === 1 ? (entry - L[i]!) / PIP : (H[i]! - entry) / PIP;
      if (!first3) { if (adv >= 3) first3 = -1; else if (fav >= 3) first3 = 1; }
      if (hitTp < 0 && fav >= 15) { hitTp = i; maeBeforeTp.push(mae); }
      if (hitSl < 0 && adv >= 7.5) hitSl = i;
      if (hitTp < 0) mae = Math.max(mae, adv);
    }
    n++; if (first3 === -1) firstHit.against3++; if (first3 === 1) firstHit.for3++;
    if (r[7] === "SL") { stopped++; minsToStop.push((T[hitSl > 0 ? hitSl : i0]! - T[i0]!) / 6e4); if (hitTp > 0 && hitTp > hitSl) stoppedThenTarget++; }
    if (r[7] === "TP") { wins++; minsToTp.push((T[hitTp > 0 ? hitTp : i0]! - T[i0]!) / 6e4); }
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
  const pct = (a: number[], f: (x: number) => boolean) => (100 * a.filter(f).length / a.length).toFixed(0);
  const spread = tr.reduce((a, r) => a + Number(r[10]), 0) / tr.length;
  console.log(`\n== ${variant.trim()}  (n=${n})`);
  console.log(`first 3 pips after entry: against ${(100 * firstHit.against3 / n).toFixed(1)}%  | with ${(100 * firstHit.for3 / n).toFixed(1)}%`);
  console.log(`exec: stopped ${(100 * stopped / n).toFixed(1)}%, target ${(100 * wins / n).toFixed(1)}%`);
  console.log(`median minutes to stop ${med(minsToStop)} (within 15 min: ${pct(minsToStop, (x) => x <= 15)}%) | to target ${med(minsToTp)}`);
  console.log(`stopped trades where price later reached the 15-pip target (mid, within 8h): ${(100 * stoppedThenTarget / stopped).toFixed(0)}%`);
  console.log(`on mid-price winners, deepest move against before target: median ${med(maeBeforeTp).toFixed(1)}p; >=7.5p (would be stopped): ${pct(maeBeforeTp, (x) => x >= 7.5)}%`);
  console.log(`avg spread ${spread.toFixed(2)}p = ${(spread / 7.5).toFixed(2)}R. Long needs bid to rise 15p+spread for TP and only 7.5p-spread to stop`);
  console.log(`=> effective stop ${(7.5 - spread).toFixed(1)}p vs target ${(15 + spread).toFixed(1)}p → random-walk win rate ≈ ${(100 * (7.5 - spread) / (22.5)).toFixed(1)}%`);
}
// how noisy is the window: typical 15-minute range 08–12 NY
