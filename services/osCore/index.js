const CoreCache = require("./cache");
const CoreMetrics = require("./metrics");
const TaskQueue = require("./queue");
const RealtimeHub = require("./realtime");

function createOSCore({ io, config = {} } = {}) {
  const metrics = new CoreMetrics();

  const cache = new CoreCache({
    defaultTtlMs: Number(config.cacheTtlMs || process.env.CORE_CACHE_TTL_MS || 30000),
    maxEntries: Number(config.cacheMaxEntries || process.env.CORE_CACHE_MAX_ENTRIES || 5000),
    metrics,
  });

  const notionQueue = new TaskQueue({
    name: "notion",
    concurrency: Number(
      config.notionConcurrency ||
      process.env.CORE_NOTION_CONCURRENCY ||
      1
    ),
    minDelayMs: Number(
      config.notionMinDelayMs ||
      process.env.CORE_NOTION_MIN_DELAY_MS ||
      400
    ),
    maxQueueSize: Number(
      config.notionMaxQueueSize ||
      process.env.CORE_NOTION_MAX_QUEUE_SIZE ||
      5000
    ),
    metrics,
  });

  const realtime = new RealtimeHub({ io, metrics });
  realtime.bind();

  const cleanupTimer = setInterval(() => {
    cache.cleanup();
  }, 60000);

  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }

  return {
    version: "2.1.1-step2-cache-stable",
    mode: "read-cache",
    cache,
    metrics,
    notionQueue,
    realtime,

    status() {
      return {
        ok: true,
        version: this.version,
        mode: this.mode,
        timestamp: new Date().toISOString(),
        memory: {
          rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
          heapUsedMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)),
          heapTotalMb: Number((process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)),
        },
        cache: cache.stats(),
        notionQueue: notionQueue.stats(),
        realtime: realtime.stats(),
        metrics: metrics.snapshot(),
      };
    },
  };
}

module.exports = {
  createOSCore,
  CoreCache,
  CoreMetrics,
  TaskQueue,
  RealtimeHub,
};
