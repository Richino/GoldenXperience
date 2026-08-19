import type { AppNotification } from "@/lib/notifications/types";

const TECHNICAL_NOISE =
  /insert or update on table|violates\s+(?:foreign key |unique |check |exclusion )?constraint|duplicate key value|relation "[^"]+" does not exist|column "[^"]+" (?:of relation|does not exist)|null value in column|invalid input syntax|permission denied for (?:table|relation|schema)|deadlock detected|could not serialize|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|password authentication failed/i;

export function notificationHref(item: AppNotification) {
  return item.instrument ? `/signals?instrument=${item.instrument}` : "/watchlist";
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
    .replace(/\s*Entry, target, and stop are available on Signals\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (item.kind === "system_issue") return humanizeIssueDetail(item, cleaned);
  return cleaned;
}

export function detailTone(item: AppNotification) {
  if (item.kind === "system_issue") return "is-issue";
  if (/[+][\d.]+R/.test(item.message)) return "is-positive";
  if (/[-−][\d.]+R/.test(item.message)) return "is-negative";
  return "";
}

export function sampleToastNotification(): AppNotification {
  return {
    id: `preview-${Date.now()}`,
    kind: "setup_ready",
    title: "EUR/USD setup ready",
    message: "Long plan is valid. Entry, target, and stop are available on Signals.",
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
