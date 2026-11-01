import type { Frame, Snapshot } from "./types";
import { recordedReadings, technicalSummary } from "./ratings";
import { levelRiskLabel, zoneGrade } from "./levels";
import { continuationRiskLabel, LEAN_RULES, outlookDirection, outlookEvidence } from "./outlook";

export const RESEARCH_PROMPT = `Perform an independent, deep fundamental and financial-news investigation for this forex pair.

Use current, independently verifiable sources.

Research:
1. Recent financial news affecting both currencies.
2. Federal Reserve and relevant foreign central-bank policies.
3. Interest-rate expectations and government bond-yield differentials.
4. Recent economic releases, comparing actual results with forecasts.
5. Broad currency strength and weakness.
6. Stock market sentiment and risk-on/risk-off conditions.
7. Upcoming major economic events during the next 1–5 trading days.
8. The most likely economic explanations for recent price movements.

Cross-reference important claims using credible financial and official economic sources.
Do not automatically agree with GX's technical conclusions.
Identify whether fundamental evidence SUPPORTS, CONTRADICTS, or is INCONCLUSIVE about each technical forecast.
Provide an independent outlook for 1, 2, 3, 4, and 5 trading days.

For each horizon explain:
- Preferred directional thesis
- Strongest supporting evidence
- Strongest opposing evidence
- Key upcoming catalysts
- What would invalidate the thesis

Distinguish verified facts, interpretations, and hypotheses.
Cite relevant sources with dates and timestamps.
Do not manufacture numerical probabilities or treat uncertain news explanations as established facts.
Finish with the most defensible directional assessment and the conditions under which it should change.`;

export function marketReport(s: Snapshot, exportedAt = s.createdAt): string {
  const price = (n: number) => n.toFixed(s.precision);
  return `GX TECHNICAL ANALYZER | ${s.instrument.replace("_", "/")} | ${s.modelVersion}
Report ID: ${s.id}
Source: ${s.source}; midpoint candles; no LLM technical conclusions.
Issued: ${s.createdAt}; market quote: ${s.marketAt} (UTC)
Exported: ${exportedAt} (UTC); quote age at export: ${Math.max(0, (Date.parse(exportedAt) - Date.parse(s.marketAt)) / 60000).toFixed(1)} minutes${s.freshness === "MARKET CLOSED" ? "; market closed, quote age is expected." : Date.parse(exportedAt) - Date.parse(s.marketAt) > 120000 ? "; WARNING: quote is over two minutes old at export; independently refresh current news and prices." : ""}
New York market time: ${new Date(s.marketAt).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" })}
Reference midpoint: ${price(s.referencePrice)}; spread: ${s.spreadPips.toFixed(2)} pips; pip: ${s.pip}
Freshness at original issue: ${s.freshness}; eligible for validation: ${s.eligible}
Warnings: ${s.warnings.join(" | ") || "None detected"}
Outcome definition: OANDA completed D1 midpoint close at the specified future Mon–Fri 17:00 America/New_York boundary compared with this reference midpoint. 1D is the next boundary and may be a partial day. Holidays without an exact candle remain pending.
Rules are unvalidated. Qualitative evidence is not a probability. Directional accuracy is not profitability.

FIVE SEPARATE HORIZONS
${s.forecasts.map(f => `${f.horizon}D | ${f.bias} | ${f.evidence} evidence | expiry ${f.expiresAt}
Directional lean: ${outlookDirection(f)}; ${outlookEvidence(f)} evidence. ${f.lean?.rationale ?? "Original report has no separate directional lean."}
Evidence grading: ${f.lean?.evidenceReasons?.join(" | ") ?? "Original evidence rules apply."}
Continuation risk: ${continuationRiskLabel(f)}. ${f.continuationRisk?.factors.join(" | ") ?? "Original risk rules apply."}
Trend: ${f.trendStrength}; momentum: ${f.momentum}; structure: ${f.structure}; regime: ${f.regime}
Evidence groups: ${JSON.stringify(f.groups)}
Decision: ${f.reasons.join(" ")}
Continuation: ${f.continuation}
Reversal: ${f.reversal}
Invalidation: ${f.invalidation}
Contradictions: ${f.contradictions.join(" | ") || "None detected by configured rules; this is not proof of no contrary evidence."}
Level risk: ${levelRiskLabel(f)}. ${f.levelRisk?.explanation ?? "Original model's recorded location rules apply."}
Volatility envelope: ${price(f.movement.low)}–${price(f.movement.high)} (±${f.movement.pips.toFixed(1)} pips). ${f.movement.method}`).join("\n\n")}

CONFIRMED TIMEFRAME SNAPSHOTS
${Object.values(s.frames).map(f => `${f.frame} | ${f.count} completed candles | final open ${f.lastOpen} | final close boundary ${f.lastCloseAt}
Close ${price(f.close)}; structure ${f.structure}; consolidation ${f.consolidation}; confirmed RSI divergence ${f.divergence ?? "none"}
EMA20 ${price(f.ema20)}; EMA50 ${price(f.ema50)}; EMA200 ${price(f.ema200)}
Five-bar slopes in ATR units: EMA20 ${f.slope20Atr.toFixed(3)}, EMA50 ${f.slope50Atr.toFixed(3)}, EMA200 ${f.slope200Atr.toFixed(3)}
RSI14 ${f.rsi.toFixed(2)}; MACD(12,26,9) ${f.macd.toFixed(7)}; signal ${f.signal.toFixed(7)}; histogram ${f.histogram.toFixed(7)}; histogram acceleration ${f.acceleration.toFixed(7)}
ADX14 ${f.adx.toFixed(2)}; +DI ${f.plusDI.toFixed(2)}; -DI ${f.minusDI.toFixed(2)}; ATR14 ${price(f.atr)}; volatility / trailing 100 ATR mean ${f.volatilityRatio.toFixed(2)}
Recent confirmed swings: ${f.pivots.slice(-10).map(p => `${p.kind} ${price(p.price)} at ${p.time}, confirmed ${p.confirmedAt}`).join(" | ") || "none"}
Structure events (close beyond swing by 0.1 prior ATR; pivots confirmed after 3 right bars): ${f.events.map(e => `${e.kind} ${e.direction} ${price(e.level)} confirmed ${e.at}`).join(" | ") || "none"}
Reaction zones: ${f.zones.map(z => `${z.role} ${price(z.low)}–${price(z.high)}, ${z.reactions} pivot reactions, rejection quality ${z.quality.toFixed(2)} ATR, distance ${z.distancePips.toFixed(1)} pips / ${z.distanceAtr.toFixed(2)} ${f.frame} ATR, broken ${z.brokenAt ?? "no"}, retested ${z.retestedAt ?? "no"}`).join(" | ") || "none detected"}`).join("\n\n")}

INDEPENDENT FUNDAMENTAL RESEARCH REQUEST
${RESEARCH_PROMPT}`;
}

export function conciseMarketReport(s: Snapshot, frame: Frame, exportedAt = s.createdAt): string {
  const f = s.frames[frame], readings = recordedReadings(f), ratings = technicalSummary(readings);
  const price = (v: number) => v.toFixed(s.precision);
  const zones = Object.values(s.frames).filter(f => f.frame !== "H1").flatMap(f => f.zones).sort((a,b) => a.distancePips - b.distancePips).slice(0, 5);
  return `GX TECHNICAL SNAPSHOT — ${s.instrument.replace("_", "/")} | ${s.modelVersion}
Source: ${s.source} completed midpoint candles. Issued ${s.createdAt}; exported ${exportedAt} (UTC).
Last available price ${price(s.referencePrice)} at ${s.marketAt}; spread ${s.spreadPips.toFixed(1)} pips.
Market/quote state at issue: ${s.freshness}. ${s.freshness === "MARKET CLOSED" ? "Market closed; last quote is expected to be old. Technical snapshot uses completed candles." : Date.parse(exportedAt)-Date.parse(s.marketAt)>120000 ? "Live quote is now older than two minutes; refresh before using current prices." : "Quote was fresh at issue."}
Selected indicator timeframe: ${frame}. Latest completed candle ${f.lastCloseAt}; close ${price(f.close)}.
Indicator summary: ${ratings.overall.label} (Sell ${ratings.overall.sell}, Neutral ${ratings.overall.neutral}, Buy ${ratings.overall.buy}).
Oscillators: ${ratings.oscillators.label}; moving averages: ${ratings.averages.label}. Overall rating balances the two groups equally; indicator counts are not forecast confidence.
Readings: ${[...readings.oscillators, ...readings.averages.filter(r => /EMA \((20|50|200)\)/.test(r.name))].map(r => `${r.name} ${r.value.toFixed(r.name.startsWith("EMA") ? s.precision : 4)}${r.extra ? ` (${r.extra})` : ""}: ${r.action}`).join("; ")}.
Structure: ${f.structure}; ADX ${f.adx.toFixed(2)}; RSI ${f.rsi.toFixed(2)}; ATR ${price(f.atr)}.

1–5 TRADING DAY OUTLOOK (independent of indicator votes)
${s.forecasts.map(h => `${h.horizon}D ${outlookDirection(h)} lean | ${outlookEvidence(h)} evidence | ${h.trendStrength}; ${h.momentum}
Strict assessment: ${h.bias}; ${h.evidence} strict evidence. Directional thresholds remain unchanged.
Continuation risk: ${continuationRiskLabel(h)}. ${h.continuationRisk?.factors.slice(0,2).join(" | ") ?? h.levelRisk?.explanation ?? "Original model's recorded location rules apply."}
Location: ${levelRiskLabel(h)}.
Expires ${h.expiresAt}. ${h.lean?.rationale ?? h.reasons.at(-1)}
Continuation: ${h.continuation}
Reversal: ${h.reversal}
Invalidation: ${h.invalidation}
Opposing evidence: ${h.contradictions.slice(0,2).join(" | ") || "None detected by configured rules; predictive skill remains unproven."}`).join("\n\n")}

NEARBY MAJOR ZONES
${zones.map(z => `${z.frame} ${z.role} ${price(z.low)}–${price(z.high)}; ${zoneGrade(z).toLowerCase()}, ${z.reactions} observed reactions, ${z.quality.toFixed(2)} ATR mean rejection; ${z.distancePips.toFixed(1)} pips away; ${z.retestedAt ? "retested" : z.brokenAt ? "broken" : "holding / no confirmed break"}`).join("\n") || "None detected."}
Data quality: ${s.technicalAvailable === false ? "UNAVAILABLE" : "completed-candle snapshot available"}. ${s.warnings.filter(w => !w.startsWith("Expected holiday")).slice(0,3).join(" | ") || "No unexpected data gaps detected."}
Scoring eligible: ${s.eligible}. ${s.scoringReasons?.join(" ") ?? "Original issuance rules apply."}
Directional lean uses the original weighted trend/structure group with a ±${LEAN_RULES.neutralBand} neutral band. Directional evidence can be strong, moderate, mixed or weak; continuation risk is separate. Strong evidence can coexist with high location/pullback risk. Lean and strict outcomes are measured separately on completed, eligible forecasts. Not yet historically validated. No calibrated probabilities. Directional accuracy is not profitability.
Outcome: exact future Mon–Fri 17:00 New York D1 close versus the recorded reference; missing expiry closes remain pending.

${RESEARCH_PROMPT}`;
}

/** Call directly from a click handler so mobile browsers retain user activation. */
export async function copyReport(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* selection fallback */ }
  }
  const area = document.createElement("textarea");
  area.value = text; area.readOnly = true;
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  const previous = document.activeElement;
  document.body.append(area);
  area.focus(); area.select(); area.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* manual fallback in UI */ }
  area.remove();
  if (typeof HTMLElement !== "undefined" && previous instanceof HTMLElement) previous.focus();
  return copied;
}
