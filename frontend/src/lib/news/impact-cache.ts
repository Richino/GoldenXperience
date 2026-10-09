/** A bounded cache owned by one mounted news sheet, including in-flight reads. */
export function createImpactCache<T>(limit = 32) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const pending = new Map<string, Promise<T>>();
  return {
    async load(key: string, read: () => Promise<T>, ttl: (value: T) => number): Promise<T> {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const existing = pending.get(key);
      if (existing) return existing;
      const startedAt = Date.now();
      const request = Promise.resolve().then(read).then((value) => {
        entries.delete(key);
        entries.set(key, { value, expiresAt: startedAt + ttl(value) });
        while (entries.size > limit) entries.delete(entries.keys().next().value!);
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
  };
}
