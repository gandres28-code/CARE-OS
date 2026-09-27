async function findEmployeeByCode(notion, databaseId, code) {
  if (!databaseId) {
    throw new Error("Falta NOTION_EMPLOYEES_DATABASE_ID");
  }

  const cleanCode = String(code || "").trim();

  const response = await notion.databases.query({
    database_id: databaseId,
    page_size: 100,
  });

  return (response.results || []).find((page) => {
    const props = page.properties || {};

    const employeeCode =
      props.Code?.rich_text?.map((t) => t.plain_text).join("").trim() ||
      props.Code?.number?.toString().padStart(4, "0") ||
      "";

    return employeeCode === cleanCode;
  });
}

function getEmployeeName(page) {
  const props = page?.properties || {};

  return (
    props.Employee?.title?.map((t) => t.plain_text).join("").trim() ||
    props.Employee?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    ""
  );
}

function getEmployeeCode(page) {
  const props = page?.properties || {};

  return (
    props.Code?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    props.Code?.number?.toString().padStart(4, "0") ||
    ""
  );
}

function getEmployeeRole(page) {
  const props = page?.properties || {};

  return (
    props.Role?.select?.name ||
    props.Role?.status?.name ||
    props.Role?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    ""
  );
}

function isEmployeeActive(page) {
  const props = page?.properties || {};
  return props.Active?.checkbox === true;
}

function getPermissionsFromRole(role) {
  const cleanRole = String(role || "").trim().toLowerCase();

  const permissions = {
    cleaner: ["cleaning"],
    "cleaner / inspector": ["cleaning", "inspection"],
    inspector: ["inspection"],
    runner: ["service_orders", "clock"],
    "laundry / activities / runner": ["service_orders", "clock"],
    "laundry / activities": ["clock"],
    laundry: ["clock"],
    activities: ["clock"],
    "dispatch / inspector": ["inspection", "operations", "rooms"],
    dispatch: ["operations", "rooms", "reports"],
    operations: ["operations", "rooms", "reports"],
    admin: ["all"],
    manager: ["all"],
  };

  return permissions[cleanRole] || [];
}

function pageToEmployee(page) {
  const name = getEmployeeName(page);
  const code = getEmployeeCode(page);
  const role = getEmployeeRole(page);
  const active = isEmployeeActive(page);

  return {
    id: page?.id || "",
    name,
    code,
    role,
    active,
    hotel: "Default Hotel",
    permissions: getPermissionsFromRole(role),
  };
}

module.exports = {
  findEmployeeByCode,
  getEmployeeName,
  getEmployeeCode,
  getEmployeeRole,
  isEmployeeActive,
  getPermissionsFromRole,
  pageToEmployee,
};
