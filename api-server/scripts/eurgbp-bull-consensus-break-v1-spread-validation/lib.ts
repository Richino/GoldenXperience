// Shared helpers for the EURGBP Bull Consensus Structure Break V1 spread validation.
// No optimization, no strategy changes: this only parses the frozen TradingView
// cohort and resolves its America/New_York timestamps to UTC (DST-aware).
import fs from 'node:fs';

export const SOURCE_CSV =
  'C:/Users/arche/Downloads/GX_EURGBP_Bull_Consensus_Structure_Break_V1_-_1_to_2_RR_OANDA_EURGBP_2026-09-06_b2d40.csv';

export const INSTRUMENT = 'EUR_GBP';
export const ORIGIN_HOUR_UTC = 6; // completed 06:00 UTC H1 candle (bar-open time)
export const AUTHORITATIVE_TRADE_COUNT = 80;
export const TV_SIGNAL = 'EURGBP_0600_LONG';

// --- America/New_York -> UTC, DST-aware (no fixed offset across the dataset) ---
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const asUTC = Date.UTC(
    +map.year,
    +map.month - 1,
    +map.day,
    +map.hour,
    +map.minute,
    +map.second,
  );
  return asUTC - utcMs; // NY is negative (behind UTC)
}

export function nyWallToUtcMs(wall: string): number {
  // wall = "YYYY-MM-DD HH:mm"
  const [d, t] = wall.trim().split(' ');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, mi);
  let off = tzOffsetMs(guess, 'America/New_York');
  let utc = guess - off;
  off = tzOffsetMs(utc, 'America/New_York'); // refine across DST edges
  utc = guess - off;
  return utc;
}

export interface TvTrade {
  tradeNumber: number;
  direction: 'long';
  tvEntryWallNy: string;
  resolvedEntryUtcMs: number; // UTC ms of the H1 signal bar (open time, must be 06:00)
  tvExitWallNy: string;
  resolvedExitUtcMs: number; // UTC ms of the exit bar (open time)
  tvEntryPrice: number; // TV mid close of the 06:00-open bar
  tvExitPrice: number;
  tvSignal: string; // EURGBP_0600_LONG
  tvExitReason: string; // TP_OR_SL | TIME_EXIT
  durationBars: number;
}

export function parseCohort(csvPath = SOURCE_CSV): TvTrade[] {
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.trim().split(/\r?\n/);
  const rows = lines.slice(1).map((l) => l.split(','));
  const byTrade = new Map<string, string[][]>();
  for (const r of rows) {
    const n = r[0];
    if (!byTrade.has(n)) byTrade.set(n, []);
    byTrade.get(n)!.push(r);
  }
  const trades: TvTrade[] = [];
  for (const [n, recs] of byTrade) {
    const entry = recs.find((x) => x[1].startsWith('Entry'))!;
    const exit = recs.find((x) => x[1].startsWith('Exit'))!;
    if (!entry || !exit) throw new Error(`Trade ${n}: missing entry or exit leg`);
    const resolvedEntryUtcMs = nyWallToUtcMs(entry[2]);
    const resolvedExitUtcMs = nyWallToUtcMs(exit[2]);
    trades.push({
      tradeNumber: +n,
      direction: 'long',
      tvEntryWallNy: entry[2],
      resolvedEntryUtcMs,
      tvExitWallNy: exit[2],
      resolvedExitUtcMs,
      tvEntryPrice: parseFloat(entry[4]),
      tvExitPrice: parseFloat(exit[4]),
      tvSignal: entry[3],
      tvExitReason: exit[3],
      durationBars: parseInt(exit[16]),
    });
  }
  trades.sort((a, b) => a.tradeNumber - b.tradeNumber);
  return trades;
}

// --- OANDA candle types (compact) ---
export interface Candle {
  t: number; // UTC ms (period start / bar-open time)
  bo: number; bh: number; bl: number; bc: number; // bid OHLC
  ao: number; ah: number; al: number; ac: number; // ask OHLC
}

export function loadCandles(file: string): Candle[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')).candles as Candle[];
}

export const PIP = 10000; // EURGBP quoted to 5 dp, 1 pip = 0.0001
