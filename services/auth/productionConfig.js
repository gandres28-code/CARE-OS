"use strict";

function splitOrigins(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function validateProductionConfig(env = process.env) {
  const errors = [];
  const required = [
    ["DATABASENEW_URL", "PostgreSQL es obligatorio"],
    ["NOTION_EMPLOYEES_DATABASE_ID", "La base Employees de Notion es obligatoria"],
    ["CODE_PEPPER", "El secreto de credenciales es obligatorio"],
    ["ALLOWED_ORIGINS", "Los orígenes web permitidos son obligatorios"],
  ];

  for (const [name, message] of required) {
    if (!String(env[name] || "").trim()) errors.push(`${name}: ${message}.`);
  }

  if (!String(env.NOTION_API_KEY || env.NOTION_TOKEN || "").trim()) {
    errors.push("NOTION_API_KEY: la integración de Notion es obligatoria.");
  }

  const pepper = String(env.CODE_PEPPER || "");
  if (pepper && pepper.length < 32) errors.push("CODE_PEPPER: debe tener al menos 32 caracteres.");

  const origins = splitOrigins(env.ALLOWED_ORIGINS);
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin) {
        errors.push(`ALLOWED_ORIGINS: '${origin}' debe ser un origen HTTPS sin ruta.`);
      }
    } catch (_error) {
      errors.push(`ALLOWED_ORIGINS: '${origin}' no es una URL válida.`);
    }
  }

  if (String(env.ALLOW_LEGACY_NAME_LOGIN || "false").toLowerCase() === "true") {
    errors.push("ALLOW_LEGACY_NAME_LOGIN: debe ser false en producción.");
  }

  return { ok: errors.length === 0, errors };
}

function assertProductionConfig(env = process.env) {
  const result = validateProductionConfig(env);
  if (!result.ok) {
    const error = new Error(`Configuración de producción inválida:\n- ${result.errors.join("\n- ")}`);
    error.code = "INVALID_PRODUCTION_CONFIG";
    error.validationErrors = result.errors;
    throw error;
  }
  return result;
}

module.exports = { assertProductionConfig, splitOrigins, validateProductionConfig };
