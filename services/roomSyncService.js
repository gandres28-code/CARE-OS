const { query } = require("../db");

function normalizeRoomValue(value) {
  const text = String(value || "").toUpperCase().trim();
  const match = text.match(/(\d{2,4})\s*([A-Z])?/);

  if (!match) {
    return text
      .replace(/\s+/g, " ")
      .replace(/[^A-Z0-9]/g, "")
      .trim();
  }

  return `${match[1]}${match[2] || ""}`;
}

function readTextProperty(property) {
  if (!property) return "";

  if (property.title) {
    return property.title.map((item) => item.plain_text || "").join("").trim();
  }

  if (property.rich_text) {
    return property.rich_text.map((item) => item.plain_text || "").join("").trim();
  }

  if (property.select?.name) return String(property.select.name).trim();
  if (property.status?.name) return String(property.status.name).trim();

  if (property.multi_select) {
    return property.multi_select.map((item) => item.name).join(" / ").trim();
  }

  if (property.people) {
    return property.people.map((item) => item.name || item.id || "").join(" / ").trim();
  }

  if (property.number !== undefined && property.number !== null) {
    return String(property.number);
  }

  return "";
}

function readBooleanProperty(properties, names) {
  for (const name of names) {
    if (properties?.[name]?.checkbox !== undefined) {
      return properties[name].checkbox === true;
    }
  }

  return false;
}

function readDateProperty(properties, names) {
  for (const name of names) {
    if (properties?.[name]?.date?.start) {
      return properties[name].date.start;
    }
  }

  return null;
}

function splitPeople(value) {
  const names = String(value || "")
    .replace(/\s+(?:and|y)\s+/gi, " / ")
    .replace(/[&|,;\n]+/g, " / ")
    .split(/\s*\/\s*/g)
    .map((name) => name.trim())
    .filter(Boolean);

  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
}

function getBuilding(roomTitle) {
  const normalized = normalizeRoomValue(roomTitle);
  const match = normalized.match(/^\d{2,4}([A-Z])$/);
  return match?.[1] || "OTHER";
}

function getRoomType(roomTitle, properties) {
  const direct =
    readTextProperty(properties?.["Room Type"]) ||
    readTextProperty(properties?.Type);

  if (direct) return direct.toUpperCase();

  const match = String(roomTitle || "").match(/\(([^)]+)\)/);
  return match ? match[1].trim().toUpperCase() : "";
}

function getRoomFromNotionPage(page, fallbackDate = "") {
  const properties = page?.properties || {};

  const roomNumber =
    readTextProperty(properties["Room Number"]) ||
    readTextProperty(properties.Unit) ||
    readTextProperty(properties.Room) ||
    readTextProperty(properties.Name);

  const workDate =
    properties.Date?.date?.start?.slice(0, 10) ||
    properties.date?.date?.start?.slice(0, 10) ||
    fallbackDate;

  const assignedCleaner =
    readTextProperty(properties["Assigned Cleaner"]) ||
    readTextProperty(properties["assigned cleaner"]);

  const assignedInspector =
    readTextProperty(properties["Assigned Inspector"]) ||
    readTextProperty(properties["assigned inspector"]);

  return {
    notionId: page?.id || "",
    workDate,
    roomNumber,
    normalizedRoom: normalizeRoomValue(roomNumber),
    roomType: getRoomType(roomNumber, properties),
    building: getBuilding(roomNumber),
    cleaningStatus:
      readTextProperty(properties["Cleaning Status"]) ||
      readTextProperty(properties.Status),
    guestOut: readBooleanProperty(properties, [
      "Guest Out",
      "guest out",
      "GuestOut",
      "Guest out",
      "Guests Out",
    ]),
    guestOutAt: readDateProperty(properties, [
      "Guest Out At",
      "guest out at",
      "Guest Out Time",
    ]),
    urgent: readBooleanProperty(properties, [
      "Urgent",
      "urgent",
      "Rush",
      "Priority",
    ]),
    arrival: readBooleanProperty(properties, [
      "Arrival",
      "arrival",
      "Arrivals",
    ]),
    stayover: readBooleanProperty(properties, [
      "Stayover",
      "Stay Over",
      "stayover",
    ]),
    assignedCleaner,
    assignedCleaners: splitPeople(assignedCleaner),
    assignedInspector,
    assignedInspectors: splitPeople(assignedInspector),
    startedAt: readDateProperty(properties, ["Started At", "Cleaning Started At"]),
    finishedAt: readDateProperty(properties, ["Finished At", "Cleaning Finished At"]),
    inspectionStartedAt: readDateProperty(properties, [
      "Inspection Started At",
      "Inspection Start At",
    ]),
    readyAt: readDateProperty(properties, ["Ready At", "Ready for Guest At"]),
    preInspection: readBooleanProperty(properties, [
      "Pre Inspection",
      "Pre-Inspection",
      "PreInspection",
      "Pre inspection",
    ]),
    preInspectionStarted: readBooleanProperty(properties, [
      "Pre Inspection Started",
      "Pre-Inspection Started",
      "PreInspection Started",
      "Pre inspection started",
    ]),
    preInspectionStartedAt: readDateProperty(properties, [
      "Pre Inspection Started At",
      "Pre Inspection Start At",
      "Pre-Inspection Started At",
      "PreInspection Started At",
    ]),
    preInspectionCompletedAt: readDateProperty(properties, [
      "Pre Inspection Completed At",
      "Pre Inspection Complete At",
      "Pre Inspection At",
      "Pre-Inspection Completed At",
    ]),
    rawData: page,
  };
}

async function upsertRoom(room) {
  if (!room.workDate || !room.roomNumber || !room.normalizedRoom) {
    return {
      saved: false,
      reason: "missing-date-or-room",
      room,
    };
  }

  const notionId = String(room.notionId || "").trim();

  const matches = await query(
    `
      SELECT
        id,
        notion_id,
        work_date,
        normalized_room
      FROM rooms
      WHERE
        (
          $1 <> ''
          AND notion_id = $1
        )
        OR (
          work_date = $2::date
          AND normalized_room = $3
        )
      ORDER BY
        CASE
          WHEN $1 <> '' AND notion_id = $1 THEN 0
          ELSE 1
        END,
        id
    `,
    [
      notionId,
      room.workDate,
      room.normalizedRoom,
    ]
  );

  let target = matches.rows[0] || null;
  const duplicateRows = target
    ? matches.rows.filter(
        (candidate) => String(candidate.id) !== String(target.id)
      )
    : [];

  /*
   * Puede existir un registro viejo con el mismo notion_id y otro
   * registro con la misma fecha + habitación. Antes, el UPSERT por
   * fecha intentaba copiar el notion_id y PostgreSQL rechazaba el
   * cambio por rooms_notion_id_key.
   *
   * Conservamos un solo registro canónico y eliminamos únicamente
   * los duplicados de Rooms. Assignments usa ON DELETE CASCADE y se
   * reconstruye inmediatamente después de este UPSERT.
   */
  if (duplicateRows.length) {
    const duplicateIds = duplicateRows.map((item) => item.id);

    console.warn("ROOM SYNC DUPLICATE MERGE:", {
      unit: room.roomNumber,
      workDate: room.workDate,
      notionId,
      keepingRoomId: target.id,
      removingRoomIds: duplicateIds,
    });

    await query(
      `
        DELETE FROM rooms
        WHERE id = ANY($1::bigint[])
      `,
      [duplicateIds]
    );
  }

  const values = [
    notionId,
    room.workDate,
    room.roomNumber,
    room.normalizedRoom,
    room.roomType,
    room.building,
    room.cleaningStatus,
    room.guestOut,
    room.guestOutAt,
    room.urgent,
    room.arrival,
    room.stayover,
    room.assignedCleaner,
    JSON.stringify(room.assignedCleaners),
    room.assignedInspector,
    JSON.stringify(room.assignedInspectors),
    room.startedAt,
    room.finishedAt,
    room.inspectionStartedAt,
    room.readyAt,
    room.preInspection,
    room.preInspectionStarted,
    room.preInspectionStartedAt,
    room.preInspectionCompletedAt,
    JSON.stringify(room.rawData || {}),
  ];

  let result;

  if (target) {
    result = await query(
      `
        UPDATE rooms
        SET
          notion_id = NULLIF($1, ''),
          work_date = $2::date,
          room_number = $3,
          normalized_room = $4,
          room_type = $5,
          building = $6,
          cleaning_status = $7,
          guest_out = $8,
          guest_out_at = $9,
          urgent = $10,
          arrival = $11,
          stayover = $12,
          assigned_cleaner = $13,
          assigned_cleaners = $14::jsonb,
          assigned_inspector = $15,
          assigned_inspectors = $16::jsonb,
          started_at = $17,
          finished_at = $18,
          inspection_started_at = $19,
          ready_at = $20,
          pre_inspection = $21,
          pre_inspection_started = $22,
          pre_inspection_started_at = $23,
          pre_inspection_completed_at = $24,
          source = 'notion',
          raw_data = $25::jsonb,
          updated_at = NOW()
        WHERE id = $26
        RETURNING *
      `,
      [...values, target.id]
    );
  } else {
    result = await query(
      `
        INSERT INTO rooms (
          notion_id,
          work_date,
          room_number,
          normalized_room,
          room_type,
          building,
          cleaning_status,
          guest_out,
          guest_out_at,
          urgent,
          arrival,
          stayover,
          assigned_cleaner,
          assigned_cleaners,
          assigned_inspector,
          assigned_inspectors,
          started_at,
          finished_at,
          inspection_started_at,
          ready_at,
          pre_inspection,
          pre_inspection_started,
          pre_inspection_started_at,
          pre_inspection_completed_at,
          source,
          raw_data,
          updated_at
        )
        VALUES (
          NULLIF($1, ''),
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
          $12,
          $13,
          $14::jsonb,
          $15,
          $16::jsonb,
          $17,
          $18,
          $19,
          $20,
          $21,
          $22,
          $23,
          $24,
          'notion',
          $25::jsonb,
          NOW()
        )
        RETURNING *
      `,
      values
    );
  }

  return {
    saved: true,
    mergedDuplicates: duplicateRows.length,
    room: result.rows[0],
  };
}

async function replaceAssignmentsForRoom(roomRow, room) {
  await query(
    `
      UPDATE assignments
      SET
        active = FALSE,
        removed_at = NOW()
      WHERE room_id = $1
        AND active = TRUE
    `,
    [roomRow.id]
  );

  const people = [
    ...room.assignedCleaners.map((name) => ({
      name,
      role: "Cleaner",
      splitPercent: 1 / Math.max(room.assignedCleaners.length, 1),
    })),
    ...room.assignedInspectors.map((name) => ({
      name,
      role: "Inspector",
      splitPercent: 1 / Math.max(room.assignedInspectors.length, 1),
    })),
  ];

  for (const person of people) {
    const normalizedEmployee = String(person.name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    await query(
      `
        INSERT INTO assignments (
          room_id,
          work_date,
          unit,
          employee_name,
          normalized_employee,
          assignment_role,
          split_percent,
          active,
          assigned_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
      `,
      [
        roomRow.id,
        room.workDate,
        room.roomNumber,
        person.name,
        normalizedEmployee,
        person.role,
        person.splitPercent,
      ]
    );
  }
}

async function syncRoomsFromNotion({
  notion,
  databaseId,
  queryDatabase,
  date,
}) {
  if (!databaseId) {
    throw new Error("Falta NOTION_DATABASE_ID");
  }

  if (!date) {
    throw new Error("La sincronización de Rooms necesita una fecha");
  }

  const syncKey = `rooms-notion-postgres:${date}`;
  const startedAt = Date.now();

  await query(
    `
      INSERT INTO sync_status (
        sync_key,
        source,
        destination,
        status,
        last_started_at,
        records_processed,
        error_message,
        updated_at
      )
      VALUES ($1, 'notion', 'postgres', 'running', NOW(), 0, '', NOW())
      ON CONFLICT (sync_key)
      DO UPDATE SET
        status = 'running',
        last_started_at = NOW(),
        records_processed = 0,
        error_message = '',
        updated_at = NOW()
    `,
    [syncKey]
  );

  try {
    let pages = [];
    let cursor;

    do {
      const body = {
        database_id: databaseId,
        page_size: 100,
        filter: {
          property: "Date",
          date: {
            equals: date,
          },
        },
      };

      if (cursor) body.start_cursor = cursor;

      const response = queryDatabase
        ? await queryDatabase(body)
        : await notion.databases.query(body);

      pages = pages.concat(response.results || []);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    let saved = 0;
    let skipped = 0;
    let mergedDuplicates = 0;
    const errors = [];

    for (const page of pages) {
      const room = getRoomFromNotionPage(page, date);

      try {
        const result = await upsertRoom(room);

        if (!result.saved) {
          skipped += 1;
          continue;
        }

        await replaceAssignmentsForRoom(result.room, room);

        saved += 1;
        mergedDuplicates += Number(
          result.mergedDuplicates || 0
        );
      } catch (roomError) {
        errors.push({
          notionId: room.notionId,
          unit: room.roomNumber,
          normalizedRoom: room.normalizedRoom,
          message: roomError.message,
        });

        console.error("ROOM SYNC ITEM ERROR:", {
          notionId: room.notionId,
          unit: room.roomNumber,
          normalizedRoom: room.normalizedRoom,
          message: roomError.message,
        });
      }
    }

    await query(
      `
        UPDATE sync_status
        SET
          status = 'success',
          last_completed_at = NOW(),
          last_success_at = NOW(),
          records_processed = $2,
          error_message = '',
          metadata = $3::jsonb,
          updated_at = NOW()
        WHERE sync_key = $1
      `,
      [
        syncKey,
        saved,
        JSON.stringify({
          date,
          totalFromNotion: pages.length,
          saved,
          skipped,
          mergedDuplicates,
          errors,
          durationMs: Date.now() - startedAt,
        }),
      ]
    );

    return {
      ok: true,
      date,
      totalFromNotion: pages.length,
      saved,
      skipped,
      mergedDuplicates,
      errors,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    await query(
      `
        UPDATE sync_status
        SET
          status = 'error',
          last_completed_at = NOW(),
          error_message = $2,
          updated_at = NOW()
        WHERE sync_key = $1
      `,
      [syncKey, error.message]
    );

    throw error;
  }
}

async function listRoomsPostgres(date) {
  const result = await query(
    `
      SELECT
        id,
        notion_id,
        work_date,
        room_number,
        normalized_room,
        room_type,
        building,
        cleaning_status,
        guest_out,
        guest_out_at,
        urgent,
        arrival,
        stayover,
        assigned_cleaner,
        assigned_cleaners,
        assigned_inspector,
        assigned_inspectors,
        started_at,
        finished_at,
        inspection_started_at,
        ready_at,
        updated_at
      FROM rooms
      WHERE work_date = $1
      ORDER BY building, room_number
    `,
    [date]
  );

  return result.rows;
}

async function getRoomSyncStatus(date) {
  const result = await query(
    `
      SELECT *
      FROM sync_status
      WHERE sync_key = $1
      LIMIT 1
    `,
    [`rooms-notion-postgres:${date}`]
  );

  return result.rows[0] || null;
}

module.exports = {
  normalizeRoomValue,
  getRoomFromNotionPage,
  syncRoomsFromNotion,
  listRoomsPostgres,
  getRoomSyncStatus,
};
