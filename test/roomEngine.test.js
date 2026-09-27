"use strict";

const assert = require("assert");
const { createRoomEngine, ROOM_STATUS } = require("../core/rooms");

async function run() {
  const events = [];
  const room = {
    id: 1,
    notion_id: "notion-room-1",
    work_date: "2026-07-18",
    room_number: "324 A",
    normalized_room: "324A",
    room_type: "2",
    building: "A",
    cleaning_status: "Pending",
    core_status: "PENDING",
    guest_out: true,
    urgent: false,
    arrival: true,
    assigned_cleaner: "",
    assigned_cleaners: [],
    assigned_inspector: "",
    assigned_inspectors: [],
  };

  async function fakeQuery(sql, params) {
    if (sql.includes("UPDATE rooms")) {
      const setLines = sql
        .split("SET")[1]
        .split("WHERE")[0]
        .split(",")
        .map((line) => line.trim())
        .filter(Boolean);

      setLines.forEach((line, index) => {
        const column = line.split("=")[0].trim();
        room[column] = params[index + 1];
        if (column.endsWith("s") && typeof room[column] === "string") {
          try { room[column] = JSON.parse(room[column]); } catch {}
        }
      });

      return { rows: [{ ...room }] };
    }

    if (sql.includes("FROM rooms")) return { rows: [{ ...room }] };
    throw new Error(`SQL inesperado en prueba: ${sql}`);
  }

  const engine = createRoomEngine({
    query: fakeQuery,
    eventEngine: {
      publish: async (event) => {
        events.push(event);
        return event;
      },
    },
    now: () => new Date("2026-07-18T15:00:00.000Z"),
  });

  const assigned = await engine.assignCleaner(1, "Daniela", { employee: "Andres" });
  assert.equal(assigned.status, ROOM_STATUS.ASSIGNED);
  assert.equal(assigned.cleaner, "Daniela");

  const started = await engine.startCleaning(1, { cleaner: "Daniela" });
  assert.equal(started.status, ROOM_STATUS.CLEANING);
  assert.equal(started.startedAt, "2026-07-18T15:00:00.000Z");

  const finished = await engine.finishCleaning(1, { cleaner: "Daniela" });
  assert.equal(finished.status, ROOM_STATUS.WAITING_INSPECTION);

  const inspecting = await engine.startInspection(1, { inspector: "Alex" });
  assert.equal(inspecting.status, ROOM_STATUS.INSPECTING);

  const ready = await engine.finishInspection(1, { inspector: "Alex" });
  assert.equal(ready.status, ROOM_STATUS.READY);
  assert.equal(events.length, 5);

  console.log("✅ RoomEngine tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
