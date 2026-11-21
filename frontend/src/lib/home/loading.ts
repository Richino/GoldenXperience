/**
 * Home stays behind its skeleton until every section it shows has settled, so
 * the page appears once, complete, instead of filling in card by card. A
 * failed request counts as settled (its card shows its own error), and
 * HOME_LOADING_CEILING_MS reveals Home regardless if a section never reports.
 * Plans and swing cards are not on Home, so they are not waited on.
 */
export const HOME_LOADING_SECTIONS = ["account", "history", "positions", "journal", "pending", "news"] as const;
export const HOME_LOADING_CEILING_MS = 30_000;
export type HomeLoadingState = { sections: Record<string, boolean>; revealed: boolean };

export function initialHomeLoadingState(): HomeLoadingState {
  return { sections: Object.fromEntries(HOME_LOADING_SECTIONS.map(section => [section, false])), revealed: false };
}

/** Once shown, background refreshes never put Home back behind a skeleton. */
export function updateHomeLoading(state: HomeLoadingState, update: { section: string; ready: boolean } | { ceiling: true }): HomeLoadingState {
  if (state.revealed) return state;
  if ("ceiling" in update) return { ...state, revealed: true };
  // Sections outside the waited-on set load in their own cards.
  if (!(update.section in state.sections)) return state;
  if (state.sections[update.section] === update.ready) return state;
  const sections = { ...state.sections, [update.section]: update.ready };
  return { sections, revealed: Object.values(sections).every(Boolean) };
}
