const { query } = require('../db');

function normalizeEmployeeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function splitEmployeeNames(value) {
  const original = String(value || '').trim();
  if (!original) return [];

  const parts = original
    .replace(/\r?\n/g, ' / ')
    .replace(/\s+(?:y|and)\s+/gi, ' / ')
    .replace(/[|&+;,]+/g, ' / ')
    .split(/\s*\/\s*/)
    .map((name) => name.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const seen = new Set();
  return parts.filter((name) => {
    const key = normalizeEmployeeName(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getPayrollWeekState(weekStart, weekEnd) {
  const result = await query(
    `SELECT * FROM payroll_weeks WHERE week_start = $1 AND week_end = $2 LIMIT 1`,
    [weekStart, weekEnd]
  );
  return result.rows[0] || null;
}

async function ensurePayrollWeek(weekStart, weekEnd) {
  const result = await query(
    `
      INSERT INTO payroll_weeks (week_start, week_end, status, updated_at)
      VALUES ($1, $2, 'open', NOW())
      ON CONFLICT (week_start, week_end)
      DO UPDATE SET updated_at = NOW()
      RETURNING *
    `,
    [weekStart, weekEnd]
  );
  return result.rows[0];
}

async function assertPayrollWeekOpen(weekStart, weekEnd) {
  const state = await getPayrollWeekState(weekStart, weekEnd);
  if (state?.status === 'closed') {
    throw new Error(`La semana ${weekStart} a ${weekEnd} está cerrada. Reábrela antes de modificarla.`);
  }
  return state || ensurePayrollWeek(weekStart, weekEnd);
}

async function writePayrollAudit({ weekStart, weekEnd, action, employee = '', unit = '', recordId = null, changedBy = 'Admin', reason = '', before = null, after = null }) {
  await query(
    `
      INSERT INTO payroll_audit (
        week_start, week_end, action, employee, unit, payroll_record_id,
        changed_by, reason, before_data, after_data
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
    `,
    [weekStart, weekEnd, action, employee, unit, recordId, changedBy, reason, JSON.stringify(before || {}), JSON.stringify(after || {})]
  );
}

async function listPayrollRates({ includeInactive = false } = {}) {
  const result = await query(
    `
      SELECT * FROM payroll_rates
      WHERE ($1::boolean = TRUE OR active = TRUE)
      ORDER BY property_name ASC, room_type ASC, effective_from DESC
    `,
    [includeInactive]
  );
  return result.rows;
}

async function savePayrollRate({ propertyName = 'ALL', roomType, amount, effectiveFrom, changedBy = 'Admin', reason = '', weekStart = '', weekEnd = '', applyToWeek = false }) {
  const cleanRoomType = String(roomType || '').trim();
  const cleanProperty = String(propertyName || 'ALL').trim() || 'ALL';
  const numericAmount = roundMoney(amount);
  const startDate = String(effectiveFrom || new Date().toISOString().slice(0, 10)).slice(0, 10);

  if (!cleanRoomType) throw new Error('roomType es requerido');
  if (!(numericAmount > 0)) throw new Error('La tarifa debe ser mayor que cero');

  const result = await query(
    `
      INSERT INTO payroll_rates (property_name, room_type, amount, effective_from, active, created_by, reason, updated_at)
      VALUES ($1,$2,$3,$4,TRUE,$5,$6,NOW())
      ON CONFLICT (property_name, room_type, effective_from)
      DO UPDATE SET amount = EXCLUDED.amount, active = TRUE, created_by = EXCLUDED.created_by,
                    reason = EXCLUDED.reason, updated_at = NOW()
      RETURNING *
    `,
    [cleanProperty, cleanRoomType, numericAmount, startDate, changedBy, reason]
  );

  let applied = 0;
  if (applyToWeek) {
    if (!weekStart || !weekEnd) throw new Error('weekStart y weekEnd son requeridos para aplicar la tarifa');
    await assertPayrollWeekOpen(weekStart, weekEnd);
    const update = await query(
      `
        UPDATE payroll_records
        SET gross_unit_amount = $1,
            amount = ROUND(($1 / GREATEST(split_count, 1))::numeric, 2),
            updated_at = NOW()
        WHERE work_date BETWEEN $2 AND $3
          AND LOWER(room_type) = LOWER($4)
          AND ($5 = 'ALL' OR LOWER(property_name) = LOWER($5))
          AND manual_override = FALSE
        RETURNING id
      `,
      [numericAmount, weekStart, weekEnd, cleanRoomType, cleanProperty]
    );
    applied = update.rowCount;
  }

  await writePayrollAudit({
    weekStart: weekStart || startDate,
    weekEnd: weekEnd || startDate,
    action: 'RATE_SAVED',
    changedBy,
    reason,
    after: { ...result.rows[0], appliedToWeek: applyToWeek, appliedRecords: applied },
  });

  return { rate: result.rows[0], appliedRecords: applied };
}

async function updatePayrollRecordAmount({ recordId, amount, reason, changedBy = 'Admin' }) {
  const numericAmount = roundMoney(amount);
  if (!(numericAmount >= 0)) throw new Error('El pago debe ser cero o mayor');
  if (!String(reason || '').trim()) throw new Error('Debes escribir el motivo del ajuste');

  const currentResult = await query(`SELECT * FROM payroll_records WHERE id = $1 LIMIT 1`, [recordId]);
  const current = currentResult.rows[0];
  if (!current) throw new Error('Registro de nómina no encontrado');

  await assertPayrollWeekOpen(String(current.week_start).slice(0, 10), String(current.week_end).slice(0, 10));

  const result = await query(
    `
      UPDATE payroll_records
      SET amount = $2, manual_override = TRUE, adjustment_reason = $3,
          adjusted_by = $4, adjusted_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [recordId, numericAmount, String(reason).trim(), changedBy]
  );

  await query(
    `
      INSERT INTO payroll_adjustments (
        payroll_record_id, week_start, week_end, employee, unit,
        original_amount, new_amount, reason, changed_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [recordId, current.week_start, current.week_end, current.employee, current.unit, current.amount, numericAmount, String(reason).trim(), changedBy]
  );

  await writePayrollAudit({
    weekStart: current.week_start,
    weekEnd: current.week_end,
    action: 'RECORD_AMOUNT_UPDATED',
    employee: current.employee,
    unit: current.unit,
    recordId,
    changedBy,
    reason,
    before: current,
    after: result.rows[0],
  });

  return result.rows[0];
}

async function resetPayrollRecordAmount({ recordId, reason, changedBy = 'Admin' }) {
  if (!String(reason || '').trim()) throw new Error('Debes escribir el motivo');
  const currentResult = await query(`SELECT * FROM payroll_records WHERE id = $1 LIMIT 1`, [recordId]);
  const current = currentResult.rows[0];
  if (!current) throw new Error('Registro de nómina no encontrado');
  await assertPayrollWeekOpen(String(current.week_start).slice(0, 10), String(current.week_end).slice(0, 10));

  const baseAmount = roundMoney(Number(current.gross_unit_amount || 0) / Math.max(1, Number(current.split_count || 1)));
  const result = await query(
    `
      UPDATE payroll_records
      SET amount = $2, manual_override = FALSE, adjustment_reason = '', adjusted_by = '', adjusted_at = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING *
    `,
    [recordId, baseAmount]
  );

  await writePayrollAudit({
    weekStart: current.week_start,
    weekEnd: current.week_end,
    action: 'RECORD_AMOUNT_RESET', employee: current.employee, unit: current.unit,
    recordId, changedBy, reason, before: current, after: result.rows[0],
  });
  return result.rows[0];
}

function payrollWeekForDate(dateValue) {
  const date = new Date(`${String(dateValue || '').slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error('La fecha del movimiento no es válida');
  const day = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: sunday.toISOString().slice(0, 10),
  };
}

async function createManualPayrollEntry({ employee, workDate, kind, unit = '', amount, reason = '', changedBy = 'Admin' }) {
  const cleanEmployee = String(employee || '').trim();
  const cleanDate = String(workDate || '').slice(0, 10);
  const cleanKind = String(kind || '').trim();
  const cleanReason = String(reason || '').trim();
  const allowedKinds = new Set(['Bonus', 'Extra Unit', 'Deduction', 'Reimbursement', 'Other Adjustment']);
  if (!cleanEmployee) throw new Error('El empleado es obligatorio');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('La fecha es obligatoria');
  if (!allowedKinds.has(cleanKind)) throw new Error('El concepto del movimiento no es válido');
  if (!cleanReason) throw new Error('Debes escribir el motivo del movimiento');

  let numericAmount = Math.abs(roundMoney(amount));
  if (!(numericAmount > 0)) throw new Error('El monto debe ser mayor que cero');
  if (cleanKind === 'Deduction') numericAmount *= -1;
  const { weekStart, weekEnd } = payrollWeekForDate(cleanDate);
  await assertPayrollWeekOpen(weekStart, weekEnd);

  const payType = cleanKind === 'Extra Unit' ? 'unit' : 'adjustment';
  const displayUnit = String(unit || '').trim() || cleanKind;
  const result = await query(
    `INSERT INTO payroll_records (
       work_date, employee, normalized_employee, unit, room_type,
       gross_unit_amount, split_count, split_percent, amount, pay_type,
       role_worked, week_start, week_end, status, source, raw_data,
       manual_override, adjustment_reason, adjusted_by, adjusted_at
     ) VALUES ($1,$2,$3,$4,$5,$6,1,1,$6,$7,'Cleaner',$8,$9,'Pending','manual',$10::jsonb,TRUE,$11,$12,NOW())
     RETURNING *`,
    [cleanDate, cleanEmployee, normalizeEmployeeName(cleanEmployee), displayUnit,
      cleanKind, numericAmount, payType, weekStart, weekEnd,
      JSON.stringify({ kind: cleanKind, reason: cleanReason, enteredUnit: String(unit || '').trim() }),
      cleanReason, changedBy]
  );
  const record = result.rows[0];
  await writePayrollAudit({
    weekStart, weekEnd, action: 'MANUAL_ENTRY_CREATED', employee: cleanEmployee,
    unit: displayUnit, recordId: record.id, changedBy, reason: cleanReason, after: record,
  });
  return record;
}

async function listManualPayrollEntries(weekStart, weekEnd) {
  const result = await query(
    `SELECT * FROM payroll_records
     WHERE work_date BETWEEN $1 AND $2 AND source = 'manual'
     ORDER BY work_date ASC, id ASC`,
    [weekStart, weekEnd]
  );
  return result.rows;
}

async function deleteManualPayrollEntry({ recordId, changedBy = 'Admin' }) {
  const currentResult = await query(
    `SELECT * FROM payroll_records WHERE id = $1 AND source = 'manual' LIMIT 1`,
    [recordId]
  );
  const current = currentResult.rows[0];
  if (!current) throw new Error('Movimiento manual no encontrado');
  const weekStart = String(current.week_start).slice(0, 10);
  const weekEnd = String(current.week_end).slice(0, 10);
  await assertPayrollWeekOpen(weekStart, weekEnd);
  await query(`DELETE FROM payroll_records WHERE id = $1 AND source = 'manual'`, [recordId]);
  await writePayrollAudit({
    weekStart, weekEnd, action: 'MANUAL_ENTRY_DELETED', employee: current.employee,
    unit: current.unit, recordId, changedBy, reason: 'Movimiento manual eliminado', before: current,
  });
  return current;
}

async function validatePayrollWeek(weekStart, weekEnd) {
  const result = await query(
    `
      SELECT
        COUNT(*)::integer AS records,
        COUNT(DISTINCT normalized_employee)::integer AS employees,
        COALESCE(SUM(amount),0)::numeric(12,2) AS total,
        COUNT(*) FILTER (WHERE TRIM(employee) = '')::integer AS missing_employee,
        COUNT(*) FILTER (WHERE TRIM(unit) = '' AND pay_type = 'unit')::integer AS missing_unit,
        COUNT(*) FILTER (WHERE amount <= 0 AND pay_type <> 'adjustment')::integer AS invalid_amount,
        COUNT(*) FILTER (WHERE manual_override = TRUE)::integer AS manual_adjustments
      FROM payroll_records
      WHERE work_date BETWEEN $1 AND $2
    `,
    [weekStart, weekEnd]
  );
  const summary = result.rows[0];
  const errors = [];
  if (!Number(summary.records)) errors.push('No hay registros de nómina en esta semana.');
  if (Number(summary.missing_employee)) errors.push(`${summary.missing_employee} registros sin empleado.`);
  if (Number(summary.missing_unit)) errors.push(`${summary.missing_unit} pagos por unidad sin unidad.`);
  if (Number(summary.invalid_amount)) errors.push(`${summary.invalid_amount} registros con pago inválido.`);
  return { valid: errors.length === 0, errors, summary };
}

async function closePayrollWeek({ weekStart, weekEnd, changedBy = 'Admin', reason = 'Payroll reviewed and approved' }) {
  const current = await ensurePayrollWeek(weekStart, weekEnd);
  if (current.status === 'closed') return current;

  const validation = await validatePayrollWeek(weekStart, weekEnd);
  if (!validation.valid) throw new Error(validation.errors.join(' '));

  const result = await query(
    `
      UPDATE payroll_weeks
      SET status = 'closed', closed_at = NOW(), closed_by = $3, close_reason = $4,
          snapshot_total = $5, snapshot_records = $6, snapshot_employees = $7,
          snapshot_data = $8::jsonb, updated_at = NOW()
      WHERE week_start = $1 AND week_end = $2
      RETURNING *
    `,
    [weekStart, weekEnd, changedBy, reason, validation.summary.total, validation.summary.records, validation.summary.employees, JSON.stringify(validation)]
  );

  await query(`UPDATE payroll_records SET status = 'Closed', updated_at = NOW() WHERE work_date BETWEEN $1 AND $2`, [weekStart, weekEnd]);
  await writePayrollAudit({ weekStart, weekEnd, action: 'WEEK_CLOSED', changedBy, reason, after: result.rows[0] });
  return result.rows[0];
}

async function reopenPayrollWeek({ weekStart, weekEnd, changedBy = 'Admin', reason }) {
  if (!String(reason || '').trim()) throw new Error('Debes escribir el motivo para reabrir la semana');
  const current = await getPayrollWeekState(weekStart, weekEnd);
  if (!current) throw new Error('La semana todavía no existe');

  const result = await query(
    `
      UPDATE payroll_weeks
      SET status = 'open', reopened_at = NOW(), reopened_by = $3, reopen_reason = $4, updated_at = NOW()
      WHERE week_start = $1 AND week_end = $2 RETURNING *
    `,
    [weekStart, weekEnd, changedBy, String(reason).trim()]
  );
  await query(`UPDATE payroll_records SET status = 'Pending', updated_at = NOW() WHERE work_date BETWEEN $1 AND $2`, [weekStart, weekEnd]);
  await writePayrollAudit({ weekStart, weekEnd, action: 'WEEK_REOPENED', changedBy, reason, before: current, after: result.rows[0] });
  return result.rows[0];
}

async function listPayrollAudit(weekStart, weekEnd, limit = 100) {
  const result = await query(
    `SELECT * FROM payroll_audit WHERE week_start = $1 AND week_end = $2 ORDER BY created_at DESC LIMIT $3`,
    [weekStart, weekEnd, Math.min(500, Math.max(1, Number(limit || 100)))]
  );
  return result.rows;
}

module.exports = {
  normalizeEmployeeName,
  splitEmployeeNames,
  getPayrollWeekState,
  ensurePayrollWeek,
  assertPayrollWeekOpen,
  listPayrollRates,
  savePayrollRate,
  updatePayrollRecordAmount,
  resetPayrollRecordAmount,
  createManualPayrollEntry,
  listManualPayrollEntries,
  deleteManualPayrollEntry,
  validatePayrollWeek,
  closePayrollWeek,
  reopenPayrollWeek,
  listPayrollAudit,
  writePayrollAudit,
};
