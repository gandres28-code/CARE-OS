const webpush = require("web-push");

let webPushReady = false;

function normalizeEmployeeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function initializeFirebaseAdmin() {
  if (webPushReady) return true;

  const publicKey = String(process.env.WEB_PUSH_PUBLIC_KEY || "").trim();
  const privateKey = String(process.env.WEB_PUSH_PRIVATE_KEY || "").trim();
  const subject = String(process.env.WEB_PUSH_SUBJECT || "mailto:admin@417maid.com").trim();

  if (!publicKey || !privateKey) {
    console.warn("⚠️ Web Push desactivado: faltan WEB_PUSH_PUBLIC_KEY y WEB_PUSH_PRIVATE_KEY.");
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  webPushReady = true;
  console.log("✅ Web Push estándar activado");
  return true;
}

async function registerPushToken(query, payload = {}) {
  const employeeName = String(payload.employeeName || "").trim();
  const employeeRole = String(payload.employeeRole || "").trim();
  const subscription = payload.subscription;

  if (!employeeName) throw new Error("Falta employeeName");
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("La suscripción push no es válida");
  }

  const employeeKey = normalizeEmployeeKey(employeeName);
  await query(`
    INSERT INTO web_push_subscriptions (
      employee_name, employee_key, employee_role, endpoint, p256dh, auth,
      platform, user_agent, active, last_seen_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,NOW(),NOW())
    ON CONFLICT (endpoint) DO UPDATE SET
      employee_name = EXCLUDED.employee_name,
      employee_key = EXCLUDED.employee_key,
      employee_role = EXCLUDED.employee_role,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      platform = EXCLUDED.platform,
      user_agent = EXCLUDED.user_agent,
      active = TRUE,
      last_seen_at = NOW(),
      updated_at = NOW()
  `, [
    employeeName,
    employeeKey,
    employeeRole,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    String(payload.platform || "web"),
    String(payload.userAgent || "").slice(0, 1000),
  ]);

  return { employeeName, employeeKey, employeeRole };
}

async function deactivatePushToken(query, endpoint) {
  if (!endpoint) return;
  await query(`UPDATE web_push_subscriptions SET active=FALSE, updated_at=NOW() WHERE endpoint=$1`, [endpoint]);
}

async function sendPushToEmployees(query, employeeNames, message = {}) {
  if (!initializeFirebaseAdmin()) return { sent: 0, failed: 0, skipped: true, reason: "web-push-not-configured" };

  const keys = [...new Set((employeeNames || []).map(normalizeEmployeeKey).filter(Boolean))];
  if (!keys.length) return { sent: 0, failed: 0, skipped: true, reason: "no-employees" };

  const result = await query(`
    SELECT endpoint, p256dh, auth
    FROM web_push_subscriptions
    WHERE active=TRUE AND employee_key = ANY($1::text[])
  `, [keys]);

  if (!result.rows.length) return { sent: 0, failed: 0, skipped: true, reason: "no-active-subscriptions" };

  const payload = JSON.stringify({
    title: String(message.title || "Care"),
    body: String(message.body || "Tienes una actualización."),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: String(message.tag || `417maid-${Date.now()}`),
    url: String(message.link || "/launch"),
    urgent: Boolean(message.urgent),
    data: message.data || {},
  });

  let sent = 0;
  let failed = 0;
  const invalidEndpoints = [];

  await Promise.all(result.rows.map(async row => {
    try {
      await webpush.sendNotification({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }, payload, {
        TTL: 60 * 60,
        urgency: message.urgent ? "high" : "normal",
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      const statusCode = Number(error?.statusCode || 0);
      console.error("WEB PUSH ERROR:", statusCode || "unknown", error?.body || error?.message || error);
      if ([404, 410].includes(statusCode)) invalidEndpoints.push(row.endpoint);
    }
  }));

  if (invalidEndpoints.length) {
    await query(`
      UPDATE web_push_subscriptions
      SET active=FALSE, updated_at=NOW()
      WHERE endpoint = ANY($1::text[])
    `, [invalidEndpoints]);
  }

  return { sent, failed, invalidSubscriptions: invalidEndpoints.length };
}

async function sendPushToRole(query, role, message = {}) {
  if (!initializeFirebaseAdmin()) return { sent: 0, failed: 0, skipped: true, reason: "web-push-not-configured" };

  const roleKey = normalizeEmployeeKey(role);
  if (!roleKey) return { sent: 0, failed: 0, skipped: true, reason: "no-role" };

  const result = await query(`
    SELECT endpoint, p256dh, auth
    FROM web_push_subscriptions
    WHERE active=TRUE
      AND LOWER(TRIM(employee_role)) = $1
  `, [roleKey]);

  if (!result.rows.length) return { sent: 0, failed: 0, skipped: true, reason: "no-active-subscriptions" };

  const payload = JSON.stringify({
    title: String(message.title || "Care"),
    body: String(message.body || "Tienes una actualización."),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: String(message.tag || `417maid-${Date.now()}`),
    url: String(message.link || "/launch"),
    urgent: Boolean(message.urgent),
    data: message.data || {},
  });

  let sent = 0;
  let failed = 0;
  const invalidEndpoints = [];

  await Promise.all(result.rows.map(async row => {
    try {
      await webpush.sendNotification({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }, payload, {
        TTL: 60 * 60,
        urgency: message.urgent ? "high" : "normal",
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      const statusCode = Number(error?.statusCode || 0);
      console.error("WEB PUSH ROLE ERROR:", statusCode || "unknown", error?.body || error?.message || error);
      if ([404, 410].includes(statusCode)) invalidEndpoints.push(row.endpoint);
    }
  }));

  if (invalidEndpoints.length) {
    await query(`
      UPDATE web_push_subscriptions
      SET active=FALSE, updated_at=NOW()
      WHERE endpoint = ANY($1::text[])
    `, [invalidEndpoints]);
  }

  return { sent, failed, invalidSubscriptions: invalidEndpoints.length };
}

module.exports = {
  initializeFirebaseAdmin,
  registerPushToken,
  deactivatePushToken,
  sendPushToEmployees,
  sendPushToRole,
  normalizeEmployeeKey,
};
