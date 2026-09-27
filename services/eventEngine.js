const crypto = require("crypto");
const { getPool, query } = require("../db");

const EVENT_ENGINE_VERSION = "1.1.0-ultra";

const ROOM_STATUS_BY_ACTION = {
  START: "In Progress",
  DONE: "Cleaned - Awaiting Inspection",
  INSPECTION_START: "Inspection Started",
  READY_GUEST: "Ready for Guest",
};

const ACTION_CATEGORY = {
  START: "Cleaning",
  DONE: "Cleaning",
  ISSUE: "Problem",
  SUPPLIES: "Supplies",
  LOST_FOUND: "Lost & Found",
  INSPECTION_START: "Inspection",
  READY_GUEST: "Inspection",
  INSPECTION_REPORT: "Problem",
  INSPECTION_SUPPLIES: "Supplies",
  GUEST_OUT: "Operations",
  PRE_INSPECTION_START: "Inspection",
  PRE_INSPECTION_COMPLETE: "Inspection",
};

const ACTION_PRIORITY = {
  ISSUE: "High",
  INSPECTION_REPORT: "High",
  LOST_FOUND: "Normal",
  SUPPLIES: "Normal",
  INSPECTION_SUPPLIES: "Normal",
};

function chicagoDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value instanceof Date ? value : new Date(value));
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeEmployee(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeRoom(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/(\d{2,4})\s*([A-Z])?/);

  if (match) {
    return `${match[1]}${match[2] || ""}`;
  }

  return normalizeText(text)
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 80);
}

function splitEmployeeNames(value) {
  const names = String(value || "")
    .replace(/\s+(?:and|y)\s+/gi, " / ")
    .replace(/[&|,;\n]+/g, " / ")
    .split(/\s*\/\s*/g)
    .map(normalizeText)
    .filter(Boolean);

  return [
    ...new Map(
      names.map((name) => [normalizeEmployee(name), name])
    ).values(),
  ];
}

function getPayrollWeek(workDate) {
  const date = new Date(`${workDate}T12:00:00`);
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(date);
  monday.setDate(date.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: sunday.toISOString().slice(0, 10),
  };
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 24);
}

function createEventId({
  eventId,
  workDate,
  action,
  unit,
  employee,
  occurredAt,
  requestId,
}) {
  if (eventId) return normalizeText(eventId);

  const stableSeed = requestId
    ? `request:${requestId}`
    : [
        workDate,
        normalizeRoom(unit),
        normalizeText(action).toUpperCase(),
        normalizeEmployee(employee),
        new Date(occurredAt).toISOString(),
      ].join("|");

  return `evt_${stableHash(stableSeed)}`;
}

function categoryForAction(action, suppliedCategory) {
  return (
    normalizeText(suppliedCategory) ||
    ACTION_CATEGORY[action] ||
    "Other"
  );
}

function priorityForAction(action, suppliedPriority) {
  return (
    normalizeText(suppliedPriority) ||
    ACTION_PRIORITY[action] ||
    "Normal"
  );
}

function statusForAction(action) {
  return ROOM_STATUS_BY_ACTION[action] || "";
}

function roleColumns(role, employee) {
  const normalizedRole = String(role || "").toLowerCase();

  return {
    cleaner: normalizedRole.includes("cleaner") ? employee : "",
    inspector: normalizedRole.includes("inspector") ? employee : "",
  };
}

async function findRoomForUpdate(client, workDate, normalizedRoom) {
  const result = await client.query(
    `
      SELECT *
      FROM rooms
      WHERE work_date = $1::date
        AND normalized_room = $2
      FOR UPDATE
    `,
    [workDate, normalizedRoom]
  );

  return result.rows[0] || null;
}

async function updateRoomForEvent(
  client,
  room,
  action,
  occurredAt,
  employee
) {
  if (!room) return null;

  let sql = "";
  // Estas consultas sólo usan $1 y $2.
  // Enviar employee como tercer parámetro provoca:
  // "bind message supplies 3 parameters, but prepared statement requires 2"
  const values = [room.id, occurredAt];

  switch (action) {
    case "START":
      sql = `
        UPDATE rooms
        SET
          cleaning_status = 'In Progress',
          core_status = 'CLEANING',
          started_at = COALESCE(started_at, $2::timestamptz),
          finished_at = NULL,
          inspection_started_at = NULL,
          ready_at = NULL,
          source = 'event-engine',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      break;

    case "DONE":
      sql = `
        UPDATE rooms
        SET
          cleaning_status = 'Cleaned - Awaiting Inspection',
          core_status = 'WAITING_INSPECTION',
          started_at = COALESCE(started_at, $2::timestamptz),
          finished_at = $2::timestamptz,
          inspection_started_at = NULL,
          ready_at = NULL,
          source = 'event-engine',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      break;

    case "INSPECTION_START":
      sql = `
        UPDATE rooms
        SET
          cleaning_status = 'Inspection Started',
          core_status = 'INSPECTING',
          inspection_started_at = COALESCE(
            inspection_started_at,
            $2::timestamptz
          ),
          ready_at = NULL,
          source = 'event-engine',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      break;

    case "READY_GUEST":
      sql = `
        UPDATE rooms
        SET
          cleaning_status = 'Ready for Guest',
          core_status = 'READY',
          inspection_started_at = COALESCE(
            inspection_started_at,
            $2::timestamptz
          ),
          ready_at = $2::timestamptz,
          source = 'event-engine',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      break;

    case "GUEST_OUT":
      sql = `
        UPDATE rooms
        SET
          guest_out = TRUE,
          guest_out_at = COALESCE(guest_out_at, $2::timestamptz),
          source = 'event-engine',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      break;

    case "PRE_INSPECTION_START":
      sql = `
        UPDATE rooms
        SET
          pre_inspection = FALSE,
          pre_inspection_started = TRUE,
          pre_inspection_started_at = COALESCE(
            pre_inspection_started_at,
            $2::timestamptz
          ),
          pre_inspection_completed_at = NULL,
          updated_by = $3,
          source = 'event-engine',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      values.push(employee || "");
      break;

    case "PRE_INSPECTION_COMPLETE":
      sql = `
        UPDATE rooms
        SET
          pre_inspection = TRUE,
          pre_inspection_started = FALSE,
          pre_inspection_started_at = COALESCE(
            pre_inspection_started_at,
            $2::timestamptz
          ),
          pre_inspection_completed_at = $2::timestamptz,
          updated_by = $3,
          source = 'event-engine',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      values.push(employee || "");
      break;

    default:
      return room;
  }

  const result = await client.query(sql, values);
  return result.rows[0] || room;
}

async function resolvePayrollRate(client, room, workDate) {
  const roomType = normalizeText(room?.room_type).toUpperCase();
  const propertyName = normalizeText(
    room?.raw_data?.propertyName ||
      room?.raw_data?.property ||
      "ALL"
  ).toUpperCase();

  const result = await client.query(
    `
      SELECT amount::float8 AS amount
      FROM payroll_rates
      WHERE active = TRUE
        AND UPPER(room_type) = $1
        AND UPPER(property_name) IN ($2, 'ALL')
        AND effective_from <= $3::date
        AND (
          effective_to IS NULL OR
          effective_to >= $3::date
        )
      ORDER BY
        CASE
          WHEN UPPER(property_name) = $2 THEN 0
          ELSE 1
        END,
        effective_from DESC
      LIMIT 1
    `,
    [roomType, propertyName, workDate]
  );

  return {
    roomType,
    propertyName,
    amount: Number(result.rows[0]?.amount || 0),
  };
}

async function createPayrollFromDone(
  client,
  eventId,
  room,
  actor,
  workDate
) {
  if (!room) {
    return { created: 0, skipped: 0, reason: "room-not-found" };
  }

  const configuredNames = Array.isArray(room.assigned_cleaners)
    ? room.assigned_cleaners
    : [];

  const cleaners = splitEmployeeNames(
    configuredNames.length
      ? configuredNames.join(" / ")
      : room.assigned_cleaner || actor
  );

  if (!cleaners.length) {
    return { created: 0, skipped: 0, reason: "no-cleaner" };
  }

  const rate = await resolvePayrollRate(client, room, workDate);

  if (!rate.amount) {
    return {
      created: 0,
      skipped: cleaners.length,
      reason: `no-rate-for-${rate.roomType || "unknown"}`,
    };
  }

  const splitMode = String(
    process.env.PAYROLL_SPLIT_MODE || "equal"
  ).toLowerCase();

  const amountPerCleaner =
    splitMode === "full_each"
      ? roundMoney(rate.amount)
      : roundMoney(rate.amount / cleaners.length);

  const week = getPayrollWeek(workDate);
  let created = 0;
  let skipped = 0;

  for (const cleaner of cleaners) {
    const payrollEventId = `${eventId}:${normalizeEmployee(cleaner)}`;

    const result = await client.query(
      `
        INSERT INTO payroll_records (
          source_event_id,
          work_date,
          employee,
          normalized_employee,
          unit,
          room_type,
          property_name,
          gross_unit_amount,
          split_count,
          split_percent,
          amount,
          pay_type,
          role_worked,
          week_start,
          week_end,
          status,
          source,
          raw_data,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2::date,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          'unit',
          'Cleaner',
          $12::date,
          $13::date,
          'Pending',
          'event-engine',
          $14::jsonb,
          NOW(),
          NOW()
        )
        ON CONFLICT (source_event_id)
        WHERE source_event_id IS NOT NULL
          AND source_event_id <> ''
        DO NOTHING
        RETURNING id
      `,
      [
        payrollEventId,
        workDate,
        cleaner,
        normalizeEmployee(cleaner),
        room.room_number || "",
        rate.roomType,
        rate.propertyName,
        rate.amount,
        cleaners.length,
        splitMode === "full_each" ? 1 : 1 / cleaners.length,
        amountPerCleaner,
        week.weekStart,
        week.weekEnd,
        JSON.stringify({
          eventId,
          roomId: room.id,
          splitMode,
          source: "event-engine",
        }),
      ]
    );

    if (result.rowCount) created += 1;
    else skipped += 1;
  }

  return {
    created,
    skipped,
    cleaners,
    grossUnitAmount: rate.amount,
    amountPerCleaner,
  };
}

async function insertNotification(
  client,
  eventId,
  action,
  unit,
  employee,
  priority,
  note
) {
  if (
    ![
      "ISSUE",
      "SUPPLIES",
      "LOST_FOUND",
      "INSPECTION_REPORT",
      "INSPECTION_SUPPLIES",
      "DONE",
    ].includes(action)
  ) {
    return null;
  }

  const titles = {
    ISSUE: "⚠️ Problema reportado",
    SUPPLIES: "📦 Supplies solicitados",
    LOST_FOUND: "🧳 Lost & Found",
    INSPECTION_REPORT: "🔎 Error de inspección",
    INSPECTION_SUPPLIES: "📦 Solicitud de inspector",
    DONE: "🧹 Habitación lista para inspección",
  };

  const result = await client.query(
    `
      INSERT INTO notifications (
        employee,
        normalized_employee,
        notification_type,
        title,
        message,
        unit,
        priority,
        source,
        metadata
      )
      VALUES (
        '',
        '',
        $1,
        $2,
        $3,
        $4,
        $5,
        'event-engine',
        $6::jsonb
      )
      RETURNING *
    `,
    [
      action,
      titles[action] || "🔔 Actualización",
      note || `${employee || "Empleado"} · ${unit}`,
      unit,
      priority,
      JSON.stringify({ eventId, action, employee }),
    ]
  );

  return result.rows[0] || null;
}

async function insertSyncQueueJob(
  client,
  eventId,
  payload,
  priority
) {
  const result = await client.query(
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
        'notion-room-action',
        'notion',
        $1,
        $2::jsonb,
        'pending',
        $3,
        0,
        $4,
        NOW(),
        NOW(),
        NOW()
      )
      ON CONFLICT (dedupe_key)
      WHERE dedupe_key IS NOT NULL
        AND dedupe_key <> ''
      DO UPDATE SET
        payload = EXCLUDED.payload,
        status = CASE
          WHEN sync_queue.status = 'completed'
            THEN 'completed'
          ELSE 'pending'
        END,
        priority = LEAST(
          sync_queue.priority,
          EXCLUDED.priority
        ),
        next_retry_at = CASE
          WHEN sync_queue.status = 'completed'
            THEN sync_queue.next_retry_at
          ELSE NOW()
        END,
        updated_at = NOW()
      RETURNING *
    `,
    [
      `notion-event:${eventId}`,
      JSON.stringify(payload),
      priority,
      Number(process.env.SYNC_QUEUE_MAX_ATTEMPTS || 10),
    ]
  );

  return result.rows[0] || null;
}

function createEventEngine({
  io = null,
  clearRoomCache = () => {},
  clearAssignmentCaches = () => {},
  onPublished = () => {},
  onEventCommitted = () => {},
} = {}) {
  async function publish(input = {}) {
    const action = normalizeText(input.action).toUpperCase();
    const unit = normalizeText(input.unit);
    const employee = normalizeText(input.employee || input.name);
    const role = normalizeText(input.role);
    const note = normalizeText(input.note);
    const photoUrl = normalizeText(input.photoUrl);
    const occurredAt = input.occurredAt
      ? new Date(input.occurredAt).toISOString()
      : new Date().toISOString();
    const workDate = input.workDate || chicagoDate(occurredAt);
    const normalizedRoom = normalizeRoom(unit);

    if (!action || !unit || !employee) {
      throw new Error(
        "eventEngine necesita action, unit y employee"
      );
    }

    if (!normalizedRoom) {
      throw new Error(`No pude normalizar la unidad ${unit}`);
    }

    const eventId = createEventId({
      eventId: input.eventId,
      requestId: input.requestId,
      workDate,
      action,
      unit,
      employee,
      occurredAt,
    });

    const category = categoryForAction(
      action,
      input.category
    );
    const priority = priorityForAction(
      action,
      input.priority
    );
    const status = statusForAction(action);
    const roleData = roleColumns(role, employee);

    const client = await getPool().connect();

    try {
      await client.query("BEGIN");
      // Fail fast instead of freezing a phone while PostgreSQL waits on a locked room.
      await client.query("SET LOCAL lock_timeout = '1500ms'");
      await client.query("SET LOCAL statement_timeout = '5000ms'");

      const existingResult = await client.query(
        `
          SELECT
            id,
            event_id,
            event_type,
            aggregate_type,
            aggregate_id,
            work_date,
            occurred_at,
            payload,
            status,
            processed_at,
            created_at
          FROM system_events
          WHERE event_id = $1
          FOR UPDATE
        `,
        [eventId]
      );

      if (existingResult.rows[0]) {
        await client.query("COMMIT");

        return {
          ok: true,
          duplicate: true,
          eventId,
          event: existingResult.rows[0],
        };
      }

      const room = await findRoomForUpdate(
        client,
        workDate,
        normalizedRoom
      );

      if (!room) {
        throw new Error(
          `La unidad ${unit} no existe en PostgreSQL para ${workDate}`
        );
      }

      const updatedRoom = await updateRoomForEvent(
        client,
        room,
        action,
        occurredAt,
        employee
      );

      const operationResult = await client.query(
        `
          INSERT INTO operations_logs (
            external_event_id,
            work_date,
            event_time,
            unit,
            normalized_room,
            action,
            cleaner,
            inspector,
            employee,
            role_worked,
            note,
            photo_url,
            category,
            priority,
            source,
            raw_data
          )
          VALUES (
            $1,
            $2::date,
            $3::timestamptz,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            'event-engine',
            $15::jsonb
          )
          ON CONFLICT (external_event_id)
          WHERE external_event_id IS NOT NULL
            AND external_event_id <> ''
          DO NOTHING
          RETURNING *
        `,
        [
          eventId,
          workDate,
          occurredAt,
          updatedRoom?.room_number || unit,
          normalizedRoom,
          action,
          roleData.cleaner,
          roleData.inspector,
          employee,
          role,
          note,
          photoUrl,
          category,
          priority,
          JSON.stringify({
            eventId,
            roomId: updatedRoom?.id || null,
            source: "event-engine",
          }),
        ]
      );

      let payroll = {
        created: 0,
        skipped: 0,
        reason: "not-a-done-event",
      };

      if (action === "DONE") {
        payroll = await createPayrollFromDone(
          client,
          eventId,
          updatedRoom,
          employee,
          workDate
        );
      }

      const notification = await insertNotification(
        client,
        eventId,
        action,
        updatedRoom?.room_number || unit,
        employee,
        priority,
        note
      );

      const queueJob = await insertSyncQueueJob(
        client,
        eventId,
        {
          eventId,
          action,
          unit: updatedRoom?.room_number || unit,
          note,
          name: employee,
          role: role.toLowerCase(),
          photoUrl,
          queuedAt: new Date().toISOString(),
        },
        action === "READY_GUEST" ? 10 : 50
      );

      const eventPayload = {
        eventId,
        action,
        unit: updatedRoom?.room_number || unit,
        normalizedRoom,
        employee,
        role,
        note,
        photoUrl,
        category,
        priority,
        status,
        roomId: updatedRoom?.id || null,
        operationLogId: operationResult.rows[0]?.id || null,
        payroll,
        notificationId: notification?.id || null,
        syncQueueId: queueJob?.id || null,
        source: "event-engine",
      };

      const eventResult = await client.query(
        `
          INSERT INTO system_events (
            event_id,
            event_type,
            aggregate_type,
            aggregate_id,
            work_date,
            occurred_at,
            actor,
            actor_role,
            payload,
            status,
            processed_at,
            created_at
          )
          VALUES (
            $1,
            $2,
            'room',
            $3,
            $4::date,
            $5::timestamptz,
            $6,
            $7,
            $8::jsonb,
            'processed',
            NOW(),
            NOW()
          )
          RETURNING *
        `,
        [
          eventId,
          action,
          normalizedRoom,
          workDate,
          occurredAt,
          employee,
          role,
          JSON.stringify(eventPayload),
        ]
      );

      await client.query("COMMIT");

      clearRoomCache(workDate);
      clearAssignmentCaches(workDate);

      const socketPayload = {
        module: "rooms",
        date: workDate,
        reason: "event-engine",
        action,
        unit: eventPayload.unit,
        normalizedRoom,
        status,
        employee,
        role,
        startedAt: updatedRoom?.started_at || null,
        finishedAt: updatedRoom?.finished_at || null,
        inspectionStartedAt:
          updatedRoom?.inspection_started_at || null,
        readyAt: updatedRoom?.ready_at || null,
        payroll,
        eventId,
        updatedAt: new Date().toISOString(),
        source: "postgres",
      };

      if (io?.emit) {
        io.emit("system-event-created", eventPayload);
        io.emit("operations-log-created", {
          ...(operationResult.rows[0] || {}),
          id: operationResult.rows[0]?.id,
          eventTime: occurredAt,
          unit: eventPayload.unit,
          normalizedRoom,
          action,
          employee,
          person: employee,
          role,
          note,
          photoUrl,
          category,
          priority,
          source: "postgres",
          eventId,
        });
        io.emit("room-updated", socketPayload);
        io.emit("rooms-updated", socketPayload);
        io.emit("assignments-updated", socketPayload);
        io.emit("data-api-updated", socketPayload);

        if (notification) {
          io.emit("system-notification", notification);
        }
      }

      // Never keep the HTTP request open for dashboard, AI, notifications or other hooks.
      // PostgreSQL is already committed at this point, so callbacks run safely in background.
      setImmediate(() => {
        Promise.resolve(
          onPublished({
            event: eventResult.rows[0],
            payload: eventPayload,
            room: updatedRoom,
          })
        ).catch((callbackError) => {
          console.error("EVENT ENGINE onPublished ERROR:", callbackError.message);
        });

        Promise.resolve(
          onEventCommitted({
            event: eventResult.rows[0],
            payload: eventPayload,
            room: updatedRoom,
            workDate,
          })
        ).catch((callbackError) => {
          console.error("EVENT ENGINE onEventCommitted ERROR:", callbackError.message);
        });
      });

      return {
        ok: true,
        duplicate: false,
        eventId,
        event: eventResult.rows[0],
        room: updatedRoom,
        operation: operationResult.rows[0] || null,
        payroll,
        notification,
        queueJob,
        status,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function getStatus() {
    const result = await query(`
      SELECT
        COUNT(*)::int AS total_events,
        COUNT(*) FILTER (
          WHERE occurred_at >= NOW() - INTERVAL '24 hours'
        )::int AS events_last_24h,
        COUNT(*) FILTER (
          WHERE status = 'failed'
        )::int AS failed_events,
        MAX(occurred_at) AS last_event_at
      FROM system_events
    `);

    const queueResult = await query(`
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('pending','failed')
        )::int AS waiting_sync,
        COUNT(*) FILTER (
          WHERE status = 'processing'
        )::int AS processing_sync
      FROM sync_queue
    `);

    return {
      ok: true,
      version: EVENT_ENGINE_VERSION,
      ...result.rows[0],
      ...queueResult.rows[0],
    };
  }

  async function listEvents({
    date = chicagoDate(),
    limit = 100,
  } = {}) {
    const safeLimit = Math.min(
      500,
      Math.max(1, Number(limit || 100))
    );

    const result = await query(
      `
        SELECT
          id,
          event_id AS "eventId",
          event_type AS "eventType",
          aggregate_type AS "aggregateType",
          aggregate_id AS "aggregateId",
          work_date AS "workDate",
          occurred_at AS "occurredAt",
          actor,
          actor_role AS "actorRole",
          payload,
          status,
          processed_at AS "processedAt",
          created_at AS "createdAt"
        FROM system_events
        WHERE work_date = $1::date
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2
      `,
      [date, safeLimit]
    );

    return result.rows;
  }

  return {
    version: EVENT_ENGINE_VERSION,
    publish,
    getStatus,
    listEvents,
  };
}

module.exports = {
  EVENT_ENGINE_VERSION,
  createEventEngine,
  normalizeRoom,
  splitEmployeeNames,
  statusForAction,
};
