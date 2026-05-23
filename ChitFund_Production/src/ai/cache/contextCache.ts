interface Entry<T> {
  value: T;
  expiresAt: number;
}

class ContextCache {
  private store = new Map<string, Entry<unknown>>();
  // Set after each getOrFetch call — lets callers count cache hits
  lastWasHit = false;

  constructor(private ttlMs: number = 30_000) {}

  async getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const entry = this.store.get(key) as Entry<T> | undefined;
    if (entry && Date.now() < entry.expiresAt) {
      this.lastWasHit = true;
      return entry.value;
    }
    this.lastWasHit = false;
    const value = await fetcher();
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  // Useful after a write operation — invalidate all keys for a group/cycle
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// Module-level singleton — shared across all nodes in a request lifecycle
export const contextCache = new ContextCache(30_000);
