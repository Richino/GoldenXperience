import { query } from "./database.js";

/**
 * The swing plan's checklist, scored: every closed manual trade tagged on the
 * ticket (trend / news view / entry level, plus day or swing) is grouped by
 * each tag, so the trader can see which parts of the plan actually pay. The
 * results only mean something with a decent sample, hence the target count.
 */

export const PLAN_REVIEW_TARGET = 30;

type Row = {
  result: string | null;
  result_r: number | null;
  paper_pl: number | null;
  plan_tags: { trend?: string | null; news?: string | null; level?: string | null } | null;
  trade_style: string | null;
};

type Bucket = { value: string; label: string; trades: number; wins: number; winRate: number; avgR: number | null; netPl: number };

const DIMENSIONS: { key: "trend" | "news" | "level" | "style"; label: string; values: Record<string, string> }[] = [
  { key: "trend", label: "Trend", values: { with: "With the trend", against: "Against the trend", none: "No trend" } },
  { key: "news", label: "News view", values: { supports: "News supports it", against: "News against it", none: "No news view" } },
  { key: "level", label: "Entry", values: { at: "At a level", none: "No level" } },
  { key: "style", label: "Style", values: { swing: "Swing", day: "Day" } },
];

export async function planReview(userId: string) {
  const rows = await query<Row>(
    `SELECT t.result, t.result_r::float AS result_r, t.paper_pl::float AS paper_pl,
            e.metadata->'planTags' AS plan_tags, e.metadata->>'tradeStyle' AS trade_style
       FROM paper_trades t
       JOIN pending_manual_entries e ON e.paper_trade_id = t.id
      WHERE t.user_id = $1 AND t.origin = 'manual' AND t.status = 'closed'
        AND jsonb_typeof(e.metadata->'planTags') = 'object'`,
    [userId],
  );
  const tagged = rows.rows;
  const valueOf = (row: Row, key: (typeof DIMENSIONS)[number]["key"]) =>
    key === "style" ? (row.trade_style === "swing" ? "swing" : "day") : row.plan_tags?.[key] ?? null;
  const groups = DIMENSIONS.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    buckets: Object.entries(dimension.values).map(([value, label]): Bucket => {
      const inBucket = tagged.filter((row) => valueOf(row, dimension.key) === value);
      const rs = inBucket.map((row) => row.result_r).filter((r): r is number => r !== null && Number.isFinite(r));
      const wins = inBucket.filter((row) => row.result === "win").length;
      return {
        value,
        label,
        trades: inBucket.length,
        wins,
        winRate: inBucket.length ? Math.round((wins / inBucket.length) * 100) : 0,
        avgR: rs.length ? Number((rs.reduce((sum, r) => sum + r, 0) / rs.length).toFixed(2)) : null,
        netPl: Number(inBucket.reduce((sum, row) => sum + (row.paper_pl ?? 0), 0).toFixed(2)),
      };
    }).filter((bucket) => bucket.trades > 0),
  }));
  return { tagged: tagged.length, target: PLAN_REVIEW_TARGET, groups };
}
