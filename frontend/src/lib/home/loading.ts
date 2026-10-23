export const HOME_LOADING_SECTIONS = ["news", "weekly"] as const;
export type HomeLoadingState = { sections: Record<string, boolean>; revealed: boolean };

export function initialHomeLoadingState(): HomeLoadingState {
  return { sections: Object.fromEntries(HOME_LOADING_SECTIONS.map(section => [section, false])), revealed: false };
}

/** Once shown, background refreshes never put Home back behind a skeleton. */
export function updateHomeLoading(state: HomeLoadingState, update: { section: string; ready: boolean }): HomeLoadingState {
  // Discovery runs independently inside a reserved card-sized skeleton.
  if (update.section === "trends") return state;
  if (state.revealed || state.sections[update.section] === update.ready) return state;
  const sections = { ...state.sections, [update.section]: update.ready };
  return { sections, revealed: Object.values(sections).every(Boolean) };
}
