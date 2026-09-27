const { query } = require('../db');
const {
  normalizeEmployeeName,
  splitEmployeeNames,
  assertPayrollWeekOpen,
  ensurePayrollWeek,
} = require('./payrollManagementService');

function readTextProperty(property) {
  if (!property) return '';
  if (Array.isArray(property.title)) return property.title.map((item) => item.plain_text || item.text?.content || '').join('').trim();
  if (Array.isArray(property.rich_text)) return property.rich_text.map((item) => item.plain_text || item.text?.content || '').join('').trim();
  if (property.select?.name) return String(property.select.name).trim();
  if (property.status?.name) return String(property.status.name).trim();
  if (Array.isArray(property.multi_select)) return property.multi_select.map((item) => item.name || '').filter(Boolean).join(' / ').trim();
  if (Array.isArray(property.people)) return property.people.map((item) => item.name || item.person?.email || item.id || '').filter(Boolean).join(' / ').trim();
  if (Array.isArray(property.relation)) return property.relation.map((item) => item.id || '').filter(Boolean).join(' / ').trim();
  if (property.formula) {
    if (property.formula.string != null) return String(property.formula.string).trim();
    if (property.formula.number != null) return String(property.formula.number);
    if (property.formula.boolean != null) return property.formula.boolean ? 'Yes' : 'No';
    if (property.formula.date?.start) return String(property.formula.date.start).trim();
  }
  if (property.rollup) {
    if (property.rollup.number != null) return String(property.rollup.number);
    if (Array.isArray(property.rollup.array)) return property.rollup.array.map(readTextProperty).filter(Boolean).join(' / ').trim();
  }
  if (property.number !== undefined && property.number !== null) return String(property.number);
  if (property.url) return String(property.url).trim();
  if (property.email) return String(property.email).trim();
  if (property.phone_number) return String(property.phone_number).trim();
  return '';
}

function firstProperty(properties, names = []) {
  for (const name of names) {
    if (properties?.[name]) return properties[name];
  }
  const normalized = new Map(Object.keys(properties || {}).map((key) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), key]));
  for (const name of names) {
    const key = normalized.get(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (key) return properties[key];
  }
  return null;
}

function readTextByNames(properties, names = []) {
  return readTextProperty(firstProperty(properties, names));
}

function readDateByNames(properties, names = []) {
  const property = firstProperty(properties, names);
  const value = property?.date?.start || property?.formula?.date?.start || readTextProperty(property);
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function readNumberByNames(properties, names = []) {
  const property = firstProperty(properties, names);
  const value = property?.number ?? property?.formula?.number ?? property?.rollup?.number ?? readTextProperty(property);
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function getPayrollWeek(dateValue) {
  const date = new Date(`${String(dateValue || '').slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return { weekStart: '', weekEnd: '' };
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { weekStart: monday.toISOString().slice(0, 10), weekEnd: sunday.toISOString().slice(0, 10) };
}

async function findEffectiveRate(propertyName, roomType, workDate) {
  if (!roomType || !workDate) return null;
  const result = await query(
    `
      SELECT * FROM payroll_rates
      WHERE active = TRUE
        AND LOWER(room_type) = LOWER($1)
        AND effective_from <= $2
        AND (effective_to IS NULL OR effective_to >= $2)
        AND (LOWER(property_name) = LOWER($3) OR property_name = 'ALL')
      ORDER BY CASE WHEN LOWER(property_name) = LOWER($3) THEN 0 ELSE 1 END,
               effective_from DESC
      LIMIT 1
    `,
    [roomType, workDate, propertyName || 'ALL']
  );
  return result.rows[0] || null;
}

async function getPayrollRecordsFromNotionPage(page) {
  const properties = page?.properties || {};
  const workDate = readDateByNames(properties, ['Date', 'Work Date', 'Cleaning Date', 'Service Date']);
  const employeeText = readTextByNames(properties, ['Cleaner', 'Employee', 'Assigned Cleaner', 'Employee Name', 'Name']);
  const employees = splitEmployeeNames(employeeText);
  const unit = readTextByNames(properties, ['Unit', 'Room', 'Room Number', 'Unit Number', 'Property Unit', 'Cleaning Unit']);
  const roomType = readTextByNames(properties, ['Room Type', 'Type', 'Unit Type', 'Cleaning Type']);
  const propertyName = readTextByNames(properties, ['Property', 'Hotel', 'Location', 'Resort']) || 'ALL';
  const statedAmount = readNumberByNames(properties, ['Amount', 'Total', 'Pay Amount', 'Cleaner Amount']);
  const statedGross = readNumberByNames(properties, ['Gross Unit Amount', 'Unit Amount', 'Gross Amount']);
  const payType = readTextByNames(properties, ['Pay Type', 'Payment Type']) || 'unit';
  const roleWorked = readTextByNames(properties, ['Role Worked', 'Role']) || 'Cleaner';
  const status = readTextByNames(properties, ['Status', 'Payroll Status']) || 'Pending';
  const computedWeek = getPayrollWeek(workDate);
  const weekStart = readDateByNames(properties, ['Week Start', 'Pay Period Start']) || computedWeek.weekStart;
  const weekEnd = readDateByNames(properties, ['Week End', 'Pay Period End']) || computedWeek.weekEnd;

  // Nunca ocultar una página de Notion. Si falta el empleado, la unidad aparece como
  // "Unassigned" con advertencia y $0 para que pueda corregirse, no desaparecer.
  const names = employees.length ? employees : ['Unassigned'];
  const splitCount = Math.max(1, names.length);
  const grossUnitAmount = roundMoney(statedGross > 0 ? statedGross : statedAmount);

  return names.map((employee, index) => {
    const amount = roundMoney(splitCount > 1 ? grossUnitAmount / splitCount : statedAmount || grossUnitAmount);
    const issues = [];
    if (!workDate) issues.push('missing-date');
    if (!employeeText) issues.push('missing-employee');
    if (!unit) issues.push('missing-unit');
    if (!(amount > 0)) issues.push('missing-or-zero-amount');

    return {
      notionId: `${page?.id || 'notion'}:${index + 1}:${normalizeEmployeeName(employee)}`,
      sourceNotionId: page?.id || '',
      workDate,
      employee,
      normalizedEmployee: normalizeEmployeeName(employee),
      unit: unit || `[Missing unit · ${page?.id || 'Notion page'}]`,
      roomType,
      propertyName,
      grossUnitAmount,
      splitCount,
      splitPercent: Number((1 / splitCount).toFixed(4)),
      amount,
      payType,
      roleWorked,
      weekStart,
      weekEnd,
      status,
      issues,
      rawData: { sourcePageId: page?.id || '', originalEmployeeText: employeeText, splitIndex: index + 1, splitCount, issues, page },
    };
  });
}

async function upsertPayrollRecord(record) {
  if (!record.workDate || !record.employee || !record.normalizedEmployee) {
    return { saved: false, reason: 'missing-date-or-employee', record };
  }

  const result = await query(
    `
      INSERT INTO payroll_records (
        notion_id, work_date, employee, normalized_employee, unit, room_type,
        property_name, gross_unit_amount, split_count, split_percent, amount,
        pay_type, role_worked, week_start, week_end, status, source, raw_data, updated_at
      ) VALUES (
        NULLIF($1,''),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'notion',$17::jsonb,NOW()
      )
      ON CONFLICT (notion_id)
      DO UPDATE SET
        notion_id = EXCLUDED.notion_id,
        employee = EXCLUDED.employee,
        room_type = EXCLUDED.room_type,
        property_name = EXCLUDED.property_name,
        gross_unit_amount = EXCLUDED.gross_unit_amount,
        split_count = EXCLUDED.split_count,
        split_percent = EXCLUDED.split_percent,
        amount = CASE WHEN payroll_records.manual_override THEN payroll_records.amount ELSE EXCLUDED.amount END,
        week_start = EXCLUDED.week_start,
        week_end = EXCLUDED.week_end,
        status = CASE WHEN payroll_records.status = 'Closed' THEN payroll_records.status ELSE EXCLUDED.status END,
        source = 'notion', raw_data = EXCLUDED.raw_data, updated_at = NOW()
      RETURNING *
    `,
    [record.notionId, record.workDate, record.employee, record.normalizedEmployee, record.unit, record.roomType,
      record.propertyName, record.grossUnitAmount, record.splitCount, record.splitPercent, record.amount,
      record.payType, record.roleWorked, record.weekStart, record.weekEnd, record.status,
      JSON.stringify(record.rawData || {})]
  );
  return { saved: true, record: result.rows[0] };
}

async function syncPayrollFromNotion({ notion, databaseId, queryDatabase, weekStart, weekEnd }) {
  if (!databaseId) throw new Error('Falta NOTION_PAYROLL_DATABASE_ID');
  if (!weekStart || !weekEnd) throw new Error('weekStart y weekEnd son requeridos');
  await assertPayrollWeekOpen(weekStart, weekEnd);
  await ensurePayrollWeek(weekStart, weekEnd);

  const syncKey = `payroll-notion-postgres:${weekStart}:${weekEnd}`;
  const startedAt = new Date();
  await query(
    `INSERT INTO sync_status (sync_key,source,destination,status,last_started_at,records_processed,error_message,metadata,updated_at)
     VALUES ($1,'notion','postgres','running',NOW(),0,'',$2::jsonb,NOW())
     ON CONFLICT (sync_key) DO UPDATE SET status='running',last_started_at=NOW(),records_processed=0,error_message='',metadata=EXCLUDED.metadata,updated_at=NOW()`,
    [syncKey, JSON.stringify({ weekStart, weekEnd })]
  );

  try {
    let pages = [];
    let cursor;
    do {
      const body = {
        database_id: databaseId,
        page_size: 100,
        filter: { and: [
          { property: 'Date', date: { on_or_after: weekStart } },
          { property: 'Date', date: { on_or_before: weekEnd } },
        ] },
        sorts: [{ property: 'Date', direction: 'ascending' }],
      };
      if (cursor) body.start_cursor = cursor;
      const response = queryDatabase ? await queryDatabase(body) : await notion.databases.query(body);
      pages = pages.concat(response.results || []);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    let saved = 0;
    let skipped = 0;
    let splitSourceRecords = 0;
    const warnings = [];

    for (const page of pages) {
      await query(
        `DELETE FROM payroll_records
         WHERE manual_override = FALSE
           AND status <> 'Closed'
           AND (notion_id = $1 OR raw_data->>'sourcePageId' = $1)`,
        [page?.id || '']
      );
      const records = await getPayrollRecordsFromNotionPage(page);
      if (records.length > 1) splitSourceRecords += 1;
      if (!records.length) {
        skipped += 1;
        warnings.push({ notionId: page?.id || '', reason: 'missing-employee' });
        continue;
      }
      for (const record of records) {
        const result = await upsertPayrollRecord(record);
        if (result.saved) saved += 1;
        else { skipped += 1; warnings.push({ notionId: page?.id || '', reason: result.reason }); }
      }
    }

    await query(
      `UPDATE sync_status SET status='success',last_completed_at=NOW(),last_success_at=NOW(),records_processed=$2,error_message='',metadata=$3::jsonb,updated_at=NOW() WHERE sync_key=$1`,
      [syncKey, saved, JSON.stringify({ weekStart, weekEnd, totalFromNotion: pages.length, saved, skipped, splitSourceRecords, warnings, durationMs: Date.now() - startedAt.getTime() })]
    );
    return { ok: true, weekStart, weekEnd, totalFromNotion: pages.length, saved, skipped, splitSourceRecords, warnings, durationMs: Date.now() - startedAt.getTime() };
  } catch (error) {
    await query(`UPDATE sync_status SET status='error',last_completed_at=NOW(),error_message=$2,updated_at=NOW() WHERE sync_key=$1`, [syncKey, error.message]);
    throw error;
  }
}

async function listPayrollPostgres({ weekStart, weekEnd, employee = '' }) {
  const normalizedEmployee = normalizeEmployeeName(employee);
  const result = await query(
    `SELECT * FROM payroll_records WHERE work_date BETWEEN $1 AND $2 AND ($3='' OR normalized_employee=$3) ORDER BY work_date,employee,unit`,
    [weekStart, weekEnd, normalizedEmployee]
  );
  return result.rows;
}

async function getPayrollSummaryPostgres(weekStart, weekEnd) {
  const result = await query(
    `SELECT employee,normalized_employee,COUNT(*)::integer AS records,
            COUNT(*) FILTER (WHERE pay_type='unit')::integer AS units,
            COALESCE(SUM(amount),0)::numeric(12,2) AS total
     FROM payroll_records WHERE work_date BETWEEN $1 AND $2
     GROUP BY employee,normalized_employee ORDER BY employee`,
    [weekStart, weekEnd]
  );
  return result.rows;
}

async function getPayrollSyncStatus(weekStart, weekEnd) {
  const result = await query(`SELECT * FROM sync_status WHERE sync_key=$1 LIMIT 1`, [`payroll-notion-postgres:${weekStart}:${weekEnd}`]);
  return result.rows[0] || null;
}

function mapPayrollPostgresToLegacy(record) {
  return {
    id: record?.id,
    date: String(record?.work_date || record?.workDate || '').slice(0,10),
    cleaner: String(record?.employee || '').trim(),
    unit: String(record?.unit || '').trim(),
    roomType: String(record?.room_type || record?.roomType || '').trim(),
    propertyName: String(record?.property_name || 'ALL').trim(),
    grossUnitAmount: roundMoney(record?.gross_unit_amount || 0),
    splitCount: Number(record?.split_count || 1),
    splitPercent: Number(record?.split_percent || 1),
    amount: roundMoney(record?.amount || 0),
    notionId: record?.notion_id || '',
    payType: record?.pay_type || 'unit',
    roleWorked: record?.role_worked || 'Cleaner',
    manualOverride: Boolean(record?.manual_override),
    adjustmentReason: record?.adjustment_reason || '',
    status: record?.status || 'Pending',
  };
}

function normalizeComparisonDate(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}/);
  if (isoMatch) return isoMatch[0];

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function payrollComparisonKey(record) {
  // El ID de Notion ya incluye el índice y el empleado cuando una unidad se divide.
  // Es la identidad más segura y evita marcar todos los registros como faltantes/extras.
  const notionId = String(record?.notionId || record?.notion_id || '').trim();
  if (notionId) return `notion:${notionId}`;

  return [
    normalizeComparisonDate(record?.date || record?.work_date),
    normalizeEmployeeName(record?.cleaner || record?.employee || ''),
    String(record?.unit || '').trim().toUpperCase().replace(/\s+/g, ''),
    String(record?.payType || record?.pay_type || 'unit').trim().toLowerCase(),
    String(record?.roleWorked || record?.role_worked || 'Cleaner').trim().toLowerCase(),
  ].join('|');
}

function comparePayrollRecordSets(notionRecords = [], postgresRecords = []) {
  const notionMap = new Map();
  const postgresMap = new Map();
  notionRecords.forEach((record) => notionMap.set(payrollComparisonKey(record), record));
  postgresRecords.forEach((record) => { const legacy = mapPayrollPostgresToLegacy(record); postgresMap.set(payrollComparisonKey(legacy), legacy); });
  const missingInPostgres = [];
  const extraInPostgres = [];
  const amountMismatches = [];
  for (const [key, notionRecord] of notionMap) {
    const postgresRecord = postgresMap.get(key);
    if (!postgresRecord) { missingInPostgres.push(notionRecord); continue; }
    const notionAmount = roundMoney(notionRecord.amount || 0);
    const postgresAmount = roundMoney(postgresRecord.amount || 0);
    if (notionAmount !== postgresAmount && !postgresRecord.manualOverride) {
      amountMismatches.push({ key, notion: notionRecord, postgres: postgresRecord, difference: roundMoney(postgresAmount - notionAmount) });
    }
  }
  for (const [key, postgresRecord] of postgresMap) if (!notionMap.has(key)) extraInPostgres.push(postgresRecord);
  const notionTotal = roundMoney(notionRecords.reduce((sum,r) => sum + Number(r.amount || 0),0));
  const postgresTotal = roundMoney(postgresRecords.reduce((sum,r) => sum + Number(r.amount || 0),0));
  const approvedAdjustments = postgresRecords.filter((record) => Boolean(record.manual_override)).length;
  return {
    matches: missingInPostgres.length===0 && extraInPostgres.length===0 && amountMismatches.length===0,
    notion: { count: notionRecords.length, total: notionTotal },
    postgres: { count: postgresRecords.length, total: postgresTotal },
    difference: { count: postgresRecords.length-notionRecords.length, total: roundMoney(postgresTotal-notionTotal) },
    approvedAdjustments, missingInPostgres, extraInPostgres, amountMismatches,
  };
}

module.exports = {
  normalizeEmployeeName,
  getPayrollRecordFromNotionPage: getPayrollRecordsFromNotionPage,
  getPayrollRecordsFromNotionPage,
  syncPayrollFromNotion,
  listPayrollPostgres,
  getPayrollSummaryPostgres,
  getPayrollSyncStatus,
  mapPayrollPostgresToLegacy,
  comparePayrollRecordSets,
};
