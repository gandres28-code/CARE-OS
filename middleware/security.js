"use strict";

const { COOKIE_NAME, parseCookies, roleKey } = require("../services/auth/sessionService");

const PUBLIC_PATHS = new Set([
  "/launch", "/launch.html", "/manifest.webmanifest", "/favicon.ico",
  "/login-role", "/mobile-code-login", "/api/auth/login", "/api/auth/logout",
  "/api/push/config", "/healthz", "/readyz",
]);
const PUBLIC_PREFIXES = ["/css/", "/js/", "/icons/", "/socket.io/"];

function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function roleMatches(role, groups) {
  const normalized = roleKey(role);
  return groups.some((group) => normalized.includes(group));
}

function requiredRoleFor(req) {
  const path = req.path;
  const method = req.method.toUpperCase();
  if (/^\/dashboard-data|^\/api\/v2\/(dashboard|bootstrap)|^\/api\/(intelligence|ai-director)|^\/statistics-(data|history)|^\/cleaner-profile-data/.test(path)) return ["admin", "manager", "operations", "dispatch", "reports"];
  if (/^\/api\/(?:v2\/)?payroll|^\/generate-payroll|^\/payroll-(excel|preview)|^\/delete-payroll|^\/backfill-payroll/.test(path)) return ["admin", "manager", "payroll"];
  if (/^\/api\/v2\/employees|^\/employee-(center|profile)|^\/refresh-employees/.test(path)) return ["admin", "manager"];
  if (/^\/api\/sync|^\/api\/sync-queue|^\/api\/security|^\/debug-env|^\/api\/cache-status|^\/api\/database-status|^\/api\/core-status/.test(path)) return ["admin"];
  if (/^\/api\/admin|^\/rooms-manager/.test(path) && method !== "GET") return ["admin", "manager", "operations", "dispatch"];
  if (/^\/api\/communications\/announcements/.test(path) && method !== "GET") return ["admin", "manager", "operations", "dispatch"];
  if (/^\/api\/service-orders\/[^/]+\/status$/.test(path) && method === "PATCH") return ["admin", "manager", "operations", "dispatch", "runner"];
  if (/^\/api\/service-orders/.test(path) && method !== "GET") return ["admin", "manager", "operations", "dispatch"];
  return null;
}

function requiresRecentReauth(req) {
  const path = req.path;
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return /^\/delete-payroll-week/.test(path);
  if (/^\/api\/payroll\/(week\/(close|reopen)|records\/[^/]+|manual-entry\/[^/]+)/.test(path)) return true;
  if (/^\/api\/security\/migrate-employee-codes$/.test(path)) return true;
  if (/^\/api\/v2\/employees(?:\/|$)/.test(path) && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  return false;
}

function createSecurityMiddleware({ sessions, production = process.env.NODE_ENV === "production" }) {
  if (!sessions) throw new Error("Security middleware requiere SessionService.");

  return async function securityMiddleware(req, res, next) {
    try {
      if (isPublicPath(req.path)) return next();

      if (!["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
        const origin = String(req.get("origin") || "").trim();
        const configured = String(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
        if (origin && configured.length && !configured.includes(origin)) {
          return res.status(403).json({ ok: false, code: "ORIGIN_REJECTED", message: "Origen de solicitud no autorizado." });
        }
      }

      const cookies = parseCookies(req.headers.cookie || "");
      const token = cookies[COOKIE_NAME] || "";
      const session = await sessions.getSession(token);
      req.auth = session;
      req.sessionToken = token;

      const isApi = req.path.startsWith("/api/") || ["/action", "/inspector-action", "/clock-in", "/clock-out"].includes(req.path);
      if (!session) {
        if (!production && process.env.SECURITY_ENFORCEMENT === "observe") return next();
        if (isApi) return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", message: "Tu sesión terminó. Vuelve a iniciar sesión." });
        return res.redirect(302, "/launch");
      }

      const allowedRoles = requiredRoleFor(req);
      if (allowedRoles && !roleMatches(session.role, allowedRoles)) {
        await sessions.audit({ session, action: "ACCESS_DENIED", targetType: "route", targetId: req.path, request: { ip: req.ip, requestId: req.requestId } });
        return res.status(403).json({ ok: false, code: "FORBIDDEN", message: "No tienes permiso para realizar esta acción." });
      }
      if (requiresRecentReauth(req)) {
        const verifiedAt = session.reauthenticated_at ? new Date(session.reauthenticated_at).getTime() : 0;
        const maxAgeMs = Math.max(1, Number(process.env.SENSITIVE_REAUTH_MINUTES || 10)) * 60000;
        if (!verifiedAt || Date.now() - verifiedAt > maxAgeMs) {
          return res.status(428).json({ ok: false, code: "REAUTH_REQUIRED", message: "Confirma tu código para continuar con esta acción sensible." });
        }
      }
      next();
    } catch (error) {
      console.error("SECURITY MIDDLEWARE ERROR:", error.message);
      return res.status(503).json({ ok: false, code: "AUTH_UNAVAILABLE", message: "No se pudo verificar la sesión de forma segura." });
    }
  };
}

module.exports = { createSecurityMiddleware, isPublicPath, requiredRoleFor, requiresRecentReauth, roleMatches };
