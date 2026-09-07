// Shared helpers for the EURUSD Frequency V3 spread validation.
// No optimization, no strategy changes: this only parses the frozen TradingView
// cohort and resolves its America/New_York timestamps to UTC (DST-aware).
import fs from 'node:fs';

export const SOURCE_CSV =
  'C:/Users/arche/Downloads/GX_EURUSD_London_Breakout_V3_-_Selected_Frequency_Legs_-_1.25R_Profit_Lock_OANDA_EURUSD_2026-09-05_1db5b.csv';

export const ALLOWED_LEGS: Record<string, number> = {
  '0600_SHORT': 6,
  '0700_LONG': 7,
  '0700_SHORT': 7,
  '0800_SHORT': 8,
  '0900_LONG': 9,
  '1000_LONG': 10,
  '1000_SHORT': 10,
};

export const AUTHORITATIVE_LEG_COUNTS: Record<string, number> = {
  '0600_SHORT': 53,
  '0700_LONG': 49,
  '0700_SHORT': 42,
  '0800_SHORT': 33,
  '0900_LONG': 20,
  '1000_LONG': 17,
  '1000_SHORT': 20,
};

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
  leg: string;
  direction: 'long' | 'short';
  originHourUtc: number; // expected leg hour
  tvEntryWallNy: string;
  resolvedEntryUtcMs: number; // UTC ms of the H1 signal bar (open time)
  tvExitWallNy: string;
  resolvedExitUtcMs: number;
  tvEntryPrice: number;
  tvExitPrice: number;
  tvExitReason: string; // TP_OR_SL | PROFIT_LOCK_OR_TP
  durationBars: number;
  netPnlUsd: number;
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
    const leg = entry[3];
    const direction: 'long' | 'short' = entry[1].includes('long') ? 'long' : 'short';
    const originHourUtc = ALLOWED_LEGS[leg];
    if (originHourUtc === undefined) throw new Error(`Unknown leg ${leg} on trade ${n}`);
    const resolvedEntryUtcMs = nyWallToUtcMs(entry[2]);
    const resolvedExitUtcMs = nyWallToUtcMs(exit[2]);
    // verify the resolved entry hour matches the leg's declared UTC origin hour
    const gotHour = new Date(resolvedEntryUtcMs).getUTCHours();
    if (gotHour !== originHourUtc) {
      throw new Error(
        `Trade ${n} leg ${leg}: resolved UTC hour ${gotHour} != expected ${originHourUtc} (NY ${entry[2]})`,
      );
    }
    trades.push({
      tradeNumber: +n,
      leg,
      direction,
      originHourUtc,
      tvEntryWallNy: entry[2],
      resolvedEntryUtcMs,
      tvExitWallNy: exit[2],
      resolvedExitUtcMs,
      tvEntryPrice: parseFloat(entry[4]),
      tvExitPrice: parseFloat(exit[4]),
      tvExitReason: exit[3],
      durationBars: parseInt(exit[16]),
      netPnlUsd: parseFloat(exit[7]),
    });
  }
  trades.sort((a, b) => a.tradeNumber - b.tradeNumber);
  return trades;
}

// --- OANDA candle types (compact) ---
export interface Candle {
  t: number; // UTC ms (period start)
  bo: number; bh: number; bl: number; bc: number; // bid OHLC
  ao: number; ah: number; al: number; ac: number; // ask OHLC
}

export function loadCandles(file: string): Candle[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')).candles as Candle[];
}
