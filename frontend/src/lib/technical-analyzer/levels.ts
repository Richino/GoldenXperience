import type { Forecast, LevelRisk, Zone } from "./types";

// Initial evidence thresholds, not calibrated probabilities of a level holding.
export const ZONE_RULES = Object.freeze({ majorReactions: 3, majorRejectionAtr: .25, nearbyAtr: .6 });

export function zoneGrade(z: Zone): "MAJOR" | "DEVELOPING" | "MINOR" {
  if (z.frame !== "H1" && z.reactions >= ZONE_RULES.majorReactions && z.quality >= ZONE_RULES.majorRejectionAtr) return "MAJOR";
  return z.reactions >= 2 ? "DEVELOPING" : "MINOR";
}

export function assessLevelRisk(zones: Zone[], reference: number, primaryAtr: number, direction: -1 | 0 | 1): LevelRisk {
  if (!direction) return { severity: "NONE", zone: null, distanceAtr: null, explanation: "Direction unresolved; no directional level-risk assessment." };
  const candidates = zones.filter(z => z.frame !== "H1" && z.role === (direction < 0 ? "support" : "resistance")
    && (direction < 0 ? z.low <= reference : z.high >= reference))
    .map(zone => ({ zone, distanceAtr: Math.max(zone.low - reference, reference - zone.high, 0) / primaryAtr }))
    .filter(z => z.distanceAtr <= ZONE_RULES.nearbyAtr)
    .sort((a, b) => Number(zoneGrade(b.zone) === "MAJOR") - Number(zoneGrade(a.zone) === "MAJOR") || a.distanceAtr - b.distanceAtr);
  const nearest = candidates[0];
  if (!nearest) return { severity: "NONE", zone: null, distanceAtr: null, explanation: `No nearby opposing H4/D1/W1 zone detected within ${ZONE_RULES.nearbyAtr} primary-frame ATR.` };
  const major = zoneGrade(nearest.zone) === "MAJOR";
  return { severity: major ? "HIGH" : "CAUTION", ...nearest,
    explanation: `${major ? "Major" : zoneGrade(nearest.zone) === "DEVELOPING" ? "Developing" : "Minor"} ${nearest.zone.frame} ${nearest.zone.role} may obstruct continuation. ${nearest.zone.reactions} observed reactions; mean rejection ${nearest.zone.quality.toFixed(2)} ATR. Level risk qualifies the directional bias; it does not cancel it.` };
}

/** Shared UI/export wording; old reports retain their original decision semantics. */
export function levelRiskLabel(f: Forecast): string {
  if (f.bias === "UNAVAILABLE") return "Level risk unavailable";
  if (!f.levelRisk) return f.groups.location === "opposing major zone" ? "Legacy level conflict" : "Legacy level assessment";
  if (!f.levelRisk.zone) return f.groups.trend === 0 ? "Direction unresolved" : "No nearby opposing level";
  return `${f.levelRisk.severity === "HIGH" ? "Major" : "Nearby"} ${f.levelRisk.zone.role} · caution`;
}
