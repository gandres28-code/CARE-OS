function dbQuery(text, params = []) {
  return require("../../db").query(text, params);
}

const QUALITY_ENGINE_VERSION = "1.0.0";
const VALID_SEVERITIES = new Set(["critical", "major", "medium", "minor"]);

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeEmployee(value) {
  return normalizeText(value).toLowerCase();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const duration = (new Date(end).getTime() - new Date(start).getTime()) / 60000;
  return Number.isFinite(duration) && duration > 0 ? Number(duration.toFixed(1)) : 0;
}

function issueSeverity(issue) {
  const explicit = normalizeText(issue?.severity).toLowerCase();
  if (VALID_SEVERITIES.has(explicit)) return explicit;

  const text = `${issue?.category || ""} ${issue?.label || ""} ${issue?.issue || ""} ${issue?.description || ""}`.toLowerCase();
  if (/stain|mancha|duvet|soap|jab[oó]n|food|comida|lost.?found|guest item|basura.*caj[oó]n/.test(text)) return "critical";
  if (/appliance|electrodom[eé]stico|floor|piso|carpet|alfombra|dust|polvo|window|ventana|lock|seguro/.test(text)) return "major";
  if (/coffee|cafetera|toaster|tostadora|crumb|migaja|duvet fold|doblez/.test(text)) return "medium";
  return "minor";
}

function summarizeIssues(issues = []) {
  const summary = { critical: 0, major: 0, medium: 0, minor: 0, total: 0, categories: {} };
  for (const raw of Array.isArray(issues) ? issues : []) {
    const issue = typeof raw === "string" ? { label: raw } : (raw || {});
    const severity = issueSeverity(issue);
    const category = normalizeText(issue.category || issue.area || issue.label || "Other") || "Other";
    summary[severity] += 1;
    summary.total += 1;
    summary.categories[category] = (summary.categories[category] || 0) + 1;
  }
  return summary;
}

function expectedTimeFallback(roomType) {
  const value = normalizeText(roomType).toUpperCase();
  if (value === "3" || value.includes("3 BED")) return 55;
  if (value === "2" || value.includes("2 BED")) return 45;
  if (value === "1" || value.includes("1 BED")) return 35;
  if (value === "M" || value.includes("MOTEL")) return 25;
  if (value === "S" || value.includes("STUDIO")) return 30;
  if (value.includes("SUITE")) return 30;
  return 40;
}

function calculateScores({ overallScore, cleanTime, expectedTime, issues, firstPass }) {
  const issueSummary = summarizeIssues(issues);
  const severityPenalty = issueSummary.critical * 25 + issueSummary.major * 12 + issueSummary.medium * 5 + issueSummary.minor * 2;
  const qualityScore = clamp(Math.round((Number(overallScore) || 100) - severityPenalty), 0, 100);
  const safeExpected = Math.max(1, Number(expectedTime) || 1);
  const ratio = Number(cleanTime) > 0 ? Number(cleanTime) / safeExpected : 1;
  const efficiencyScore = clamp(Math.round(100 - Math.max(0, ratio - 1) * 55), 0, 100);
  const consistencyBonus = firstPass ? 5 : -10;
  const overall = clamp(Math.round(qualityScore * 0.7 + efficiencyScore * 0.3 + consistencyBonus), 0, 100);
  return { qualityScore, efficiencyScore, overallScore: overall, issueSummary };
}

async function estimateExpectedTime({ roomType, building }) {
  const result = await dbQuery(
    `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY clean_time_minutes)::float8 AS expected
       FROM room_metrics
      WHERE room_type = $1
        AND building = $2
        AND clean_time_minutes BETWEEN 5 AND 240
        AND work_date >= CURRENT_DATE - INTERVAL '60 days'`,
    [normalizeText(roomType), normalizeText(building) || "OTHER"]
  );
  const historical = Number(result.rows[0]?.expected || 0);
  return historical > 0 ? Number(historical.toFixed(1)) : expectedTimeFallback(roomType);
}

async function refreshRoomMetric({ date, normalizedRoom }) {
  const source = await dbQuery(
    `SELECT r.id AS room_id, r.work_date, r.room_number, r.normalized_room, r.room_type,
            r.building, r.assigned_cleaner, r.assigned_inspector, r.arrival, r.guest_out,
            r.started_at, r.finished_at, r.inspection_started_at, r.ready_at,
            qr.id AS review_id, qr.overall_score AS inspection_score, qr.status AS review_status,
            qr.first_pass, qr.scores, qr.issues, qr.notes, qr.completed_at
       FROM rooms r
       LEFT JOIN LATERAL (
         SELECT * FROM quality_reviews q
          WHERE q.work_date = r.work_date AND q.normalized_room = r.normalized_room
          ORDER BY q.updated_at DESC LIMIT 1
       ) qr ON TRUE
      WHERE r.work_date = $1::date AND r.normalized_room = $2
      LIMIT 1`,
    [date, normalizedRoom]
  );

  const room = source.rows[0];
  if (!room) return null;

  const cleanTime = minutesBetween(room.started_at, room.finished_at);
  const inspectionTime = minutesBetween(room.inspection_started_at, room.ready_at || room.completed_at);
  const expectedTime = await estimateExpectedTime(room);
  const scores = calculateScores({
    overallScore: room.inspection_score || 100,
    cleanTime,
    expectedTime,
    issues: room.issues || [],
    firstPass: room.first_pass !== false,
  });

  const difficultyRatio = cleanTime > 0 ? cleanTime / Math.max(1, expectedTime) : 1;
  const difficulty = difficultyRatio >= 1.35 ? "hard" : difficultyRatio >= 1.1 ? "medium" : "standard";

  const upsert = await dbQuery(
    `INSERT INTO room_metrics (
       work_date, room_id, review_id, room_number, normalized_room, room_type, building,
       cleaner, normalized_cleaner, inspector, started_at, finished_at, clean_time_minutes,
       expected_time_minutes, inspection_time_minutes, difficulty, arrival, guest_out,
       inspection_score, quality_score, efficiency_score, overall_score, first_pass,
       critical_errors, major_errors, medium_errors, minor_errors, issue_categories, source_payload, updated_at
     ) VALUES (
       $1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,NOW()
     )
     ON CONFLICT (work_date, normalized_room)
     DO UPDATE SET review_id=EXCLUDED.review_id, room_type=EXCLUDED.room_type, building=EXCLUDED.building,
       cleaner=EXCLUDED.cleaner, normalized_cleaner=EXCLUDED.normalized_cleaner, inspector=EXCLUDED.inspector,
       started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at,
       clean_time_minutes=EXCLUDED.clean_time_minutes, expected_time_minutes=EXCLUDED.expected_time_minutes,
       inspection_time_minutes=EXCLUDED.inspection_time_minutes, difficulty=EXCLUDED.difficulty,
       arrival=EXCLUDED.arrival, guest_out=EXCLUDED.guest_out, inspection_score=EXCLUDED.inspection_score,
       quality_score=EXCLUDED.quality_score, efficiency_score=EXCLUDED.efficiency_score,
       overall_score=EXCLUDED.overall_score, first_pass=EXCLUDED.first_pass,
       critical_errors=EXCLUDED.critical_errors, major_errors=EXCLUDED.major_errors,
       medium_errors=EXCLUDED.medium_errors, minor_errors=EXCLUDED.minor_errors,
       issue_categories=EXCLUDED.issue_categories, source_payload=EXCLUDED.source_payload, updated_at=NOW()
     RETURNING *`,
    [room.work_date, room.room_id, room.review_id, room.room_number, room.normalized_room,
      room.room_type || "", room.building || "OTHER", room.assigned_cleaner || "",
      normalizeEmployee(room.assigned_cleaner), room.assigned_inspector || "", room.started_at,
      room.finished_at, cleanTime, expectedTime, inspectionTime, difficulty, Boolean(room.arrival),
      Boolean(room.guest_out), Number(room.inspection_score || 100), scores.qualityScore,
      scores.efficiencyScore, scores.overallScore, room.first_pass !== false,
      scores.issueSummary.critical, scores.issueSummary.major, scores.issueSummary.medium,
      scores.issueSummary.minor, JSON.stringify(scores.issueSummary.categories),
      JSON.stringify({ scores: room.scores || {}, issues: room.issues || [], notes: room.notes || "", reviewStatus: room.review_status || "" })]
  );
  return upsert.rows[0];
}

async function refreshEmployeeMetrics(date) {
  await dbQuery(
    `INSERT INTO employee_metrics (
       work_date, employee, normalized_employee, role, rooms_completed, average_clean_time,
       average_expected_time, average_quality_score, average_efficiency_score, overall_score,
       first_pass_rate, critical_errors, major_errors, medium_errors, minor_errors, recurring_issues, updated_at
     )
     SELECT work_date, COALESCE(MAX(cleaner), ''), normalized_cleaner, 'Cleaner', COUNT(*)::int,
            COALESCE(ROUND(AVG(NULLIF(clean_time_minutes,0))::numeric,1), 0),
            COALESCE(ROUND(AVG(NULLIF(expected_time_minutes,0))::numeric,1), 0),
            COALESCE(ROUND(AVG(quality_score)::numeric,1), 100),
            COALESCE(ROUND(AVG(efficiency_score)::numeric,1), 100),
            COALESCE(ROUND(AVG(overall_score)::numeric,1), 100),
            COALESCE(ROUND((100.0 * COUNT(*) FILTER (WHERE first_pass) / NULLIF(COUNT(*),0))::numeric,1), 100),
            COALESCE(SUM(critical_errors),0)::int, COALESCE(SUM(major_errors),0)::int,
            COALESCE(SUM(medium_errors),0)::int, COALESCE(SUM(minor_errors),0)::int,
            COALESCE(jsonb_object_agg(category, category_count) FILTER (WHERE category IS NOT NULL), '{}'::jsonb), NOW()
       FROM room_metrics rm
       LEFT JOIN LATERAL (
         SELECT key AS category, SUM(value::int)::int AS category_count
         FROM jsonb_each_text(rm.issue_categories)
         GROUP BY key ORDER BY category_count DESC LIMIT 8
       ) issue ON TRUE
      WHERE work_date = $1::date AND normalized_cleaner <> ''
      GROUP BY work_date, normalized_cleaner
     ON CONFLICT (work_date, normalized_employee, role)
     DO UPDATE SET employee=EXCLUDED.employee, rooms_completed=EXCLUDED.rooms_completed,
       average_clean_time=EXCLUDED.average_clean_time, average_expected_time=EXCLUDED.average_expected_time,
       average_quality_score=EXCLUDED.average_quality_score, average_efficiency_score=EXCLUDED.average_efficiency_score,
       overall_score=EXCLUDED.overall_score, first_pass_rate=EXCLUDED.first_pass_rate,
       critical_errors=EXCLUDED.critical_errors, major_errors=EXCLUDED.major_errors,
       medium_errors=EXCLUDED.medium_errors, minor_errors=EXCLUDED.minor_errors,
       recurring_issues=EXCLUDED.recurring_issues, updated_at=NOW()`,
    [date]
  );
}

async function refreshDate(date) {
  const rooms = await dbQuery(`SELECT normalized_room FROM rooms WHERE work_date=$1::date`, [date]);
  const metrics = [];
  for (const room of rooms.rows) {
    metrics.push(await refreshRoomMetric({ date, normalizedRoom: room.normalized_room }));
  }
  await refreshEmployeeMetrics(date);
  return { ok: true, version: QUALITY_ENGINE_VERSION, date, roomsProcessed: metrics.filter(Boolean).length };
}

async function cleanerLeaderboard({ from, to }) {
  const result = await dbQuery(
    `SELECT COALESCE(MAX(cleaner), '') AS employee,
            COUNT(*)::int AS rooms_completed,
            COUNT(*) FILTER (WHERE clean_time_minutes BETWEEN 10 AND 240)::int AS valid_time_rooms,
            COUNT(*) FILTER (WHERE clean_time_minutes = 0)::int AS missing_time_rooms,
            COUNT(*) FILTER (WHERE clean_time_minutes > 0 AND clean_time_minutes < 10)::int AS suspicious_short_rooms,
            COUNT(*) FILTER (WHERE clean_time_minutes > 240)::int AS suspicious_long_rooms,
            COUNT(*) FILTER (WHERE review_id IS NOT NULL)::int AS inspected_rooms,
            ROUND(AVG(clean_time_minutes) FILTER (WHERE clean_time_minutes BETWEEN 10 AND 240)::numeric,1) AS average_clean_time,
            ROUND(AVG(expected_time_minutes) FILTER (WHERE expected_time_minutes > 0)::numeric,1) AS average_expected_time,
            ROUND(AVG(quality_score) FILTER (WHERE review_id IS NOT NULL)::numeric,1) AS quality_score,
            ROUND(AVG(efficiency_score) FILTER (WHERE clean_time_minutes BETWEEN 10 AND 240)::numeric,1) AS efficiency_score,
            ROUND(AVG(overall_score) FILTER (WHERE review_id IS NOT NULL OR clean_time_minutes BETWEEN 10 AND 240)::numeric,1) AS overall_score,
            ROUND((100.0 * COUNT(*) FILTER (WHERE review_id IS NOT NULL AND first_pass) /
              NULLIF(COUNT(*) FILTER (WHERE review_id IS NOT NULL),0))::numeric,1) AS first_pass_rate,
            COALESCE(SUM(critical_errors),0)::int AS critical_errors,
            COALESCE(SUM(major_errors),0)::int AS major_errors,
            COALESCE(SUM(medium_errors),0)::int AS medium_errors,
            COALESCE(SUM(minor_errors),0)::int AS minor_errors
       FROM room_metrics
      WHERE work_date BETWEEN $1::date AND $2::date AND normalized_cleaner <> ''
      GROUP BY normalized_cleaner
      ORDER BY COALESCE(AVG(overall_score) FILTER (WHERE review_id IS NOT NULL OR clean_time_minutes BETWEEN 10 AND 240),-1) DESC,
               COUNT(*) DESC`,
    [from, to]
  );
  return result.rows.map((row) => ({
    ...row,
    data_status: Number(row.inspected_rooms) > 0 && Number(row.valid_time_rooms) === Number(row.rooms_completed)
      ? "complete"
      : Number(row.valid_time_rooms) === 0 && Number(row.inspected_rooms) === 0
        ? "missing"
        : "partial",
    is_team: /[&/]|\band\b|\by\b/i.test(String(row.employee || "")),
  }));
}

async function qualitySummary({ from, to }) {
  const result = await dbQuery(
    `SELECT COUNT(*)::int AS rooms_processed,
            COUNT(DISTINCT normalized_cleaner)::int AS cleaners,
            COUNT(*) FILTER (WHERE clean_time_minutes BETWEEN 10 AND 240)::int AS valid_time_rooms,
            COUNT(*) FILTER (WHERE clean_time_minutes = 0)::int AS missing_time_rooms,
            COUNT(*) FILTER (WHERE clean_time_minutes > 0 AND clean_time_minutes < 10)::int AS suspicious_short_rooms,
            COUNT(*) FILTER (WHERE clean_time_minutes > 240)::int AS suspicious_long_rooms,
            COUNT(*) FILTER (WHERE review_id IS NOT NULL)::int AS inspected_rooms,
            ROUND(AVG(clean_time_minutes) FILTER (WHERE clean_time_minutes BETWEEN 10 AND 240)::numeric,1) AS average_clean_time,
            ROUND(AVG(quality_score) FILTER (WHERE review_id IS NOT NULL)::numeric,1) AS average_quality_score,
            ROUND((100.0 * COUNT(*) FILTER (WHERE review_id IS NOT NULL AND first_pass) /
              NULLIF(COUNT(*) FILTER (WHERE review_id IS NOT NULL),0))::numeric,1) AS first_pass_rate,
            COALESCE(SUM(critical_errors),0)::int AS critical_errors,
            COALESCE(SUM(major_errors),0)::int AS major_errors,
            COALESCE(SUM(medium_errors),0)::int AS medium_errors,
            COALESCE(SUM(minor_errors),0)::int AS minor_errors
       FROM room_metrics
      WHERE work_date BETWEEN $1::date AND $2::date`,
    [from, to]
  );
  return result.rows[0] || {};
}

module.exports = {
  QUALITY_ENGINE_VERSION,
  summarizeIssues,
  calculateScores,
  refreshRoomMetric,
  refreshEmployeeMetrics,
  refreshDate,
  cleanerLeaderboard,
  qualitySummary,
};
