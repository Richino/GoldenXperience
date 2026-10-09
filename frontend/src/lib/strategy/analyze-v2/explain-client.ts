"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import type { AnalysisResult } from "@/lib/strategy/analyze-v2/decide";
import { explanationFacts, validateExplanation, type Explanation } from "@/lib/strategy/analyze-v2/explain";

export type ExplanationState =
  | { status: "loading" }
  | { status: "ready"; explanation: Explanation }
  | { status: "unavailable"; reason: string };

/** One request per analysis result, however often it is shown. */
const requests = new WeakMap<AnalysisResult, Promise<ExplanationState>>();

export function requestExplanation(result: AnalysisResult): Promise<ExplanationState> {
  const cached = requests.get(result);
  if (cached) return cached;
  const facts = explanationFacts(result);
  const request = fetch(apiUrl("/api/analyze/explain"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ facts }),
  })
    .then(async (response) => {
      const payload = (await response.json().catch(() => null)) as { explanation?: unknown; error?: string } | null;
      if (!response.ok || !payload?.explanation) return { status: "unavailable" as const, reason: payload?.error ?? "The explanation service did not answer." };
      // Re-checked here too: the app never shows numbers the engine did not produce.
      const checked = validateExplanation(payload.explanation, facts);
      return checked.ok ? { status: "ready" as const, explanation: checked.explanation } : { status: "unavailable" as const, reason: checked.reason };
    })
    .catch(() => ({ status: "unavailable" as const, reason: "The explanation service could not be reached." }));
  requests.set(result, request);
  return request;
}

/** Supply a known explanation state for a result (previews and tests); no request is made. */
export function primeExplanation(result: AnalysisResult, state: ExplanationState) {
  requests.set(result, Promise.resolve(state));
}

/** The explanation for a V2 result; null when there is no V2 result. */
export function useExplanation(result: AnalysisResult | null | undefined): ExplanationState | null {
  const [state, setState] = useState<{ result: AnalysisResult; value: ExplanationState } | null>(null);
  useEffect(() => {
    if (!result) return;
    let active = true;
    void requestExplanation(result).then((value) => {
      if (active) setState({ result, value });
    });
    return () => {
      active = false;
    };
  }, [result]);
  if (!result) return null;
  return state && state.result === result ? state.value : { status: "loading" };
}
