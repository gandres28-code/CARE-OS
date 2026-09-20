
const os = require("os");
const { query } = require("../db");

const workerId =
  process.env.SYNC_QUEUE_WORKER_ID ||
  `${os.hostname()}:${process.pid}`;

const DEFAULT_MAX_ATTEMPTS = Number(
  process.env.SYNC_QUEUE_MAX_ATTEMPTS || 10
);

const BASE_RETRY_MS = Number(
  process.env.SYNC_QUEUE_BASE_RETRY_MS || 5000
);

const MAX_RETRY_MS = Number(
  process.env.SYNC_QUEUE_MAX_RETRY_MS || 15 * 60 * 1000
);

function calculateRetryMs(attempts) {
  const exponential = BASE_RETRY_MS * Math.pow(2, Math.max(0, attempts - 1));
  const jitter = Math.floor(Math.random() * 1000);
  return Math.min(MAX_RETRY_MS, exponential + jitter);
}

async function enqueueSyncJob({
  jobType,
  destination = "notion",
  dedupeKey = "",
  payload = {},
  priority = 100,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (!jobType) {
    throw new Error("sync_queue necesita jobType");
  }

  const result = await query(
    `
      INSERT INTO sync_queue (
        job_type,
        destination,
        dedupe_key,
        payload,
        status,
        priority,
        attempts,
        max_attempts,
        next_retry_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        NULLIF($3, ''),
        $4::jsonb,
        'pending',
        $5,
        0,
        $6,
        NOW(),
        NOW(),
        NOW()
      )
      ON CONFLICT (dedupe_key)
      WHERE dedupe_key IS NOT NULL AND dedupe_key <> ''
      DO UPDATE SET
        payload = EXCLUDED.payload,
        status = CASE
          WHEN sync_queue.status = 'completed'
            THEN sync_queue.status
          ELSE 'pending'
        END,
        priority = LEAST(sync_queue.priority, EXCLUDED.priority),
        next_retry_at = CASE
          WHEN sync_queue.status = 'completed'
            THEN sync_queue.next_retry_at
          ELSE NOW()
        END,
        updated_at = NOW()
      RETURNING *
    `,
    [
      jobType,
      destination,
      dedupeKey,
      JSON.stringify(payload || {}),
      priority,
      maxAttempts,
    ]
  );

  return result.rows[0];
}

async function recoverStaleJobs(staleAfterMinutes = 10) {
  const result = await query(
    `
      UPDATE sync_queue
      SET
        status = 'failed',
        locked_at = NULL,
        locked_by = '',
        last_error = CASE
          WHEN last_error = ''
            THEN 'Worker interrupted before completion'
          ELSE last_error
        END,
        next_retry_at = NOW(),
        updated_at = NOW()
      WHERE status = 'processing'
        AND locked_at < NOW() - ($1::text || ' minutes')::interval
      RETURNING id
    `,
    [String(staleAfterMinutes)]
  );

  return result.rowCount;
}

async function claimNextJob(destination = "notion") {
  const result = await query(
    `
      WITH next_job AS (
        SELECT id
        FROM sync_queue
        WHERE destination = $1
          AND status IN ('pending','failed')
          AND attempts < max_attempts
          AND next_retry_at <= NOW()
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE sync_queue AS queue
      SET
        status = 'processing',
        attempts = queue.attempts + 1,
        locked_at = NOW(),
        locked_by = $2,
        updated_at = NOW()
      FROM next_job
      WHERE queue.id = next_job.id
      RETURNING queue.*
    `,
    [destination, workerId]
  );

  return result.rows[0] || null;
}

async function completeJob(id) {
  const result = await query(
    `
      UPDATE sync_queue
      SET
        status = 'completed',
        completed_at = NOW(),
        locked_at = NULL,
        locked_by = '',
        last_error = '',
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function failJob(job, error) {
  const retryMs = calculateRetryMs(job.attempts);
  const exhausted = Number(job.attempts) >= Number(job.max_attempts);

  const result = await query(
    `
      UPDATE sync_queue
      SET
        status = 'failed',
        locked_at = NULL,
        locked_by = '',
        last_error = $2,
        next_retry_at = CASE
          WHEN $3::boolean
            THEN NOW() + INTERVAL '100 years'
          ELSE NOW() + ($4::text || ' milliseconds')::interval
        END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      job.id,
      String(error?.message || error || "Unknown sync error").slice(0, 4000),
      exhausted,
      String(retryMs),
    ]
  );

  return {
    job: result.rows[0] || null,
    exhausted,
    retryMs,
  };
}

async function processNextSyncJob({
  destination = "notion",
  processors = {},
} = {}) {
  const job = await claimNextJob(destination);

  if (!job) {
    return {
      processed: false,
      reason: "empty",
    };
  }

  const processor = processors[job.job_type];

  if (typeof processor !== "function") {
    const failure = await failJob(
      job,
      new Error(`No existe processor para ${job.job_type}`)
    );

    return {
      processed: true,
      ok: false,
      job: failure.job,
      exhausted: failure.exhausted,
    };
  }

  try {
    const result = await processor(job.payload || {}, job);
    const completed = await completeJob(job.id);

    return {
      processed: true,
      ok: true,
      job: completed,
      result,
    };
  } catch (error) {
    const failure = await failJob(job, error);

    return {
      processed: true,
      ok: false,
      job: failure.job,
      error,
      exhausted: failure.exhausted,
      retryMs: failure.retryMs,
    };
  }
}

async function getSyncQueueStatus() {
  const countsResult = await query(
    `
      SELECT
        status,
        COUNT(*)::integer AS count
      FROM sync_queue
      GROUP BY status
    `
  );

  const recentResult = await query(
    `
      SELECT
        id,
        job_type,
        destination,
        status,
        attempts,
        max_attempts,
        next_retry_at,
        last_error,
        completed_at,
        created_at,
        updated_at
      FROM sync_queue
      ORDER BY created_at DESC
      LIMIT 25
    `
  );

  const counts = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };

  for (const row of countsResult.rows) {
    counts[row.status] = Number(row.count || 0);
  }

  return {
    counts,
    recent: recentResult.rows,
    workerId,
  };
}

async function retryFailedJobs() {
  const result = await query(
    `
      UPDATE sync_queue
      SET
        status = 'pending',
        next_retry_at = NOW(),
        locked_at = NULL,
        locked_by = '',
        updated_at = NOW()
      WHERE status = 'failed'
        AND attempts < max_attempts
      RETURNING id
    `
  );

  return result.rowCount;
}

module.exports = {
  enqueueSyncJob,
  recoverStaleJobs,
  processNextSyncJob,
  getSyncQueueStatus,
  retryFailedJobs,
};
