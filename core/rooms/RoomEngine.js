"use strict";

const {
  ROOM_STATUS,
  ROOM_EVENT,
  LEGACY_STATUS_BY_CORE_STATUS,
} = require("./constants");

function required(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`RoomEngine: falta ${fieldName}.`);
  return text;
}

function normalizeRoom(value) {
  const text = String(value || "").toUpperCase().trim();
  const match = text.match(/(\d{2,4})\s*([A-Z])?/);
  if (!match) return text.replace(/[^A-Z0-9]/g, "");
  return `${match[1]}${match[2] || ""}`;
}

function mapRoom(row) {
  if (!row) return null;

  return {
    id: row.id,
    notionId: row.notion_id || null,
    workDate: row.work_date,
    roomNumber: row.room_number,
    normalizedRoom: row.normalized_room,
    roomType: row.room_type || "",
    building: row.building || "OTHER",
    status: row.core_status || null,
    legacyStatus: row.cleaning_status || "",
    guestOut: Boolean(row.guest_out),
    urgent: Boolean(row.urgent),
    arrival: Boolean(row.arrival),
    stayover: Boolean(row.stayover),
    cleaner: row.assigned_cleaner || "",
    cleaners: Array.isArray(row.assigned_cleaners) ? row.assigned_cleaners : [],
    inspector: row.assigned_inspector || "",
    inspectors: Array.isArray(row.assigned_inspectors) ? row.assigned_inspectors : [],
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    inspectionStartedAt: row.inspection_started_at || null,
    readyAt: row.ready_at || null,
    updatedAt: row.updated_at || null,
  };
}

function createRoomEngine({ query, eventEngine = null, now = () => new Date() } = {}) {
  if (typeof query !== "function") {
    throw new Error("RoomEngine requiere una función query(text, params).");
  }

  async function get(roomId) {
    const id = Number(roomId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("RoomEngine: roomId inválido.");
    }

    const result = await query(
      `
        SELECT *
        FROM rooms
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    return mapRoom(result.rows[0]);
  }

  async function getByDateAndUnit(workDate, unit) {
    const date = required(workDate, "workDate");
    const normalized = normalizeRoom(required(unit, "unit"));

    const result = await query(
      `
        SELECT *
        FROM rooms
        WHERE work_date = $1::date
          AND normalized_room = $2
        LIMIT 1
      `,
      [date, normalized]
    );

    return mapRoom(result.rows[0]);
  }

  async function publishEvent(room, eventType, actor = {}, details = {}) {
    if (!eventEngine || typeof eventEngine.publish !== "function") return null;

    return eventEngine.publish({
      action: eventType,
      unit: room.roomNumber,
      workDate: room.workDate,
      employee: actor.employee || actor.name || "",
      cleaner: actor.cleaner || "",
      inspector: actor.inspector || "",
      note: details.note || "",
      priority: details.priority || "Normal",
      category: details.category || "Operations",
      source: details.source || "care-operations-core",
      metadata: {
        roomId: room.id,
        ...details.metadata,
      },
    });
  }

  async function transition(roomId, {
    status,
    eventType,
    actor = {},
    details = {},
    extraUpdates = {},
  }) {
    if (!Object.values(ROOM_STATUS).includes(status)) {
      throw new Error(`RoomEngine: estado inválido ${status}.`);
    }

    const legacyStatus = LEGACY_STATUS_BY_CORE_STATUS[status];
    const timestamp = now().toISOString();

    const allowedColumns = new Set([
      "assigned_cleaner",
      "assigned_cleaners",
      "assigned_inspector",
      "assigned_inspectors",
      "started_at",
      "finished_at",
      "inspection_started_at",
      "ready_at",
      "urgent",
      "arrival",
      "stayover",
      "guest_out",
    ]);

    const updates = {
      core_status: status,
      cleaning_status: legacyStatus,
      updated_at: timestamp,
      ...extraUpdates,
    };

    const entries = Object.entries(updates).filter(([column]) =>
      column === "core_status" ||
      column === "cleaning_status" ||
      column === "updated_at" ||
      allowedColumns.has(column)
    );

    const setSql = entries
      .map(([column], index) => `${column} = $${index + 2}`)
      .join(",\n          ");

    const values = entries.map(([, value]) =>
      Array.isArray(value) ? JSON.stringify(value) : value
    );

    const result = await query(
      `
        UPDATE rooms
        SET
          ${setSql}
        WHERE id = $1
        RETURNING *
      `,
      [Number(roomId), ...values]
    );

    const room = mapRoom(result.rows[0]);
    if (!room) throw new Error("RoomEngine: habitación no encontrada.");

    await publishEvent(room, eventType, actor, details);
    return room;
  }

  async function assignCleaner(roomId, cleaner, actor = {}) {
    const name = required(cleaner, "cleaner");
    return transition(roomId, {
      status: ROOM_STATUS.ASSIGNED,
      eventType: ROOM_EVENT.ROOM_ASSIGNED,
      actor,
      details: { note: `Cleaner asignado: ${name}` },
      extraUpdates: {
        assigned_cleaner: name,
        assigned_cleaners: [name],
      },
    });
  }

  async function assignInspector(roomId, inspector, actor = {}) {
    const name = required(inspector, "inspector");
    const current = await get(roomId);
    if (!current) throw new Error("RoomEngine: habitación no encontrada.");

    return transition(roomId, {
      status: current.status || ROOM_STATUS.ASSIGNED,
      eventType: ROOM_EVENT.INSPECTOR_ASSIGNED,
      actor,
      details: { note: `Inspector asignado: ${name}` },
      extraUpdates: {
        assigned_inspector: name,
        assigned_inspectors: [name],
      },
    });
  }

  async function startCleaning(roomId, actor = {}) {
    return transition(roomId, {
      status: ROOM_STATUS.CLEANING,
      eventType: ROOM_EVENT.CLEANING_STARTED,
      actor,
      extraUpdates: { started_at: now().toISOString() },
    });
  }

  async function finishCleaning(roomId, actor = {}) {
    return transition(roomId, {
      status: ROOM_STATUS.WAITING_INSPECTION,
      eventType: ROOM_EVENT.CLEANING_FINISHED,
      actor,
      extraUpdates: { finished_at: now().toISOString() },
    });
  }

  async function startInspection(roomId, actor = {}) {
    return transition(roomId, {
      status: ROOM_STATUS.INSPECTING,
      eventType: ROOM_EVENT.INSPECTION_STARTED,
      actor,
      extraUpdates: { inspection_started_at: now().toISOString() },
    });
  }

  async function finishInspection(roomId, actor = {}) {
    return transition(roomId, {
      status: ROOM_STATUS.READY,
      eventType: ROOM_EVENT.READY_FOR_GUEST,
      actor,
      extraUpdates: { ready_at: now().toISOString() },
    });
  }

  async function reportIssue(roomId, issue = {}, actor = {}) {
    const room = await get(roomId);
    if (!room) throw new Error("RoomEngine: habitación no encontrada.");

    await publishEvent(room, ROOM_EVENT.ISSUE_REPORTED, actor, {
      note: issue.note || issue.type || "Problema reportado",
      priority: issue.priority || "Normal",
      category: issue.category || "Issue",
      metadata: issue,
    });

    return room;
  }

  async function requestSupplies(roomId, request = {}, actor = {}) {
    const room = await get(roomId);
    if (!room) throw new Error("RoomEngine: habitación no encontrada.");

    await publishEvent(room, ROOM_EVENT.SUPPLIES_REQUESTED, actor, {
      note: request.note || request.item || "Supplies solicitados",
      priority: request.priority || "Normal",
      category: "Supplies",
      metadata: request,
    });

    return room;
  }

  return {
    version: "1.0.0",
    get,
    getByDateAndUnit,
    assignCleaner,
    assignInspector,
    startCleaning,
    finishCleaning,
    startInspection,
    finishInspection,
    reportIssue,
    requestSupplies,
  };
}

module.exports = {
  createRoomEngine,
  normalizeRoom,
  mapRoom,
};
