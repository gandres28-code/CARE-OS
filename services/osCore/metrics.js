class CoreMetrics {
  constructor() {
    this.startedAt = Date.now();
    this.counters = new Map();
    this.timings = new Map();
    this.gauges = new Map();
    this.errors = [];
  }

  increment(name, amount = 1) {
    const current = Number(this.counters.get(name) || 0);
    this.counters.set(name, current + Number(amount || 0));
  }

  gauge(name, value) {
    this.gauges.set(name, Number(value || 0));
  }

  timing(name, durationMs) {
    const value = Math.max(0, Number(durationMs || 0));
    const current = this.timings.get(name) || {
      count: 0,
      totalMs: 0,
      minMs: null,
      maxMs: 0,
      lastMs: 0,
    };

    current.count += 1;
    current.totalMs += value;
    current.minMs = current.minMs === null ? value : Math.min(current.minMs, value);
    current.maxMs = Math.max(current.maxMs, value);
    current.lastMs = value;

    this.timings.set(name, current);
  }

  async measure(name, fn) {
    const started = Date.now();

    try {
      return await fn();
    } finally {
      this.timing(name, Date.now() - started);
    }
  }

  recordError(scope, error) {
    this.increment(`errors.${scope}`);

    this.errors.unshift({
      scope,
      message: error?.message || String(error || "Unknown error"),
      code: error?.code || "",
      status: error?.status || "",
      at: new Date().toISOString(),
    });

    if (this.errors.length > 50) {
      this.errors.length = 50;
    }
  }

  snapshot() {
    const timings = {};

    for (const [name, value] of this.timings.entries()) {
      timings[name] = {
        ...value,
        averageMs: value.count
          ? Number((value.totalMs / value.count).toFixed(2))
          : 0,
      };
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      timings,
      recentErrors: this.errors,
    };
  }
}

module.exports = CoreMetrics;
