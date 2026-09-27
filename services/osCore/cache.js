class CoreCache {
  constructor({ defaultTtlMs = 30000, maxEntries = 5000, metrics = null } = {}) {
    this.defaultTtlMs = Number(defaultTtlMs) || 30000;
    this.maxEntries = Number(maxEntries) || 5000;
    this.metrics = metrics;
    this.store = new Map();
    this.inFlight = new Map();
  }

  _now() {
    return Date.now();
  }

  _record(name, amount = 1) {
    if (this.metrics && typeof this.metrics.increment === "function") {
      this.metrics.increment(name, amount);
    }
  }

  _isExpired(entry) {
    return !entry || entry.expiresAt <= this._now();
  }

  _trim() {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
      this._record("cache.evictions");
    }
  }

  get(key) {
    const entry = this.store.get(key);

    if (!entry) {
      this._record("cache.misses");
      return null;
    }

    if (this._isExpired(entry)) {
      this.store.delete(key);
      this._record("cache.expired");
      this._record("cache.misses");
      return null;
    }

    this._record("cache.hits");
    entry.lastAccessedAt = this._now();
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs, tags = []) {
    const now = this._now();

    this.store.set(key, {
      value,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      expiresAt: now + Math.max(1, Number(ttlMs) || this.defaultTtlMs),
      tags: Array.isArray(tags) ? [...new Set(tags.map(String))] : [],
    });

    this._record("cache.sets");
    this._trim();
    return value;
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    const deleted = this.store.delete(key);
    if (deleted) this._record("cache.deletes");
    return deleted;
  }

  clear() {
    const size = this.store.size;
    this.store.clear();
    this.inFlight.clear();
    this._record("cache.clears");
    return size;
  }

  invalidateTag(tag) {
    const normalizedTag = String(tag);
    let removed = 0;

    for (const [key, entry] of this.store.entries()) {
      if (entry.tags?.includes(normalizedTag)) {
        this.store.delete(key);
        removed += 1;
      }
    }

    if (removed) this._record("cache.tagInvalidations", removed);
    return removed;
  }

  async remember(key, ttlMs, loader, tags = []) {
    const cached = this.get(key);
    if (cached !== null) return cached;

    if (this.inFlight.has(key)) {
      this._record("cache.singleFlightJoins");
      return this.inFlight.get(key);
    }

    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        this.set(key, value, ttlMs, tags);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  cleanup() {
    let removed = 0;

    for (const [key, entry] of this.store.entries()) {
      if (this._isExpired(entry)) {
        this.store.delete(key);
        removed += 1;
      }
    }

    if (removed) this._record("cache.cleanupRemoved", removed);
    return removed;
  }

  stats() {
    const now = this._now();
    let expired = 0;

    for (const entry of this.store.values()) {
      if (entry.expiresAt <= now) expired += 1;
    }

    return {
      entries: this.store.size,
      inFlight: this.inFlight.size,
      expiredPendingCleanup: expired,
      defaultTtlMs: this.defaultTtlMs,
      maxEntries: this.maxEntries,
    };
  }
}

module.exports = CoreCache;
