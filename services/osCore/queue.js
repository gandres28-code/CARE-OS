class TaskQueue {
  constructor({
    name = "default",
    concurrency = 1,
    minDelayMs = 0,
    maxQueueSize = 5000,
    metrics = null,
  } = {}) {
    this.name = name;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.minDelayMs = Math.max(0, Number(minDelayMs) || 0);
    this.maxQueueSize = Math.max(1, Number(maxQueueSize) || 5000);
    this.metrics = metrics;

    this.pending = [];
    this.active = 0;
    this.lastStartedAt = 0;
    this.paused = false;
    this.sequence = 0;
  }

  _metric(name, amount = 1) {
    if (this.metrics?.increment) {
      this.metrics.increment(`queue.${this.name}.${name}`, amount);
    }
  }

  add(task, metadata = {}) {
    if (typeof task !== "function") {
      return Promise.reject(new TypeError("Queue task must be a function"));
    }

    if (this.pending.length >= this.maxQueueSize) {
      const error = new Error(`Queue ${this.name} is full`);
      error.code = "QUEUE_FULL";
      this._metric("rejected");
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      this.pending.push({
        id: ++this.sequence,
        task,
        metadata,
        queuedAt: Date.now(),
        resolve,
        reject,
      });

      this._metric("added");
      this._drain();
    });
  }

  async _waitForDelay() {
    const elapsed = Date.now() - this.lastStartedAt;
    const waitMs = Math.max(0, this.minDelayMs - elapsed);

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  _drain() {
    if (this.paused) return;

    while (this.active < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      this.active += 1;
      this._run(item);
    }
  }

  async _run(item) {
    const startedAt = Date.now();

    try {
      await this._waitForDelay();
      this.lastStartedAt = Date.now();
      this._metric("started");

      if (this.metrics?.timing) {
        this.metrics.timing(
          `queue.${this.name}.waitMs`,
          this.lastStartedAt - item.queuedAt
        );
      }

      const result = await item.task();
      item.resolve(result);
      this._metric("completed");
    } catch (error) {
      item.reject(error);
      this._metric("failed");

      if (this.metrics?.recordError) {
        this.metrics.recordError(`queue.${this.name}`, error);
      }
    } finally {
      if (this.metrics?.timing) {
        this.metrics.timing(
          `queue.${this.name}.taskMs`,
          Date.now() - startedAt
        );
      }

      this.active -= 1;
      queueMicrotask(() => this._drain());
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this._drain();
  }

  clear(reason = "Queue cleared") {
    const error = new Error(reason);
    error.code = "QUEUE_CLEARED";

    while (this.pending.length) {
      const item = this.pending.shift();
      item.reject(error);
    }
  }

  stats() {
    return {
      name: this.name,
      pending: this.pending.length,
      active: this.active,
      concurrency: this.concurrency,
      minDelayMs: this.minDelayMs,
      maxQueueSize: this.maxQueueSize,
      paused: this.paused,
    };
  }
}

module.exports = TaskQueue;
