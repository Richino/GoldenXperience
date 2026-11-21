/**
 * The last Home data this device loaded, so an app launch can show Home at
 * once and refresh it in the background instead of sitting on a skeleton
 * while the code and every request load. Each section is saved only after a
 * live read succeeds; the hero's "Synced" time comes from the saved snapshot,
 * so cached money is never presented as newer than it is.
 */
const STORAGE_KEY = "gx:home-cache:v1";
/** Older than this, a launch waits for live data rather than show it. */
export const HOME_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

export type HomeCache<Account, Journal, OpenTrade, Pending> = {
  savedAt: number;
  account?: Account;
  journal?: Journal;
  openTrades?: OpenTrade[];
  pending?: Pending[];
};

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function readHomeCache<A, J, O, P>(now = Date.now()): HomeCache<A, J, O, P> | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as HomeCache<A, J, O, P>;
    if (!cache || typeof cache.savedAt !== "number" || cache.savedAt > now || now - cache.savedAt > HOME_CACHE_MAX_AGE_MS) return null;
    return cache;
  } catch { return null; }
}

export function writeHomeCache<A, J, O, P>(patch: Omit<HomeCache<A, J, O, P>, "savedAt">, now = Date.now()) {
  const store = storage();
  if (!store) return;
  try {
    const current = readHomeCache<A, J, O, P>(now) ?? { savedAt: now };
    store.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch, savedAt: now }));
  } catch { /* Storage may be full or blocked; Home still loads live. */ }
}

/** Signing out must not leave the account on the device. */
export function clearHomeCache() {
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
}
