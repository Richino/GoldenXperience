"use client";

/**
 * Analyze V2 result inside the Analyze card (desktop) and sheet (phone):
 *
 *   A  decision header and its one-line reason
 *   C  trade plan, only for LONG / SHORT
 *   F  for NO TRADE: what failed, and what to watch for (never an entry)
 *      the 13-check list (PASS / CAUTION / FAIL / UNKNOWN)
 *   B  market structure  ·  D  market risk  ·  liquidity   (collapsible)
 *   E  AI explanation (rendered by the caller)
 *
 * Every number comes from the deterministic result; nothing here computes a
 * level. Unknown data is shown as unknown, never as fine.
 */

import { Activity, Droplets, Eye, Hourglass, ListChecks, ShieldAlert } from "lucide-react";
import { formatChartPrice } from "@/lib/chart-utils";
import type { CheckStatus } from "@/lib/strategy/analyze-v2/data-quality";
import type { AnalysisResult, DecisionCheck } from "@/lib/strategy/analyze-v2/decide";
import type { LiquidityLevel } from "@/lib/strategy/analyze-v2/liquidity";
import type { PullbackState } from "@/lib/strategy/analyze-v2/pullback";
import type { TrendDirection } from "@/lib/strategy/analyze-v2/structure";
import type { SrZone } from "@/lib/strategy/analyze-v2/zones";

const TREND: Record<TrendDirection, string> = {
  UPTREND: "Uptrend",
  DOWNTREND: "Downtrend",
  RANGE: "Range",
  TRANSITION: "Transition (structure broke)",
  UNCLEAR: "Unclear",
};

const PULLBACK: Record<PullbackState, string> = {
  NOT_APPLICABLE: "No trend to pull back in",
  NO_PULLBACK: "No pullback yet",
  DEVELOPING: "Pulling back, zone not reached",
  AT_ZONE: "At a zone, waiting for confirmation",
  TRIGGERED: "Confirmed turn at a zone",
  EXPIRED: "Confirmed, but the entry has passed",
  INVALIDATED: "Structure broke",
};

const STATUS_WORD: Record<CheckStatus, string> = { PASS: "Pass", CAUTION: "Caution", FAIL: "Fail", UNKNOWN: "Unknown" };
const STATUS_MARK: Record<CheckStatus, string> = { PASS: "✓", CAUTION: "!", FAIL: "✕", UNKNOWN: "?" };

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const etTime = (iso: string | null) => (iso ? `${ET.format(new Date(iso))} ET` : "Unknown");

function StatusChip({ status, label }: { status: CheckStatus; label?: string }) {
  return (
    <span className={`nl-v2-chip is-${status.toLowerCase()}`}>
      <span aria-hidden="true">{STATUS_MARK[status]}</span>
      {label ?? STATUS_WORD[status]}
    </span>
  );
}

function Section({ title, icon, preview, status, extra, children, className = "" }: {
  title: string;
  icon: React.ReactNode;
  /** One line shown while collapsed, so the section informs without opening. */
  preview?: string;
  status?: CheckStatus;
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={`nl-v2-section ${className}`}>
      <summary>
        <span className="nl-v2-sum-icon" aria-hidden="true">{icon}</span>
        <span className="nl-v2-sum-text">
          <b>{title}</b>
          {preview ? <small>{preview}</small> : null}
        </span>
        {extra ?? (status ? <StatusChip status={status} /> : null)}
      </summary>
      <div className="nl-v2-section-body">{children}</div>
    </details>
  );
}

function Rows({ rows }: { rows: Array<[string, React.ReactNode] | null | false> }) {
  return (
    <dl className="nl-an-rows nl-v2-rows">
      {rows.filter((row): row is [string, React.ReactNode] => Boolean(row)).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Capitalise the first letter, as the start of its own sentence. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const worst = (statuses: CheckStatus[]): CheckStatus =>
  statuses.includes("FAIL") ? "FAIL" : statuses.includes("UNKNOWN") ? "UNKNOWN" : statuses.includes("CAUTION") ? "CAUTION" : "PASS";

export function AnalyzeV2Content({ result, titleId }: { result: AnalysisResult; titleId: string }) {
  const instrument = result.pair;
  const price = (value: number | null | undefined) => (typeof value === "number" ? formatChartPrice(value, instrument) : "—");
  const plan = result.execution;
  const structure = result.marketStructure;
  const check = (id: DecisionCheck["id"]) => result.checks.find((item) => item.id === id)!;
  const evaluated = result.checks.filter((item) => item.evaluated);
  const counts = (["PASS", "CAUTION", "FAIL", "UNKNOWN"] as const)
    .map((status) => [status, evaluated.filter((item) => item.status === status).length] as const)
    .filter(([, count]) => count > 0);
  const blockers = evaluated.filter((item) => item.status === "FAIL" || item.status === "UNKNOWN");
  const tone = result.decision === "LONG" ? "is-up" : result.decision === "SHORT" ? "is-down" : "";
  const heading = result.decision === "LONG" ? "Long" : result.decision === "SHORT" ? "Short" : "No trade";
  const subline = result.decision === "LONG" ? "Bullish setup qualified" : result.decision === "SHORT" ? "Bearish setup qualified" : "No actionable setup";
  const reference = result.foundation.referencePrice;
  const zones = result.foundation.zones;
  const nearestZone = (side: "below" | "above"): SrZone | null =>
    reference === null ? null : zones
      .filter((zone) => (zone.status === "ACTIVE" || zone.flipped) && (side === "below" ? zone.high < reference : zone.low > reference))
      .sort((a, b) => (side === "below" ? b.high - a.high : a.low - b.low))[0] ?? null;
  const zoneText = (zone: SrZone | null) =>
    zone ? `${price(zone.low)}–${price(zone.high)} · ${zone.relevance === "STRUCTURAL" ? "structural" : zone.relevance === "HIGHER_TF" ? "higher TF" : "minor"}${zone.flipped ? ", role reversed" : ""}` : "None near";
  const quote = result.foundation.data.quote;
  const quoteAge = quote.executable ? `${Math.max(0, Math.round(quote.executable.ageMs / 1000))}s old at analysis` : quote.reason;
  const dataProblems = result.foundation.data.checks.filter((item) => item.status !== "PASS" && item.id !== "quote");
  const liquidity = result.liquidity.assessment;
  const levelText = (item: { level: LiquidityLevel; distancePips: number } | null) =>
    item ? `${item.level.labels.join(" / ")} ${price(item.level.price)} · ${item.level.status.toLowerCase().replace(/_/g, " ")} · ${item.distancePips.toFixed(1)} pips` : "None near";
  const liquidityStatus: CheckStatus | undefined = check("liquidity").evaluated ? check("liquidity").status : undefined;
  const passed = evaluated.filter((item) => item.status === "PASS").length;
  const cautions = evaluated.filter((item) => item.status === "CAUTION").length;
  const skipped = result.checks.length - evaluated.length;
  const meterText = [
    `${passed} passed`,
    cautions ? `${cautions} caution` : null,
    blockers.length ? `${blockers.length} blocking` : null,
    skipped ? `${skipped} not reached` : null,
  ].filter(Boolean).join(" · ");
  const lower = (text: string | null) => (text ? text.toLowerCase() : "unknown");
  const structurePreview = `${structure.primaryTimeframe} ${lower(structure.primaryTrend)} · ${structure.higherTimeframe} ${lower(structure.higherTimeframeTrend)}`;
  const newsWord = result.news.state === "NEWS_UNKNOWN" ? "unknown" : result.news.state === "CLEAR" ? "clear" : result.news.state === "BLOCKED" ? "blocked" : "caution";
  const riskPreview = `News ${newsWord} · ${quote.executable ? `${quote.executable.spreadPips.toFixed(1)}p spread` : "no live quote"}`;
  const short = (item: { level: LiquidityLevel; distancePips: number } | null) => (item ? `${item.level.labels[0]} ${item.distancePips.toFixed(1)}p` : "none");
  const liquidityPreview = `↑ ${short(liquidity.nearestAbove)} · ↓ ${short(liquidity.nearestBelow)}`;

  return (
    <>
      {/* A — decision */}
      <div className="nl-v2-hero">
        <div className="nl-an-head">
          <h2 id={titleId} className={`nl-an-decision ${tone}`}>{heading}</h2>
          {plan ? <span className="nl-an-ratio">1:{plan.rewardRisk.toFixed(1)}</span> : null}
        </div>
        <p className="nl-v2-headline">
          <b className={tone}>{subline}.</b>{" "}
          {plan
            ? sentence(result.headline.replace(/^(Bullish|Bearish) pullback qualified: /, ""))
            : `${blockers.length} ${blockers.length === 1 ? "check is" : "checks are"} blocking a trade.`}
        </p>
        <div className="nl-v2-meter" role="img" aria-label={meterText}>
          {result.checks.map((item) => (
            <span key={item.id} className={item.evaluated ? `is-${item.status.toLowerCase()}` : "is-skipped"} title={`${item.label}: ${item.evaluated ? STATUS_WORD[item.status] : "not reached"}`} />
          ))}
        </div>
      </div>

      {/* C — trade plan (LONG / SHORT only) */}
      {plan ? (
        <>
          <dl className="nl-an-levels">
            <div>
              <dt>{plan.side === "LONG" ? "Buy at ask" : "Sell at bid"}</dt>
              <dd className="metric-number">{price(plan.entry)}</dd>
            </div>
            <div>
              <dt>Stop</dt>
              <dd className="metric-number is-down">{price(plan.stop)}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd className="metric-number is-up">{price(plan.target)}</dd>
            </div>
          </dl>
          <Rows
            rows={[
              ["Stop distance", <span key="s" className="metric-number">{plan.stopPips.toFixed(1)} pips</span>],
              ["Target distance", <span key="t" className="metric-number">{plan.targetPips.toFixed(1)} pips</span>],
              ["Reward/risk", <span key="r" className="metric-number">{plan.rewardRisk.toFixed(2)}R after spread</span>],
              ["Spread", <span key="p" className="metric-number">{plan.spreadPips.toFixed(1)} pips · {Math.round(plan.spreadShare * 100)}% of risk</span>],
              ["Order lifetime", `${plan.orderLifetimeHours}h, then it cancels`],
            ]}
          />
          <div className="nl-an-notes">
            <p><span>Invalidation · </span>{result.invalidation}</p>
            <p><span>Stop · </span>{plan.stopBasis}.</p>
            <p><span>Target · </span>{plan.targetBasis}.</p>
            {result.warnings.length ? (
              <ul className="is-caution" role="alert">
                {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}
          </div>
        </>
      ) : (
        /* F — no trade: what failed, and what would have to happen */
        <div className="nl-v2-why">
          <span className="nl-v2-label">Why not</span>
          <ul>
            {blockers.slice(0, 4).map((item) => (
              <li key={item.id} className="nl-v2-why-item">
                <span className={`nl-v2-why-icon is-${item.status.toLowerCase()}`} aria-hidden="true">{STATUS_MARK[item.status]}</span>
                <span className="nl-v2-why-copy">
                  <b>{item.label}</b>
                  <span>{item.reason}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className={`nl-v2-watch${result.watch ? "" : " is-empty"}`}>
            <span className="nl-v2-watch-icon" aria-hidden="true">{result.watch ? <Eye /> : <Hourglass />}</span>
            <p>
              <b>{result.watch ? "Watch for" : "Nothing to watch yet"}</b>
              <span>{result.watch?.condition ?? "The setup is missing more than a pullback or a confirmation."}</span>
            </p>
          </div>
        </div>
      )}

      {/* The full checklist */}
      <Section
        className="nl-v2-checks"
        title="Checks"
        icon={<ListChecks />}
        preview={`${result.checks.length} rules · ${meterText}`}
        extra={
          <span className="nl-v2-counts">
            {counts.map(([status, count]) => (
              <StatusChip key={status} status={status} label={`${count}`} />
            ))}
          </span>
        }
      >
        <ul>
          {result.checks.map((item) => (
            <li key={item.id} className={item.evaluated ? "" : "is-skipped"}>
              {item.evaluated ? <StatusChip status={item.status} /> : <span className="nl-v2-chip is-skipped">—</span>}
              <span>
                <b>{item.label}</b> {item.evaluated ? item.reason : item.reason.replace(/^Not evaluated: /, "Not reached: ")}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      {/* B — market structure */}
      <Section title="Market structure" icon={<Activity />} preview={structurePreview} status={worst([check("structure").status, ...(check("higher").evaluated ? [check("higher").status] : [])])}>
        <Rows
          rows={[
            [`${structure.primaryTimeframe} trend`, TREND[structure.primaryTrend]],
            [`${structure.higherTimeframe} trend`, structure.higherTimeframeTrend ? TREND[structure.higherTimeframeTrend] : "Unknown"],
            ["Alignment", structure.alignmentText],
            ["Last swing high", <span key="h" className="metric-number">{price(structure.lastSwingHigh)}</span>],
            ["Last swing low", <span key="l" className="metric-number">{price(structure.lastSwingLow)}</span>],
            structure.structureLevel !== null && [
              structure.primaryTrend === "UPTREND" ? "Higher low (holds trend)" : "Lower high (holds trend)",
              <span key="s" className="metric-number">{price(structure.structureLevel)}</span>,
            ],
            ["Support below", zoneText(nearestZone("below"))],
            ["Resistance above", zoneText(nearestZone("above"))],
            ["Pullback", `${PULLBACK[result.setup.status]}${result.setup.zoneLow !== null ? ` · ${price(result.setup.zoneLow)}–${price(result.setup.zoneHigh)}` : ""}${result.setup.depth !== null ? ` · ${Math.round(result.setup.depth * 100)}% of the leg` : ""}`],
          ]}
        />
        {structure.evidence.length ? <p className="nl-v2-small">{structure.evidence.join(" · ")}</p> : null}
      </Section>

      {/* D — market risk */}
      <Section title="Market risk" icon={<ShieldAlert />} preview={riskPreview} status={worst([check("news-volatility").status, check("data").status])}>
        <Rows
          rows={[
            ["News", result.news.state === "NEWS_UNKNOWN" ? "Unknown: calendar unavailable" : result.news.state === "CLEAR" ? "Clear" : result.news.state === "BLOCKED" ? "Blocked" : "Caution"],
            ["Volatility", result.volatility.reason],
            ["Spread", quote.executable ? `${quote.executable.spreadPips.toFixed(1)} pips` : "Unknown: no live quote"],
            ["Last candle", etTime(result.marketDataTimestamp)],
            ["Quote", quoteAge],
          ]}
        />
        <p className="nl-v2-small">{result.news.reason}</p>
        {result.news.events.length ? (
          <ul className="nl-v2-events">
            {result.news.events.slice(0, 4).map((event) => (
              <li key={`${event.currency}-${event.title}-${event.at}`} className={event.blocking ? "is-blocking" : ""}>
                <span className="metric-number">{etTime(event.at)}</span>
                <span>{event.currency} {event.title}{event.impact >= 3 ? " · high" : " · medium"}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {dataProblems.length ? (
          <ul className="nl-v2-events">
            {dataProblems.map((item) => <li key={item.id}><StatusChip status={item.status} /> <span>{item.reason}</span></li>)}
          </ul>
        ) : null}
        {!plan && result.warnings.length ? <p className="nl-v2-small is-caution">{result.warnings.join(" ")}</p> : null}
      </Section>

      {/* Liquidity */}
      <Section title="Liquidity" icon={<Droplets />} preview={liquidityPreview} status={liquidityStatus}>
        <Rows
          rows={[
            ["Above", levelText(liquidity.nearestAbove)],
            ["Below", levelText(liquidity.nearestBelow)],
            plan && ["Stop exposed", liquidity.stopExposed ? "Yes, see below" : "No identifiable level"],
          ]}
        />
        {liquidity.confirmation ? <p className="nl-v2-small">{liquidity.confirmation}</p> : null}
        <p className="nl-v2-small">{liquidity.findings.join(" ")}</p>
        <p className="nl-v2-small is-muted">Levels are price-action references; candle data cannot show where stop orders sit.</p>
      </Section>
    </>
  );
}
