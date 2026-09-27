(() => {
  const CACHE_PREFIX = "417maid:cache:";
  const QUEUE_KEY = "417maid:pending-actions:v1";
  const DEFAULT_TIMEOUT = 8000;

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const requestId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  function safeParse(value, fallback) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }

  function saveSnapshot(key, value) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), value }));
    } catch (_) {}
  }

  function loadSnapshot(key, maxAgeMs = 12 * 60 * 60 * 1000) {
    try {
      const record = safeParse(localStorage.getItem(CACHE_PREFIX + key), null);
      if (!record || !record.savedAt || Date.now() - record.savedAt > maxAgeMs) return null;
      return record.value;
    } catch (_) { return null; }
  }

  async function fetchJson(url, options = {}, config = {}) {
    const timeoutMs = Number(config.timeoutMs || DEFAULT_TIMEOUT);
    const retries = Number(config.retries ?? 1);
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: { Accept: "application/json", ...(options.headers || {}) },
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(body.message || body.error || `HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return body;
      } catch (error) {
        lastError = error.name === "AbortError"
          ? new Error("La conexión está tardando más de lo normal")
          : error;
        if (attempt < retries) await wait(350 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("No se pudo conectar");
  }

  function readQueue() {
    const parsed = safeParse(localStorage.getItem(QUEUE_KEY), []);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  }

  function writeQueue(queue) {
    const safeQueue = Array.isArray(queue) ? queue.filter(Boolean) : [];
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(safeQueue.slice(-100)));
    } catch (_) {}
  }

  function queueAction(url, payload) {
    const queue = readQueue();
    const item = {
      id: payload.requestId || payload.eventId || requestId(),
      url,
      payload: { ...payload },
      createdAt: Date.now(),
      attempts: 0,
    };
    item.payload.requestId = item.id;
    queue.push(item);
    writeQueue(queue);
    return item;
  }

  async function postAction(url, payload) {
    const body = { ...payload, requestId: payload.requestId || requestId() };
    try {
      return await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, { timeoutMs: 9000, retries: 1 });
    } catch (error) {
      // Validation errors should not be queued. Network/server outages should.
      if (error.status && error.status < 500) throw error;
      queueAction(url, body);
      return {
        success: true,
        accepted: true,
        queuedOffline: true,
        message: "Guardado en este teléfono. Se sincronizará automáticamente.",
      };
    }
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    try {
      const queue = readQueue();
      const remaining = [];
      for (const item of queue) {
        if (!item || !item.url || !item.payload) continue;
        try {
          await fetchJson(item.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(item.payload),
          }, { timeoutMs: 9000, retries: 0 });
        } catch (error) {
          item.attempts = Number(item.attempts || 0) + 1;
          if (!error.status || error.status >= 500) remaining.push(item);
        }
      }
      writeQueue(remaining);
    } finally {
      flushing = false;
    }
  }

  window.OSResilience = {
    fetchJson,
    saveSnapshot,
    loadSnapshot,
    postAction,
    flushQueue,
    pendingCount: () => readQueue().length,
  };

  window.addEventListener("online", flushQueue);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushQueue();
  });
  setInterval(flushQueue, 30000);
  setTimeout(flushQueue, 1200);
})();
