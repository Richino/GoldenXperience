type ImpactCacheStorage<T> = {
  key: string;
  storage: () => Pick<Storage, "getItem" | "setItem">;
  valid: (value: unknown) => value is T;
};

/** Bounded cache for news data, including in-flight reads and optional tab storage. */
export function createImpactCache<T>(limit = 32, persistence?: ImpactCacheStorage<T>) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const pending = new Map<string, Promise<T>>();
  let restored = false;

  function restore() {
    if (restored || !persistence) return;
    restored = true;
    try {
      const saved: unknown = JSON.parse(persistence.storage().getItem(persistence.key) ?? "null");
      if (!Array.isArray(saved)) return;
      for (const entry of saved.slice(-limit)) {
        if (typeof entry?.key === "string" && Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now() && persistence.valid(entry.value)) {
          entries.set(entry.key, { value: entry.value, expiresAt: entry.expiresAt });
        }
      }
    } catch { /* A blocked or invalid store falls back to memory. */ }
  }

  return {
    async load(key: string, read: () => Promise<T>, ttl: (value: T) => number): Promise<T> {
      restore();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const existing = pending.get(key);
      if (existing) return existing;
      const startedAt = Date.now();
      const request = Promise.resolve().then(read).then((value) => {
        entries.delete(key);
        entries.set(key, { value, expiresAt: startedAt + ttl(value) });
        while (entries.size > limit) entries.delete(entries.keys().next().value!);
        if (persistence) {
          const fresh = [...entries].flatMap(([key, entry]) => entry.expiresAt > Date.now() ? [{ key, ...entry }] : []);
          try { persistence.storage().setItem(persistence.key, JSON.stringify(fresh)); }
          catch { /* In-memory caching still works. */ }
        }
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
  };
}
