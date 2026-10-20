import { currenciesOf } from "@/lib/instruments/catalog";
import type { NewsRelease, NewsReleaseMember } from "@/lib/news/news-straddle-v3";

export type TimedNewsEvent = NewsReleaseMember & { timestamp: string; impact: number; timingVerified?: boolean };
const key = (e: NewsReleaseMember) => `${e.currency}|${e.title}|${e.id}`;
const compare = (a: NewsReleaseMember, b: NewsReleaseMember) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
export function isNewsRelease(instrument: string, e: TimedNewsEvent) {
  const { base, quote } = currenciesOf(instrument);
  return [base, quote].includes(e.currency) && e.impact >= 3 && e.timingVerified === true
    && Number.isFinite(Date.parse(e.timestamp)) && !/tentative|all.day|summit|speaks|speech|meeting day/i.test(e.title);
}
export function newsEventsAtTime(instrument: string, events: TimedNewsEvent[], time: string): NewsReleaseMember[] {
  const members = events.filter(e => isNewsRelease(instrument, e) && Date.parse(e.timestamp) === Date.parse(time));
  return [...new Map(members.map(e => [key(e), { id: e.id, title: e.title, currency: e.currency }])).values()].sort(compare);
}
export function sameNewsMembers(a: NewsReleaseMember[], b: NewsReleaseMember[]) {
  const sorted = [...b].sort(compare);
  return a.length === sorted.length && [...a].sort(compare).every((e, i) => key(e) === key(sorted[i]!));
}
export function nextNewsReleaseGroup(instrument: string, events: TimedNewsEvent[], now: number) {
  const next = events.filter(e => isNewsRelease(instrument, e) && Date.parse(e.timestamp) > now + 15_000)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || compare(a, b))[0];
  if (!next) return null;
  const members = newsEventsAtTime(instrument, events, next.timestamp);
  return { ...members[0]!, timestamp: next.timestamp, events: members };
}
export function newsReleaseStillMatches(instrument: string, release: NewsRelease, events: TimedNewsEvent[]) {
  // Already-armed older runs keep their original single-event validation.
  if (!release.events) return events.some(e => isNewsRelease(instrument, e) && e.id === release.id && e.title === release.title && e.currency === release.currency && Date.parse(e.timestamp) === Date.parse(release.time));
  return release.events.length > 0 && sameNewsMembers(release.events, newsEventsAtTime(instrument, events, release.time));
}
