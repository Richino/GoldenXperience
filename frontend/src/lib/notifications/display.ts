import type { AppNotification } from "@/lib/notifications/types";

const TECHNICAL_NOISE =
  /insert or update on table|violates\s+(?:foreign key |unique |check |exclusion )?constraint|duplicate key value|relation "[^"]+" does not exist|column "[^"]+" (?:of relation|does not exist)|null value in column|invalid input syntax|permission denied for (?:table|relation|schema)|deadlock detected|could not serialize|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|password authentication failed/i;

export function notificationHref(item: AppNotification) {
  if (item.kind === "news_reminder") return "/";
  // Background research finished: open Analyze on that pair with the report and its plans.
  if (item.kind === "research_ready" && item.instrument) return `/chart?instrument=${encodeURIComponent(item.instrument)}&analyze=1`;
  if (item.instrument && /plan to review|entry conditions met/i.test(item.title)) return `/chart?instrument=${encodeURIComponent(item.instrument)}&observer=review`;
  return item.instrument ? `/chart?instrument=${item.instrument}` : "/watchlist";
}

export function displayTitle(item: AppNotification) {
  return item.title
    .replace(/\spaper trade\s/gi, " ")
    .replace(/\spractice\s/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function displayDetail(item: AppNotification) {
  const cleaned = item.message
    .replace(/\s*Entry, target, and stop are available on (?:Signals|Charts)\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (item.kind === "system_issue") return humanizeIssueDetail(item, cleaned);
  return cleaned;
}

export function detailTone(item: AppNotification) {
  if (item.kind === "system_issue") return "is-issue";
  if (/\btrade won\b/i.test(item.title)) return "is-positive";
  if (/\btrade lost\b/i.test(item.title)) return "is-negative";
  if (item.kind === "paper_closed" || /\btrade closed\b/i.test(item.title)) {
    const result = item.message.match(/(?:^|\s)([+−-]\d+(?:\.\d+)?)R\b/);
    const value = result ? Number(result[1].replace("−", "-")) : 0;
    if (value > 0) return "is-positive";
    if (value < 0) return "is-negative";
    // A breakeven or unspecified close is not a win or a loss.
    return "";
  }
  if (/\b(?:failed|needs attention|error)\b/i.test(item.title)) return "is-issue";
  if (item.kind === "news_reminder" || /\b(?:expired|invalidated)\b/i.test(item.title)
    || /\bno stop(?: or target)?\b|\bclose it yourself\b/i.test(item.message)) return "is-warning";
  return "is-info";
}

export function sampleToastNotification(): AppNotification {
  return {
    id: `preview-${Date.now()}`,
    kind: "setup_ready",
    title: "EUR/USD setup ready",
    message: "Long plan is valid. Entry, target, and stop are available on Charts.",
    instrument: "EUR_USD",
    paperTradeId: null,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
}

function isTechnicalNoise(message: string) {
  return TECHNICAL_NOISE.test(message) || /\sat\s+\S+\s+\([^)]*:\d+:\d+\)/.test(message);
}

function humanizeIssueDetail(item: AppNotification, message: string) {
  if (!message) return message;
  if (!isTechnicalNoise(message)) return message;

  const source = `${item.title} ${message}`;
  if (/paper_watch_snapshots|paper collector|collector/i.test(source)) {
    return "The paper collector hit a data error.";
  }
  if (/practice close/i.test(item.title)) {
    return "The broker close failed. The internal trade remains open.";
  }
  return "A background job hit a data error.";
}
