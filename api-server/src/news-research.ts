import { query } from "./database.js";

/**
 * News-impact research breakdowns.
 *
 * Read-only aggregation over resolved trades. The question it exists to answer:
 * does strategy performance change around economic news, and specifically — is
 * Momentum losing mainly around news, or is it still bad when NO_NEWS?
 *
 * Reports the numbers and nothing else. It draws no conclusion about whether
 * news causes the losses; that is what the data is for.
 */

export interface NewsMetrics {
  group: string;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number | null;
  totalR: number;
  /** Net expectancy: mean R per trade. */
  netE: number | null;
}

/** The one metric definition, so every breakdown is computed identically. */
export function metricsFor(group: string, results: number[]): NewsMetrics {
  const wins = results.filter((r) => r > 0).length;
  const losses = results.filter((r) => r < 0).length;
  const totalR = results.reduce((sum, r) => sum + r, 0);
  const decided = wins + losses;
  return {
    group,
    trades: results.length,
    wins,
    losses,
    // A trade that resolves at exactly 0R is neither; counting it as a loss
    // would understate win rate, so it is reported separately.
    scratches: results.length - decided,
    winRate: decided ? wins / decided : null,
    totalR: Number(totalR.toFixed(4)),
    netE: results.length ? Number((totalR / results.length).toFixed(4)) : null,
  };
}

export const NEWS_TAG_ORDER = ["NO_NEWS", "NEAR_NEWS", "HIGH_IMPACT_NEWS", "(untagged)"] as const;

interface TradeRow {
  result_r: string;
  news_impact_tag: string | null;
  strategy_family: string | null;
  instrument: string;
  session: string | null;
  inverted: boolean | null;
  original_direction: string | null;
  direction: string;
  news_currency: string | null;
  news_event_name: string | null;
  news_impact_level: number | null;
}

async function resolvedTrades(): Promise<TradeRow[]> {
  const rows = await query<TradeRow>(
    `SELECT result_r::text, news_impact_tag, strategy_family, instrument, session,
            inverted, original_direction, direction, news_currency, news_event_name, news_impact_level
     FROM paper_strategy_trades
     WHERE result_r IS NOT NULL
     ORDER BY COALESCE(opened_at, decision_time)`,
  );
  return rows.rows;
}

function groupBy(rows: TradeRow[], key: (row: TradeRow) => string | null): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const row of rows) {
    const bucket = key(row);
    if (bucket === null) continue;
    const value = Number(row.result_r);
    if (!Number.isFinite(value)) continue;
    const list = map.get(bucket) ?? [];
    list.push(value);
    map.set(bucket, list);
  }
  return map;
}

function toMetrics(map: Map<string, number[]>, order?: readonly string[]): NewsMetrics[] {
  const entries = [...map.entries()].map(([group, results]) => metricsFor(group, results));
  if (order) {
    return entries.sort((a, b) => {
      const ai = order.indexOf(a.group); const bi = order.indexOf(b.group);
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi) || a.group.localeCompare(b.group);
    });
  }
  return entries.sort((a, b) => b.trades - a.trades || a.group.localeCompare(b.group));
}

const tagOf = (row: TradeRow) => row.news_impact_tag ?? "(untagged)";

/**
 * The Momentum comparison the experiment turns on.
 *
 * `inverted` splits the executed trade from the strategy's own verdict, so
 * "original Momentum" and "inverted Momentum" can be read separately within
 * each news bucket. Trades predating the inversion experiment carry
 * inverted=false and are the original cohort by construction.
 */
const momentumVariant = (row: TradeRow) =>
  row.strategy_family !== "momentum" ? null
    : row.inverted ? "momentum (inverted)" : "momentum (original)";

export async function newsImpactReport() {
  const rows = await resolvedTrades();
  const all = rows.map((row) => Number(row.result_r)).filter((value) => Number.isFinite(value));

  return {
    overall: metricsFor("ALL", all),
    byNewsTag: toMetrics(groupBy(rows, tagOf), NEWS_TAG_ORDER),
    byFamily: toMetrics(groupBy(rows, (row) => row.strategy_family ?? "(none)")),
    byFamilyAndNews: toMetrics(groupBy(rows, (row) => `${row.strategy_family ?? "(none)"} / ${tagOf(row)}`)),
    momentumByNews: toMetrics(groupBy(rows, (row) => {
      const variant = momentumVariant(row);
      return variant === null ? null : `${variant} / ${tagOf(row)}`;
    })),
    momentumVariants: toMetrics(groupBy(rows, momentumVariant)),
    byPairAndNews: toMetrics(groupBy(rows, (row) => `${row.instrument} / ${tagOf(row)}`)),
    byNewsCurrency: toMetrics(groupBy(rows, (row) => row.news_currency)),
    bySessionAndNews: toMetrics(groupBy(rows, (row) => `${row.session ?? "(none)"} / ${tagOf(row)}`)),
    byEventName: toMetrics(groupBy(rows, (row) => row.news_event_name)),
    sampleSize: rows.length,
  };
}
