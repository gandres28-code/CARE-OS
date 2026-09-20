"use strict";

const assert = require("assert");
const { parseCookies, tokenHash } = require("../services/auth/sessionService");
const { isPublicPath, requiredRoleFor, requiresRecentReauth, roleMatches } = require("../middleware/security");

assert.deepStrictEqual(parseCookies("care_session=abc123; theme=light"), {
  care_session: "abc123",
  theme: "light",
});
assert.strictEqual(tokenHash("secret").length, 64);
assert.strictEqual(isPublicPath("/launch"), true);
assert.strictEqual(isPublicPath("/healthz"), true);
assert.strictEqual(isPublicPath("/readyz"), true);
assert.strictEqual(isPublicPath("/css/app.css"), true);
assert.strictEqual(isPublicPath("/api/v2/payroll"), false);
assert.strictEqual(isPublicPath("/test-mobile-code-login"), false);
assert.strictEqual(roleMatches("Dispatch / Inspector", ["dispatch"]), true);
assert.strictEqual(roleMatches("Cleaner", ["admin", "manager"]), false);
assert.deepStrictEqual(requiredRoleFor({ path: "/api/v2/payroll", method: "GET" }), ["admin", "manager", "payroll"]);
assert.deepStrictEqual(requiredRoleFor({ path: "/api/sync-queue/retry", method: "POST" }), ["admin"]);
assert.deepStrictEqual(requiredRoleFor({ path: "/api/v2/dashboard", method: "GET" }), ["admin", "manager", "operations", "dispatch", "reports"]);
assert.deepStrictEqual(requiredRoleFor({ path: "/api/communications/announcements", method: "POST" }), ["admin", "manager", "operations", "dispatch"]);
assert.strictEqual(requiresRecentReauth({ path:"/api/payroll/week/close", method:"POST" }), true);
assert.strictEqual(requiresRecentReauth({ path:"/api/v2/employees/42/status", method:"PATCH" }), true);
assert.strictEqual(requiresRecentReauth({ path:"/api/security/migrate-employee-codes", method:"POST" }), true);
assert.deepStrictEqual(requiredRoleFor({ path:"/api/security/employee-code-status", method:"GET" }), ["admin"]);
assert.strictEqual(requiresRecentReauth({ path:"/api/service-orders/42/status", method:"PATCH" }), false);

console.log("security tests passed");
