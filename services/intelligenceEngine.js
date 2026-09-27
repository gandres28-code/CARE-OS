const { query } = require("../db");

const INTELLIGENCE_ENGINE_VERSION = "1.1.0-ultra";

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

function classifyBuilding(room) {
  const unit = normalizeText(room?.room_number || room?.unit || "");
  const roomType = normalizeText(room?.room_type || "").toLowerCase();
  const searchable = `${unit} ${roomType}`.toLowerCase();

  if (/\bsuite(?:s)?\b/i.test(searchable)) {
    return "SUITES";
  }

  const houseKeywords = [
    "sundowner",
    "sunrise",
    "cabin",
    "lodge",
    "house",
    "home",
    "villa",
    "bungalow",
    "cottage",
    "condo",
    "chalet",
    "retreat",
    "hideaway",
    "lakehouse",
    "farmhouse",
    "townhouse",
    "duplex",
    "triplex",
  ];

  if (houseKeywords.some((keyword) => searchable.includes(keyword))) {
    return "CASAS";
  }

  const cleaned = unit
    .replace(/\s+URGENTE\s*$/i, "")
    .replace(/\s*[-–—]\s*URGENTE\s*$/i, "")
    .trim();

  const match = cleaned.match(
    /(?:^|[\s\-–—])([A-Z])(?:\s*(?:\([^)]*\))?)?\s*$/i
  );

  return match ? match[1].toUpperCase() : "CASAS";
}

function median(values) {
  const valid = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (!valid.length) return 0;

  const middle = Math.floor(valid.length / 2);

  if (valid.length % 2 === 0) {
    return Number(((valid[middle - 1] + valid[middle]) / 2).toFixed(1));
  }

  return Number(valid[middle].toFixed(1));
}

function average(values) {
  const valid = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!valid.length) return 0;

  return Number(
    (valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1)
  );
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;

  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return 0;
  }

  return Math.max(0, (endTime - startTime) / 60000);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function estimateRemainingMinutes({
  pending,
  inProgress,
  awaitingInspection,
  inspection,
  avgCleaningMinutes,
  avgInspectionMinutes,
  activeCleaners,
  activeInspectors,
}) {
  const cleaners = Math.max(1, activeCleaners || 1);
  const inspectors = Math.max(1, activeInspectors || 1);

  const cleaningLoad =
    pending * avgCleaningMinutes +
    inProgress * Math.max(5, avgCleaningMinutes * 0.5);

  const inspectionLoad =
    awaitingInspection * avgInspectionMinutes +
    inspection * Math.max(2, avgInspectionMinutes * 0.5);

  const cleaningMinutes = cleaningLoad / cleaners;
  const inspectionMinutes = inspectionLoad / inspectors;

  return Math.max(0, Math.ceil(Math.max(cleaningMinutes, inspectionMinutes)));
}

async function fetchRooms(date) {
  const result = await query(
    `
      SELECT
        id,
        room_number,
        normalized_room,
        room_type,
        building,
        cleaning_status,
        guest_out,
        guest_out_at,
        urgent,
        arrival,
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
      WHERE work_date = $1::date
      ORDER BY room_number
    `,
    [date]
  );

  return result.rows;
}

async function fetchOpenClock(date) {
  const result = await query(
    `
      SELECT DISTINCT ON (normalized_employee)
        employee,
        normalized_employee,
        role_worked,
        clock_in,
        clock_out,
        status
      FROM time_clock_records
      WHERE clock_out IS NULL
        AND (clock_in AT TIME ZONE 'America/Chicago')::date = $1::date
      ORDER BY normalized_employee, clock_in DESC
    `,
    [date]
  );

  return result.rows;
}

async function fetchOperations(date) {
  const result = await query(
    `
      SELECT
        id,
        event_time,
        unit,
        normalized_room,
        action,
        cleaner,
        inspector,
        employee,
        role_worked,
        note,
        category,
        priority,
        source
      FROM operations_logs
      WHERE work_date = $1::date
      ORDER BY event_time ASC, id ASC
    `,
    [date]
  );

  return result.rows;
}

async function fetchPayroll(date) {
  const result = await query(
    `
      SELECT
        COALESCE(SUM(amount), 0)::float8 AS total,
        COUNT(*)::int AS records
      FROM payroll_records
      WHERE work_date = $1::date
        AND LOWER(COALESCE(status, '')) <> 'cancelled'
    `,
    [date]
  );

  return result.rows[0] || { total: 0, records: 0 };
}

function buildRoomState(room, operations, now) {
  const roomOps = operations.filter(
    (event) => event.normalized_room === room.normalized_room
  );

  const currentStatus = normalizeText(room.cleaning_status).toLowerCase();

  const statusGroup =
    currentStatus.includes("ready")
      ? "ready"
      : currentStatus.includes("inspection started")
        ? "inspection"
        : currentStatus.includes("awaiting inspection") ||
            currentStatus.includes("cleaned")
          ? "awaitingInspection"
          : currentStatus.includes("progress")
            ? "inProgress"
            : "pending";

  const cleaner =
    normalizeText(room.assigned_cleaner) ||
    (Array.isArray(room.assigned_cleaners)
      ? room.assigned_cleaners.join(", ")
      : "");

  const inspector =
    normalizeText(room.assigned_inspector) ||
    (Array.isArray(room.assigned_inspectors)
      ? room.assigned_inspectors.join(", ")
      : "");

  const currentDurationMinutes =
    statusGroup === "inProgress" && room.started_at
      ? minutesBetween(room.started_at, now)
      : statusGroup === "inspection" && room.inspection_started_at
        ? minutesBetween(room.inspection_started_at, now)
        : 0;

  const issueCount = roomOps.filter((event) =>
    ["ISSUE", "INSPECTION_REPORT"].includes(
      String(event.action || "").toUpperCase()
    )
  ).length;

  const supplyCount = roomOps.filter((event) =>
    ["SUPPLIES", "INSPECTION_SUPPLIES"].includes(
      String(event.action || "").toUpperCase()
    )
  ).length;

  return {
    id: room.id,
    unit: room.room_number,
    normalizedRoom: room.normalized_room,
    building: classifyBuilding(room),
    roomType: room.room_type,
    status: room.cleaning_status,
    statusGroup,
    cleaner,
    inspector,
    urgent: Boolean(room.urgent),
    arrival: Boolean(room.arrival),
    guestOut: Boolean(room.guest_out),
    startedAt: room.started_at,
    finishedAt: room.finished_at,
    inspectionStartedAt: room.inspection_started_at,
    readyAt: room.ready_at,
    currentDurationMinutes: Number(currentDurationMinutes.toFixed(1)),
    issueCount,
    supplyCount,
    lastAction: roomOps.at(-1)?.action || "",
    lastEventAt: roomOps.at(-1)?.event_time || null,
  };
}

function buildEmployeeStates(rooms, operations, clockedIn) {
  const map = new Map();

  function ensure(name, role = "") {
    const displayName = normalizeText(name);
    const key = normalizeEmployee(displayName);

    if (!key) return null;

    if (!map.has(key)) {
      map.set(key, {
        name: displayName,
        normalizedName: key,
        role,
        clockedIn: false,
        clockInAt: null,
        currentUnit: "",
        currentBuilding: "",
        roomsCompleted: 0,
        inspectionsCompleted: 0,
        cleaningDurations: [],
        inspectionDurations: [],
        problems: 0,
        supplyRequests: 0,
        lastAction: "",
        lastEventAt: null,
      });
    }

    const employee = map.get(key);

    if (!employee.role && role) {
      employee.role = role;
    }

    return employee;
  }

  for (const clock of clockedIn) {
    const employee = ensure(clock.employee, clock.role_worked);
    if (!employee) continue;

    employee.clockedIn = true;
    employee.clockInAt = clock.clock_in;
  }

  for (const room of rooms) {
    for (const cleanerName of String(room.cleaner || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)) {
      const employee = ensure(cleanerName, "Cleaner");
      if (!employee) continue;

      if (room.statusGroup === "inProgress") {
        employee.currentUnit = room.unit;
        employee.currentBuilding = room.building;
      }

      if (room.finishedAt) {
        employee.roomsCompleted += 1;
        const duration = minutesBetween(room.startedAt, room.finishedAt);
        if (duration > 0 && duration <= 600) {
          employee.cleaningDurations.push(duration);
        }
      }
    }

    for (const inspectorName of String(room.inspector || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)) {
      const employee = ensure(inspectorName, "Inspector");
      if (!employee) continue;

      if (room.statusGroup === "inspection") {
        employee.currentUnit = room.unit;
        employee.currentBuilding = room.building;
      }

      if (room.readyAt) {
        employee.inspectionsCompleted += 1;
        const duration = minutesBetween(
          room.inspectionStartedAt,
          room.readyAt
        );
        if (duration > 0 && duration <= 300) {
          employee.inspectionDurations.push(duration);
        }
      }
    }
  }

  for (const event of operations) {
    const employee = ensure(
      event.employee || event.cleaner || event.inspector,
      event.role_worked
    );

    if (!employee) continue;

    const action = String(event.action || "").toUpperCase();

    if (["ISSUE", "INSPECTION_REPORT"].includes(action)) {
      employee.problems += 1;
    }

    if (["SUPPLIES", "INSPECTION_SUPPLIES"].includes(action)) {
      employee.supplyRequests += 1;
    }

    employee.lastAction = action;
    employee.lastEventAt = event.event_time;
  }

  return Array.from(map.values())
    .map((employee) => {
      const avgCleaningMinutes = average(employee.cleaningDurations);
      const avgInspectionMinutes = average(employee.inspectionDurations);

      const completed =
        employee.roomsCompleted + employee.inspectionsCompleted;

      const qualityPenalty = employee.problems * 8;
      const productivityBase = completed * 6;
      const attendanceBonus = employee.clockedIn ? 12 : 0;

      return {
        name: employee.name,
        normalizedName: employee.normalizedName,
        role: employee.role,
        clockedIn: employee.clockedIn,
        clockInAt: employee.clockInAt,
        currentUnit: employee.currentUnit,
        currentBuilding: employee.currentBuilding,
        roomsCompleted: employee.roomsCompleted,
        inspectionsCompleted: employee.inspectionsCompleted,
        averageCleaningMinutes: avgCleaningMinutes,
        averageInspectionMinutes: avgInspectionMinutes,
        problems: employee.problems,
        supplyRequests: employee.supplyRequests,
        lastAction: employee.lastAction,
        lastEventAt: employee.lastEventAt,
        productivityScore: clamp(
          Math.round(productivityBase + attendanceBonus - qualityPenalty),
          0,
          100
        ),
      };
    })
    .sort((a, b) => {
      if (b.productivityScore !== a.productivityScore) {
        return b.productivityScore - a.productivityScore;
      }

      return a.name.localeCompare(b.name);
    });
}

function buildBuildings(roomStates, employees, averages, now) {
  const map = new Map();

  for (const room of roomStates) {
    if (!map.has(room.building)) {
      map.set(room.building, {
        building: room.building,
        total: 0,
        pending: 0,
        inProgress: 0,
        awaitingInspection: 0,
        inspection: 0,
        ready: 0,
        urgent: 0,
        arrivals: 0,
        activeCleaners: new Set(),
        activeInspectors: new Set(),
        rooms: [],
      });
    }

    const building = map.get(room.building);
    building.total += 1;
    building[room.statusGroup] += 1;
    if (room.urgent) building.urgent += 1;
    if (room.arrival) building.arrivals += 1;

    if (room.statusGroup === "inProgress" && room.cleaner) {
      room.cleaner
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => building.activeCleaners.add(name));
    }

    if (room.statusGroup === "inspection" && room.inspector) {
      room.inspector
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => building.activeInspectors.add(name));
    }

    building.rooms.push(room);
  }

  return Array.from(map.values())
    .map((building) => {
      const completionPercent = building.total
        ? Math.round((building.ready / building.total) * 100)
        : 0;

      const remainingMinutes = estimateRemainingMinutes({
        pending: building.pending,
        inProgress: building.inProgress,
        awaitingInspection: building.awaitingInspection,
        inspection: building.inspection,
        avgCleaningMinutes: averages.averageCleaningMinutes || 35,
        avgInspectionMinutes: averages.averageInspectionMinutes || 6,
        activeCleaners: building.activeCleaners.size,
        activeInspectors: building.activeInspectors.size,
      });

      return {
        building: building.building,
        total: building.total,
        pending: building.pending,
        inProgress: building.inProgress,
        awaitingInspection: building.awaitingInspection,
        inspection: building.inspection,
        ready: building.ready,
        urgent: building.urgent,
        arrivals: building.arrivals,
        activeCleaners: Array.from(building.activeCleaners),
        activeInspectors: Array.from(building.activeInspectors),
        completionPercent,
        estimatedRemainingMinutes: remainingMinutes,
        estimatedFinishAt: new Date(
          now.getTime() + remainingMinutes * 60000
        ).toISOString(),
        rooms: building.rooms,
      };
    })
    .sort((a, b) => {
      if (a.building === "SUITES") return 1;
      if (b.building === "SUITES") return -1;
      if (a.building === "CASAS") return 1;
      if (b.building === "CASAS") return -1;
      return a.building.localeCompare(b.building, undefined, {
        numeric: true,
      });
    });
}

function buildAlerts(roomStates, employees, buildings, now) {
  const alerts = [];

  for (const room of roomStates) {
    if (
      room.statusGroup === "inProgress" &&
      room.currentDurationMinutes >= 60
    ) {
      alerts.push({
        type: "slow-cleaning",
        severity: room.currentDurationMinutes >= 90 ? "high" : "medium",
        unit: room.unit,
        building: room.building,
        employee: room.cleaner,
        message: `${room.unit} lleva ${Math.round(
          room.currentDurationMinutes
        )} minutos en limpieza.`,
      });
    }

    if (
      room.statusGroup === "inspection" &&
      room.currentDurationMinutes >= 20
    ) {
      alerts.push({
        type: "slow-inspection",
        severity: room.currentDurationMinutes >= 35 ? "high" : "medium",
        unit: room.unit,
        building: room.building,
        employee: room.inspector,
        message: `${room.unit} lleva ${Math.round(
          room.currentDurationMinutes
        )} minutos en inspección.`,
      });
    }

    if (room.guestOut && !room.cleaner && room.statusGroup === "pending") {
      alerts.push({
        type: "unassigned-guest-out",
        severity: "high",
        unit: room.unit,
        building: room.building,
        employee: "",
        message: `${room.unit} tiene Guest Out y no tiene limpiador asignado.`,
      });
    }

    if (room.issueCount > 0) {
      alerts.push({
        type: "quality-problem",
        severity: room.issueCount >= 2 ? "high" : "medium",
        unit: room.unit,
        building: room.building,
        employee: room.cleaner || room.inspector,
        message: `${room.unit} tiene ${room.issueCount} reporte(s) de calidad.`,
      });
    }
  }

  for (const employee of employees) {
    if (employee.problems >= 3) {
      alerts.push({
        type: "employee-quality",
        severity: "high",
        unit: employee.currentUnit,
        building: employee.currentBuilding,
        employee: employee.name,
        message: `${employee.name} acumula ${employee.problems} reportes hoy.`,
      });
    }
  }

  for (const building of buildings) {
    if (
      building.completionPercent < 50 &&
      building.estimatedRemainingMinutes >= 120
    ) {
      alerts.push({
        type: "building-delay",
        severity: "medium",
        unit: "",
        building: building.building,
        employee: "",
        message: `Building ${building.building} podría tardar más de 2 horas en terminar.`,
      });
    }
  }

  return alerts
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return (rank[a.severity] || 9) - (rank[b.severity] || 9);
    })
    .slice(0, 50);
}

async function persistSnapshot(snapshot) {
  await query(
    `
      INSERT INTO intelligence_snapshots (
        work_date,
        generated_at,
        version,
        payload,
        total_units,
        ready_units,
        active_employees,
        estimated_remaining_minutes,
        payroll_actual,
        payroll_estimated
      )
      VALUES (
        $1::date,
        $2::timestamptz,
        $3,
        $4::jsonb,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10
      )
      ON CONFLICT (work_date)
      DO UPDATE SET
        generated_at = EXCLUDED.generated_at,
        version = EXCLUDED.version,
        payload = EXCLUDED.payload,
        total_units = EXCLUDED.total_units,
        ready_units = EXCLUDED.ready_units,
        active_employees = EXCLUDED.active_employees,
        estimated_remaining_minutes =
          EXCLUDED.estimated_remaining_minutes,
        payroll_actual = EXCLUDED.payroll_actual,
        payroll_estimated = EXCLUDED.payroll_estimated,
        updated_at = NOW()
    `,
    [
      snapshot.date,
      snapshot.generatedAt,
      INTELLIGENCE_ENGINE_VERSION,
      JSON.stringify(snapshot),
      snapshot.summary.totalUnits,
      snapshot.summary.ready,
      snapshot.summary.activeEmployees,
      snapshot.predictions.estimatedRemainingMinutes,
      snapshot.payroll.actual,
      snapshot.payroll.estimatedFinal,
    ]
  );
}

async function buildSnapshot(date = chicagoDate()) {
  const now = new Date();

  const [rooms, operations, clockedIn, payroll] = await Promise.all([
    fetchRooms(date),
    fetchOperations(date),
    fetchOpenClock(date),
    fetchPayroll(date),
  ]);

  const roomStates = rooms.map((room) =>
    buildRoomState(room, operations, now)
  );

  const cleaningDurations = roomStates
    .map((room) => minutesBetween(room.startedAt, room.finishedAt))
    .filter((value) => value > 0 && value <= 600);

  const inspectionDurations = roomStates
    .map((room) =>
      minutesBetween(room.inspectionStartedAt, room.readyAt)
    )
    .filter((value) => value > 0 && value <= 300);

  const averages = {
    averageCleaningMinutes: average(cleaningDurations),
    medianCleaningMinutes: median(cleaningDurations),
    averageInspectionMinutes: average(inspectionDurations),
    medianInspectionMinutes: median(inspectionDurations),
    cleaningSamples: cleaningDurations.length,
    inspectionSamples: inspectionDurations.length,
  };

  const employees = buildEmployeeStates(
    roomStates,
    operations,
    clockedIn
  );

  const buildings = buildBuildings(
    roomStates,
    employees,
    averages,
    now
  );

  const counts = {
    totalUnits: roomStates.length,
    pending: roomStates.filter((room) => room.statusGroup === "pending").length,
    inProgress: roomStates.filter((room) => room.statusGroup === "inProgress").length,
    awaitingInspection: roomStates.filter(
      (room) => room.statusGroup === "awaitingInspection"
    ).length,
    inspection: roomStates.filter(
      (room) => room.statusGroup === "inspection"
    ).length,
    ready: roomStates.filter((room) => room.statusGroup === "ready").length,
    activeEmployees: employees.filter((employee) => employee.clockedIn).length,
    activeCleaners: employees.filter(
      (employee) =>
        employee.clockedIn &&
        String(employee.role || "").toLowerCase().includes("cleaner")
    ).length,
    activeInspectors: employees.filter(
      (employee) =>
        employee.clockedIn &&
        String(employee.role || "").toLowerCase().includes("inspector")
    ).length,
  };

  const estimatedRemainingMinutes = estimateRemainingMinutes({
    pending: counts.pending,
    inProgress: counts.inProgress,
    awaitingInspection: counts.awaitingInspection,
    inspection: counts.inspection,
    avgCleaningMinutes: averages.averageCleaningMinutes || 35,
    avgInspectionMinutes: averages.averageInspectionMinutes || 6,
    activeCleaners: counts.activeCleaners,
    activeInspectors: counts.activeInspectors,
  });

  const completedUnits = Math.max(1, counts.ready);
  const averagePayrollPerCompletedUnit =
    Number(payroll.total || 0) / completedUnits;
  const estimatedFinalPayroll =
    counts.totalUnits > 0
      ? roundMoney(
          Math.max(
            Number(payroll.total || 0),
            averagePayrollPerCompletedUnit * counts.totalUnits
          )
        )
      : Number(payroll.total || 0);

  const alerts = buildAlerts(
    roomStates,
    employees,
    buildings,
    now
  );

  const confidenceBase =
    50 +
    Math.min(25, averages.cleaningSamples * 2) +
    Math.min(15, averages.inspectionSamples * 3) +
    Math.min(10, counts.activeEmployees * 2);

  const snapshot = {
    ok: true,
    source: "postgres",
    version: INTELLIGENCE_ENGINE_VERSION,
    date,
    generatedAt: now.toISOString(),
    summary: counts,
    averages,
    predictions: {
      estimatedRemainingMinutes,
      estimatedFinishAt: new Date(
        now.getTime() + estimatedRemainingMinutes * 60000
      ).toISOString(),
      confidence: clamp(confidenceBase, 45, 98),
      nextBuildingToFinish:
        buildings
          .filter((building) => building.ready < building.total)
          .sort(
            (a, b) =>
              a.estimatedRemainingMinutes -
              b.estimatedRemainingMinutes
          )[0]?.building || "",
    },
    payroll: {
      actual: roundMoney(payroll.total || 0),
      records: Number(payroll.records || 0),
      estimatedFinal: estimatedFinalPayroll,
    },
    alerts,
    buildings,
    employees,
    rooms: roomStates,
  };

  await persistSnapshot(snapshot);

  return snapshot;
}

async function getLatestSnapshot(date = chicagoDate()) {
  const result = await query(
    `
      SELECT
        payload,
        generated_at
      FROM intelligence_snapshots
      WHERE work_date = $1::date
      LIMIT 1
    `,
    [date]
  );

  return result.rows[0]?.payload || null;
}

function createIntelligenceEngine({
  io = null,
  refreshDebounceMs = Number(
    process.env.INTELLIGENCE_REFRESH_DEBOUNCE_MS || 2500
  ),
} = {}) {
  let timer = null;
  let refreshing = false;
  let queuedDate = "";

  async function refresh(date = chicagoDate(), reason = "manual") {
    if (refreshing) {
      queuedDate = date;
      return getLatestSnapshot(date);
    }

    refreshing = true;

    try {
      const snapshot = await buildSnapshot(date);

      if (io?.emit) {
        io.emit("intelligence-updated", {
          reason,
          date,
          generatedAt: snapshot.generatedAt,
          summary: snapshot.summary,
          predictions: snapshot.predictions,
          payroll: snapshot.payroll,
          alerts: snapshot.alerts,
        });
      }

      return snapshot;
    } finally {
      refreshing = false;

      if (queuedDate) {
        const nextDate = queuedDate;
        queuedDate = "";
        setTimeout(() => {
          refresh(nextDate, "queued").catch((error) => {
            console.error(
              "INTELLIGENCE QUEUED REFRESH ERROR:",
              error.message
            );
          });
        }, 50);
      }
    }
  }

  function scheduleRefresh(date = chicagoDate(), reason = "event") {
    clearTimeout(timer);

    timer = setTimeout(() => {
      refresh(date, reason).catch((error) => {
        console.error(
          "INTELLIGENCE REFRESH ERROR:",
          error.message
        );
      });
    }, refreshDebounceMs);

    timer.unref?.();
  }

  async function get(date = chicagoDate(), { fresh = false } = {}) {
    if (fresh) {
      return refresh(date, "fresh-request");
    }

    const cached = await getLatestSnapshot(date);

    if (cached) {
      const ageMs =
        Date.now() - new Date(cached.generatedAt || 0).getTime();

      if (
        Number.isFinite(ageMs) &&
        ageMs <= Number(process.env.INTELLIGENCE_SNAPSHOT_TTL_MS || 30000)
      ) {
        return cached;
      }
    }

    return refresh(date, "cache-miss");
  }

  async function status() {
    const result = await query(`
      SELECT
        COUNT(*)::int AS snapshots,
        MAX(generated_at) AS last_generated_at,
        MAX(updated_at) AS last_updated_at
      FROM intelligence_snapshots
    `);

    return {
      ok: true,
      version: INTELLIGENCE_ENGINE_VERSION,
      refreshing,
      queuedDate,
      ...result.rows[0],
    };
  }

  return {
    version: INTELLIGENCE_ENGINE_VERSION,
    refresh,
    scheduleRefresh,
    get,
    status,
  };
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  INTELLIGENCE_ENGINE_VERSION,
  createIntelligenceEngine,
  classifyBuilding,
};
