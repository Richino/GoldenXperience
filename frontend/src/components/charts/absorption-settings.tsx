"use client";
import { ABSORPTION_DEFAULTS, ABSORPTION_RANGES, type AbsorptionSettings } from "@/lib/indicators/absorption";
import { updateAbsorptionSettings, useAbsorptionSettings } from "@/lib/indicators/absorption-settings";
import styles from "./absorption.module.css";
const LABELS: Record<keyof AbsorptionSettings, string> = {
  relativeVolume: "Relative tick activity", volumeLookback: "Volume lookback", structureLookback: "Structure lookback", wickRatio: "Minimum wick ratio", bodyRatio: "Maximum body ratio",
  minimumScore: "Minimum strength", confirmationWindow: "Confirmation candles", minimumRangeAtr: "Minimum range / ATR", structureToleranceAtr: "Structure tolerance / ATR", projection: "Projection candles",
  showBullish: "Bullish zones", showBearish: "Bearish zones", showCandidates: "Candidate markers", showConfirmations: "Confirmation markers", showScores: "Strength scores",
};
export function AbsorptionSettingsPanel() {
  const settings = useAbsorptionSettings();
  return <details className={styles.settings}><summary>GX Absorption settings</summary>
    <p>Price-action and OANDA tick-activity proxy. Strength is not a win probability. ATR uses the previous 14 true ranges. New-bar alerts run while this chart is open; loading history never sends alerts.</p>
    <div className={styles.fields}>{(Object.keys(settings) as Array<keyof AbsorptionSettings>).map(key => {
      const value = settings[key];
      return <label key={key}><span>{LABELS[key]}</span>{typeof value === "boolean"
        ? <input type="checkbox" checked={value} onChange={e => updateAbsorptionSettings({ [key]: e.target.checked })} />
        : <input key={`${key}:${value}`} type="number" inputMode="decimal" aria-label={LABELS[key]} defaultValue={value} min={ABSORPTION_RANGES[key][0]} max={ABSORPTION_RANGES[key][1]} step={ABSORPTION_RANGES[key][2]} onBlur={e => {
          if (!e.target.value) return;
          try { updateAbsorptionSettings({ [key]: Number(e.target.value) }); } catch { e.target.value = String(value); }
        }} />}</label>;
    })}</div>
    <button type="button" onClick={() => updateAbsorptionSettings(ABSORPTION_DEFAULTS)}>Reset absorption settings</button>
  </details>;
}
