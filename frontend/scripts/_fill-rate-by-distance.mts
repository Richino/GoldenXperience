// How often does a limit order N average-1h-candles (H1 ATR14) from price fill
// within the Analyze order lifetime (normal 4h, swing 48h)? 14 majors, M5 bid/ask, 2021-10..2026-10.
import fs from "node:fs";
const DIR = process.argv[2]!;
const PAIRS = ["EUR_USD","GBP_USD","USD_JPY","AUD_USD","NZD_USD","USD_CAD","USD_CHF","EUR_GBP","EUR_JPY","CAD_JPY","NZD_JPY","GBP_JPY","AUD_JPY","EUR_AUD"];
const DISTS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
const LIFE = { normal: 4 * 3_600_000, swing: 48 * 3_600_000 };
const hits: Record<string, number[]> = { normal: DISTS.map(() => 0), swing: DISTS.map(() => 0) };
let n = 0;
for (const inst of PAIRS) {
  const h1 = (JSON.parse(fs.readFileSync(`${DIR}/${inst}_H1.json`, "utf8")) as number[][]);
  const buf = fs.readFileSync(`${DIR}/${inst}_M5BA.bin`);
  const m5 = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  const n5 = m5.length / 9;
  // ATR14 on H1 mid.
  const atr: number[] = []; let prev = 0;
  for (let i = 0; i < h1.length; i++) {
    const [, , h, l, c] = h1[i]!; const pc = i ? h1[i - 1]![4]! : c!;
    const tr = Math.max(h! - l!, Math.abs(h! - pc), Math.abs(l! - pc));
    prev = i < 14 ? (prev * i + tr) / (i + 1) : (prev * 13 + tr) / 14; atr.push(prev);
  }
  let k = 0;
  for (let i = 20; i < h1.length; i += 3) {
    const t = h1[i]![0]! + 3_600_000; // after this H1 candle closes
    while (k < n5 && m5[k * 9]! < t) k++;
    if (k >= n5 - 600) break;
    if (m5[k * 9]! - t > 2 * 3_600_000) continue; // weekend gap
    const a = atr[i]!;
    const bid = m5[k * 9 + 1]!, ask = m5[k * 9 + 5]!;
    n++;
    for (const mode of ["normal", "swing"] as const) {
      let lowAsk = Infinity, highBid = -Infinity;
      for (let j = k; j < n5 && m5[j * 9]! - t <= LIFE[mode]; j++) { lowAsk = Math.min(lowAsk, m5[j * 9 + 7]!); highBid = Math.max(highBid, m5[j * 9 + 2]!); }
      DISTS.forEach((d, x) => {
        // Average of a buy limit below (fills on ask) and a sell limit above (fills on bid).
        hits[mode]![x]! += ((lowAsk <= ask - d * a ? 1 : 0) + (highBid >= bid + d * a ? 1 : 0)) / 2;
      });
    }
  }
}
console.log(`samples ${n}`);
console.table(DISTS.map((d, x) => ({ "distance (H1 ATR)": d, "normal 4h fill %": (100 * hits.normal![x]! / n).toFixed(0), "swing 48h fill %": (100 * hits.swing![x]! / n).toFixed(0) })));
