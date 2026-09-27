"use strict";

const crypto = require("crypto");

const COOKIE_NAME = "care_session";

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function parseCookies(header = "") {
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return cookies;
      const key = decodeURIComponent(part.slice(0, separator));
      const value = decodeURIComponent(part.slice(separator + 1));
      cookies[key] = value;
      return cookies;
    }, {});
}

function roleKey(role) {
  return String(role || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sessionHoursForRole(role) {
  const value = roleKey(role);
  const administrative = /admin|manager|operations|dispatch|payroll/.test(value);
  const configured = administrative
    ? process.env.ADMIN_SESSION_DURATION_HOURS || 4
    : process.env.SESSION_DURATION_HOURS || 12;
  return Math.min(Math.max(Number(configured) || 4, 1), 24);
}

function cookieOptions(maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production";
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].filter(Boolean);
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = cookieOptions(maxAgeSeconds);
  parts[0] = `${COOKIE_NAME}=${encodeURIComponent(token)}`;
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", cookieOptions(0).join("; "));
}

function createSessionService({ query, now = () => new Date() }) {
  if (typeof query !== "function") throw new Error("SessionService requiere query.");

  async function createSession(user, request = {}) {
    const token = crypto.randomBytes(32).toString("base64url");
    const hours = sessionHoursForRole(user.role);
    const expiresAt = new Date(now().getTime() + hours * 60 * 60 * 1000);
    const result = await query(
      `INSERT INTO auth_sessions
        (token_hash, employee_id, employee_name, role, permissions, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       RETURNING id, employee_id, employee_name, role, permissions, created_at, expires_at`,
      [
        tokenHash(token),
        user.id ? String(user.id) : null,
        String(user.name || ""),
        String(user.role || ""),
        JSON.stringify(user.permissions || []),
        String(request.ip || "").slice(0, 120),
        String(request.userAgent || "").slice(0, 500),
        expiresAt.toISOString(),
      ]
    );
    return { token, expiresAt, session: result.rows[0] };
  }

  async function getSession(token) {
    if (!token) return null;
    const result = await query(
      `SELECT id, employee_id, employee_name, role, permissions, created_at, expires_at, reauthenticated_at
       FROM auth_sessions
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [tokenHash(token)]
    );
    return result.rows[0] || null;
  }

  async function revokeSession(token) {
    if (!token) return false;
    const result = await query(
      `UPDATE auth_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL`,
      [tokenHash(token)]
    );
    return result.rowCount > 0;
  }

  async function markReauthenticated(token) {
    if (!token) return null;
    const result = await query(
      `UPDATE auth_sessions SET reauthenticated_at=NOW()
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()
       RETURNING id, employee_id, employee_name, role, permissions, created_at, expires_at, reauthenticated_at`,
      [tokenHash(token)]
    );
    return result.rows[0] || null;
  }

  async function audit({ session = null, action, targetType = "", targetId = "", details = {}, request = {} }) {
    await query(
      `INSERT INTO security_audit_log
        (session_id, employee_id, employee_name, role, action, target_type, target_id, details, ip_address, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        session?.id || null,
        session?.employee_id || null,
        session?.employee_name || "",
        session?.role || "",
        String(action || "UNKNOWN"),
        String(targetType || ""),
        String(targetId || ""),
        JSON.stringify(details || {}),
        String(request.ip || "").slice(0, 120),
        String(request.requestId || ""),
      ]
    );
  }

  return { createSession, getSession, revokeSession, markReauthenticated, audit };
}

module.exports = {
  COOKIE_NAME,
  createSessionService,
  parseCookies,
  roleKey,
  setSessionCookie,
  clearSessionCookie,
  tokenHash,
};
