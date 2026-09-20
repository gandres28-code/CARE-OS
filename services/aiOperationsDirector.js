const { query } = require("../db");

const AI_OPERATIONS_DIRECTOR_VERSION = "1.1.0-ultra";

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}

function priorityRank(priority) {
  const ranks = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };

  return ranks[String(priority || "").toLowerCase()] ?? 9;
}

function createRecommendation({
  type,
  priority = "medium",
  title,
  message,
  action,
  unit = "",
  building = "",
  employee = "",
  score = 50,
  metadata = {},
}) {
  return {
    id: [
      type,
      building,
      unit,
      employee,
      normalizeText(title),
    ]
      .join("|")
      .toLowerCase()
      .replace(/[^a-z0-9|]+/g, "-")
      .slice(0, 180),
    type,
    priority,
    title,
    message,
    action,
    unit,
    building,
    employee,
    score: clamp(score, 0, 100),
    metadata,
  };
}

function calculateOperationScore(snapshot) {
  const summary = snapshot.summary || {};
  const total = Math.max(1, Number(summary.totalUnits || 0));
  const ready = Number(summary.ready || 0);
  const alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts : [];

  const completionScore = (ready / total) * 55;
  const activeScore = Math.min(
    20,
    Number(summary.activeEmployees || 0) * 2.5
  );

  const criticalAlerts = alerts.filter(
    (alert) => String(alert.severity).toLowerCase() === "high"
  ).length;

  const mediumAlerts = alerts.filter(
    (alert) => String(alert.severity).toLowerCase() === "medium"
  ).length;

  const alertPenalty = criticalAlerts * 7 + mediumAlerts * 3;

  const etaMinutes = Number(
    snapshot.predictions?.estimatedRemainingMinutes || 0
  );

  const etaPenalty =
    etaMinutes > 240
      ? 20
      : etaMinutes > 180
        ? 14
        : etaMinutes > 120
          ? 8
          : etaMinutes > 60
            ? 3
            : 0;

  return Math.round(
    clamp(completionScore + activeScore + 25 - alertPenalty - etaPenalty, 0, 100)
  );
}

function operationGrade(score) {
  if (score >= 90) return "Excelente";
  if (score >= 78) return "Muy bien";
  if (score >= 65) return "Estable";
  if (score >= 50) return "En riesgo";
  return "Crítica";
}

function buildBottleneckRecommendations(snapshot) {
  const summary = snapshot.summary || {};
  const recommendations = [];

  const waitingInspection = Number(
    summary.awaitingInspection || 0
  );

  const activeInspectors = Math.max(
    0,
    Number(summary.activeInspectors || 0)
  );

  if (waitingInspection >= 5 && activeInspectors <= 1) {
    recommendations.push(
      createRecommendation({
        type: "inspection-bottleneck",
        priority: waitingInspection >= 10 ? "critical" : "high",
        title: "Cuello de botella en inspecciones",
        message:
          `${waitingInspection} habitaciones esperan inspección y ` +
          `${activeInspectors || 0} inspector(es) aparecen activos.`,
        action:
          "Mover temporalmente un inspector adicional a las habitaciones que llevan más tiempo esperando.",
        score: Math.min(100, 60 + waitingInspection * 4),
        metadata: {
          waitingInspection,
          activeInspectors,
        },
      })
    );
  }

  const inProgress = Number(summary.inProgress || 0);
  const activeCleaners = Math.max(
    0,
    Number(summary.activeCleaners || 0)
  );

  if (inProgress >= 8 && activeCleaners <= 2) {
    recommendations.push(
      createRecommendation({
        type: "cleaning-capacity",
        priority: inProgress >= 14 ? "critical" : "high",
        title: "Capacidad de limpieza limitada",
        message:
          `${inProgress} habitaciones están en limpieza con ` +
          `${activeCleaners || 0} limpiador(es) activos.`,
        action:
          "Revisar Clock In y asignaciones. Reubicar apoyo hacia las unidades urgentes y arrivals.",
        score: Math.min(100, 55 + inProgress * 3),
        metadata: {
          inProgress,
          activeCleaners,
        },
      })
    );
  }

  return recommendations;
}

function buildBuildingRecommendations(snapshot) {
  const buildings = Array.isArray(snapshot.buildings)
    ? snapshot.buildings
    : [];

  const recommendations = [];

  for (const building of buildings) {
    const remaining = Number(
      building.estimatedRemainingMinutes || 0
    );
    const completion = Number(
      building.completionPercent || 0
    );
    const urgent = Number(building.urgent || 0);
    const waiting = Number(
      building.awaitingInspection || 0
    );

    if (remaining >= 120 && completion < 70) {
      recommendations.push(
        createRecommendation({
          type: "building-delay",
          priority: remaining >= 180 ? "critical" : "high",
          title: `${labelBuilding(building.building)} está retrasado`,
          message:
            `Progreso ${completion}% y ETA aproximada de ` +
            `${Math.round(remaining)} minutos.`,
          action:
            urgent > 0
              ? "Priorizar las unidades urgentes y mover apoyo desde el edificio más adelantado."
              : "Mover al menos una persona desde un edificio adelantado y revisar las unidades sin iniciar.",
          building: building.building,
          score: Math.min(100, 55 + remaining / 4),
          metadata: {
            completion,
            remaining,
            urgent,
            waiting,
          },
        })
      );
    }

    if (waiting >= 4) {
      recommendations.push(
        createRecommendation({
          type: "building-inspection-backlog",
          priority: waiting >= 8 ? "high" : "medium",
          title: `${labelBuilding(building.building)} necesita inspección`,
          message:
            `${waiting} habitaciones están listas para inspeccionar.`,
          action:
            "Enviar al próximo inspector disponible a este edificio.",
          building: building.building,
          score: Math.min(100, 45 + waiting * 6),
          metadata: { waiting },
        })
      );
    }

    if (urgent >= 2) {
      recommendations.push(
        createRecommendation({
          type: "urgent-cluster",
          priority: urgent >= 4 ? "critical" : "high",
          title: `Urgencias concentradas en ${labelBuilding(building.building)}`,
          message:
            `${urgent} habitaciones urgentes están dentro del mismo grupo.`,
          action:
            "Crear una mini-ruta urgente y asignar un cleaner e inspector dedicados hasta despejarla.",
          building: building.building,
          score: Math.min(100, 65 + urgent * 7),
          metadata: { urgent },
        })
      );
    }
  }

  return recommendations;
}

function buildEmployeeRecommendations(snapshot) {
  const employees = Array.isArray(snapshot.employees)
    ? snapshot.employees
    : [];

  const recommendations = [];

  const cleanerLoads = employees
    .filter((employee) =>
      String(employee.role || "").toLowerCase().includes("cleaner")
    )
    .map((employee) => ({
      ...employee,
      load: Number(employee.roomsCompleted || 0) +
        (employee.currentUnit ? 1 : 0),
    }));

  const averageLoad = cleanerLoads.length
    ? cleanerLoads.reduce((sum, employee) => sum + employee.load, 0) /
      cleanerLoads.length
    : 0;

  for (const employee of employees) {
    const problems = Number(employee.problems || 0);
    const score = Number(employee.productivityScore || 0);
    const cleaningAverage = Number(
      employee.averageCleaningMinutes || 0
    );

    if (problems >= 3) {
      recommendations.push(
        createRecommendation({
          type: "employee-quality",
          priority: problems >= 5 ? "critical" : "high",
          title: `Revisar calidad de ${employee.name}`,
          message:
            `${employee.name} acumula ${problems} reportes en la operación actual.`,
          action:
            "Revisar los reportes antes de asignar más habitaciones y ofrecer corrección específica.",
          employee: employee.name,
          unit: employee.currentUnit || "",
          building: employee.currentBuilding || "",
          score: Math.min(100, 60 + problems * 7),
          metadata: {
            problems,
            productivityScore: score,
          },
        })
      );
    }

    if (cleaningAverage >= 60 && Number(employee.roomsCompleted || 0) >= 2) {
      recommendations.push(
        createRecommendation({
          type: "employee-speed",
          priority: cleaningAverage >= 85 ? "high" : "medium",
          title: `${employee.name} está por encima del tiempo objetivo`,
          message:
            `Promedio de limpieza: ${cleaningAverage.toFixed(1)} minutos.`,
          action:
            "Revisar si las unidades son más grandes, si faltan supplies o si necesita apoyo.",
          employee: employee.name,
          unit: employee.currentUnit || "",
          building: employee.currentBuilding || "",
          score: Math.min(100, 45 + cleaningAverage / 2),
          metadata: {
            cleaningAverage,
          },
        })
      );
    }

    const employeeLoad =
      Number(employee.roomsCompleted || 0) +
      (employee.currentUnit ? 1 : 0);

    if (
      averageLoad > 0 &&
      employeeLoad >= Math.max(8, averageLoad * 1.6)
    ) {
      recommendations.push(
        createRecommendation({
          type: "employee-overload",
          priority: employeeLoad >= 13 ? "high" : "medium",
          title: `${employee.name} tiene carga alta`,
          message:
            `${employeeLoad} habitaciones activas/completadas frente a un promedio de ` +
            `${averageLoad.toFixed(1)}.`,
          action:
            "Mover una o dos habitaciones pendientes hacia una persona con menor carga.",
          employee: employee.name,
          unit: employee.currentUnit || "",
          building: employee.currentBuilding || "",
          score: Math.min(100, 55 + employeeLoad * 3),
          metadata: {
            employeeLoad,
            averageLoad,
          },
        })
      );
    }
  }

  return recommendations;
}

function buildRoomRecommendations(snapshot) {
  const rooms = Array.isArray(snapshot.rooms)
    ? snapshot.rooms
    : [];

  const recommendations = [];

  for (const room of rooms) {
    const duration = Number(room.currentDurationMinutes || 0);

    if (
      room.statusGroup === "inProgress" &&
      duration >= 70
    ) {
      recommendations.push(
        createRecommendation({
          type: "room-cleaning-delay",
          priority: duration >= 100 ? "critical" : "high",
          title: `${room.unit} lleva demasiado tiempo`,
          message:
            `La limpieza lleva aproximadamente ${Math.round(duration)} minutos.`,
          action:
            "Contactar al cleaner para confirmar si hay daño, suciedad extraordinaria o falta de supplies.",
          unit: room.unit,
          building: room.building,
          employee: room.cleaner,
          score: Math.min(100, 55 + duration / 2),
          metadata: {
            duration,
            status: room.status,
          },
        })
      );
    }

    if (
      room.statusGroup === "inspection" &&
      duration >= 25
    ) {
      recommendations.push(
        createRecommendation({
          type: "room-inspection-delay",
          priority: duration >= 45 ? "high" : "medium",
          title: `${room.unit} está detenida en inspección`,
          message:
            `La inspección lleva aproximadamente ${Math.round(duration)} minutos.`,
          action:
            "Verificar si existe un problema de limpieza o si el inspector necesita apoyo.",
          unit: room.unit,
          building: room.building,
          employee: room.inspector,
          score: Math.min(100, 45 + duration),
          metadata: {
            duration,
            status: room.status,
          },
        })
      );
    }

    if (
      room.guestOut &&
      !normalizeText(room.cleaner) &&
      room.statusGroup === "pending"
    ) {
      recommendations.push(
        createRecommendation({
          type: "unassigned-guest-out",
          priority: room.urgent ? "critical" : "high",
          title: `${room.unit} necesita cleaner`,
          message:
            "La unidad tiene Guest Out y continúa sin limpiador asignado.",
          action:
            "Asignar inmediatamente al cleaner disponible con menor carga en el mismo edificio.",
          unit: room.unit,
          building: room.building,
          score: room.urgent ? 98 : 85,
          metadata: {
            urgent: Boolean(room.urgent),
            arrival: Boolean(room.arrival),
          },
        })
      );
    }
  }

  return recommendations;
}

function buildPayrollRecommendations(snapshot) {
  const payroll = snapshot.payroll || {};
  const actual = Number(payroll.actual || 0);
  const projected = Number(payroll.estimatedFinal || 0);

  if (!actual || projected <= actual) {
    return [];
  }

  const increasePercent = ((projected - actual) / actual) * 100;

  if (increasePercent < 20) {
    return [];
  }

  return [
    createRecommendation({
      type: "payroll-growth",
      priority: increasePercent >= 40 ? "high" : "medium",
      title: "Payroll proyectado por encima del actual",
      message:
        `El payroll podría subir de $${actual.toFixed(2)} a ` +
        `$${projected.toFixed(2)} (${increasePercent.toFixed(1)}%).`,
      action:
        "Revisar unidades faltantes, splits y tarifas antes del cierre del día.",
      score: Math.min(100, 40 + increasePercent),
      metadata: {
        actual,
        projected,
        increasePercent,
      },
    }),
  ];
}

function labelBuilding(value) {
  const text = String(value || "").toUpperCase();

  if (text === "CASAS") return "Casas";
  if (text === "SUITES") return "Suites";

  return `Building ${text}`;
}

function buildExecutiveSummary(snapshot, recommendations, score) {
  const summary = snapshot.summary || {};
  const predictions = snapshot.predictions || {};
  const critical = recommendations.filter(
    (item) => item.priority === "critical"
  ).length;
  const high = recommendations.filter(
    (item) => item.priority === "high"
  ).length;

  const nextBuilding = predictions.nextBuildingToFinish
    ? labelBuilding(predictions.nextBuildingToFinish)
    : "ningún grupo identificado";

  return (
    `${operationGrade(score)}. ` +
    `${Number(summary.ready || 0)} de ${Number(summary.totalUnits || 0)} ` +
    `habitaciones están listas. ` +
    `ETA general: ${Math.round(
      Number(predictions.estimatedRemainingMinutes || 0)
    )} minutos. ` +
    `El siguiente grupo en terminar es ${nextBuilding}. ` +
    `${critical} recomendación(es) crítica(s) y ${high} de prioridad alta.`
  );
}

async function persistDirectorSnapshot(result) {
  await query(
    `
      INSERT INTO ai_director_snapshots (
        work_date,
        generated_at,
        version,
        operation_score,
        operation_grade,
        summary,
        recommendations,
        payload
      )
      VALUES (
        $1::date,
        $2::timestamptz,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb,
        $8::jsonb
      )
      ON CONFLICT (work_date)
      DO UPDATE SET
        generated_at = EXCLUDED.generated_at,
        version = EXCLUDED.version,
        operation_score = EXCLUDED.operation_score,
        operation_grade = EXCLUDED.operation_grade,
        summary = EXCLUDED.summary,
        recommendations = EXCLUDED.recommendations,
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `,
    [
      result.date,
      result.generatedAt,
      AI_OPERATIONS_DIRECTOR_VERSION,
      result.operation.score,
      result.operation.grade,
      result.summary,
      JSON.stringify(result.recommendations),
      JSON.stringify(result),
    ]
  );
}

async function fetchLatestDirectorSnapshot(date) {
  const result = await query(
    `
      SELECT payload
      FROM ai_director_snapshots
      WHERE work_date = $1::date
      LIMIT 1
    `,
    [date]
  );

  return result.rows[0]?.payload || null;
}

function createAIOperationsDirector({
  intelligenceEngine,
  io = null,
  debounceMs = Number(
    process.env.AI_DIRECTOR_REFRESH_DEBOUNCE_MS || 5000
  ),
} = {}) {
  if (!intelligenceEngine) {
    throw new Error(
      "createAIOperationsDirector necesita intelligenceEngine"
    );
  }

  let timer = null;
  let generating = false;
  let queuedDate = "";

  async function generate(
    date,
    { freshIntelligence = false, reason = "manual" } = {}
  ) {
    if (generating) {
      queuedDate = date;
      return fetchLatestDirectorSnapshot(date);
    }

    generating = true;

    try {
      const snapshot = await intelligenceEngine.get(date, {
        fresh: freshIntelligence,
      });

      const recommendations = [
        ...buildBottleneckRecommendations(snapshot),
        ...buildBuildingRecommendations(snapshot),
        ...buildEmployeeRecommendations(snapshot),
        ...buildRoomRecommendations(snapshot),
        ...buildPayrollRecommendations(snapshot),
      ]
        .sort((a, b) => {
          const priorityDifference =
            priorityRank(a.priority) - priorityRank(b.priority);

          if (priorityDifference !== 0) {
            return priorityDifference;
          }

          return Number(b.score || 0) - Number(a.score || 0);
        })
        .slice(0, 40);

      const score = calculateOperationScore(snapshot);
      const grade = operationGrade(score);

      const result = {
        ok: true,
        source: "ai-operations-director",
        version: AI_OPERATIONS_DIRECTOR_VERSION,
        date,
        generatedAt: new Date().toISOString(),
        reason,
        operation: {
          score,
          grade,
          criticalRecommendations: recommendations.filter(
            (item) => item.priority === "critical"
          ).length,
          highRecommendations: recommendations.filter(
            (item) => item.priority === "high"
          ).length,
          totalRecommendations: recommendations.length,
        },
        summary: buildExecutiveSummary(
          snapshot,
          recommendations,
          score
        ),
        recommendations,
        intelligenceGeneratedAt: snapshot.generatedAt,
      };

      await persistDirectorSnapshot(result);

      if (io?.emit) {
        io.emit("ai-director-updated", {
          date,
          generatedAt: result.generatedAt,
          operation: result.operation,
          summary: result.summary,
          recommendations: result.recommendations.slice(0, 12),
        });
      }

      return result;
    } finally {
      generating = false;

      if (queuedDate) {
        const nextDate = queuedDate;
        queuedDate = "";

        setTimeout(() => {
          generate(nextDate, {
            reason: "queued",
          }).catch((error) => {
            console.error(
              "AI DIRECTOR QUEUED GENERATION ERROR:",
              error.message
            );
          });
        }, 50);
      }
    }
  }

  function schedule(date, reason = "event") {
    clearTimeout(timer);

    timer = setTimeout(() => {
      generate(date, { reason }).catch((error) => {
        console.error(
          "AI DIRECTOR GENERATION ERROR:",
          error.message
        );
      });
    }, debounceMs);

    timer.unref?.();
  }

  async function get(date, { fresh = false } = {}) {
    if (fresh) {
      return generate(date, {
        freshIntelligence: true,
        reason: "fresh-request",
      });
    }

    const cached = await fetchLatestDirectorSnapshot(date);

    if (cached) {
      const ageMs =
        Date.now() -
        new Date(cached.generatedAt || 0).getTime();

      if (
        Number.isFinite(ageMs) &&
        ageMs <= Number(
          process.env.AI_DIRECTOR_SNAPSHOT_TTL_MS || 30000
        )
      ) {
        return cached;
      }
    }

    return generate(date, {
      reason: "cache-miss",
    });
  }

  async function status() {
    const result = await query(`
      SELECT
        COUNT(*)::int AS snapshots,
        MAX(generated_at) AS last_generated_at,
        MAX(updated_at) AS last_updated_at
      FROM ai_director_snapshots
    `);

    return {
      ok: true,
      version: AI_OPERATIONS_DIRECTOR_VERSION,
      generating,
      queuedDate,
      ...result.rows[0],
    };
  }

  return {
    version: AI_OPERATIONS_DIRECTOR_VERSION,
    generate,
    schedule,
    get,
    status,
  };
}

module.exports = {
  AI_OPERATIONS_DIRECTOR_VERSION,
  createAIOperationsDirector,
};
