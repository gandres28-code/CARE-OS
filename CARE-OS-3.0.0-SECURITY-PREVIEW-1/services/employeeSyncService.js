const { query } = require("../db");

function normalizeEmployeeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[|,]+/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function readPlainText(property) {
  if (!property) return "";

  if (property.title) {
    return property.title.map((item) => item.plain_text || "").join("").trim();
  }

  if (property.rich_text) {
    return property.rich_text.map((item) => item.plain_text || "").join("").trim();
  }

  if (property.select?.name) {
    return property.select.name.trim();
  }

  if (property.status?.name) {
    return property.status.name.trim();
  }

  if (property.multi_select) {
    return property.multi_select.map((item) => item.name).join(" / ").trim();
  }

  if (property.number !== undefined && property.number !== null) {
    return String(property.number);
  }

  return "";
}

function getEmployeeFromNotionPage(page) {
  const properties = page?.properties || {};

  const name =
    readPlainText(properties.Employee) ||
    readPlainText(properties.Name) ||
    readPlainText(properties.Nombre);

  const code =
    readPlainText(properties.Code) ||
    readPlainText(properties.Codigo) ||
    readPlainText(properties["Employee Code"]);

  const role =
    readPlainText(properties.Role) ||
    readPlainText(properties.role);

  const hourlyRate =
    Number(
      properties["Hourly Rate"]?.number ??
      properties.Rate?.number ??
      properties["Pay Rate"]?.number ??
      0
    ) || 0;

  let active = true;

  if (properties.Active?.checkbox !== undefined) {
    active = properties.Active.checkbox === true;
  } else if (properties.active?.checkbox !== undefined) {
    active = properties.active.checkbox === true;
  }

  return {
    notionId: page?.id || "",
    name,
    normalizedName: normalizeEmployeeName(name),
    code,
    role,
    hourlyRate,
    active,
    rawData: page,
  };
}

async function upsertEmployee(employee) {
  if (!employee.name || !employee.normalizedName) {
    return {
      saved: false,
      reason: "missing-name",
    };
  }

  const sql = `
    INSERT INTO employees (
      notion_id,
      name,
      normalized_name,
      code,
      role,
      hourly_rate,
      active,
      permissions,
      source,
      updated_at
    )
    VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8::jsonb, 'notion', NOW())
    ON CONFLICT (notion_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      normalized_name = EXCLUDED.normalized_name,
      code = EXCLUDED.code,
      role = EXCLUDED.role,
      hourly_rate = EXCLUDED.hourly_rate,
      active = EXCLUDED.active,
      permissions = EXCLUDED.permissions,
      source = 'notion',
      updated_at = NOW()
    RETURNING id, notion_id, name, code, role, hourly_rate, active
  `;

  const permissions = [];

  const result = await query(sql, [
    employee.notionId,
    employee.name,
    employee.normalizedName,
    employee.code,
    employee.role,
    employee.hourlyRate,
    employee.active,
    JSON.stringify(permissions),
  ]);

  return {
    saved: true,
    employee: result.rows[0],
  };
}

async function syncEmployeesFromNotion({
  notion,
  databaseId,
  queryDatabase,
}) {
  if (!databaseId) {
    throw new Error("Falta NOTION_EMPLOYEES_DATABASE_ID");
  }

  const startedAt = new Date();

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
      VALUES (
        'employees-notion-postgres',
        'notion',
        'postgres',
        'running',
        NOW(),
        0,
        '',
        NOW()
      )
      ON CONFLICT (sync_key)
      DO UPDATE SET
        status = 'running',
        last_started_at = NOW(),
        records_processed = 0,
        error_message = '',
        updated_at = NOW()
    `
  );

  try {
    let pages = [];
    let cursor;

    do {
      const body = {
        database_id: databaseId,
        page_size: 100,
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

    for (const page of pages) {
      const employee = getEmployeeFromNotionPage(page);
      const result = await upsertEmployee(employee);

      if (result.saved) {
        saved += 1;
      } else {
        skipped += 1;
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
        "employees-notion-postgres",
        saved,
        JSON.stringify({
          totalFromNotion: pages.length,
          saved,
          skipped,
          durationMs: Date.now() - startedAt.getTime(),
        }),
      ]
    );

    return {
      ok: true,
      totalFromNotion: pages.length,
      saved,
      skipped,
      durationMs: Date.now() - startedAt.getTime(),
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
      ["employees-notion-postgres", error.message]
    );

    throw error;
  }
}

async function findEmployeeByCodePostgres(code) {
  const cleanCode = String(code || "").trim();

  if (!cleanCode) return null;

  const result = await query(
    `
      SELECT
        id,
        notion_id,
        name,
        code,
        role,
        hourly_rate,
        active,
        permissions
      FROM employees
      WHERE code = $1
      LIMIT 1
    `,
    [cleanCode]
  );

  return result.rows[0] || null;
}

async function listEmployeesPostgres({ activeOnly = true } = {}) {
  const result = await query(
    `
      SELECT
        id,
        notion_id,
        name,
        code,
        role,
        hourly_rate,
        active,
        permissions,
        updated_at
      FROM employees
      WHERE ($1::boolean = false OR active = true)
      ORDER BY name ASC
    `,
    [activeOnly]
  );

  return result.rows;
}

async function getEmployeeSyncStatus() {
  const result = await query(
    `
      SELECT *
      FROM sync_status
      WHERE sync_key = 'employees-notion-postgres'
      LIMIT 1
    `
  );

  return result.rows[0] || null;
}

module.exports = {
  normalizeEmployeeName,
  getEmployeeFromNotionPage,
  syncEmployeesFromNotion,
  findEmployeeByCodePostgres,
  listEmployeesPostgres,
  getEmployeeSyncStatus,
};
