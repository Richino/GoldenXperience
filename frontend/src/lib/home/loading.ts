/**
 * Only the balance holds Home behind its skeleton. Every other section
 * (positions, orders, activity, news, weekly review, plans) shows its own
 * placeholder and fills in as its request lands, so the slowest request no
 * longer sets the load time on a phone.
 */
export const HOME_LOADING_SECTIONS = ["account"] as const;
export type HomeLoadingState = { sections: Record<string, boolean>; revealed: boolean };

export function initialHomeLoadingState(): HomeLoadingState {
  return { sections: Object.fromEntries(HOME_LOADING_SECTIONS.map(section => [section, false])), revealed: false };
}

/** Once shown, background refreshes never put Home back behind a skeleton. */
export function updateHomeLoading(state: HomeLoadingState, update: { section: string; ready: boolean }): HomeLoadingState {
  // Sections outside the blocking set load in their own cards.
  if (!(update.section in state.sections)) return state;
  if (state.revealed || state.sections[update.section] === update.ready) return state;
  const sections = { ...state.sections, [update.section]: update.ready };
  return { sections, revealed: Object.values(sections).every(Boolean) };
}
