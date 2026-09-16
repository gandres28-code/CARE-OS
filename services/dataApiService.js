const { query } = require("../db");

function cleanDate(value, fallback = "") {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function classifyRoomStatus(statusValue) {
  const status = String(statusValue || "").trim().toLowerCase();

  if (
    status.includes("ready for guest") ||
    status === "ready" ||
    status.includes("guest ready")
  ) {
    return "ready";
  }

  if (
    status.includes("inspection started") ||
    status.includes("in inspection") ||
    status.includes("inspecting")
  ) {
    return "inspection";
  }

  if (
    status.includes("done") ||
    status.includes("awaiting inspection") ||
    status.includes("ready for inspection") ||
    status.includes("para inspeccionar")
  ) {
    return "awaitingInspection";
  }

  if (
    status.includes("started") ||
    status.includes("in progress") ||
    status.includes("cleaning")
  ) {
    return "inProgress";
  }

  return "pending";
}


function normalizeUnitLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function classifyOperationalBuilding(room) {
  const unit = normalizeUnitLabel(room?.unit || room?.room_number || "");
  const roomType = String(room?.roomType || room?.room_type || "")
    .trim()
    .toLowerCase();
  const searchable = `${unit} ${roomType}`.toLowerCase();

  if (/\bsuite(?:s)?\b/i.test(searchable)) {
    return "SUITES";
  }

  const houseKeywords = [
    "sundowner", "sunrise", "cabin", "lodge", "house", "home",
    "villa", "bungalow", "cottage", "condo", "chalet", "retreat",
    "hideaway", "lakehouse", "farmhouse", "townhouse", "duplex", "triplex"
  ];

  if (houseKeywords.some((keyword) => searchable.includes(keyword))) {
    return "CASAS";
  }

  const cleaned = unit
    .replace(/\s+URGENTE\s*$/i, "")
    .replace(/\s*[-–—]\s*URGENTE\s*$/i, "")
    .trim();

  const finalLetterMatch = cleaned.match(
    /(?:^|[\s\-–—])([A-Z])(?:\s*(?:\([^)]*\))?)?\s*$/i
  );

  if (finalLetterMatch) {
    return finalLetterMatch[1].toUpperCase();
  }

  return "CASAS";
}

function averageNumbers(values) {
  const valid = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!valid.length) return 0;

  return Number(
    (valid.reduce((total, value) => total + value, 0) / valid.length).toFixed(1)
  );
}

async function getDataApiHealth() {
  const result = await query(`
    SELECT
      NOW() AS database_time,
      current_database() AS database_name,
      (SELECT COUNT(*)::int FROM employees) AS employees,
      (SELECT COUNT(*)::int FROM rooms) AS rooms,
      (SELECT COUNT(*)::int FROM assignments WHERE active = TRUE) AS assignments,
      (SELECT COUNT(*)::int FROM payroll_records) AS payroll_records,
      (SELECT COUNT(*)::int FROM operations_logs) AS operations_logs
  `);

  return {
    ok: true,
    source: "postgres",
    generatedAt: new Date().toISOString(),
    ...result.rows[0],
  };
}

async function listDataApiEmployees({ activeOnly = true } = {}) {
  const result = await query(
    `
      SELECT
        id,
        notion_id AS "notionId",
        name,
        code,
        role,
        hourly_rate::float8 AS "hourlyRate",
        active,
        permissions,
        source,
        updated_at AS "updatedAt"
      FROM employees
      WHERE ($1::boolean = FALSE OR active = TRUE)
      ORDER BY active DESC, name ASC
    `,
    [activeOnly]
  );

  return result.rows;
}

async function listDataApiRooms({ date, employee = "", role = "" }) {
  const workDate = cleanDate(date);
  if (!workDate) {
    throw new Error("La fecha debe usar formato YYYY-MM-DD.");
  }

  const normalizedEmployee = String(employee || "").trim().toLowerCase();
  const normalizedRole = String(role || "").trim().toLowerCase();

  const result = await query(
    `
      SELECT
        r.id,
        r.notion_id AS "notionId",
        r.work_date::text AS date,
        r.room_number AS unit,
        r.normalized_room AS "normalizedRoom",
        r.room_type AS "roomType",
        r.building,
        r.cleaning_status AS status,
        r.guest_out AS "guestOut",
        r.guest_out_at AS "guestOutAt",
        r.urgent,
        r.arrival,
        r.stayover,
        r.assigned_cleaner AS "assignedCleaner",
        r.assigned_cleaners AS "assignedCleaners",
        r.assigned_inspector AS "assignedInspector",
        r.assigned_inspectors AS "assignedInspectors",
        r.started_at AS "startedAt",
        r.finished_at AS "finishedAt",
        r.inspection_started_at AS "inspectionStartedAt",
        r.ready_at AS "readyAt",
        r.pre_inspection AS "preInspection",
        r.pre_inspection_started AS "preInspectionStarted",
        r.pre_inspection_started_at AS "preInspectionStartedAt",
        r.pre_inspection_completed_at AS "preInspectionCompletedAt",
        r.updated_at AS "updatedAt"
      FROM rooms r
      WHERE r.work_date = $1::date
        AND (
          $2::text = ''
          OR EXISTS (
            SELECT 1
            FROM assignments a
            WHERE a.room_id = r.id
              AND a.active = TRUE
              AND a.normalized_employee = $2
              AND (
                $3::text = ''
                OR LOWER(a.assignment_role) = $3
              )
          )
        )
      ORDER BY
        r.urgent DESC,
        r.guest_out DESC,
        r.building ASC,
        r.normalized_room ASC
    `,
    [workDate, normalizedEmployee, normalizedRole]
  );

  return result.rows.map((room) => ({
    ...room,
    statusGroup: classifyRoomStatus(room.status),
  }));
}

async function getDataApiDashboard(date) {
  const workDate = cleanDate(date);
  if (!workDate) {
    throw new Error("La fecha debe usar formato YYYY-MM-DD.");
  }

  const [
    rooms,
    activeEmployeeResult,
    operationsResult,
    payrollResult,
    clockedInResult,
  ] = await Promise.all([
    listDataApiRooms({ date: workDate }),

    query(`
      SELECT COUNT(*)::int AS total
      FROM employees
      WHERE active = TRUE
    `),

    query(
      `
        SELECT
          id,
          event_time AS "eventTime",
          unit,
          normalized_room AS "normalizedRoom",
          action,
          cleaner,
          inspector,
          employee,
          role_worked AS role,
          note,
          photo_url AS "photoUrl",
          category,
          priority,
          source,
          created_at AS "createdAt"
        FROM operations_logs
        WHERE work_date = $1::date
        ORDER BY event_time DESC, id DESC
        LIMIT 100
      `,
      [workDate]
    ),

    query(
      `
        SELECT COALESCE(SUM(amount), 0)::float8 AS total
        FROM payroll_records
        WHERE work_date = $1::date
          AND LOWER(COALESCE(status, '')) <> 'cancelled'
      `,
      [workDate]
    ),

    query(
      `
        SELECT DISTINCT ON (normalized_employee)
          id,
          employee,
          role_worked AS role,
          clock_in AS "clockIn",
          clock_out AS "clockOut",
          hourly_rate::float8 AS "hourlyRate",
          status
        FROM time_clock_records
        WHERE clock_out IS NULL
          AND (clock_in AT TIME ZONE 'America/Chicago')::date = $1::date
        ORDER BY normalized_employee, clock_in DESC
      `,
      [workDate]
    ),
  ]);

  const stats = {
    totalUnits: rooms.length,
    pending: 0,
    inProgress: 0,
    awaitingInspection: 0,
    inspection: 0,
    ready: 0,
    guestOut: 0,
    arrivals: 0,
    stayovers: 0,
    urgent: 0,
    problems: 0,
    activeEmployees: activeEmployeeResult.rows[0]?.total || 0,
    clockedInEmployees: clockedInResult.rows.length,
    operations: operationsResult.rows.length,
  };

  const buildingMap = new Map();
  const cleaningDurations = [];
  const inspectionDurations = [];

  const enrichedRooms = rooms.map((room) => {
    const group = room.statusGroup || "pending";
    stats[group] = (stats[group] || 0) + 1;

    if (room.guestOut) stats.guestOut += 1;
    if (room.arrival) stats.arrivals += 1;
    if (room.stayover) stats.stayovers += 1;
    if (room.urgent) stats.urgent += 1;

    if (room.startedAt && room.finishedAt) {
      const minutes =
        (new Date(room.finishedAt).getTime() -
          new Date(room.startedAt).getTime()) /
        60000;

      if (minutes >= 1 && minutes <= 600) {
        cleaningDurations.push(minutes);
      }
    }

    if (room.inspectionStartedAt && room.readyAt) {
      const minutes =
        (new Date(room.readyAt).getTime() -
          new Date(room.inspectionStartedAt).getTime()) /
        60000;

      if (minutes >= 1 && minutes <= 300) {
        inspectionDurations.push(minutes);
      }
    }

    const operationalBuilding = classifyOperationalBuilding(room);

    if (!buildingMap.has(operationalBuilding)) {
      buildingMap.set(operationalBuilding, {
        building: operationalBuilding,
        total: 0,
        ready: 0,
        pending: 0,
        inProgress: 0,
        awaitingInspection: 0,
        inspection: 0,
        urgent: 0,
        units: [],
      });
    }

    const item = buildingMap.get(operationalBuilding);
    item.total += 1;
    item[group] = (item[group] || 0) + 1;

    if (group === "ready") item.ready += 1;
    else item.pending += 1;

    if (room.urgent) item.urgent += 1;

    item.units.push({
      id: room.id,
      unit: room.unit,
      status: room.status,
      statusGroup: group,
      urgent: Boolean(room.urgent),
      guestOut: Boolean(room.guestOut),
      arrival: Boolean(room.arrival),
      stayover: Boolean(room.stayover),
    });

    return {
      ...room,
      building: operationalBuilding,
      originalBuilding: room.building || "",
    };
  });

  const problemActions = new Set([
    "ISSUE",
    "INSPECTION_REPORT",
    "LOST_FOUND",
    "SUPPLIES",
    "INSPECTION_SUPPLIES",
  ]);

  const alerts = operationsResult.rows
    .filter((event) => {
      const action = String(event.action || "").trim().toUpperCase();
      const priority = String(event.priority || "").toLowerCase();

      return (
        problemActions.has(action) ||
        ["high", "urgent", "blocking"].some((word) =>
          priority.includes(word)
        )
      );
    })
    .slice(0, 25)
    .map((event) => ({
      id: event.id,
      unit: event.unit || "Operación",
      message:
        event.note ||
        event.action ||
        "Situación que requiere atención",
      severity: /high|urgent|blocking/i.test(
        String(event.priority || "")
      )
        ? "high"
        : "medium",
      action: event.action,
      time: event.eventTime,
      employee:
        event.employee ||
        event.cleaner ||
        event.inspector ||
        "",
    }));

  stats.problems = alerts.length;

  const buildingOrder = (value) => {
    if (value === "SUITES") return "ZZY";
    if (value === "CASAS") return "ZZZ";
    return value;
  };

  const buildings = Array.from(buildingMap.values())
    .map((building) => ({
      ...building,
      units: building.units.sort((a, b) =>
        String(a.unit).localeCompare(String(b.unit), undefined, {
          numeric: true,
          sensitivity: "base",
        })
      ),
    }))
    .sort((a, b) =>
      buildingOrder(a.building).localeCompare(
        buildingOrder(b.building),
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        }
      )
    );

  return {
    ok: true,
    source: "postgres",
    date: workDate,
    generatedAt: new Date().toISOString(),
    stats,
    averages: {
      averageCleaningMinutes: averageNumbers(cleaningDurations),
      averageInspectionMinutes: averageNumbers(inspectionDurations),
      cleaningSamples: cleaningDurations.length,
      inspectionSamples: inspectionDurations.length,
    },
    payroll: {
      total: numberValue(payrollResult.rows[0]?.total),
    },
    employees: {
      active: activeEmployeeResult.rows[0]?.total || 0,
      clockedIn: clockedInResult.rows,
    },
    alerts,
    timeline: operationsResult.rows.slice(0, 40).map((event) => ({
      ...event,
      person:
        event.employee ||
        event.cleaner ||
        event.inspector ||
        "",
      time: event.eventTime,
      message: event.note || "",
    })),
    buildings,
    rooms: enrichedRooms,
  };
}

async function getDataApiPayrollWeek({ start, end }) {
  const weekStart = cleanDate(start);
  const weekEnd = cleanDate(end);

  if (!weekStart || !weekEnd) {
    throw new Error("start y end deben usar formato YYYY-MM-DD.");
  }

  const result = await query(
    `
      SELECT
        id,
        notion_id AS "notionId",
        work_date::text AS date,
        employee,
        unit,
        room_type AS "roomType",
        gross_unit_amount::float8 AS "grossUnitAmount",
        split_count AS "splitCount",
        split_percent::float8 AS "splitPercent",
        amount::float8 AS amount,
        pay_type AS "payType",
        role_worked AS role,
        status,
        source,
        updated_at AS "updatedAt"
      FROM payroll_records
      WHERE week_start = $1::date
        AND week_end = $2::date
      ORDER BY work_date ASC, employee ASC, unit ASC, id ASC
    `,
    [weekStart, weekEnd]
  );

  const employeeMap = new Map();
  let total = 0;

  for (const record of result.rows) {
    const amount = numberValue(record.amount);
    total += amount;

    if (!employeeMap.has(record.employee)) {
      employeeMap.set(record.employee, {
        employee: record.employee,
        total: 0,
        units: 0,
        records: 0,
      });
    }

    const item = employeeMap.get(record.employee);
    item.total += amount;
    item.records += 1;
    if (record.payType === "unit" && record.unit) item.units += 1;
  }

  return {
    ok: true,
    source: "postgres",
    weekStart,
    weekEnd,
    generatedAt: new Date().toISOString(),
    count: result.rows.length,
    total: Number(total.toFixed(2)),
    employees: Array.from(employeeMap.values())
      .map((item) => ({
        ...item,
        total: Number(item.total.toFixed(2)),
      }))
      .sort((a, b) => b.total - a.total),
    records: result.rows,
  };
}

async function getDataApiBootstrap({
  date,
  employee = "",
  role = "",
  weekStart = "",
  weekEnd = "",
} = {}) {
  const workDate = cleanDate(date);
  if (!workDate) {
    throw new Error("La fecha debe usar formato YYYY-MM-DD.");
  }

  const [health, dashboard, employees] = await Promise.all([
    getDataApiHealth(),
    getDataApiDashboard(workDate),
    listDataApiEmployees({ activeOnly: true }),
  ]);

  let payroll = null;
  if (cleanDate(weekStart) && cleanDate(weekEnd)) {
    payroll = await getDataApiPayrollWeek({
      start: weekStart,
      end: weekEnd,
    });
  }

  const assignments = employee
    ? await listDataApiRooms({
        date: workDate,
        employee,
        role,
      })
    : [];

  return {
    ok: true,
    source: "postgres",
    generatedAt: new Date().toISOString(),
    health,
    dashboard,
    employees,
    assignments,
    payroll,
  };
}

module.exports = {
  cleanDate,
  classifyRoomStatus,
  classifyOperationalBuilding,
  getDataApiHealth,
  listDataApiEmployees,
  listDataApiRooms,
  getDataApiDashboard,
  getDataApiPayrollWeek,
  getDataApiBootstrap,
};
