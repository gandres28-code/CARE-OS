require("dotenv").config();
const express = require("express");
const compression = require("compression");
const { Client } = require("@notionhq/client");
const OpenAI = require("openai");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const EmployeeService = require("./services/employeeService");
const { createOSCore } = require("./services/osCore/index.js");
const {
  initializeDatabase,
  testDatabaseConnection,
  query: postgresQuery,
  getPool,
} = require("./db");
const {
  syncEmployeesFromNotion,
  listEmployeesPostgres,
  getEmployeeSyncStatus,
} = require("./services/employeeSyncService");
const {
  syncRoomsFromNotion,
  listRoomsPostgres,
  getRoomSyncStatus,
} = require("./services/roomSyncService");
const {
  syncPayrollFromNotion,
  listPayrollPostgres,
  getPayrollSummaryPostgres,
  getPayrollSyncStatus,
  mapPayrollPostgresToLegacy,
  comparePayrollRecordSets,
  getPayrollRecordsFromNotionPage,
} = require("./services/payrollSyncService");
const {
  getPayrollWeekState,
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
} = require("./services/payrollManagementService");

const {
  getDataApiHealth,
  listDataApiEmployees,
  listDataApiRooms,
  getDataApiDashboard,
  getDataApiPayrollWeek,
  getDataApiBootstrap,
} = require("./services/dataApiService");
const {
  enqueueSyncJob,
  recoverStaleJobs,
  processNextSyncJob,
  getSyncQueueStatus,
  retryFailedJobs,
} = require("./services/syncQueueService");
const {
  createEventEngine,
} = require("./services/eventEngine");
const {
  createIntelligenceEngine,
} = require("./services/intelligenceEngine");
const {
  createAIOperationsDirector,
} = require("./services/aiOperationsDirector");
const { qualityEngine: QualityEngine } = require("./services/intelligence");
const {
  initializeFirebaseAdmin,
  registerPushToken,
  deactivatePushToken,
  sendPushToEmployees,
  sendPushToRole,
} = require("./services/pushNotifications");
const {
  createSessionService,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  COOKIE_NAME,
} = require("./services/auth/sessionService");
const { createSecurityMiddleware } = require("./middleware/security");

const server = http.createServer(app);

// =========================================================
// POSTGRESQL · CARE OS
// =========================================================
// En esta primera etapa PostgreSQL se prepara al arrancar, pero Notion
// continúa funcionando como fuente operativa. Si PostgreSQL no responde,
// el servidor no se cae y la operación diaria puede continuar.
let postgresStatus = {
  configured: !!process.env.DATABASENEW_URL,
  connected: false,
  database: "",
  databaseTime: null,
  lastCheckedAt: null,
  error: "",
};

async function startPostgres() {
  postgresStatus.configured = !!process.env.DATABASENEW_URL;
  postgresStatus.lastCheckedAt = new Date().toISOString();

  if (!postgresStatus.configured) {
    postgresStatus.connected = false;
    postgresStatus.error =
      "Falta DATABASENEW_URL en las variables de entorno de Render.";

    console.warn("⚠️ PostgreSQL sin configurar:", postgresStatus.error);
    return postgresStatus;
  }

  try {
    const database = await initializeDatabase();

    postgresStatus = {
      configured: true,
      connected: true,
      database: database.database_name || "",
      databaseTime: database.database_time || null,
      lastCheckedAt: new Date().toISOString(),
      error: "",
    };

    console.log("✅ PostgreSQL conectado:", {
      database: postgresStatus.database,
      time: postgresStatus.databaseTime,
    });
  } catch (error) {
    postgresStatus = {
      configured: true,
      connected: false,
      database: "",
      databaseTime: null,
      lastCheckedAt: new Date().toISOString(),
      error: error.message,
    };

    console.error("⚠️ PostgreSQL no pudo iniciar:", error.message);
  }

  return postgresStatus;
}

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
const originAllowed = (origin) => !origin || !allowedOrigins.length || allowedOrigins.includes(origin);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      const allowed = originAllowed(origin);
      callback(allowed ? null : new Error("Origin not allowed"), allowed);
    },
    credentials: true,
  },
});

const SessionService = createSessionService({ query: postgresQuery });
io.use(async (socket, next) => {
  try {
    const cookies = parseCookies(socket.handshake.headers.cookie || "");
    const session = await SessionService.getSession(cookies[COOKIE_NAME] || "");
    if (!session) return next(new Error("Authentication required"));
    socket.data.auth = session;
    next();
  } catch (error) {
    next(new Error("Authentication unavailable"));
  }
});

const OSCore = createOSCore({
  io,
  config: {
    cacheTtlMs: process.env.CORE_CACHE_TTL_MS,
    cacheMaxEntries: process.env.CORE_CACHE_MAX_ENTRIES,
    notionConcurrency: process.env.CORE_NOTION_CONCURRENCY,
    notionMinDelayMs: process.env.CORE_NOTION_MIN_DELAY_MS,
    notionMaxQueueSize: process.env.CORE_NOTION_MAX_QUEUE_SIZE,
  },
});

console.log("Care Core iniciado:", OSCore.version, OSCore.mode);

app.use(createSecurityMiddleware({ sessions: SessionService }));

function coreDeleteKeys(...keys) {
  let deleted = 0;

  for (const key of keys.flat().filter(Boolean)) {
    if (OSCore?.cache?.delete?.(String(key))) {
      deleted += 1;
    }
  }

  return deleted;
}

function coreInvalidateTags(...tags) {
  let removed = 0;

  for (const tag of tags.flat().filter(Boolean)) {
    removed += Number(
      OSCore?.cache?.invalidateTag?.(String(tag)) || 0
    );
  }

  return removed;
}
let systemNotifications = [];
let systemTimeline = [];
function addNotification(title, message) {
  const notification = {
    id: Date.now(),
    title,
    message,
    time: new Date().toLocaleTimeString(),
  };

  systemNotifications.unshift(notification);

  if (systemNotifications.length > 100) {
    systemNotifications.pop();
  }

  io.emit("system-notification", notification);
}
app.get("/notifications-data", (req, res) => {
  res.json({
    ok: true,
    notifications: systemNotifications,
  });
});
app.get("/api/timeline", (req, res) => {
  res.json({
    ok: true,
    timeline: systemTimeline.slice(0, 100),
  });
});

app.get("/api/core-status", (req, res) => {
  res.json(OSCore.status());
});

app.get("/api/cache-status", (req, res) => {
  res.json({
    ok: true,
    rooms: ServerCache.rooms.size,
    employees: ServerCache.employees.size,
    dashboard: ServerCache.dashboard.size,
    assignments: ServerCache.assignments.size,
    timeline: systemTimeline.length,
    notifications: systemNotifications.length,
  });
});
const multer = require("multer");
const { File } = require("node:buffer");
const cloudinary = require("cloudinary").v2;
const upload = multer({ storage: multer.memoryStorage() });
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
// ■ Anti duplicados
const recentActions = new Map();
const cacheStore = new Map();

// Evita que varias pantallas hagan la misma consulta a Notion al mismo tiempo.
// Todos esperan la misma promesa en vez de formar una fila de llamadas duplicadas.
const inFlightRequests = new Map();

async function singleFlight(key, task) {
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }

  const promise = Promise.resolve()
    .then(task)
    .finally(() => inFlightRequests.delete(key));

  inFlightRequests.set(key, promise);
  return promise;
}

// =========================================================
// SERVER CACHE ENGINE v1
// =========================================================
// Cache en memoria RAM para reducir llamadas repetidas a Notion.
// Este cache vive mientras Render mantiene vivo el servidor.
// Si Render reinicia, el cache se reconstruye automáticamente.
const ServerCache = {
  rooms: new Map(),
  employees: new Map(),
  dashboard: new Map(),
  assignments: new Map(),

  get(section, key) {
    const bucket = this[section];

    if (!bucket || typeof bucket.get !== "function") {
      return null;
    }

    return bucket.get(key) || null;
  },

  set(section, key, value) {
    if (!this[section] || typeof this[section].set !== "function") {
      this[section] = new Map();
    }

    this[section].set(key, {
      value,
      updatedAt: new Date().toISOString(),
    });
  },

  clear(section, key = null) {
    const bucket = this[section];

    if (!bucket || typeof bucket.clear !== "function") {
      return;
    }

    if (key) {
      bucket.delete(key);
      return;
    }

    bucket.clear();
  },
};

function getCache(key){
  const item = cacheStore.get(key);

  if(!item){
    return null;
  }

  if(Date.now() > item.expiresAt){
    cacheStore.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data, ttlMs = 5000){
  cacheStore.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

function clearOpsCache(){
  // Borra sólo datos operativos que deben reflejarse inmediatamente.
  // Los schemas y empleados permanecen en cache para proteger a Notion.
  for (const key of Array.from(cacheStore.keys())) {
    const cacheKey = String(key);
    if (
      cacheKey.startsWith("ops:") ||
      cacheKey.startsWith("notifications:") ||
      cacheKey.startsWith("dashboard:data:") ||
      cacheKey.startsWith("dashboard:reports:") ||
      cacheKey.startsWith("dashboard:payroll:") ||
      cacheKey.startsWith("dashboard:timeclock:")
    ) {
      cacheStore.delete(key);
    }
  }

  if (typeof ServerCache !== "undefined") {
    ServerCache.clear("dashboard");
  }

  coreInvalidateTags("dashboard", "operations");
}

function clearRoomCache(date = todayISO()){
  cacheStore.delete(`todayRooms:${date}`);
  cacheStore.delete(`roomsByDate:${date}`);
  cacheStore.delete(`dashboard:data:${date}`);
  cacheStore.delete("master-units");

  if (typeof ServerCache !== "undefined") {
    ServerCache.clear("rooms", date);
    ServerCache.clear("dashboard");
    ServerCache.clear("assignments");
  }

  coreInvalidateTags(`rooms:${date}`, `assignments:${date}`, "dashboard");
}

// =========================================================
// CACHE DE ASIGNACIONES EN TIEMPO REAL
// =========================================================
function clearAssignmentCaches(date = todayISO()) {
  for (const key of Array.from(cacheStore.keys())) {
    const cacheKey = String(key);

    if (
      cacheKey.startsWith("cleaner-assignments:") ||
      cacheKey.startsWith("inspector-assignments:") ||
      cacheKey === `todayRooms:${date}` ||
      cacheKey === `roomsByDate:${date}`
    ) {
      cacheStore.delete(key);
    }
  }

  if (typeof ServerCache !== "undefined") {
    ServerCache.clear("rooms", date);
    ServerCache.clear("assignments");
    ServerCache.clear("dashboard");
  }

  coreInvalidateTags(`rooms:${date}`, `assignments:${date}`, "dashboard");
}

function broadcastAssignmentUpdate(reason = "notion-change", extra = {}) {
  const date = todayISO();
  clearAssignmentCaches(date);

  const payload = {
    reason,
    date,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  io.emit("assignments-updated", payload);
  io.emit("rooms-updated", payload);
}
function broadcastOpsUpdate(payload = {}) {
  clearOpsCache();

  const event = {
    id: Date.now(),
    time: new Date().toISOString(),
    type: payload.type || "ops-update",
    action: payload.action || "",
    unit: payload.unit || "",
    employee: payload.employee || payload.person || "",
    message: payload.message || payload.note || "",
    ...payload,
  };
systemTimeline.unshift(event);

if (systemTimeline.length > 300) {
  systemTimeline.pop();
}
  io.emit("ops-update", event);

  systemNotifications.unshift({
    id: event.id,
    title: getNotificationTitle(event),
    message: getNotificationMessage(event),
    time: new Date().toLocaleTimeString(),
    event,
  });

  if (systemNotifications.length > 100) {
    systemNotifications.pop();
  }

  io.emit("system-notification", systemNotifications[0]);
}
function getNotificationTitle(event) {

  switch(event.type){

    case "action":
      return "📋 Nueva acción";

    case "report":
      return "📨 Nuevo reporte";

    case "hotsos-sent":
      return "✅ HotSOS";

    default:
      return "🔔 Sistema";
  }

}

function getNotificationMessage(event){

  if(event.unit && event.employee){
    return `${event.employee} • ${event.unit}`;
  }

  if(event.unit){
    return `Unidad ${event.unit}`;
  }

  return "Nueva actividad registrada";
}
const cors = require("cors");

app.disable("x-powered-by");
app.use(compression({ threshold: 1024 }));
app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));
app.use(cors({
  origin(origin, callback) {
    const allowed = originAllowed(origin);
    callback(allowed ? null : new Error("Origin not allowed"), allowed);
  },
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  req.requestId = String(req.get("x-request-id") || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  res.setHeader("X-Request-Id", req.requestId);
  if (req.path.startsWith("/api/") || req.path === "/action" || req.path === "/inspector-action") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(express.static("public", { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0, etag: true }));

// Diagnóstico seguro de PostgreSQL. No expone DATABASENEW_URL.
app.get("/api/database-status", async (req, res) => {
  try {
    if (!process.env.DATABASENEW_URL) {
      return res.status(503).json({
        ok: false,
        ...postgresStatus,
      });
    }

    const database = await testDatabaseConnection();

    postgresStatus = {
      configured: true,
      connected: true,
      database: database.database_name || "",
      databaseTime: database.database_time || null,
      lastCheckedAt: new Date().toISOString(),
      error: "",
    };

    return res.json({
      ok: true,
      ...postgresStatus,
    });
  } catch (error) {
    postgresStatus.connected = false;
    postgresStatus.error = error.message;
    postgresStatus.lastCheckedAt = new Date().toISOString();

    return res.status(503).json({
      ok: false,
      ...postgresStatus,
    });
  }
});
// ■ Carpeta para PDFs
const reportsDir = path.join(__dirname, "reports");
if (!fs.existsSync(reportsDir)) {
fs.mkdirSync(reportsDir);
}
app.use("/reports", express.static(reportsDir));
// ■ Carpeta para Excel de nómina
const payrollDir = path.join(__dirname, "payroll_exports");
if (!fs.existsSync(payrollDir)) {
fs.mkdirSync(payrollDir);
}
app.use("/payroll_exports", express.static(payrollDir));
// ■ ENV
const NOTION_API_KEY =
process.env.NOTION_API_KEY ||
process.env.NOTION_TOKEN ||
"";
const NOTION_DATABASE_ID =
process.env.NOTION_DATABASE_ID ||
process.env.DATABASE_ID ||
"37f25b5a514a8092ad64e6a8d478dc76";
const NOTION_LOG_DATABASE_ID =
process.env.NOTION_LOG_DATABASE_ID ||
process.env.NOTION_DAILY_CLEANING_LOGS_DB_ID ||
"";
const NOTION_PAYROLL_DATABASE_ID =
process.env.NOTION_PAYROLL_DATABASE_ID ||
process.env.NOTION_PAYROLL_RECORDS_DB_ID ||
"";
const NOTION_TIME_CLOCK_DATABASE_ID =
  process.env.NOTION_TIME_CLOCK_DATABASE_ID || "";

const NOTION_EMPLOYEES_DATABASE_ID =
  process.env.NOTION_EMPLOYEES_DATABASE_ID || "";
const NOTION_REPORTS_DATABASE_ID =
  process.env.NOTION_REPORTS_DB_ID ||
  process.env.NOTION_REPORTS_DATABASE_ID ||
  process.env.NOTION_REPORT_MESSAGES_DB_ID ||
  "";
const NOTION_REPORT_PHOTOS_DATABASE_ID =
  process.env.NOTION_REPORT_PHOTOS_DB_ID ||
  process.env.NOTION_REPORT_PHOTOS_DATABASE_ID ||
  "";
const OPENAI_API_KEY =
process.env.OPENAI_API_KEY || "";
console.log("■ ENV CHECK");
console.log("NOTION_API_KEY existe:", !!NOTION_API_KEY);
console.log("NOTION_DATABASE_ID existe:", !!NOTION_DATABASE_ID);
console.log("NOTION_LOG_DATABASE_ID existe:", !!NOTION_LOG_DATABASE_ID);
console.log("NOTION_PAYROLL_DATABASE_ID existe:", !!NOTION_PAYROLL_DATABASE_ID);
console.log("NOTION_TIME_CLOCK_DATABASE_ID existe:", !!NOTION_TIME_CLOCK_DATABASE_ID);
console.log("NOTION_EMPLOYEES_DATABASE_ID existe:", !!NOTION_EMPLOYEES_DATABASE_ID);
console.log("NOTION_REPORTS_DATABASE_ID existe:", !!NOTION_REPORTS_DATABASE_ID);
console.log("NOTION_REPORT_PHOTOS_DATABASE_ID existe:", !!NOTION_REPORT_PHOTOS_DATABASE_ID);
console.log("OPENAI_API_KEY existe:", !!OPENAI_API_KEY);
console.log("PAYROLL RAW:", process.env.NOTION_PAYROLL_DATABASE_ID);
const notion = new Client({ auth: NOTION_API_KEY });

// =========================================================
// PROTECCIÓN URGENTE CONTRA NOTION RATE_LIMITED (429)
// =========================================================
// Notion aguanta pocas llamadas por segundo. Este bloque pone una fila única,
// reintentos automáticos y pausa inteligente cuando Notion dice "rate_limited".
const NOTION_MIN_DELAY_MS = Number(process.env.NOTION_MIN_DELAY_MS || 450);
const NOTION_MAX_RETRIES = Number(process.env.NOTION_MAX_RETRIES || 6);
let notionQueue = Promise.resolve();
let lastNotionRequestAt = 0;

function isNotionRateLimitError(error) {
  return (
    error?.code === "rate_limited" ||
    error?.status === 429 ||
    error?.body?.code === "rate_limited" ||
    String(error?.message || "").toLowerCase().includes("rate limited")
  );
}

function getRetryAfterMs(error, attempt) {
  const retryAfter =
    Number(error?.headers?.["retry-after"]) ||
    Number(error?.response?.headers?.["retry-after"]);

  if (retryAfter && retryAfter > 0) {
    return retryAfter * 1000;
  }

  return Math.min(30000, 1500 * Math.pow(2, attempt));
}

async function runNotionTask(taskName, fn) {
  const run = async () => {
    const waitMs = Math.max(0, NOTION_MIN_DELAY_MS - (Date.now() - lastNotionRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastNotionRequestAt = Date.now();

    for (let attempt = 0; attempt <= NOTION_MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!isNotionRateLimitError(error) || attempt >= NOTION_MAX_RETRIES) {
          throw error;
        }

        const delay = getRetryAfterMs(error, attempt);
        console.log(`⏳ Notion rate limited en ${taskName}. Reintentando en ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
      }
    }
  };

  const resultPromise = notionQueue.then(run, run);
  notionQueue = resultPromise.catch(() => {});
  return resultPromise;
}

function patchNotionClientForRateLimits(client) {
  const wrap = (group, method) => {
    const original = client[group][method].bind(client[group]);
    client[group][method] = (args) => runNotionTask(`${group}.${method}`, () => original(args));
  };

  wrap("databases", "query");
  wrap("databases", "retrieve");
  wrap("pages", "create");
  wrap("pages", "update");
  wrap("pages", "retrieve");
}

patchNotionClientForRateLimits(notion);

async function notionFetch(url, options = {}, taskName = "fetch") {
  return runNotionTask(taskName, async () => {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const error = new Error("Notion rate_limited");
      error.status = 429;
      error.headers = {
        "retry-after": response.headers.get("retry-after"),
      };
      throw error;
    }

    return response;
  });
}


// =========================================================
// FIX NOTION 2025: DATABASES CON MULTIPLE DATA SOURCES
// =========================================================
// Notion cambió su API: una Database ahora puede tener varias Data Sources.
// Si una base tiene multiple data sources, notion.databases.query falla.
// Estos helpers resuelven automáticamente el data_source_id correcto y usan
// /v1/data_sources/{id}/query con Notion-Version 2025-09-03.
const NOTION_API_VERSION = process.env.NOTION_API_VERSION || "2025-09-03";
const notionDataSourceCache = new Map();

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_API_VERSION,
  };
}

async function notionRest(pathValue, options = {}, taskName = "notion.rest") {
  const response = await notionFetch(
    `https://api.notion.com/v1${pathValue}`,
    {
      ...options,
      headers: {
        ...notionHeaders(),
        ...(options.headers || {}),
      },
    },
    taskName
  );

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(data.message || `Notion error ${response.status}`);
    error.status = response.status;
    error.code = data.code;
    error.body = data;
    throw error;
  }

  return data;
}

function idWithoutDashes(id) {
  return String(id || "").replace(/-/g, "");
}

async function resolveDataSourceId(databaseOrDataSourceId) {
  const rawId = String(databaseOrDataSourceId || "").trim();
  if (!rawId) return rawId;

  const cacheKey = `dataSource:${idWithoutDashes(rawId)}`;
  const cached = getCache(cacheKey) || notionDataSourceCache.get(cacheKey);
  if (cached) return cached;

  try {
    const db = await notionRest(
      `/databases/${rawId}`,
      { method: "GET" },
      "databases.retrieve.2025"
    );

    const firstDataSourceId =
      db.data_sources?.[0]?.id ||
      db.data_sources?.[0]?.data_source_id ||
      db.data_sources?.[0];

    const resolved = firstDataSourceId || rawId;
    notionDataSourceCache.set(cacheKey, resolved);
    setCache(cacheKey, resolved, 10 * 60 * 1000);
    return resolved;
  } catch (error) {
    // Si el ID ya era un data_source_id, /databases/{id} puede fallar.
    // En ese caso lo usamos directamente.
    console.log("⚠️ No pude resolver database->data_source, usando ID directo:", rawId, error.message);
    notionDataSourceCache.set(cacheKey, rawId);
    setCache(cacheKey, rawId, 10 * 60 * 1000);
    return rawId;
  }
}

async function queryNotionDatabaseCompat(args) {
  const dataSourceId = await resolveDataSourceId(args.database_id || args.data_source_id);
  const { database_id, data_source_id, ...body } = args;

  return notionRest(
    `/data_sources/${dataSourceId}/query`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    "data_sources.query"
  );
}

async function retrieveNotionDatabaseSchemaCompat(args) {
  const dataSourceId = await resolveDataSourceId(args.database_id || args.data_source_id);

  return notionRest(
    `/data_sources/${dataSourceId}`,
    { method: "GET" },
    "data_sources.retrieve"
  );
}

async function createNotionPageCompat(args) {
  const payload = { ...args };

  if (payload.parent?.database_id) {
    const dataSourceId = await resolveDataSourceId(payload.parent.database_id);
    payload.parent = {
      type: "data_source_id",
      data_source_id: dataSourceId,
    };
  }

  return notionRest(
    "/pages",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    "pages.create.2025"
  );
}

// Sobrescribir sólo estas llamadas para que el resto de tu código no cambie.
// Mantiene el mismo formato viejo: notion.databases.query({ database_id, ... })
notion.databases.query = queryNotionDatabaseCompat;
notion.databases.retrieve = retrieveNotionDatabaseSchemaCompat;
notion.pages.create = createNotionPageCompat;

const openai = new OpenAI({
apiKey: OPENAI_API_KEY || "no-key",
});
// ■ Página principal limpiadores
app.get("/notifications", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "notifications.html"));
});
const loginAttempts = new Map();
function loginAttemptKey(req, login) {
  return `${String(req.ip || "unknown")}:${String(login || "").toLowerCase()}`;
}
function loginLocked(req, login) {
  const key = loginAttemptKey(req, login);
  const item = loginAttempts.get(key);
  if (!item) return false;
  if (item.lockedUntil > Date.now()) return true;
  if (item.lockedUntil) loginAttempts.delete(key);
  return false;
}
function recordLoginFailure(req, login) {
  const key = loginAttemptKey(req, login);
  const maxAttempts = Math.max(3, Number(process.env.LOGIN_MAX_ATTEMPTS || 5));
  const lockMs = Math.max(1, Number(process.env.LOGIN_LOCK_MINUTES || 15)) * 60000;
  const item = loginAttempts.get(key) || { attempts: 0, lockedUntil: 0 };
  item.attempts += 1;
  if (item.attempts >= maxAttempts) item.lockedUntil = Date.now() + lockMs;
  loginAttempts.set(key, item);
}
function clearLoginFailures(req, login) {
  loginAttempts.delete(loginAttemptKey(req, login));
}
async function completeSecureLogin(req, res, user) {
  const created = await SessionService.createSession(user, {
    ip: req.ip,
    userAgent: req.get("user-agent") || "",
  });
  const maxAge = Math.max(1, Math.floor((new Date(created.expiresAt).getTime() - Date.now()) / 1000));
  setSessionCookie(res, created.token, maxAge);
  await SessionService.audit({
    session: created.session,
    action: "LOGIN_SUCCESS",
    targetType: "employee",
    targetId: user.id || user.name,
    request: { ip: req.ip, requestId: req.requestId },
  });
}

app.post("/login-role", async (req, res) => {
  try {
    const login = String(req.body?.code || "").trim();

    if (!login) {
      return res.json({
        ok: false,
        message: "Nombre o código requerido",
      });
    }

    if (loginLocked(req, login)) {
      return res.status(429).json({ ok: false, message: "Demasiados intentos. Espera antes de volver a intentar." });
    }

    if (!NOTION_EMPLOYEES_DATABASE_ID) {
      return res.json({
        ok: false,
        message: "Falta NOTION_EMPLOYEES_DATABASE_ID en Render",
      });
    }

    const employee = await findEmployeeByLogin(login);

    if (employee) {
      const user = pageToUser(employee);

      if (!user.active) {
        recordLoginFailure(req, login);
        return res.json({
          ok: false,
          message: "Empleado inactivo",
        });
      }

      await completeSecureLogin(req, res, user);
      clearLoginFailures(req, login);

      return res.json({
        ok: true,
        id: user.id,
        name: user.name,
        role: user.role,
        active: user.active,
        permissions: user.permissions,
        home: user.home,
      });
    }

    // Fallback temporal: permite que un cleaner que todavía no esté en Employees
    // entre por nombre si aparece asignado en la página principal del día.
    // Recomendación: mover todos los cleaners a Employees con código.
    if (String(process.env.ALLOW_LEGACY_NAME_LOGIN || "false").toLowerCase() !== "true") {
      recordLoginFailure(req, login);
      return res.status(401).json({ ok: false, message: "Código no encontrado o empleado inactivo" });
    }

    const normalizedLogin = cleanEmployeeText(login);
    const mainDbId = NOTION_DATABASE_ID;

    if (mainDbId) {
      const assignmentsResponse = await notion.databases.query({
        database_id: mainDbId,
        page_size: 100,
      });

      for (const page of assignmentsResponse.results || []) {
        const props = page.properties || {};

        const assignedCleaner =
          props["Assigned Cleaner"]?.rich_text?.map((t) => t.plain_text).join("").trim() ||
          props["Assigned Cleaner"]?.select?.name ||
          props["Assigned Cleaner"]?.multi_select?.map((s) => s.name).join(", ") ||
          props["Assigned Cleaner"]?.people?.map((p) => p.name).join(", ") ||
          props["assigned cleaner"]?.rich_text?.map((t) => t.plain_text).join("").trim() ||
          props["assigned cleaner"]?.select?.name ||
          props["assigned cleaner"]?.multi_select?.map((s) => s.name).join(", ") ||
          "";

        const cleaners = assignedCleaner
          .split(",")
          .map((name) => cleanEmployeeText(name))
          .filter(Boolean);

        if (cleaners.includes(normalizedLogin)) {
          const legacyUser = { id: "", name: login, role: "Cleaner", active: true, permissions: ["cleaning"], home: "cleaner" };
          await completeSecureLogin(req, res, legacyUser);
          clearLoginFailures(req, login);
          return res.json({
            ok: true,
            ...legacyUser,
          });
        }
      }
    }

    recordLoginFailure(req, login);
    return res.status(401).json({
      ok: false,
      message: "Nombre o código no encontrado o empleado inactivo",
    });
  } catch (error) {
    console.error("LOGIN ROLE ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.post("/refresh-employees", async (req, res) => {
  try {
    clearEmployeesCache();
    const employees = await getEmployeesCached(true);

    const payload = {
      ok: true,
      count: employees.length,
      updatedAt: new Date().toISOString(),
      message: "Empleados actualizados",
    };

    io.emit("employees-updated", payload);
    return res.json(payload);
  } catch (error) {
    console.error("Error en /refresh-employees:", error.message);

    return res.status(500).json({
      ok: false,
      message: "No se pudieron actualizar los empleados",
      error: error.message,
    });
  }
});

app.get("/launch", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "launch.html"));
});
app.post("/api/auth/logout", async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    await SessionService.revokeSession(cookies[COOKIE_NAME] || "");
  } catch (error) {
    console.error("LOGOUT ERROR:", error.message);
  } finally {
    clearSessionCookie(res);
    res.json({ ok: true });
  }
});
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
 }); 
app.get("/employee-center", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "employee-center.html"));
});
app.get("/employee-profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "employee-profile.html"));
});
app.get("/payroll", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "payroll.html"));
});
app.get("/", (req, res) => {
res.sendFile(__dirname + "/public/index.html");
});
// ■ Página inspectores
app.get("/inspector", (req, res) => {
res.sendFile(__dirname + "/public/inspector.html");
});
app.get("/still-waters-quality", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "still-waters-quality.html"));
});

app.get("/operations-intelligence", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "operations-intelligence.html"));
});

app.get("/quality-performance", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "quality-performance.html"));
});

app.get("/master", (req, res) => {
  res.redirect(302, "/operations-center.html");
});
// ■ Diagnóstico seguro
app.get("/debug-env", (req, res) => {
res.json({
notionApiKeyExists: !!NOTION_API_KEY,
notionDatabaseIdExists: !!NOTION_DATABASE_ID,
notionLogDatabaseIdExists: !!NOTION_LOG_DATABASE_ID,
notionPayrollDatabaseIdExists: !!NOTION_PAYROLL_DATABASE_ID,
notionReportsDatabaseIdExists: !!NOTION_REPORTS_DATABASE_ID,
notionReportPhotosDatabaseIdExists: !!NOTION_REPORT_PHOTOS_DATABASE_ID,
openAiKeyExists: !!OPENAI_API_KEY,
notionDatabaseIdPreview: NOTION_DATABASE_ID
? NOTION_DATABASE_ID.slice(0, 6) + "..." + NOTION_DATABASE_ID.slice(-6)
: null,
notionLogDatabaseIdPreview: NOTION_LOG_DATABASE_ID
? NOTION_LOG_DATABASE_ID.slice(0, 6) + "..." + NOTION_LOG_DATABASE_ID.slice(-6)
: null,
notionPayrollDatabaseIdPreview: NOTION_PAYROLL_DATABASE_ID
? NOTION_PAYROLL_DATABASE_ID.slice(0, 6) + "..." + NOTION_PAYROLL_DATABASE_ID.slice(-6)
: null,
notionReportsDatabaseIdPreview: NOTION_REPORTS_DATABASE_ID
? NOTION_REPORTS_DATABASE_ID.slice(0, 6) + "..." + NOTION_REPORTS_DATABASE_ID.slice(-6)
: null,
notionReportPhotosDatabaseIdPreview: NOTION_REPORT_PHOTOS_DATABASE_ID
? NOTION_REPORT_PHOTOS_DATABASE_ID.slice(0, 6) + "..." + NOTION_REPORT_PHOTOS_DATABASE_ID.slice(-6)
: null,
});
});
app.get("/api/me", async (req, res) => {
  try {
    if (!req.auth) return res.status(401).json({ ok: false, message: "Sesión requerida" });
    const user = {
      id: req.auth.employee_id,
      name: req.auth.employee_name,
      role: req.auth.role,
      permissions: req.auth.permissions || [],
      active: true,
    };

    res.json({
      ok: true,
      user,
    });
  } catch (error) {
    console.error("Error en /api/me:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.get("/api/bootstrap", async (req, res) => {
  try {
    if (req.auth) {
      const user = {
        id: req.auth.employee_id,
        name: req.auth.employee_name,
        role: req.auth.role,
        permissions: req.auth.permissions || [],
        active: true,
      };
      return res.json({
        ok: true,
        session: { user, permissions: user.permissions, startedAt: req.auth.created_at },
        assignments: [],
        stats: {},
        notifications: systemNotifications.slice(0, 50),
        timeline: systemTimeline.slice(0, 100),
        hotel: { name: "Still Waters Resort" },
        settings: {},
      });
    }
    const code = String(req.query.code || "").trim();

    if (!code) {
      return res.status(401).json({
        ok: false,
        message: "Código requerido",
      });
    }

    const meResponse = await EmployeeService.findEmployeeByCode(
      notion,
      NOTION_EMPLOYEES_DATABASE_ID,
      code
    );

    if (!meResponse) {
      return res.status(404).json({
        ok: false,
        message: "Empleado no encontrado",
      });
    }

    const user = EmployeeService.pageToEmployee(meResponse);

    if (!user.active) {
      return res.status(403).json({
        ok: false,
        message: "Empleado inactivo",
      });
    }

    const stats = {};
    const assignments = [];
    const notifications = systemNotifications.slice(0, 50);

    res.json({
      ok: true,
      session: {
        user,
        permissions: user.permissions || [],
        startedAt: new Date().toISOString(),
      },
      assignments,
      stats,
      notifications,
timeline: systemTimeline.slice(0, 100),
      hotel: {
        name: "Default Hotel",
      },
      settings: {},
    });

  } catch (error) {
    console.error("Error en /api/bootstrap:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
// ■ Fecha de hoy
function todayISO() {
return new Intl.DateTimeFormat("en-CA", {
timeZone: "America/Chicago",
year: "numeric",
month: "2-digit",
day: "2-digit",
}).format(new Date());
}
// ■ Hora local
function localTime() {
return new Date().toLocaleString("en-US", {
timeZone: "America/Chicago",
hour: "2-digit",
minute: "2-digit",
hour12: true,
});
}
// ■ Normalizar unidad
function normalizeRoom(value) {
const text = String(value || "").toUpperCase();
const match = text.match(/(\d{2,4})\s*([A-Z])?/);
if (!match) return "";
let room = match[1];
if (match[2]) room += match[2];
return room;
}
// ■ Solo números
function roomDigits(value) {
const match = String(value || "").match(/(\d{2,4})/);
return match ? match[1] : "";
}
// ■ Tarifas por tipo de unidad
// Cambia estos números por tus tarifas reales.
// También puedes controlarlos desde Render con PAYROLL_RATE_1, PAYROLL_RATE_2, etc.
const ROOM_RATES = {
S: Number(process.env.PAYROLL_RATE_S || 22), // Studio
M: Number(process.env.PAYROLL_RATE_M || 20), // Motel
"1": Number(process.env.PAYROLL_RATE_1 || 35),
"2": Number(process.env.PAYROLL_RATE_2 || 45),
"3": Number(process.env.PAYROLL_RATE_3 || 55),
"SUNRISE": Number(process.env.PAYROLL_RATE_4 || 41),
"30 ELM": Number(process.env.PAYROLL_RATE_5 || 33),
"SERENITY": Number(process.env.PAYROLL_RATE_5 || 51),
"MAIA": Number(process.env.PAYROLL_RATE_5 || 125),
"WILLOW": Number(process.env.PAYROLL_RATE_5 || 125),
"MENA": Number(process.env.PAYROLL_RATE_5 || 88),
"SUNDOWNER": Number(process.env.PAYROLL_RATE_5 || 70),
"LANDS END": Number(process.env.PAYROLL_RATE_5 || 90),
"38 LAKEHOUSE": Number(process.env.PAYROLL_RATE_5 || 55),
"37": Number(process.env.PAYROLL_RATE_5 || 55),
"TOUCH UP": Number(process.env.PAYROLL_RATE_5 || 0),
"SUITES": Number(process.env.PAYROLL_RATE_5 || 0),
};
// ■ Leer tipo de habitación desde lo que está entre paréntesis: 331A (2), 405 (S), 210 (M)
function getRoomType(unitName) {
const match = String(unitName || "").match(/\(([^)]+)\)/);
if (!match) return "";
return match[1].trim().toUpperCase();
}
// ■ Calcular pago por unidad
function getUnitPay(unitName) {
const roomType = getRoomType(unitName);
if (!roomType) {
return {
roomType: "",
amount: 0,
error: "No se encontró tipo de unidad entre paréntesis",
};
}
const amount = ROOM_RATES[roomType];
if (amount === undefined || Number.isNaN(amount)) {
return {
roomType,
amount: 0,
error: `No hay tarifa configurada para tipo ${roomType}`,
};
}
return {
roomType,
amount,
error: null,
};
}
// ■ Semana de nómina: lunes a domingo
function getPayrollWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();

  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: sunday.toISOString().slice(0, 10),
  };
}

// Nombre seguro para hojas de Excel
function cleanSheetName(name) {
  return String(name || "Unknown")
    .replace(/[\\/*?:[\]]/g, "")
    .trim()
    .substring(0, 31) || "Unknown";
}

function uniqueSheetName(workbook, baseName) {
  const cleanBase = cleanSheetName(baseName);
  const existingNames = new Set(
    workbook.worksheets.map((sheet) => String(sheet.name || "").toLowerCase())
  );

  let sheetName = cleanBase;
  let counter = 1;

  while (existingNames.has(sheetName.toLowerCase())) {
    const suffix = ` ${counter}`;
    const maxBaseLength = 31 - suffix.length;
    sheetName = `${cleanBase.substring(0, maxBaseLength)}${suffix}`;
    counter++;
  }

  return sheetName;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Nombre del archivo Excel semanal
function payrollFileName(weekStart, weekEnd) {
  return `Payroll_${weekStart}_to_${weekEnd}.xlsx`;
}

function isISODate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function validatePayrollRange(weekStart, weekEnd) {
  if (!isISODate(weekStart) || !isISODate(weekEnd)) {
    throw new Error("Las fechas de nómina deben usar el formato YYYY-MM-DD");
  }

  const start = new Date(`${weekStart}T12:00:00`);
  const end = new Date(`${weekEnd}T12:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("El periodo de nómina contiene fechas inválidas");
  }

  if (end < start) {
    throw new Error("La fecha final no puede ser anterior a la fecha inicial");
  }

  const days = Math.round((end - start) / 86400000) + 1;
  if (days !== 7) {
    throw new Error("La nómina debe contener exactamente 7 días");
  }

  if (start.getDay() !== 1 || end.getDay() !== 0) {
    throw new Error("La nómina debe comenzar en lunes y terminar en domingo");
  }

  return { weekStart, weekEnd };
}

// Leer título real de la unidad desde Notion, incluyendo paréntesis
function getRoomTitleFromPage(page) {
  return page.properties?.["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";
}
// ■ Evitar acciones duplicadas
function isDuplicateAction(action, unit, employee) {
const key = `${action}-${unit}-${employee}`.toUpperCase();
const now = Date.now();
const lastTime = recentActions.get(key);
if (lastTime && now - lastTime < 30000) {
return true;
}
recentActions.set(key, now);
setTimeout(() => {
recentActions.delete(key);
}, 30000);
return false;
}
// ■ Lectura directa para sincronización externa.
// Consulta Notion sin borrar el caché que están usando los paneles.
async function fetchRoomsFreshFromNotion(date) {
  let pages = [];
  let cursor;

  do {
    const body = {
      database_id: NOTION_DATABASE_ID,
      page_size: 100,
      filter: {
        property: "Date",
        date: { equals: date },
      },
    };

    if (cursor) body.start_cursor = cursor;

    const response = await notion.databases.query(body);
    pages = pages.concat(response.results || []);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  OSCore.metrics.increment("watcher.rooms.notion");
  return pages;
}

// ■ Buscar unidades de hoy en Notion usando search
async function queryTodayRooms(forceRefresh = false) {
  return queryRoomsByDate(todayISO(), forceRefresh);
}
// ■ Buscar unidades de cualquier fecha en la página central de Notion
async function queryRoomsByDate(date, forceRefresh = false) {
  const isToday = date === todayISO();
  const legacyCacheKey = isToday ? `todayRooms:${date}` : `roomsByDate:${date}`;
  const coreCacheKey = `core:rooms:${date}`;
  const ttlMs = isToday
    ? Number(process.env.ROOMS_CACHE_MS || 30000)
    : 120000;

  if (forceRefresh) {
    coreDeleteKeys(coreCacheKey);
    cacheStore.delete(legacyCacheKey);
    ServerCache.clear("rooms", date);
  }

  return OSCore.cache.remember(
    coreCacheKey,
    ttlMs,
    async () => {
      const legacyRoomCache = !forceRefresh
        ? ServerCache.get("rooms", date)
        : null;

      if (legacyRoomCache) {
        const age = Date.now() - new Date(legacyRoomCache.updatedAt).getTime();
        if (Number.isFinite(age) && age < ttlMs) {
          return legacyRoomCache.value;
        }
        ServerCache.clear("rooms", date);
      }

      const legacyCached = !forceRefresh ? getCache(legacyCacheKey) : null;
      if (legacyCached) {
        ServerCache.set("rooms", date, legacyCached);
        return legacyCached;
      }

      const pages = await fetchRoomsFreshFromNotion(date);

      setCache(legacyCacheKey, pages, ttlMs);
      ServerCache.set("rooms", date, pages);
      OSCore.metrics.increment("reads.rooms.notion");
      return pages;
    },
    [`rooms:${date}`, "rooms"]
  );
}
// ■ Status de Notion
function notionStatusFromAction(action) {
if (action === "START") return "In Progress";
if (action === "DONE") return "Cleaned - Awaiting Inspection";
if (action === "INSPECTION_START") return "Inspection Started";
if (action === "READY_GUEST") return "Ready for Guest";
return null;
}
async function notifyInspectors(unit) {
if (!process.env.WHAPI_TOKEN || !process.env.INSPECTORS_GROUP_ID) {
console.log("■■ WHAPI_TOKEN o INSPECTORS_GROUP_ID faltante");
return;
}
try {
const response = await fetch("https://gate.whapi.cloud/messages/text", {
method: "POST",
headers: {
Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
"Content-Type": "application/json",
},
body: JSON.stringify({
to: process.env.INSPECTORS_GROUP_ID,
body: `■ ${unit} lista para inspeccionar`,
}),
});
const data = await response.json();
console.log("■ Aviso enviado a inspectores:", data);
} catch (error) {
console.log("■ Error enviando a inspectores:", error.message);
}
}
// ■ Labels
function actionLabel(action) {
if (action === "START") return "■ Limpieza iniciada";
if (action === "DONE") return "■ Limpieza terminada";
if (action === "ISSUE") return "■■ Problema reportado";
if (action === "SUPPLIES") return "■ Supplies solicitados";
if (action === "INSPECTION_START") return "■ Inspección iniciada";
if (action === "READY_GUEST") return "■ Ready for Guest";
if (action === "INSPECTION_REPORT") return "■ Error de limpieza reportado";
if (action === "INSPECTION_SUPPLIES") return "■ Solicitud de inspector";
if (action === "GUEST_OUT") return "Guest Out";
if (action === "PRE_INSPECTION_START") return "Pre Inspection Started";
if (action === "PRE_INSPECTION_COMPLETE") return "Pre Inspection Complete";
if (action === "LOST_FOUND") return "■ Lost & Found";
if (action === "PHOTO") return "■ Foto adjunta";
return "Actualización";
}
// ■ Analizar nota con OpenAI
async function analyzeNoteWithAI(action, note) {
const safeNote = String(note || "").trim();
if (!OPENAI_API_KEY || !safeNote) {
return {
category: "Other",
priority: "Normal",
summary: safeNote || "Sin nota",
};
}
try {
const response = await openai.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.2,
messages: [
{
role: "system",
content: "Clasifica reportes de housekeeping de hotel. Responde solo JSON válido.",
},
{
role: "user",
content: `
Acción: ${action}
Nota: ${safeNote}
Devuelve exactamente:
{
"category": "Cleaning | Maintenance | Supplies | Damage | Guest Item | Other",
"priority": "Low | Normal | High | Urgent",
"summary": "resumen corto en español"
}
`,
},
],
});
const text = response.choices[0].message.content;
const cleanText = text.replace(/```json|```/g, "").trim();
return JSON.parse(cleanText);
} catch (error) {
console.log("■■ OpenAI error:", error.message);
return {
category: "Other",
priority: "Normal",
summary: safeNote || "Sin nota",
};
}
}
// ■ Sacar limpiador asignado desde Notion
function getAssignedCleaner(page) {
  return (
    page.properties?.["Assigned Cleaner"]?.select?.name ||
    page.properties?.["Assigned Cleaner"]?.rich_text?.map((t) => t.plain_text).join("") ||
    ""
  );
}

function readCheckboxProp(page, names) {
  const props = page?.properties || {};

  for (const name of names) {
    if (props[name]?.checkbox !== undefined) {
      return props[name].checkbox === true;
    }
  }

  return false;
}

function readDateProp(page, names) {
  const props = page?.properties || {};

  for (const name of names) {
    if (props[name]?.date?.start) {
      return props[name].date.start;
    }
  }

  return "";
}

function hasProp(page, name) {
  return !!page?.properties?.[name];
}

function getRoomOpsFlags(page) {
  const preInspection = readCheckboxProp(page, [
    "Pre Inspection",
    "Pre-Inspection",
    "Pre Inspected",
    "pre inspection",
    "Pre inspection",
  ]);

  const preInspectionStartedAt = readDateProp(page, [
    "Pre Inspection Started At",
    "Pre-Inspection Started At",
    "Pre Inspection Start At",
    "pre inspection started at",
  ]);

  const preInspectionStartedCheckbox = readCheckboxProp(page, [
    "Pre Inspection Started",
    "Pre-Inspection Started",
    "pre inspection started",
    "Pre inspection started",
  ]);

  return {
    guestOut: readCheckboxProp(page, [
      "Guest Out",
      "guest out",
      "GuestOut",
      "Guest out",
      "Guests Out",
    ]),

    guestOutAt: readDateProp(page, [
      "Guest Out At",
      "guest out at",
      "Guest Out Time",
    ]),

    preInspection,

    // Si no existe el checkbox, la fecha de inicio funciona como respaldo.
    // Cuando la pre inspección ya está completada, deja de considerarse iniciada.
    preInspectionStarted:
      !preInspection &&
      (preInspectionStartedCheckbox || !!preInspectionStartedAt),

    preInspectionStartedAt,

    preInspectionCompletedAt: readDateProp(page, [
      "Pre Inspection Completed At",
      "Pre-Inspection Completed At",
      "Pre Inspection At",
      "pre inspection completed at",
    ]),
  };
}

function setCheckboxIfExists(page, props, name, value) {
  if (hasProp(page, name)) {
    props[name] = {
      checkbox: !!value,
    };

    return name;
  }

  return "";
}

function setDateIfExists(page, props, name, value) {
  if (hasProp(page, name)) {
    props[name] = {
      date: {
        start: value,
      },
    };

    return name;
  }

  return "";
}

function setFirstExistingCheckbox(page, props, possibleNames, value) {
  for (const name of possibleNames) {
    if (hasProp(page, name)) {
      props[name] = {
        checkbox: !!value,
      };

      return name;
    }
  }

  return "";
}

function setFirstExistingDate(page, props, possibleNames, value) {
  for (const name of possibleNames) {
    if (hasProp(page, name)) {
      props[name] = {
        date: {
          start: value,
        },
      };

      return name;
    }
  }

  return "";
}

async function getDatabaseSchema(databaseId) {
const cacheKey = `schema:${databaseId}`;
const cached = getCache(cacheKey);
if (cached) return cached;
const db = await notion.databases.retrieve({
database_id: databaseId,
});
setCache(cacheKey, db.properties, 10 * 60 * 1000);
return db.properties;
}
function findPropName(schema, possibleNames) {
return possibleNames.find((name) => schema[name]);
}
function buildTextProperty(schema, possibleNames, value) {
const name = findPropName(schema, possibleNames);
if (!name) return null;
const type = schema[name].type;
if (type === "title") {
return {
name,
value: {
title: [
{
text: {
content: String(value || ""),
},
},
],
},
};
}
if (type === "rich_text") {
return {
name,
value: {
rich_text: [
{
text: {
content: String(value || ""),
},
},
],
},
};
}
return null;
}
function buildDateProperty(schema, possibleNames, value) {
const name = findPropName(schema, possibleNames);
if (!name) return null;
return {
name,
value: {
date: {
start: value,
},
},
};
}
function buildSelectProperty(schema, possibleNames, value) {
const name = findPropName(schema, possibleNames);
if (!name) return null;
return {
name,
value: {
select: {
name: String(value || "Other"),
},
},
};
}
async function dailyLogAlreadyExists(action, unit, employee, inspector) {
  const today = todayISO();
  const person = employee || inspector || "";

  const response = await notion.databases.query({
    database_id: NOTION_LOG_DATABASE_ID,
    filter: {
      and: [
        {
          property: "Date",
          date: {
            equals: today,
          },
        },
        {
          property: "Unit",
          rich_text: {
            equals: unit,
          },
        },
        {
          property: "Action",
          select: {
            equals: action,
          },
        },
      ],
    },
    page_size: 10,
  });

  return response.results.some((page) => {
    const cleaner =
      page.properties.Cleaner?.rich_text?.map((t) => t.plain_text).join("") || "";

    const inspectorName =
      page.properties.Inspector?.rich_text?.map((t) => t.plain_text).join("") || "";

    return cleaner === person || inspectorName === person;
  });
}
async function saveDailyLog({
action,
unit,
employee,
inspector,
assignedCleaner,
note,
ai = null,
photoUrl = "",
lostAndFound = false,
}) {
if (!NOTION_LOG_DATABASE_ID) {
console.log("■■ NOTION_LOG_DATABASE_ID faltante, no se guardó historial");
return;
}
const now = new Date().toISOString();
try {
const schema = await getDatabaseSchema(NOTION_LOG_DATABASE_ID);
const alreadyExists = await dailyLogAlreadyExists(
action,
unit,
employee,
inspector
);
if (alreadyExists) {
console.log("■■ Registro duplicado, no se guardó en Daily Cleaning Logs");
return;
}
const props = {};
const fields = [
buildTextProperty(schema, ["log", "Log"], `${unit} - ${action} - ${employee || inspector || ""}`),
buildDateProperty(schema, ["date", "Date"], todayISO()),
buildDateProperty(schema, ["time", "Time"], now),
buildTextProperty(schema, ["unit", "Unit"], unit),
buildTextProperty(schema, ["cleaner", "Cleaner"], employee || ""),
buildTextProperty(schema, ["inspector", "Inspector"], inspector || ""),
buildSelectProperty(schema, ["action", "Action"], action),
buildTextProperty(schema, ["note", "Note"], note || ""),
buildSelectProperty(schema, ["category", "Category"], ai?.category || "Other"),
buildSelectProperty(schema, ["priority", "Priority"], ai?.priority || "Normal"),
buildSelectProperty(schema, ["status", "Status"], notionStatusFromAction(action) || action),
buildTextProperty(schema, ["cleaner error", "Cleaner Error"], assignedCleaner || ""),
];
fields.forEach((field) => {
if (field) {
props[field.name] = field.value;
}
});
if (schema["Photo URL"] && photoUrl) {
  props["Photo URL"] = {
    url: photoUrl,
  };
}

if (schema["Lost and Found"]) {
  props["Lost and Found"] = {
    checkbox: !!lostAndFound,
  };
}
const response = await notion.pages.create({
parent: {
  database_id: NOTION_LOG_DATABASE_ID,
},
  properties: props,
});
  
console.log("■ Daily Cleaning Log guardado");
} catch (error) {
console.log("■ ERROR guardando Daily Cleaning Log:", error.body || error.message);
}
}
// ■ Evitar duplicados en Payroll Records
async function payrollRecordExists({ cleaner, unit, date }) {
  if (!NOTION_PAYROLL_DATABASE_ID) return false;

  const response = await notion.databases.query({
    database_id: NOTION_PAYROLL_DATABASE_ID,
    page_size: 100,
  });

  return response.results.some((page) => {
    const props = page.properties;

    const existingDate = props.Date?.date?.start || "";

    const existingCleaner =
      props.Cleaner?.rich_text?.map((t) => t.plain_text).join("") || "";

    const existingUnit =
      props.Unit?.rich_text?.map((t) => t.plain_text).join("") || "";

    return (
      existingDate === date &&
      existingCleaner === cleaner &&
      existingUnit === unit
    );
  });
}
// Separar correctamente varios limpiadores escritos en un mismo campo.
// Acepta: "Daniela / Aide", "Daniela/Aide", "Daniela & Aide", comas y saltos de línea.
function splitCleanerNames(value) {
  const names = String(value || "")
    .replace(/\s+(?:and|y)\s+/gi, " / ")
    .replace(/[&|,;\n]+/g, " / ")
    .split(/\s*\/\s*/g)
    .map((name) => normalizeCleaner(name))
    .filter(Boolean);

  return [...new Map(names.map((name) => [cleanEmployeeText(name), name])).values()];
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// ■ Crear registro de nómina cuando se termina una unidad
async function payrollRecordAlreadyExists({ cleaner, unit, date }) {
  if (!NOTION_PAYROLL_DATABASE_ID) return false;

  const cleanCleaner = normalizeCleaner(cleaner);
  const cleanUnit = String(unit || "").trim();

  const response = await notion.databases.query({
    database_id: NOTION_PAYROLL_DATABASE_ID,
    page_size: 10,
    filter: {
      and: [
        {
          property: "Date",
          date: {
            equals: date,
          },
        },
        {
          property: "Cleaner",
          rich_text: {
            equals: cleanCleaner,
          },
        },
        {
          property: "Unit",
          rich_text: {
            equals: cleanUnit,
          },
        },
      ],
    },
  });

  return response.results.length > 0;
}

async function createPayrollRecord({ cleaner, unit, date }) {
  unit = String(unit || "").trim();
  const cleaners = splitCleanerNames(cleaner);

  if (!NOTION_PAYROLL_DATABASE_ID) {
    throw new Error("NOTION_PAYROLL_DATABASE_ID faltante");
  }

  if (!cleaners.length || !unit || !date) {
    throw new Error(`Payroll incompleto: cleaner=${cleaner || ""}, unit=${unit}, date=${date || ""}`);
  }

  const pay = getUnitPay(unit);
  if (pay.error) throw new Error(`${pay.error}: ${unit}`);

  // Por defecto el pago de la unidad se divide equitativamente.
  // PAYROLL_SPLIT_MODE=full_each pagaría el total completo a cada persona.
  const splitMode = String(process.env.PAYROLL_SPLIT_MODE || "equal").toLowerCase();
  const amountPerCleaner = splitMode === "full_each"
    ? roundMoney(pay.amount)
    : roundMoney(pay.amount / cleaners.length);

  const week = getPayrollWeek(new Date(`${date}T12:00:00`));
  const result = { created: 0, skipped: 0, cleaners, amountPerCleaner };

  for (const cleanerName of cleaners) {
    const exists = await payrollRecordAlreadyExists({
      cleaner: cleanerName,
      unit,
      date,
    });

    if (exists) {
      console.log("Payroll duplicado ignorado:", cleanerName, unit, date);
      result.skipped += 1;
      continue;
    }

    const payrollProperties = {
      Payroll: {
        title: [{ text: { content: `${cleanerName} - ${unit} - $${amountPerCleaner.toFixed(2)}` } }],
      },
      Date: { date: { start: date } },
      Cleaner: { rich_text: [{ text: { content: cleanerName } }] },
      Unit: { rich_text: [{ text: { content: unit } }] },
      "Room Type": { select: { name: pay.roomType } },
      Amount: { number: amountPerCleaner },
      "Week Start": { date: { start: week.weekStart } },
      "Week End": { date: { start: week.weekEnd } },
      Status: { select: { name: "Pending" } },
    };

    try {
      const payrollSchema = await getNotionDatabaseSchema(NOTION_PAYROLL_DATABASE_ID);
      const propertySchema = payrollSchema.Property || payrollSchema.Hotel || payrollSchema.Location;
      const propertyKey = payrollSchema.Property ? "Property" : payrollSchema.Hotel ? "Hotel" : payrollSchema.Location ? "Location" : "";
      const propertyValue = buildNotionTextValue(propertySchema, getPayrollPropertyFromUnit(unit));
      if (propertyKey && propertyValue) payrollProperties[propertyKey] = propertyValue;
    } catch (schemaError) {
      console.warn("No se pudo leer Property de Payroll; se guardará sin clasificación:", schemaError.message);
    }

    await notion.pages.create({
      parent: { database_id: NOTION_PAYROLL_DATABASE_ID },
      properties: payrollProperties,
    });

    result.created += 1;
    console.log("Payroll Record guardado:", cleanerName, unit, `$${amountPerCleaner.toFixed(2)}`);
  }

  return result;
}
// ■ Nómina directa desde la página central de Notion.
// NOTION_DATABASE_ID es la fuente oficial. Payroll Records y PostgreSQL no participan.
function readCentralPropertyText(property) {
  if (!property) return "";
  if (property.title) return property.title.map((item) => item.plain_text || item.text?.content || "").join("").trim();
  if (property.rich_text) return property.rich_text.map((item) => item.plain_text || item.text?.content || "").join("").trim();
  if (property.select?.name) return String(property.select.name).trim();
  if (property.status?.name) return String(property.status.name).trim();
  if (property.multi_select) return property.multi_select.map((item) => item.name).filter(Boolean).join(", ").trim();
  if (property.people) return property.people.map((item) => item.name || item.person?.email || "").filter(Boolean).join(", ").trim();
  if (property.formula?.string != null) return String(property.formula.string).trim();
  if (property.formula?.number != null) return String(property.formula.number);
  if (property.rollup?.number != null) return String(property.rollup.number);
  if (property.number != null) return String(property.number);
  return "";
}

function readCentralNumber(properties, names) {
  for (const name of names) {
    const prop = properties?.[name];
    if (!prop) continue;
    if (prop.number != null && Number.isFinite(Number(prop.number))) return Number(prop.number);
    if (prop.formula?.number != null && Number.isFinite(Number(prop.formula.number))) return Number(prop.formula.number);
    if (prop.rollup?.number != null && Number.isFinite(Number(prop.rollup.number))) return Number(prop.rollup.number);
    const text = readCentralPropertyText(prop).replace(/[$,]/g, "").trim();
    if (text && Number.isFinite(Number(text))) return Number(text);
  }
  return null;
}

function centralCleanerText(properties) {
  const names = ["Assigned Cleaner", "Cleaner", "Assigned Cleaners", "Housekeeper"];
  for (const name of names) {
    const value = readCentralPropertyText(properties?.[name]);
    if (value) return value;
  }
  return "";
}

function centralUnitText(properties) {
  const names = ["Room Number", "Unit", "Room", "Unit Number", "Property Unit"];
  for (const name of names) {
    const value = readCentralPropertyText(properties?.[name]);
    if (value) return value;
  }
  return "";
}

function centralRoomType(properties, unit) {
  const names = ["Room Type", "Type", "Unit Type"];
  for (const name of names) {
    const value = readCentralPropertyText(properties?.[name]);
    if (value) return value.toUpperCase();
  }
  return getRoomType(unit);
}

async function getPayrollRecordsFromNotion(weekStart, weekEnd) {
  if (!NOTION_DATABASE_ID) throw new Error("Falta NOTION_DATABASE_ID de la página central");

  const records = [];
  const audit = { days: 0, pages: 0, included: 0, missingCleaner: 0, missingUnit: 0, zeroRate: 0 };
  const startDate = new Date(`${weekStart}T12:00:00`);
  const endDate = new Date(`${weekEnd}T12:00:00`);

  for (let cursorDate = new Date(startDate); cursorDate <= endDate; cursorDate.setDate(cursorDate.getDate() + 1)) {
    const date = cursorDate.toISOString().slice(0, 10);
    const pages = await fetchRoomsFreshFromNotion(date);
    audit.days += 1;
    audit.pages += pages.length;

    for (const page of pages) {
      const properties = page?.properties || {};
      const workDate = properties.Date?.date?.start?.slice(0, 10) || date;
      const unit = centralUnitText(properties);
      const cleanerText = centralCleanerText(properties);
      const cleaners = splitCleanerNames(cleanerText);
      const roomType = centralRoomType(properties, unit);
      const explicitRate = readCentralNumber(properties, ["Rate", "Amount", "Payroll Rate", "Cleaning Rate"]);
      const calculatedPay = getUnitPay(unit);
      const grossAmount = roundMoney(explicitRate != null ? explicitRate : calculatedPay.amount || 0);
      const propertyName = readCentralPropertyText(properties.Property)
        || readCentralPropertyText(properties.Hotel)
        || readCentralPropertyText(properties.Location)
        || getPayrollPropertyFromUnit(unit)
        || "ALL";

      if (!unit) { audit.missingUnit += 1; continue; }
      if (!cleaners.length) { audit.missingCleaner += 1; continue; }
      if (grossAmount <= 0) audit.zeroRate += 1;

      const splitCount = cleaners.length;
      cleaners.forEach((cleaner, index) => {
        records.push({
          id: null,
          date: workDate,
          cleaner: normalizeCleaner(cleaner),
          unit,
          roomType,
          propertyName,
          grossUnitAmount: grossAmount,
          splitCount,
          splitPercent: Number((1 / splitCount).toFixed(4)),
          amount: roundMoney(grossAmount / splitCount),
          notionId: `${page.id}:${index + 1}:${cleanEmployeeText(cleaner)}`,
          sourcePageId: page.id,
          payType: "unit",
          roleWorked: "Cleaner",
          manualOverride: false,
          adjustmentReason: "",
          status: readCentralPropertyText(properties["Cleaning Status"]) || "Central",
          source: "central-notion",
        });
        audit.included += 1;
      });
    }
  }

  records.sort((a, b) => `${a.date}|${a.unit}|${a.cleaner}`.localeCompare(`${b.date}|${b.unit}|${b.cleaner}`));
  console.log("PAYROLL CENTRAL NOTION AUDIT:", { weekStart, weekEnd, ...audit });
  return records;
}

async function getPayrollRecordsWithSource(
  weekStart,
  weekEnd,
  { source = "central", allowFallback = false } = {}
) {
  validatePayrollRange(weekStart, weekEnd);
  const records = await getPayrollRecordsFromNotion(weekStart, weekEnd);
  if (postgresStatus.connected) {
    const manualRecords = await listManualPayrollEntries(weekStart, weekEnd);
    records.push(...manualRecords.map((record) => ({
      id: record.id,
      date: String(record.work_date).slice(0, 10),
      workDate: String(record.work_date).slice(0, 10),
      cleaner: record.employee,
      employee: record.employee,
      unit: record.unit,
      roomType: record.room_type,
      amount: Number(record.amount || 0),
      payType: record.pay_type,
      roleWorked: record.role_worked,
      manualOverride: true,
      adjustmentReason: record.adjustment_reason,
      source: 'manual',
    })));
  }
  return {
    records,
    source: "central-notion",
    requestedSource: String(source || "central"),
    fallback: false,
    fallbackReason: "",
  };
}

async function getPayrollRecords(weekStart, weekEnd, options = {}) {
  const result = await getPayrollRecordsWithSource(weekStart, weekEnd, options);
  return result.records;
}

// ■ Generar / actualizar Excel semanal con hoja por limpiador
async function getHourlyPayrollRecords(weekStart, weekEnd) {
  if (!NOTION_TIME_CLOCK_DATABASE_ID) return [];

  const response = await notion.databases.query({
    database_id: NOTION_TIME_CLOCK_DATABASE_ID,
    page_size: 100,
  });

  return response.results
    .map((page) => {
      const p = page.properties;

      return {
        employee: p.Employee?.rich_text?.map((t) => t.plain_text).join("") || "",
        code: p.Code?.rich_text?.map((t) => t.plain_text).join("") || "",
        role: p.Role?.select?.name || "",
        clockIn: p["Clock In"]?.date?.start || "",
        clockOut: p["Clock Out"]?.date?.start || "",
        hours: p.Hours?.number || 0,
        hourlyRate: p["Hourly Rate"]?.number || 0,
        total: p.Total?.number || 0,
        workLocation: p["Location Status"]?.select?.name || "Unspecified",
        status: p.Status?.select?.name || "",
      };
    })
    .filter((r) => {
      if (!r.clockIn) return false;
      const day = r.clockIn.slice(0, 10);
      return day >= weekStart && day <= weekEnd && r.status === "Completed";
    });
}
async function getEmployeesCached(forceRefresh = false) {
  const legacyCacheKey = "employees:active";
  const coreCacheKey = "core:employees:active";
  const ttlMs = Number(process.env.EMPLOYEES_CACHE_MS || 300000);

  if (!NOTION_EMPLOYEES_DATABASE_ID) return [];

  if (forceRefresh) {
    coreDeleteKeys(coreCacheKey);
    cacheStore.delete(legacyCacheKey);
    ServerCache.clear("employees", "active");
  }

  return OSCore.cache.remember(
    coreCacheKey,
    ttlMs,
    async () => {
      const employeeCache = !forceRefresh
        ? ServerCache.get("employees", "active")
        : null;

      if (employeeCache) {
        const age = Date.now() - new Date(employeeCache.updatedAt).getTime();
        if (Number.isFinite(age) && age < ttlMs) {
          return employeeCache.value;
        }
        ServerCache.clear("employees", "active");
      }

      const legacyCached = !forceRefresh ? getCache(legacyCacheKey) : null;
      if (legacyCached) {
        ServerCache.set("employees", "active", legacyCached);
        return legacyCached;
      }

      let results = [];
      let cursor;

      do {
        const body = {
          database_id: NOTION_EMPLOYEES_DATABASE_ID,
          page_size: 100,
        };

        if (cursor) body.start_cursor = cursor;

        const response = await notion.databases.query(body);
        results = results.concat(response.results || []);
        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor);

      setCache(legacyCacheKey, results, ttlMs);
      ServerCache.set("employees", "active", results);
      OSCore.metrics.increment("reads.employees.notion");
      return results;
    },
    ["employees"]
  );
}

function clearEmployeesCache() {
  cacheStore.delete("employees:active");
  coreDeleteKeys("core:employees:active");
  coreInvalidateTags("employees");

  if (typeof ServerCache !== "undefined") {
    ServerCache.clear("employees", "active");
  }
}

// =========================================================
// EMPLOYEES · NOTION → POSTGRESQL
// =========================================================
// Notion sigue siendo la fuente administrativa durante esta etapa.
// PostgreSQL recibe una copia rápida de Employees para preparar login,
// permisos, nómina, notificaciones y la futura aplicación móvil.
let employeeSyncTimer = null;
let employeeSyncRunning = false;

async function runEmployeeSync(reason = "manual") {
  if (!postgresStatus.connected) {
    return {
      ok: false,
      skipped: true,
      reason,
      message: "PostgreSQL no está conectado; Employees continúa operando desde Notion.",
    };
  }

  if (employeeSyncRunning) {
    return {
      ok: true,
      skipped: true,
      reason,
      message: "La sincronización de Employees ya está en ejecución.",
    };
  }

  if (!NOTION_EMPLOYEES_DATABASE_ID) {
    throw new Error("Falta NOTION_EMPLOYEES_DATABASE_ID en Render.");
  }

  employeeSyncRunning = true;

  try {
    const result = await syncEmployeesFromNotion({
      notion,
      databaseId: NOTION_EMPLOYEES_DATABASE_ID,
      queryDatabase: (body) => notion.databases.query(body),
    });

    clearEmployeesCache();

    const payload = {
      ...result,
      reason,
      updatedAt: new Date().toISOString(),
    };

    io.emit("employees-updated", payload);

    console.log("✅ Employees sincronizados Notion → PostgreSQL:", {
      reason,
      totalFromNotion: result.totalFromNotion,
      saved: result.saved,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });

    return payload;
  } catch (error) {
    console.error("EMPLOYEE SYNC ERROR:", error.message);
    throw error;
  } finally {
    employeeSyncRunning = false;
  }
}

function startEmployeeSyncSchedule() {
  const intervalMs = Math.max(
    60000,
    Number(process.env.EMPLOYEE_SYNC_INTERVAL_MS || 300000)
  );

  if (employeeSyncTimer) {
    clearInterval(employeeSyncTimer);
  }

  employeeSyncTimer = setInterval(() => {
    runEmployeeSync("scheduled").catch((error) => {
      console.error("EMPLOYEE SCHEDULED SYNC ERROR:", error.message);
    });
  }, intervalMs);

  // Evita que este temporizador impida un apagado limpio del proceso.
  if (typeof employeeSyncTimer.unref === "function") {
    employeeSyncTimer.unref();
  }

  console.log(
    `🔄 Employee sync programado cada ${Math.round(intervalMs / 60000)} minuto(s).`
  );
}

app.post("/api/sync/employees", async (req, res) => {
  try {
    const result = await runEmployeeSync("manual");

    return res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/sync/employees/status", async (req, res) => {
  try {
    const status = postgresStatus.connected
      ? await getEmployeeSyncStatus()
      : null;

    return res.json({
      ok: true,
      postgresConnected: postgresStatus.connected,
      running: employeeSyncRunning,
      scheduled: !!employeeSyncTimer,
      intervalMs: Math.max(
        60000,
        Number(process.env.EMPLOYEE_SYNC_INTERVAL_MS || 300000)
      ),
      status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/postgres/employees", async (req, res) => {
  try {
    if (!postgresStatus.connected) {
      return res.status(503).json({
        ok: false,
        message: "PostgreSQL no está conectado.",
      });
    }

    const employees = await listEmployeesPostgres({
      activeOnly: String(req.query.all || "").toLowerCase() !== "true",
    });

    return res.json({
      ok: true,
      count: employees.length,
      employees,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});


// =========================================================
// ROOMS · NOTION → POSTGRESQL
// =========================================================
// Modo seguro: Notion continúa siendo la fuente operativa.
// PostgreSQL recibe una copia de las habitaciones para validar datos
// antes de que los paneles comiencen a leer desde la nueva base.
let roomSyncTimer = null;
let roomSyncRunning = false;

async function runRoomSync(reason = "manual", date = todayISO()) {
  if (!postgresStatus.connected) {
    return {
      ok: false,
      skipped: true,
      reason,
      date,
      message: "PostgreSQL no está conectado; Rooms continúa operando desde Notion.",
    };
  }

  if (roomSyncRunning) {
    return {
      ok: true,
      skipped: true,
      reason,
      date,
      message: "La sincronización de Rooms ya está en ejecución.",
    };
  }

  roomSyncRunning = true;

  try {
    const result = await syncRoomsFromNotion({
      notion,
      databaseId: NOTION_DATABASE_ID,
      queryDatabase: (body) => notion.databases.query(body),
      date,
    });

    const payload = {
      ...result,
      reason,
      updatedAt: new Date().toISOString(),
    };

    io.emit("rooms-postgres-synced", payload);
    io.emit("data-api-updated", {
      module: "rooms",
      date,
      reason,
      updatedAt: payload.updatedAt,
    });

    console.log("✅ Rooms sincronizados Notion → PostgreSQL:", {
      reason,
      date,
      totalFromNotion: result.totalFromNotion,
      saved: result.saved,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });

    return payload;
  } catch (error) {
    console.error("ROOM SYNC ERROR:", error.message);
    throw error;
  } finally {
    roomSyncRunning = false;
  }
}

function startRoomSyncSchedule() {
  const intervalMs = Math.max(
    15000,
    Number(process.env.ROOM_SYNC_INTERVAL_MS || 30000)
  );

  if (roomSyncTimer) {
    clearInterval(roomSyncTimer);
  }

  roomSyncTimer = setInterval(() => {
    runRoomSync("scheduled", todayISO()).catch((error) => {
      console.error("ROOM SCHEDULED SYNC ERROR:", error.message);
    });
  }, intervalMs);

  if (typeof roomSyncTimer.unref === "function") {
    roomSyncTimer.unref();
  }

  console.log(
    `🏨 Rooms sync programado cada ${Math.round(intervalMs / 60000)} minuto(s).`
  );
}

app.post("/api/sync/rooms", async (req, res) => {
  try {
    const date = String(req.body?.date || req.query?.date || todayISO()).trim();
    const result = await runRoomSync("manual", date);
    return res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/sync/rooms/status", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const status = postgresStatus.connected
      ? await getRoomSyncStatus(date)
      : null;

    return res.json({
      ok: true,
      date,
      postgresConnected: postgresStatus.connected,
      running: roomSyncRunning,
      scheduled: !!roomSyncTimer,
      intervalMs: Math.max(
        60000,
        Number(process.env.ROOM_SYNC_INTERVAL_MS || 120000)
      ),
      status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/postgres/rooms", async (req, res) => {
  try {
    if (!postgresStatus.connected) {
      return res.status(503).json({
        ok: false,
        message: "PostgreSQL no está conectado.",
      });
    }

    const date = String(req.query.date || todayISO()).trim();
    const rooms = await listRoomsPostgres(date);

    return res.json({
      ok: true,
      date,
      count: rooms.length,
      rooms,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});


// =========================================================
// PAYROLL · NOTION → POSTGRESQL
// =========================================================
// PostgreSQL es la fuente principal de lectura para Preview y Excel.
// Notion permanece como fallback automático y fuente de comparación.
let payrollSyncTimer = null;
let payrollSyncRunning = false;

async function runPayrollSync(reason = "manual", weekStart = "", weekEnd = "") {
  const week = weekStart && weekEnd
    ? validatePayrollRange(weekStart, weekEnd)
    : getPayrollWeek(new Date());

  if (!postgresStatus.connected) {
    return {
      ok: false,
      skipped: true,
      reason,
      ...week,
      message: "PostgreSQL no está conectado; Payroll continúa operando desde Notion.",
    };
  }

  const weekState = await getPayrollWeekState(week.weekStart, week.weekEnd);
  if (weekState?.status === "closed") {
    return {
      ok: true,
      skipped: true,
      reason,
      ...week,
      weekState,
      message: "La semana está cerrada y no se volvió a sincronizar.",
    };
  }

  if (payrollSyncRunning) {
    return {
      ok: true,
      skipped: true,
      reason,
      ...week,
      message: "La sincronización de Payroll ya está en ejecución.",
    };
  }

  payrollSyncRunning = true;

  try {
    const result = await syncPayrollFromNotion({
      notion,
      databaseId: NOTION_PAYROLL_DATABASE_ID,
      queryDatabase: (body) => notion.databases.query(body),
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
    });

    clearOpsCache();

    const payload = {
      ...result,
      reason,
      updatedAt: new Date().toISOString(),
    };

    io.emit("payroll-postgres-synced", payload);

    console.log("✅ Payroll sincronizado Notion → PostgreSQL:", {
      reason,
      weekStart: result.weekStart,
      weekEnd: result.weekEnd,
      totalFromNotion: result.totalFromNotion,
      saved: result.saved,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });

    return payload;
  } catch (error) {
    console.error("PAYROLL SYNC ERROR:", error.message);
    throw error;
  } finally {
    payrollSyncRunning = false;
  }
}

function startPayrollSyncSchedule() {
  const intervalMs = Math.max(
    60000,
    Number(process.env.PAYROLL_SYNC_INTERVAL_MS || 300000)
  );

  if (payrollSyncTimer) clearInterval(payrollSyncTimer);

  payrollSyncTimer = setInterval(() => {
    const week = getPayrollWeek(new Date());
    runPayrollSync("scheduled", week.weekStart, week.weekEnd).catch((error) => {
      console.error("PAYROLL SCHEDULED SYNC ERROR:", error.message);
    });
  }, intervalMs);

  if (typeof payrollSyncTimer.unref === "function") payrollSyncTimer.unref();

  console.log(
    `💵 Payroll sync programado cada ${Math.round(intervalMs / 60000)} minuto(s).`
  );
}

app.post("/api/sync/payroll", async (req, res) => {
  try {
    const currentWeek = getPayrollWeek(new Date());
    const weekStart = String(req.body?.start || req.query?.start || currentWeek.weekStart).trim();
    const weekEnd = String(req.body?.end || req.query?.end || currentWeek.weekEnd).trim();
    const result = await runPayrollSync("manual", weekStart, weekEnd);
    return res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/sync/payroll/status", async (req, res) => {
  try {
    const currentWeek = getPayrollWeek(new Date());
    const weekStart = String(req.query.start || currentWeek.weekStart).trim();
    const weekEnd = String(req.query.end || currentWeek.weekEnd).trim();
    validatePayrollRange(weekStart, weekEnd);

    const status = postgresStatus.connected
      ? await getPayrollSyncStatus(weekStart, weekEnd)
      : null;

    return res.json({
      ok: true,
      weekStart,
      weekEnd,
      postgresConnected: postgresStatus.connected,
      running: payrollSyncRunning,
      scheduled: !!payrollSyncTimer,
      intervalMs: Math.max(60000, Number(process.env.PAYROLL_SYNC_INTERVAL_MS || 300000)),
      status,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/postgres/payroll", async (req, res) => {
  try {
    if (!postgresStatus.connected) {
      return res.status(503).json({ ok: false, message: "PostgreSQL no está conectado." });
    }

    const currentWeek = getPayrollWeek(new Date());
    const weekStart = String(req.query.start || currentWeek.weekStart).trim();
    const weekEnd = String(req.query.end || currentWeek.weekEnd).trim();
    const employee = String(req.query.employee || "").trim();
    validatePayrollRange(weekStart, weekEnd);

    const [records, summary] = await Promise.all([
      listPayrollPostgres({ weekStart, weekEnd, employee }),
      getPayrollSummaryPostgres(weekStart, weekEnd),
    ]);

    return res.json({
      ok: true,
      weekStart,
      weekEnd,
      count: records.length,
      total: Number(records.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2)),
      records,
      summary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/payroll/compare", async (req, res) => {
  try {
    const currentWeek = getPayrollWeek(new Date());
    const weekStart = String(req.query.start || currentWeek.weekStart).trim();
    const weekEnd = String(req.query.end || currentWeek.weekEnd).trim();
    validatePayrollRange(weekStart, weekEnd);
    const records = await getPayrollRecordsFromNotion(weekStart, weekEnd);
    return res.json({
      ok: true,
      matches: true,
      weekStart,
      weekEnd,
      source: "central-notion",
      notionCount: records.length,
      postgresCount: 0,
      missingInPostgres: [],
      extraInPostgres: [],
      amountMismatches: [],
      message: "Payroll se verificó directamente contra la página central de Notion.",
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/payroll/preview", async (req, res) => {
  try {
    const currentWeek = getPayrollWeek(new Date());
    const weekStart = String(req.query.start || currentWeek.weekStart).trim();
    const weekEnd = String(req.query.end || currentWeek.weekEnd).trim();
    const source = String(req.query.source || "auto").trim().toLowerCase();

    const payrollRead = await getPayrollRecordsWithSource(weekStart, weekEnd, {
      source,
      allowFallback: source === "auto",
    });

    const records = payrollRead.records;
    const summaryMap = new Map();

    for (const record of records) {
      const employee = normalizeCleaner(record.cleaner || "Unknown");
      const key = cleanEmployeeText(employee);
      const current = summaryMap.get(key) || {
        employee,
        records: 0,
        units: 0,
        total: 0,
      };

      current.records += 1;
      current.units += String(record.payType || "unit").toLowerCase() === "unit" ? 1 : 0;
      current.total = roundMoney(current.total + Number(record.amount || 0));
      summaryMap.set(key, current);
    }

    return res.json({
      ok: true,
      weekStart,
      weekEnd,
      requestedSource: payrollRead.requestedSource,
      source: payrollRead.source,
      fallback: payrollRead.fallback,
      fallbackReason: payrollRead.fallbackReason || "",
      count: records.length,
      total: roundMoney(records.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      summary: [...summaryMap.values()].sort((a, b) => a.employee.localeCompare(b.employee)),
      records,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});



function cleanEmployeeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[|,]+/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function getEmployeeNameFromPage(page) {
  const props = page?.properties || {};

  return (
    props.Employee?.title?.map((t) => t.plain_text).join("").trim() ||
    props.Employee?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    props.Nombre?.title?.map((t) => t.plain_text).join("").trim() ||
    props.Name?.title?.map((t) => t.plain_text).join("").trim() ||
    ""
  );
}

function getEmployeeCodeFromPage(page) {
  const props = page?.properties || {};
  const raw =
    props.Code?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    props.Code?.number?.toString() ||
    props.Codigo?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    props["Employee Code"]?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    "";

  return String(raw || "").trim();
}

function getEmployeeRoleFromPage(page) {
  const props = page?.properties || {};

  return (
    props.Role?.select?.name ||
    props.Role?.status?.name ||
    props.Role?.multi_select?.map((r) => r.name).join(" / ") ||
    props.Role?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    props.role?.select?.name ||
    props.role?.rich_text?.map((t) => t.plain_text).join("").trim() ||
    ""
  );
}

function isEmployeeActiveFromPage(page) {
  const props = page?.properties || {};

  if (props.Active?.checkbox !== undefined) return props.Active.checkbox === true;
  if (props.active?.checkbox !== undefined) return props.active.checkbox === true;

  // Si todavía no existe Active en algún registro, no lo bloqueamos por accidente.
  return true;
}

function roleIncludes(role, words) {
  const r = cleanEmployeeText(role);

  return words.some((word) => r.includes(cleanEmployeeText(word)));
}

function isAdminRole(role) {
  return roleIncludes(role, [
    "admin",
    "manager",
    "owner",
    "company owner",
    "general manager",
    "corporate",
  ]);
}

function canCleanRole(role) {
  return isAdminRole(role) || roleIncludes(role, ["cleaner", "cleaning", "housekeeper"]);
}

function canInspectRole(role) {
  return (
    isAdminRole(role) ||
    roleIncludes(role, ["inspector", "inspection", "dispatch", "operations", "supervisor"])
  );
}

function canOperationsRole(role) {
  return isAdminRole(role) || roleIncludes(role, ["dispatch", "operations", "supervisor"]);
}

function canReportsRole(role) {
  return isAdminRole(role) || roleIncludes(role, ["dispatch", "operations", "reports", "payroll"]);
}

function canClockRole(role) {
  return (
    isAdminRole(role) ||
    roleIncludes(role, [
      "clock",
      "laundry",
      "activities",
      "runner",
      "houseman",
      "support",
      "hourly",
      "dispatch",
      "operations",
      "inspector",
    ])
  );
}

function getPermissionsFromRole(role) {
  if (isAdminRole(role)) return ["all"];

  const permissions = [];

  if (canCleanRole(role)) permissions.push("cleaning");
  if (canInspectRole(role)) permissions.push("inspection");
  if (canOperationsRole(role)) permissions.push("operations", "rooms");
  if (canReportsRole(role)) permissions.push("reports");
  if (canClockRole(role)) permissions.push("clock");

  return [...new Set(permissions)];
}

function pageToUser(page) {
  const name = getEmployeeNameFromPage(page);
  const code = getEmployeeCodeFromPage(page);
  const role = getEmployeeRoleFromPage(page);
  const active = isEmployeeActiveFromPage(page);

  return {
    id: page?.id || "",
    name,
    code,
    role,
    active,
    hotel: "Default Hotel",
    permissions: getPermissionsFromRole(role),
    home: mobileHomeFromRole(role),
  };
}

function userCan(user, permission) {
  const permissions = user?.permissions || getPermissionsFromRole(user?.role || "");
  return permissions.includes("all") || permissions.includes(permission);
}

async function findEmployeeByCode(code) {
  const cleanCode = String(code || "").trim();

  const findMatch = (employees) =>
    employees.find((page) => {
      const employeeCode = getEmployeeCodeFromPage(page);
      return employeeCode === cleanCode;
    });

  const employees = await getEmployeesCached();
  return findMatch(employees);
}

async function findEmployeeByLogin(login) {
  const cleanLogin = String(login || "").trim();
  const cleanLoginText = cleanEmployeeText(cleanLogin);

  const findMatch = (employees) =>
    employees.find((page) => {
      const name = getEmployeeNameFromPage(page);
      const code = getEmployeeCodeFromPage(page);

      const nameMatch = cleanEmployeeText(name) === cleanLoginText;
      const codeMatch = code && code === cleanLogin;

      return nameMatch || codeMatch;
    });

  const employees = await getEmployeesCached();
  return findMatch(employees);
}

function mobileHomeFromRole(role) {
  if (isAdminRole(role) || canOperationsRole(role)) {
    return "admin";
  }

  if (canCleanRole(role) && canInspectRole(role)) {
    return "choose-role";
  }

  if (canInspectRole(role)) {
    return "inspector";
  }

  if (canCleanRole(role)) {
    return "cleaner";
  }

  if (canClockRole(role)) {
    return "clock";
  }

  return "staff";
}

app.post("/mobile-code-login", async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();

    if (!code) {
      return res.status(400).json({
        ok: false,
        message: "Código requerido",
      });
    }

    const employee = await findEmployeeByCode(code);

    if (!employee) {
      return res.status(404).json({
        ok: false,
        message: "Código no encontrado",
      });
    }

    const employeeName = getEmployeeNameFromPage(employee);
    const role = getEmployeeRoleFromPage(employee);
    const home = mobileHomeFromRole(role);

    res.json({
      ok: true,
      employee: employeeName,
      role,
      code,
      home,
      employeeId: employee.id,
    });

  } catch (error) {
    console.error("Error en /mobile-code-login:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/test-mobile-code-login", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();

    if (!code) {
      return res.status(400).json({
        ok: false,
        message: "Código requerido",
      });
    }

    const employee = await findEmployeeByCode(code);

    if (!employee) {
      return res.status(404).json({
        ok: false,
        message: "Código no encontrado",
      });
    }

    const employeeName = getEmployeeNameFromPage(employee);
    const role = getEmployeeRoleFromPage(employee);
    const home = mobileHomeFromRole(role);

    res.json({
      ok: true,
      employee: employeeName,
      role,
      code,
      home,
      employeeId: employee.id,
    });

  } catch (error) {
    console.error("Error en /test-mobile-code-login:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

async function generateWeeklyPayrollExcel(weekStart, weekEnd) {
  validatePayrollRange(weekStart, weekEnd);
  const payrollRead = await getPayrollRecordsWithSource(weekStart, weekEnd, {
    source: "central",
    allowFallback: false,
  });
  const records = payrollRead.records;
  const hourlyRecords = await getHourlyPayrollRecords(weekStart, weekEnd);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = process.env.COMPANY_NAME || "Care";
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet("Payroll Summary");
  const quickbooksSheet = workbook.addWorksheet("QuickBooks Upload");
  const dailySheet = workbook.addWorksheet("Daily Payroll");
  const hourlySheet = workbook.addWorksheet("Hourly Payroll");
  const warningsSheet = workbook.addWorksheet("Payroll Warnings");

  const people = new Map();
  const warnings = [];

  function getPerson(name) {
    const employee = normalizeCleaner(name || "Unknown");
    const key = cleanEmployeeText(employee);
    if (!people.has(key)) {
      people.set(key, {
        employee,
        unitRecords: [],
        hourlyRecords: [],
        roles: new Set(),
        unitTotal: 0,
        hourlyTotal: 0,
        hours: 0,
      });
    }
    return people.get(key);
  }

  dailySheet.columns = [
    { header: "Date", key: "date", width: 15 },
    { header: "Cleaner", key: "cleaner", width: 24 },
    { header: "Unit", key: "unit", width: 24 },
    { header: "Property", key: "propertyName", width: 18 },
    { header: "Room Type", key: "roomType", width: 15 },
    { header: "Amount", key: "amount", width: 15 },
  ];

  for (const r of records) {
    const person = getPerson(r.cleaner);
    const amount = roundMoney(r.amount);
    person.unitRecords.push(r);
    person.unitTotal += amount;
    person.roles.add("Cleaner");

    if (!r.date || !r.cleaner || !r.unit) {
      warnings.push({ type: "Cleaning", employee: r.cleaner, date: r.date, detail: `Registro incompleto: ${r.unit || "sin unidad"}` });
    }
    if (!r.roomType || amount <= 0) {
      warnings.push({ type: "Cleaning", employee: r.cleaner, date: r.date, detail: `${r.unit}: tarifa o tipo de unidad inválido` });
    }

    dailySheet.addRow({ ...r, amount });
  }

  hourlySheet.columns = [
    { header: "Employee", key: "employee", width: 24 },
    { header: "Role", key: "role", width: 20 },
    { header: "Work Location", key: "workLocation", width: 20 },
    { header: "Clock In", key: "clockIn", width: 25 },
    { header: "Clock Out", key: "clockOut", width: 25 },
    { header: "Hours", key: "hours", width: 12 },
    { header: "Hourly Rate", key: "hourlyRate", width: 15 },
    { header: "Total", key: "total", width: 15 },
  ];

  for (const r of hourlyRecords) {
    const person = getPerson(r.employee);
    const hours = Number(r.hours || 0);
    const total = roundMoney(r.total);
    person.hourlyRecords.push(r);
    person.hours += hours;
    person.hourlyTotal += total;
    if (r.role) person.roles.add(r.role);

    if (!r.clockOut || hours <= 0 || Number(r.hourlyRate || 0) <= 0) {
      warnings.push({ type: "Hourly", employee: r.employee, date: String(r.clockIn || "").slice(0, 10), detail: "Clock Out, horas o tarifa inválidos" });
    }

    hourlySheet.addRow({ ...r, total });
  }

  summarySheet.columns = [
    { header: "Employee", key: "employee", width: 24 },
    { header: "Functions", key: "roles", width: 28 },
    { header: "Units", key: "units", width: 10 },
    { header: "Unit Pay", key: "unitPay", width: 15 },
    { header: "Hours", key: "hours", width: 12 },
    { header: "Hourly Pay", key: "hourlyPay", width: 15 },
    { header: "Weekly Total", key: "total", width: 16 },
  ];

  quickbooksSheet.columns = [
    { header: "Employee", key: "employee", width: 24 },
    { header: "Pay Period", key: "payPeriod", width: 25 },
    { header: "Unit Pay", key: "unitPay", width: 15 },
    { header: "Hourly Pay", key: "hourlyPay", width: 15 },
    { header: "Total", key: "total", width: 15 },
  ];

  const sortedPeople = [...people.values()].sort((a, b) => a.employee.localeCompare(b.employee));

  for (const person of sortedPeople) {
    const unitPay = roundMoney(person.unitTotal);
    const hourlyPay = roundMoney(person.hourlyTotal);
    const grandTotal = roundMoney(unitPay + hourlyPay);
    const roles = [...person.roles].filter(Boolean).join(" / ") || "Unspecified";

    summarySheet.addRow({
      employee: person.employee,
      roles,
      units: person.unitRecords.length,
      unitPay,
      hours: Number(person.hours.toFixed(2)),
      hourlyPay,
      total: grandTotal,
    });

    quickbooksSheet.addRow({
      employee: person.employee,
      payPeriod: `${weekStart} to ${weekEnd}`,
      unitPay,
      hourlyPay,
      total: grandTotal,
    });

    const employeeSheet = workbook.addWorksheet(uniqueSheetName(workbook, person.employee));
    employeeSheet.addRow(["Employee", person.employee]);
    employeeSheet.addRow(["Pay Period", `${weekStart} to ${weekEnd}`]);
    employeeSheet.addRow(["Functions", roles]);
    employeeSheet.addRow([]);

    employeeSheet.addRow(["CLEANING / UNIT PAY"]);
    employeeSheet.addRow(["Date", "Property", "Unit", "Room Type", "Amount"]);
    for (const r of person.unitRecords) {
      employeeSheet.addRow([r.date, r.propertyName || "Hotel", r.unit, r.roomType, roundMoney(r.amount)]);
    }
    employeeSheet.addRow(["Cleaning subtotal", "", "", "", unitPay]);
    employeeSheet.addRow([]);

    employeeSheet.addRow(["HOURLY WORK"]);
    employeeSheet.addRow(["Date", "Role", "Work Location", "Clock In", "Clock Out", "Hours", "Rate", "Total"]);
    for (const r of person.hourlyRecords) {
      employeeSheet.addRow([
        String(r.clockIn || "").slice(0, 10), r.role, r.workLocation || "Unspecified", r.clockIn, r.clockOut,
        Number(r.hours || 0), Number(r.hourlyRate || 0), roundMoney(r.total),
      ]);
    }
    employeeSheet.addRow(["Hourly subtotal", "", "", "", "", Number(person.hours.toFixed(2)), "", hourlyPay]);
    employeeSheet.addRow([]);
    employeeSheet.addRow(["WEEKLY TOTAL", "", "", "", "", "", "", grandTotal]);

    employeeSheet.columns = [
      { width: 18 }, { width: 20 }, { width: 24 }, { width: 20 },
      { width: 25 }, { width: 12 }, { width: 12 }, { width: 15 },
    ];
  }

  warningsSheet.columns = [
    { header: "Type", key: "type", width: 15 },
    { header: "Employee", key: "employee", width: 24 },
    { header: "Date", key: "date", width: 15 },
    { header: "Detail", key: "detail", width: 60 },
  ];
  if (warnings.length) warnings.forEach((warning) => warningsSheet.addRow(warning));
  else warningsSheet.addRow({ type: "OK", detail: "No payroll warnings found" });

  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const header = sheet.getRow(1);
    header.font = { bold: true };
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === "number") cell.numFmt = '$#,##0.00';
      });
    });
  }

  const folder = path.join(__dirname, "payroll_exports");
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, payrollFileName(weekStart, weekEnd));
  await workbook.xlsx.writeFile(filePath);

  return {
    fileName: payrollFileName(weekStart, weekEnd),
    filePath,
    fileUrl: `/payroll_exports/${payrollFileName(weekStart, weekEnd)}`,
    totalRecords: records.length + hourlyRecords.length,
    employees: sortedPeople.length,
    warnings: warnings.length,
    payrollSource: payrollRead.source,
    payrollFallback: payrollRead.fallback,
    payrollFallbackReason: payrollRead.fallbackReason || "",
  };
}
// ■ Actualizar habitación principal
async function updateNotionRoom(unit, action, employee, note, mode = "cleaner", photoUrl = "") {
if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
throw new Error("Faltan variables de Notion. Revisa NOTION_API_KEY y NOTION_DATABASE_ID");
}
const allowedActions = [
"START",
"DONE",
"ISSUE",
"SUPPLIES",
"PHOTO",
"LOST_FOUND",
"INSPECTION_START",
"READY_GUEST",
"INSPECTION_REPORT",
"INSPECTION_SUPPLIES",
"GUEST_OUT",
"PRE_INSPECTION_START",
"PRE_INSPECTION_COMPLETE"
];
if (!allowedActions.includes(action)) {
throw new Error("Acción no permitida");
}
let pages = await queryTodayRooms();
const normalizedTarget = normalizeRoom(unit);
const targetDigits = roomDigits(unit);

const findMatches = (roomPages) => {
  const exactNormalized = roomPages.filter((page) => {
    const title =
      page.properties["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";
    return normalizeRoom(title) === normalizedTarget;
  });

  if (exactNormalized.length > 0) return exactNormalized;

  // Compatibilidad con títulos decorados, por ejemplo: "334 B (M) - H".
  // Solo usamos números cuando no existe una coincidencia normalizada.
  return roomPages.filter((page) => {
    const title =
      page.properties["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";
    return targetDigits && roomDigits(title) === targetDigits;
  });
};

let matches = findMatches(pages);

// El caché puede estar desactualizado cuando una unidad acaba de agregarse,
// renombrarse o sincronizarse. Antes de fallar, consultar Notion directamente.
if (matches.length === 0) {
  pages = await queryTodayRooms(true);
  matches = findMatches(pages);
}

if (matches.length === 0) {
  throw new Error(`No encontré la unidad ${unit} en Notion para hoy`);
}

const now = new Date().toISOString();
const label = actionLabel(action);
const status = notionStatusFromAction(action);

const needsAI = [
  "ISSUE",
  "SUPPLIES",
  "INSPECTION_REPORT",
  "INSPECTION_SUPPLIES",
].includes(action);

let ai = null;

if (needsAI) {
  ai = await analyzeNoteWithAI(action, note);
}

for (const page of matches) {
  const assignedCleaner = getAssignedCleaner(page);
  const officialCleaner = assignedCleaner || employee;
  const fullUnitTitle = getRoomTitleFromPage(page) || unit;
  const cleanerFinishedAt =
    page.properties["Finished At"]?.date?.start || "";

  const historyLine =
    `${localTime()} - ${employee} - ${label}` +
    `${assignedCleaner && mode === "inspector" ? ` - Cleaner: ${assignedCleaner}` : ""}` +
    `${note ? ` - ${note}` : ""}` +
    `${photoUrl ? ` - Photo: ${photoUrl}` : ""}` +
    `${ai ? ` | ${ai.category} | ${ai.priority} | ${ai.summary}` : ""}`;

  const oldLastMessage =
    page.properties["Last Message"]?.rich_text?.map((t) => t.plain_text).join("") || "";

  const newLastMessage = oldLastMessage
    ? `${oldLastMessage}\n${historyLine}`
    : historyLine;

  const props = {
    "Last Whatsapp Update ": {
      date: {
        start: now,
      },
    },
    "Last Message": {
      rich_text: [
        {
          text: {
            content: newLastMessage.slice(-1900),
          },
        },
      ],
    },
    "Last Update By": {
      rich_text: [
        {
          text: {
            content: employee,
          },
        },
      ],
    },
  };

  if (status) {
    props["Cleaning Status"] = {
      status: {
        name: status,
      },
    };
  }

  if (action === "START") {
    props["Started At"] = {
      date: {
        start: now,
      },
    };
  }

  if (action === "DONE") {
    props["Finished At"] = {
      date: {
        start: now,
      },
    };
  }

  if (action === "INSPECTION_START") {
    setFirstExistingDate(
      page,
      props,
      ["Inspection Started At", "Inspection Start At"],
      now
    );
  }

  if (action === "READY_GUEST") {
    setFirstExistingDate(
      page,
      props,
      ["Ready At", "Ready for Guest At"],
      now
    );
  }

  if (action === "GUEST_OUT") {
    setCheckboxIfExists(page, props, "Guest Out", true);
    setDateIfExists(page, props, "Guest Out At", now);
  }

  if (action === "PRE_INSPECTION_START") {
    // El checkbox es opcional. Si no existe, usamos la fecha como estado.
    setFirstExistingCheckbox(
      page,
      props,
      [
        "Pre Inspection Started",
        "Pre-Inspection Started",
        "pre inspection started",
        "Pre inspection started",
      ],
      true
    );

    const startedAtProperty = setFirstExistingDate(
      page,
      props,
      [
        "Pre Inspection Started At",
        "Pre-Inspection Started At",
        "Pre Inspection Start At",
        "pre inspection started at",
      ],
      now
    );

    if (!startedAtProperty) {
      throw new Error(
        'No encontré en Notion una propiedad de fecha llamada "Pre Inspection Started At"'
      );
    }
  }

  if (action === "PRE_INSPECTION_COMPLETE") {
    const completedProperty = setFirstExistingCheckbox(
      page,
      props,
      [
        "Pre Inspection",
        "Pre-Inspection",
        "Pre Inspected",
        "pre inspection",
        "Pre inspection",
      ],
      true
    );

    setFirstExistingCheckbox(
      page,
      props,
      [
        "Pre Inspection Started",
        "Pre-Inspection Started",
        "pre inspection started",
        "Pre inspection started",
      ],
      false
    );

    setFirstExistingDate(
      page,
      props,
      [
        "Pre Inspection Completed At",
        "Pre-Inspection Completed At",
        "Pre Inspection At",
        "pre inspection completed at",
      ],
      now
    );

    if (!completedProperty) {
      throw new Error(
        'No encontré en Notion una propiedad checkbox llamada "Pre Inspection"'
      );
    }
  }

  const autoCloseCleaning =
    action === "INSPECTION_START" &&
    !cleanerFinishedAt &&
    officialCleaner;

  if (autoCloseCleaning) {
    props["Finished At"] = {
      date: {
        start: now,
      },
    };
  }

  if (needsAI) {
    props["Issues Notes"] = {
      rich_text: [
        {
          text: {
            content: ai ? ai.summary : note || label,
          },
        },
      ],
    };

    props["Issue Category"] = {
      select: {
        name: ai ? ai.category : "Other",
      },
    };

    props["Priority"] = {
      select: {
        name: ai ? ai.priority : "Normal",
      },
    };
  }

  await notion.pages.update({
    page_id: page.id,
    properties: props,
  });

  clearRoomCache(todayISO());
  clearAssignmentCaches(todayISO());

  const existingFlags = getRoomOpsFlags(page);

  const roomUpdatePayload = {
    id: page.id,
    pageId: page.id,
    unit: fullUnitTitle,
    action,
    status:
      status ||
      page.properties?.["Cleaning Status"]?.status?.name ||
      "",
    guestOut:
      action === "GUEST_OUT"
        ? true
        : existingFlags.guestOut,
    preInspectionStarted:
      action === "PRE_INSPECTION_START"
        ? true
        : action === "PRE_INSPECTION_COMPLETE"
          ? false
          : existingFlags.preInspectionStarted,
    preInspection:
      action === "PRE_INSPECTION_COMPLETE"
        ? true
        : existingFlags.preInspection,
    startedAt:
      action === "START"
        ? now
        : page.properties?.["Started At"]?.date?.start || "",
    finishedAt:
      action === "DONE"
        ? now
        : page.properties?.["Finished At"]?.date?.start || "",
    inspectionStartedAt:
      action === "INSPECTION_START"
        ? now
        : readDateProp(page, ["Inspection Started At", "Inspection Start At"]),
    readyAt:
      action === "READY_GUEST"
        ? now
        : readDateProp(page, ["Ready At", "Ready for Guest At"]),
    updatedAt: now,
  };

  // Evento ligero para actualizar solo una tarjeta en todos los teléfonos.
  io.emit("room-updated", roomUpdatePayload);

  // Alertas administrativas: limpieza iniciada, terminada y solicitudes operativas.
  const adminAlertConfig = {
    START: {
      kind: "cleaning_start",
      title: `🧹 Limpieza iniciada · ${fullUnitTitle}`,
      body: `${officialCleaner || employee || "Cleaner"} comenzó la habitación.`,
      link: "/operations.html",
    },
    DONE: {
      kind: "cleaning_done",
      title: `✅ Limpieza terminada · ${fullUnitTitle}`,
      body: `${officialCleaner || employee || "Cleaner"} terminó la habitación.`,
      link: "/operations.html",
    },
    ISSUE: {
      kind: "request",
      title: `⚠️ Reporte en Operations · ${fullUnitTitle}`,
      body: `${employee || officialCleaner || "Empleado"}: ${note || "Reportó un problema."}`,
      link: "/operations.html",
    },
    SUPPLIES: {
      kind: "request",
      title: `📦 Solicitud en Operations · ${fullUnitTitle}`,
      body: `${employee || officialCleaner || "Empleado"}: ${note || "Solicitó artículos."}`,
      link: "/operations.html",
    },
    LOST_FOUND: {
      kind: "request",
      title: `🔎 Lost & Found · ${fullUnitTitle}`,
      body: `${employee || officialCleaner || "Empleado"}: ${note || "Registró un objeto."}`,
      link: "/operations.html",
    },
  };

  const adminAlert = adminAlertConfig[action];
  if (adminAlert) {
    const adminPayload = {
      ...adminAlert,
      action,
      unit: fullUnitTitle,
      employee: officialCleaner || employee || "",
      createdAt: now,
    };
    io.emit("admin-operation-alert", adminPayload);
    Promise.resolve(sendPushToRole(postgresQuery, "admin", {
      title: adminPayload.title,
      body: adminPayload.body,
      link: adminPayload.link,
      tag: `admin-${String(action).toLowerCase()}-${String(fullUnitTitle).replace(/\s+/g, "-")}-${Date.now()}`,
      urgent: ["ISSUE", "SUPPLIES", "LOST_FOUND"].includes(action),
      data: {
        type: "ADMIN_OPERATION_ALERT",
        soundType: adminPayload.kind,
        action,
        unit: fullUnitTitle,
      },
    })).then(result => {
      console.log("ADMIN OPERATIONS PUSH:", { action, unit: fullUnitTitle, ...result });
    }).catch(error => console.error("ADMIN OPERATIONS PUSH ERROR:", error.message));
  }

  // Evento general como respaldo para cambios de asignación o cambios externos.
  broadcastAssignmentUpdate("server-room-update", {
    pageId: page.id,
    unit: fullUnitTitle,
    action,
    lightweight: true,
  });

  await saveDailyLog({
    action,
    unit: fullUnitTitle,
    employee: mode === "cleaner" ? officialCleaner : officialCleaner,
    inspector: mode === "inspector" ? employee : "",
    assignedCleaner: mode === "inspector" ? officialCleaner : "",
    note,
    ai,
    photoUrl: photoUrl || "",
    lostAndFound: action === "LOST_FOUND",
  });

  if (autoCloseCleaning) {
    await saveDailyLog({
      action: "DONE",
      unit: fullUnitTitle,
      employee: officialCleaner,
      inspector: "",
      assignedCleaner: "",
      note: `Cierre automático porque ${employee} inició inspección`,
      ai: null,
    });

    await createPayrollRecord({
      cleaner: officialCleaner,
      unit: fullUnitTitle,
      date: todayISO(),
    });
  }

  if (mode === "cleaner" && action === "DONE") {
    await createPayrollRecord({
      cleaner: officialCleaner,
      unit: fullUnitTitle,
      date: todayISO(),
    });
  }
}

return {
  label,
  ai,
};
}

// Helpers para PDF
function getProp(page, names) {
  for (const name of names) {
    if (page.properties[name]) return page.properties[name];
  }

  return null;
}

function readText(page, names) {
  const prop = getProp(page, names);

  if (!prop) return "";

  if (prop.title) return prop.title.map((t) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join("");
  if (prop.select) return prop.select.name || "";
  if (prop.status) return prop.status.name || "";
  if (prop.date) return prop.date.start || "";
  if (prop.number !== null && prop.number !== undefined) return String(prop.number);
  if (prop.checkbox !== undefined) return prop.checkbox ? "Yes" : "No";

  return "";
}

function readUrl(page, names) {
  const prop = getProp(page, names);
  if (!prop) return "";
  return prop.url || "";
}

function formatReportTime(value) {
  if (!value) return "N/A";

  return new Date(value).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

async function getDailyLogsForReport(date) {
  if (!NOTION_LOG_DATABASE_ID) {
    throw new Error("Falta NOTION_LOG_DATABASE_ID o NOTION_DAILY_CLEANING_LOGS_DB_ID");
  }

  const response = await notion.databases.query({
    database_id: NOTION_LOG_DATABASE_ID,
    filter: {
      property: "Date",
      date: {
        equals: date,
      },
    },
    sorts: [
      {
        property: "Time",
        direction: "ascending",
      },
    ],
  });

  return response.results;
}
function normalizeCleaner(name) {
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");

  const map = {
    "steve": "Steve Soto",
    "steve soto": "Steve Soto",
    "brenda": "Brenda",
    "yoel": "Yoel",
    "carolina": "Carolina",
  };

  return map[n] || String(name || "").trim().replace(/\s+/g, " ");
}

function normalizeReportUnit(unit) {
  return String(unit || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .trim();
}
async function generateDailyReport(date = todayISO()) {
  console.log("USANDO REPORTE DESDE SERVER.JS - REPORTE DESDE PAGINA CENTRAL");

  const [centralRooms, logs] = await Promise.all([
    queryRoomsByDate(date),
    getDailyLogsForReport(date),
  ]);

  const fileName = `daily-housekeeping-report-${date}.pdf`;
  const filePath = path.join(reportsDir, fileName);

  const logsByUnit = {};
  const logsByCleaner = {};
  const logsByInspector = {};

  logs.forEach((log) => {
    const unit = normalizeReportUnit(readText(log, ["Unit", "unit"]));
    const cleaner = normalizeCleaner(readText(log, ["Cleaner", "cleaner"]));
    const inspector = normalizeCleaner(readText(log, ["Inspector", "inspector"]));
    const action = readText(log, ["Action", "action"]);
    const note = readText(log, ["Note", "note"]);
    const category = readText(log, ["Category", "category"]);
    const priority = readText(log, ["Priority", "priority"]);
    const time = readText(log, ["Time", "time"]);
    const photoUrl = readUrl(log, ["Photo URL", "photo url"]);
    const cleanerError = normalizeCleaner(readText(log, ["Cleaner Error", "cleaner error"]));

    const item = {
      unit,
      cleaner,
      inspector,
      action,
      note,
      category,
      priority,
      time,
      photoUrl,
      cleanerError,
      displayTime: formatReportTime(time),
    };

    if (!logsByUnit[unit]) logsByUnit[unit] = [];
    logsByUnit[unit].push(item);

    if (cleaner) {
      if (!logsByCleaner[cleaner]) logsByCleaner[cleaner] = [];
      logsByCleaner[cleaner].push(item);
    }

    if (inspector) {
      if (!logsByInspector[inspector]) logsByInspector[inspector] = [];
      logsByInspector[inspector].push(item);
    }
  });

  const centralUnits = centralRooms.map((page) => {
    const unitTitle = getRoomTitleFromPage(page);
    const unitKey = normalizeReportUnit(unitTitle);
    const assignedCleaner = normalizeCleaner(getAssignedCleaner(page));
    const status = readText(page, ["Cleaning Status", "Status", "status"]);
    const startedAt = readText(page, ["Started At", "started at"]);
    const finishedAt = readText(page, ["Finished At", "finished at"]);

    return {
      unitTitle,
      unitKey,
      assignedCleaner,
      status,
      startedAt,
      finishedAt,
      startedDisplay: formatReportTime(startedAt),
      finishedDisplay: formatReportTime(finishedAt),
      logs: logsByUnit[unitKey] || [],
    };
  });

  const totalUnits = centralUnits.length;
  const completedUnits = centralUnits.filter((u) => u.finishedAt).length;
  const readyUnits = centralUnits.filter((u) =>
    String(u.status || "").toLowerCase().includes("ready")
  ).length;

  const assignedCleaners = new Set(
    centralUnits.map((u) => u.assignedCleaner).filter(Boolean)
  );

  const activeInspectors = new Set(
    logs.map((log) => normalizeCleaner(readText(log, ["Inspector", "inspector"]))).filter(Boolean)
  );

  let issues = 0;
  let supplyRequests = 0;
  let lostAndFound = 0;
  let cleanerErrors = 0;
  let highPriority = 0;

  logs.forEach((log) => {
    const action = readText(log, ["Action", "action"]).toLowerCase();
    const category = readText(log, ["Category", "category"]).toLowerCase();
    const priority = readText(log, ["Priority", "priority"]).toLowerCase();

    if (
      action.includes("issue") ||
      action.includes("report") ||
      category.includes("maintenance") ||
      category.includes("damage") ||
      category.includes("cleaning")
    ) {
      issues++;
    }

    if (action.includes("supplies") || category.includes("supplies")) {
      supplyRequests++;
    }

    if (action.includes("lost_found") || category.includes("guest item")) {
      lostAndFound++;
    }

    if (action === "inspection_report") {
      cleanerErrors++;
    }

    if (
      priority.includes("high") ||
      priority.includes("urgent") ||
      priority.includes("alta") ||
      priority.includes("urgente")
    ) {
      highPriority++;
    }
  });

  const cleanerSummary = {};

  centralUnits.forEach((unit) => {
    const cleaner = unit.assignedCleaner || "Sin asignar";

    if (!cleanerSummary[cleaner]) {
      cleanerSummary[cleaner] = [];
    }

    const unitLogs = unit.logs || [];

    const requests = unitLogs.filter((l) =>
      String(l.action || "").toLowerCase().includes("supplies")
    );

    const problems = unitLogs.filter((l) => {
      const a = String(l.action || "").toLowerCase();
      const c = String(l.category || "").toLowerCase();

      return (
        a.includes("issue") ||
        a.includes("report") ||
        a.includes("lost_found") ||
        c.includes("maintenance") ||
        c.includes("damage") ||
        c.includes("guest item")
      );
    });

    cleanerSummary[cleaner].push({
      unit: unit.unitTitle,
      start: unit.startedDisplay,
      finish: unit.finishedDisplay,
      status: unit.status || "N/A",
      requests,
      problems,
    });
  });

  const inspectorSummary = {};

  logs.forEach((log) => {
    const inspector = normalizeCleaner(readText(log, ["Inspector", "inspector"]));
    const unit = readText(log, ["Unit", "unit"]);
    const action = readText(log, ["Action", "action"]);
    const note = readText(log, ["Note", "note"]);
    const priority = readText(log, ["Priority", "priority"]);
    const category = readText(log, ["Category", "category"]);
    const time = readText(log, ["Time", "time"]);
    const photoUrl = readUrl(log, ["Photo URL", "photo url"]);

    if (!inspector) return;

    if (!inspectorSummary[inspector]) {
      inspectorSummary[inspector] = {};
    }

    if (!inspectorSummary[inspector][unit]) {
      inspectorSummary[inspector][unit] = {
        start: "",
        finish: "",
        requests: [],
        problems: [],
      };
    }

    const target = inspectorSummary[inspector][unit];
    const actionLower = String(action || "").toLowerCase();
    const categoryLower = String(category || "").toLowerCase();

    if (actionLower === "inspection_start") {
      target.start = formatReportTime(time);
    }

    if (actionLower === "ready_guest") {
      target.finish = formatReportTime(time);
    }

    if (actionLower.includes("supplies") || categoryLower.includes("supplies")) {
      target.requests.push({
        time: formatReportTime(time),
        note: note || "Supply request",
        priority,
        photoUrl,
      });
    }

    if (
      actionLower.includes("inspection_report") ||
      actionLower.includes("lost_found") ||
      categoryLower.includes("maintenance") ||
      categoryLower.includes("damage") ||
      categoryLower.includes("guest item")
    ) {
      target.problems.push({
        time: formatReportTime(time),
        note: note || "Issue reported",
        priority,
        photoUrl,
      });
    }
  });

  const doc = new PDFDocument({ margin: 45 });
  doc.pipe(fs.createWriteStream(filePath));

  function sectionTitle(title) {
    if (doc.y > 700) doc.addPage();
    doc.moveDown(0.6);
    doc.fontSize(15).text(title);
    doc.moveDown(0.4);
  }

  function writeSmallLine(textValue) {
    if (doc.y > 735) doc.addPage();
    doc.fontSize(9).text(textValue);
  }

  function writeNoteList(title, items) {
    if (!items || items.length === 0) return;

    writeSmallLine(title);

    items.forEach((item) => {
      const priority = item.priority ? ` (${item.priority})` : "";
      const photo = item.photoUrl ? " | Photo attached" : "";
      writeSmallLine(`  - ${item.time || ""} ${item.note || ""}${priority}${photo}`);
    });
  }

  doc.fontSize(20).text("DAILY REPORT", { align: "center" });
  doc.moveDown();
  doc.fontSize(11).text(`Date: ${date}`);
  doc.text(`Company: ${process.env.COMPANY_NAME || "Care Luxury Cleaning"}`);

  sectionTitle("1. Executive Summary");
  doc.fontSize(11).text(`Total Units from Central Page: ${totalUnits}`);
  doc.text(`Units Finished by Cleaners: ${completedUnits}`);
  doc.text(`Units Ready for Guest: ${readyUnits}`);
  doc.text(`Issues / Reports: ${issues}`);
  doc.text(`Supply Requests: ${supplyRequests}`);
  doc.text(`Lost & Found: ${lostAndFound}`);
  doc.text(`High Priority Records: ${highPriority}`);
  doc.text(`Cleaner Errors: ${cleanerErrors}`);
  doc.text(`Assigned Cleaners: ${assignedCleaners.size}`);
  doc.text(`Active Inspectors: ${activeInspectors.size}`);

  sectionTitle("2. Units from Central Page");
  if (centralUnits.length === 0) {
    doc.fontSize(10).text("No units found in the central page for this date.");
  } else {
    centralUnits
      .sort((a, b) => a.unitTitle.localeCompare(b.unitTitle))
      .forEach((unit) => {
        writeSmallLine(
          `${unit.unitTitle} | Cleaner: ${unit.assignedCleaner || "Sin asignar"} | Status: ${unit.status || "N/A"} | Start: ${unit.startedDisplay} | Finish: ${unit.finishedDisplay}`
        );
      });
  }

  doc.addPage();
  doc.fontSize(16).text("3. Cleaner Summary", { align: "center" });
  doc.moveDown();

  Object.entries(cleanerSummary)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([cleaner, units]) => {
      if (doc.y > 680) doc.addPage();

      doc.fontSize(12).text(cleaner);
      doc.moveDown(0.25);

      units
        .sort((a, b) => a.unit.localeCompare(b.unit))
        .forEach((item) => {
          writeSmallLine(
            `Unit ${item.unit} | Start: ${item.start} | Finished: ${item.finish} | Status: ${item.status}`
          );

          writeNoteList("  Requests:", item.requests);
          writeNoteList("  Problems / Lost & Found:", item.problems);

          doc.moveDown(0.2);
        });

      doc.moveDown(0.5);
    });

  doc.addPage();
  doc.fontSize(16).text("4. Inspector Summary", { align: "center" });
  doc.moveDown();

  if (Object.keys(inspectorSummary).length === 0) {
    doc.fontSize(10).text("No inspector activity found.");
  } else {
    Object.entries(inspectorSummary)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([inspector, units]) => {
        if (doc.y > 680) doc.addPage();

        doc.fontSize(12).text(inspector);
        doc.moveDown(0.25);

        Object.entries(units)
          .sort(([a], [b]) => a.localeCompare(b))
          .forEach(([unit, item]) => {
            writeSmallLine(
              `Unit ${unit || "N/A"} | Inspection Start: ${item.start || "N/A"} | Ready for Guest: ${item.finish || "N/A"}`
            );

            writeNoteList("  Requests:", item.requests);
            writeNoteList("  Problems / Lost & Found:", item.problems);

            doc.moveDown(0.2);
          });

        doc.moveDown(0.5);
      });
  }

  doc.end();

  return {
    fileName,
    fileUrl: `/reports/${fileName}`,
    totalRecords: logs.length,
    totalUnits,
  };
}


// =========================================================
// NUEVO MÓDULO: REPORTES INTELIGENTES + FOTOS MÚLTIPLES
// =========================================================
function limitText(value, max = 1900) {
  return String(value || "").slice(0, max);
}

function readPlainTextFromProp(prop) {
  if (!prop) return "";
  if (prop.title) return prop.title.map((t) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join("");
  if (prop.select) return prop.select.name || "";
  if (prop.status) return prop.status.name || "";
  if (prop.date) return prop.date.start || "";
  if (prop.url) return prop.url || "";
  if (prop.checkbox !== undefined) return prop.checkbox ? "Yes" : "No";
  if (prop.number !== null && prop.number !== undefined) return String(prop.number);
  return "";
}

function buildRichTextValue(value) {
  return {
    rich_text: [
      {
        text: {
          content: limitText(value, 1900),
        },
      },
    ],
  };
}

function buildTitleValue(value) {
  return {
    title: [
      {
        text: {
          content: limitText(value, 180),
        },
      },
    ],
  };
}

function buildNotionProp(schema, names, value, forcedType = null) {
  const name = findPropName(schema, names);
  if (!name) return null;

  const type = forcedType || schema[name].type;
  const text = String(value ?? "");

  if (type === "title") return { name, value: buildTitleValue(text) };
  if (type === "rich_text") return { name, value: buildRichTextValue(text) };
  if (type === "date") return { name, value: { date: { start: text } } };
  if (type === "select") return { name, value: { select: { name: text || "Other" } } };
  if (type === "status") return { name, value: { status: { name: text || "Received" } } };
  if (type === "checkbox") return { name, value: { checkbox: !!value } };
  if (type === "number") return { name, value: { number: Number(value || 0) } };
  if (type === "url") return { name, value: { url: text || null } };

  return null;
}

function addNotionProp(props, schema, names, value, forcedType = null) {
  const prop = buildNotionProp(schema, names, value, forcedType);
  if (prop) props[prop.name] = prop.value;
}

async function uploadBufferToCloudinary(file, folder = "housekeeping/reports") {
  const base64 = file.buffer.toString("base64");
  const dataUri = `data:${file.mimetype};base64,${base64}`;

  return cloudinary.uploader.upload(dataUri, {
    folder,
    resource_type: "image",
    quality: "auto:best",
  });
}

async function analyzeReportMessageWithAI({ unit, employee, role, message, action }) {
  const safeMessage = String(message || "").trim();

  if (!OPENAI_API_KEY || !safeMessage) {
    return {
      category: "General Message",
      priority: "Normal",
      summary: safeMessage || "Sin mensaje",
      suggestedHotSOS: "",
      needsHotSOS: false,
      detectedItems: "",
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "Eres un asistente de operaciones de housekeeping hotelero. Clasifica mensajes de limpiadores e inspectores. Responde solo JSON válido, sin markdown.",
        },
        {
          role: "user",
          content: `
Unidad: ${unit}
Empleado: ${employee}
Rol: ${role}
Acción: ${action || "REPORT"}
Mensaje original: ${safeMessage}

Clasifica el mensaje sin pedir categorías al empleado.
Devuelve exactamente este JSON:
{
  "category": "Supplies | Maintenance | Lost & Found | Cleaner Error | Damage | Ready Note | Guest Request | General Message | Multiple",
  "priority": "Normal | Urgent | Blocking Room",
  "summary": "resumen corto en español para operaciones",
  "suggestedHotSOS": "texto corto en inglés para copiar y pegar en HotSOS, o vacío si no aplica",
  "needsHotSOS": true,
  "detectedItems": "lista corta de cosas detectadas, como towels, toilet clogged, hair, remote missing"
}

Reglas:
- Si hay mantenimiento, daño, falta de supplies, objeto perdido, bloqueo de unidad o error importante, needsHotSOS debe ser true.
- Si sólo dice que terminó, inició, o es una nota general sin acción externa, needsHotSOS debe ser false.
- Si hay más de una categoría, usa Multiple.
`,
        },
      ],
    });

    const text = response.choices[0].message.content || "{}";
    const cleanText = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleanText);

    return {
      category: parsed.category || "General Message",
      priority: parsed.priority || "Normal",
      summary: parsed.summary || safeMessage,
      suggestedHotSOS: parsed.suggestedHotSOS || "",
      needsHotSOS: !!parsed.needsHotSOS,
      detectedItems: parsed.detectedItems || "",
    };
  } catch (error) {
    console.log("■■ OpenAI report error:", error.message);
    return {
      category: "General Message",
      priority: "Normal",
      summary: safeMessage || "Sin mensaje",
      suggestedHotSOS: "",
      needsHotSOS: false,
      detectedItems: "",
    };
  }
}

async function createReportMessage({
  unit,
  employee,
  role,
  action = "REPORT",
  message,
  ai,
  photoUrls = [],
  sourcePanel = "Unknown",
}) {
  if (!NOTION_REPORTS_DATABASE_ID) {
    throw new Error("Falta NOTION_REPORTS_DB_ID en Render");
  }

  const now = new Date().toISOString();
  const reportId = `RPT-${Date.now()}`;
  const schema = await getDatabaseSchema(NOTION_REPORTS_DATABASE_ID);
  const props = {};

  addNotionProp(props, schema, ["Report ID", "Report", "Name", "Title"], `${reportId} - ${unit}`, "title");
  addNotionProp(props, schema, ["Date", "date"], todayISO(), "date");
  addNotionProp(props, schema, ["Time", "time", "Created At"], now, "date");
  addNotionProp(props, schema, ["Unit", "unit"], unit);
  addNotionProp(props, schema, ["Employee", "Employee Name", "Name"], employee);
  addNotionProp(props, schema, ["Role", "role"], role || "Cleaner", "select");
  addNotionProp(props, schema, ["Action", "action"], action || "REPORT", "select");
  addNotionProp(props, schema, ["Original Message", "Message", "Note"], message || "");
  addNotionProp(props, schema, ["AI Category", "Category"], ai?.category || "General Message", "select");
  addNotionProp(props, schema, ["AI Priority", "Priority"], ai?.priority || "Normal", "select");
  addNotionProp(props, schema, ["AI Summary", "Summary"], ai?.summary || message || "");
  addNotionProp(props, schema, ["Suggested HotSOS Text", "HotSOS Text", "HOTSOS Text"], ai?.suggestedHotSOS || "");
  addNotionProp(props, schema, ["Needs HotSOS", "Needs HOTSOS"], !!ai?.needsHotSOS, "checkbox");
  addNotionProp(props, schema, ["HotSOS Sent", "HOTSOS Sent"], false, "checkbox");
  addNotionProp(props, schema, ["Photos Count", "Photo Count"], photoUrls.length, "number");
  addNotionProp(props, schema, ["Status", "status"], "Received", "select");
  addNotionProp(props, schema, ["Source Panel", "Source"], sourcePanel, "select");
  addNotionProp(props, schema, ["Detected Items", "Items Detected"], ai?.detectedItems || "");

  if (schema["First Photo URL"] && photoUrls[0]) {
    props["First Photo URL"] = { url: photoUrls[0] };
  }

  const page = await notion.pages.create({
    parent: {
      database_id: NOTION_REPORTS_DATABASE_ID,
    },
    properties: props,
  });

  return {
    reportId,
    notionPageId: page.id,
    createdAt: now,
  };
}

async function saveReportPhotos({ reportId, reportPageId, unit, employee, photoUrls }) {
  if (!NOTION_REPORT_PHOTOS_DATABASE_ID || !photoUrls || photoUrls.length === 0) {
    return [];
  }

  const schema = await getDatabaseSchema(NOTION_REPORT_PHOTOS_DATABASE_ID);
  const created = [];

  for (let i = 0; i < photoUrls.length; i++) {
    const url = photoUrls[i];
    const photoId = `${reportId}-PHOTO-${i + 1}`;
    const props = {};

    addNotionProp(props, schema, ["Photo ID", "Photo", "Name", "Title"], photoId, "title");
    addNotionProp(props, schema, ["Report ID", "Report"], reportId);
    addNotionProp(props, schema, ["Report Page ID", "Report Page"], reportPageId);
    addNotionProp(props, schema, ["Date", "date"], todayISO(), "date");
    addNotionProp(props, schema, ["Unit", "unit"], unit);
    addNotionProp(props, schema, ["Employee", "Employee Name", "Name"], employee);
    addNotionProp(props, schema, ["Photo URL", "URL", "Image URL"], url, "url");

    const page = await notion.pages.create({
      parent: {
        database_id: NOTION_REPORT_PHOTOS_DATABASE_ID,
      },
      properties: props,
    });

    created.push({ id: page.id, photoId, url });
  }

  return created;
}

function reportPageToObject(page) {
  const p = page.properties || {};
  const dateValue = readPlainTextFromProp(p.Date || p.date);
  const timeValue = readPlainTextFromProp(p.Time || p.time || p["Created At"]);

  return {
    id: page.id,
    reportId: readPlainTextFromProp(p["Report ID"] || p.Report || p.Name || p.Title),
    date: dateValue,
    timeRaw: timeValue,
    time: timeValue
      ? new Date(timeValue).toLocaleString("en-US", {
          timeZone: "America/Chicago",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        })
      : "",
    unit: readPlainTextFromProp(p.Unit || p.unit),
    employee: readPlainTextFromProp(p.Employee || p["Employee Name"] || p.Name),
    role: readPlainTextFromProp(p.Role || p.role),
    action: readPlainTextFromProp(p.Action || p.action),
    message: readPlainTextFromProp(p["Original Message"] || p.Message || p.Note),
    aiCategory: readPlainTextFromProp(p["AI Category"] || p.Category),
    aiPriority: readPlainTextFromProp(p["AI Priority"] || p.Priority),
    aiSummary: readPlainTextFromProp(p["AI Summary"] || p.Summary),
    suggestedHotSOS: readPlainTextFromProp(p["Suggested HotSOS Text"] || p["HotSOS Text"] || p["HOTSOS Text"]),
    needsHotSOS: !!(p["Needs HotSOS"] || p["Needs HOTSOS"])?.checkbox,
    hotsosSent: !!(p["HotSOS Sent"] || p["HOTSOS Sent"])?.checkbox,
    photosCount: (p["Photos Count"] || p["Photo Count"])?.number || 0,
    status: readPlainTextFromProp(p.Status || p.status),
    sourcePanel: readPlainTextFromProp(p["Source Panel"] || p.Source),
    detectedItems: readPlainTextFromProp(p["Detected Items"] || p["Items Detected"]),
    firstPhotoUrl: (p["First Photo URL"] || {})?.url || "",
  };
}

async function getReportPhotosByReportId(reportId) {
  if (!NOTION_REPORT_PHOTOS_DATABASE_ID || !reportId) return [];

  const response = await notion.databases.query({
    database_id: NOTION_REPORT_PHOTOS_DATABASE_ID,
    page_size: 100,
    filter: {
      property: "Report ID",
      rich_text: {
        equals: reportId,
      },
    },
  });

  return response.results.map((page) => {
    const p = page.properties || {};
    return {
      id: page.id,
      photoId: readPlainTextFromProp(p["Photo ID"] || p.Photo || p.Name || p.Title),
      reportId: readPlainTextFromProp(p["Report ID"] || p.Report),
      unit: readPlainTextFromProp(p.Unit || p.unit),
      employee: readPlainTextFromProp(p.Employee || p["Employee Name"] || p.Name),
      url: (p["Photo URL"] || p.URL || p["Image URL"] || {})?.url || "",
    };
  });
}


app.post("/submit-report", upload.array("photos", 20), async (req, res) => {
  try {
    const unit = String(req.body.unit || "").trim();
    const employee = String(req.body.employee || req.body.name || "").trim();
    const role = String(req.body.role || "Cleaner").trim();
    const action = String(req.body.action || "REPORT").trim();
    const message = String(req.body.message || req.body.note || "").trim();
    const sourcePanel = String(req.body.sourcePanel || role || "Unknown").trim();

    if (!unit || !employee || !message) {
      return res.status(400).json({
        ok: false,
        success: false,
        message: "Falta unidad, empleado o mensaje",
      });
    }

    const files = req.files || [];
    const uploadResults = [];

    for (const file of files) {
      const uploaded = await uploadBufferToCloudinary(
        file,
        `housekeeping/reports/${todayISO()}/${normalizeRoom(unit) || "unknown"}`
      );
      uploadResults.push(uploaded.secure_url);
    }

    const ai = await analyzeReportMessageWithAI({
      unit,
      employee,
      role,
      message,
      action,
    });

    const report = await createReportMessage({
      unit,
      employee,
      role,
      action,
      message,
      ai,
      photoUrls: uploadResults,
      sourcePanel,
    });

    const photos = await saveReportPhotos({
      reportId: report.reportId,
      reportPageId: report.notionPageId,
      unit,
      employee,
      photoUrls: uploadResults,
    });

    broadcastOpsUpdate({
      type: "report",
      unit,
      employee,
      reportId: report.reportId,
    });

    res.json({
      ok: true,
      success: true,
      message: "Reporte enviado correctamente",
      reportId: report.reportId,
      notionPageId: report.notionPageId,
      photosCount: uploadResults.length,
      photoUrls: uploadResults,
      photos,
      ai,
    });
  } catch (error) {
    console.error("Error en /submit-report:", error.message);
    res.status(500).json({
      ok: false,
      success: false,
      message: error.message,
    });
  }
});

app.get("/my-reports", async (req, res) => {
  try {
    if (!NOTION_REPORTS_DATABASE_ID) {
      return res.json({ ok: true, count: 0, reports: [] });
    }

    const employee = String(req.query.employee || req.query.name || "").trim().toLowerCase();
    const role = String(req.query.role || "").trim().toLowerCase();
    const date = String(req.query.date || todayISO()).trim();

    const response = await notion.databases.query({
      database_id: NOTION_REPORTS_DATABASE_ID,
      page_size: 100,
      filter: {
        property: "Date",
        date: {
          equals: date,
        },
      },
      sorts: [
        {
          property: "Time",
          direction: "descending",
        },
      ],
    });

    let reports = response.results.map(reportPageToObject);

    if (employee) {
      reports = reports.filter((r) => String(r.employee || "").toLowerCase().trim() === employee);
    }

    if (role) {
      reports = reports.filter((r) => String(r.role || "").toLowerCase().trim() === role);
    }

    res.json({
      ok: true,
      date,
      count: reports.length,
      reports,
    });
  } catch (error) {
    console.error("Error en /my-reports:", error.message);
    res.status(500).json({ ok: false, message: error.message, reports: [] });
  }
});

app.get("/operations-reports", async (req, res) => {
  try {
    if (!NOTION_REPORTS_DATABASE_ID) {
      return res.json({ ok: true, count: 0, reports: [] });
    }

    const date = String(req.query.date || todayISO()).trim();
    const includePhotos = true;
    const cacheKey = `operations-reports:${date}:with-photos`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const response = await notion.databases.query({
      database_id: NOTION_REPORTS_DATABASE_ID,
      page_size: 100,
      filter: {
        property: "Date",
        date: {
          equals: date,
        },
      },
      sorts: [
        {
          property: "Time",
          direction: "descending",
        },
      ],
    });

    const reports = [];

    for (const page of response.results) {
      const report = reportPageToObject(page);
    if (report.reportId) {
  let cleanReportId = String(report.reportId || "").trim().split(" - ")[0];

  if (cleanReportId && !cleanReportId.startsWith("RPT-")) {
    cleanReportId = `RPT-${cleanReportId}`;
  }

  report.reportId = cleanReportId;
  report.photos = await getReportPhotosByReportId(cleanReportId);
  report.photosCount = report.photos.length;
}
      reports.push(report);
    }

    const payload = {
      ok: true,
      date,
      count: reports.length,
      reports,
    };

    setCache(cacheKey, payload, Number(process.env.ASSIGNMENTS_CACHE_MS || 15000));
    res.json(payload);
  } catch (error) {
    console.error("Error en /operations-reports:", error.message);
    res.status(500).json({ ok: false, message: error.message, reports: [] });
  }
});
app.get("/report-photos", async (req, res) => {
  let reportId = String(req.query.reportId || "").trim();

  if (
    reportId &&
    !reportId.startsWith("RPT-")
  ) {
    reportId = `RPT-${reportId}`;
  }

  try {
    if (!reportId) {
      return res.status(400).json({
        ok: false,
        message: "Report ID requerido"
      });
    }

    const photos = await getReportPhotosByReportId(reportId);

    res.json({
      ok: true,
      reportId,
      count: photos.length,
      photos,
    });

  } catch (error) {
    console.error("Error en /report-photos:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
      photos: []
    });
  }
});

app.post("/mark-hotsos-sent", async (req, res) => {
  try {
    const reportPageId = String(req.body.reportPageId || req.body.id || "").trim();

    if (!reportPageId) {
      return res.status(400).json({ ok: false, message: "Falta reportPageId" });
    }

    if (!NOTION_REPORTS_DATABASE_ID) {
      throw new Error("Falta NOTION_REPORTS_DB_ID en Render");
    }

    const schema = await getDatabaseSchema(NOTION_REPORTS_DATABASE_ID);
    const props = {};

    addNotionProp(props, schema, ["HotSOS Sent", "HOTSOS Sent"], true, "checkbox");
    addNotionProp(props, schema, ["Status", "status"], "Sent to HotSOS", "select");

    await notion.pages.update({
      page_id: reportPageId,
      properties: props,
    });

    broadcastOpsUpdate({
      type: "hotsos-sent",
      reportPageId,
    });

    res.json({ ok: true, message: "Reporte marcado como enviado a HotSOS" });
  } catch (error) {
    console.error("Error en /mark-hotsos-sent:", error.message);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/unit-history", async (req, res) => {
  try {
    const unit = String(req.query.unit || "").trim();
    const employee = String(req.query.employee || req.query.name || "").trim().toLowerCase();
    const date = String(req.query.date || todayISO()).trim();

    if (!unit) {
      return res.status(400).json({ ok: false, message: "Unidad requerida" });
    }

    const normalizedTarget = normalizeRoom(unit);
    const targetDigits = roomDigits(unit);
    const history = [];

    if (NOTION_LOG_DATABASE_ID) {
      const logs = await getDailyLogsForReport(date);
      logs.forEach((log) => {
        const p = log.properties || {};
        const logUnit = readPlainTextFromProp(p.Unit || p.unit);
        const cleaner = readPlainTextFromProp(p.Cleaner || p.cleaner);
        const inspector = readPlainTextFromProp(p.Inspector || p.inspector);
        const person = cleaner || inspector;

        const sameUnit = normalizeRoom(logUnit) === normalizedTarget || roomDigits(logUnit) === targetDigits;
        const sameEmployee = !employee || String(person || "").toLowerCase().trim() === employee;

        if (sameUnit && sameEmployee) {
          history.push({
            source: "Daily Log",
            id: log.id,
            timeRaw: readPlainTextFromProp(p.Time || p.time),
            unit: logUnit,
            employee: person,
            action: readPlainTextFromProp(p.Action || p.action),
            message: readPlainTextFromProp(p.Note || p.note),
            photoUrl: (p["Photo URL"] || {})?.url || "",
          });
        }
      });
    }

    if (NOTION_REPORTS_DATABASE_ID) {
      const reportsResponse = await notion.databases.query({
        database_id: NOTION_REPORTS_DATABASE_ID,
        page_size: 100,
        filter: {
          property: "Date",
          date: {
            equals: date,
          },
        },
      });

      reportsResponse.results.map(reportPageToObject).forEach((report) => {
        const sameUnit = normalizeRoom(report.unit) === normalizedTarget || roomDigits(report.unit) === targetDigits;
        const sameEmployee = !employee || String(report.employee || "").toLowerCase().trim() === employee;

        if (sameUnit && sameEmployee) {
          history.push({
            source: "Report",
            id: report.id,
            timeRaw: report.timeRaw,
            unit: report.unit,
            employee: report.employee,
            action: report.action,
            message: report.message,
            aiCategory: report.aiCategory,
            aiPriority: report.aiPriority,
            hotsosSent: report.hotsosSent,
            photosCount: report.photosCount,
            firstPhotoUrl: report.firstPhotoUrl,
          });
        }
      });
    }

    history.sort((a, b) => String(b.timeRaw || "").localeCompare(String(a.timeRaw || "")));

    res.json({
      ok: true,
      date,
      unit,
      count: history.length,
      history: history.map((item) => ({
        ...item,
        time: item.timeRaw
          ? new Date(item.timeRaw).toLocaleString("en-US", {
              timeZone: "America/Chicago",
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            })
          : "",
      })),
    });
  } catch (error) {
    console.error("Error en /unit-history:", error.message);
    res.status(500).json({ ok: false, message: error.message, history: [] });
  }
});



// =========================================================
// REAL-TIME INTELLIGENCE ENGINE · FASE 8
// =========================================================
const IntelligenceEngine = createIntelligenceEngine({
  io,
});

console.log(
  "✅ Intelligence Engine iniciado:",
  IntelligenceEngine.version
);

app.get("/api/intelligence/status", async (req, res) => {
  try {
    return res.json(await IntelligenceEngine.status());
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/intelligence", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const fresh =
      String(req.query.fresh || "").toLowerCase() === "true";

    const snapshot = await IntelligenceEngine.get(date, {
      fresh,
    });

    return res.json(snapshot);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.post("/api/intelligence/refresh", async (req, res) => {
  try {
    const date = String(
      req.body?.date || req.query.date || todayISO()
    ).trim();

    const snapshot = await IntelligenceEngine.refresh(
      date,
      "manual-api"
    );

    return res.json(snapshot);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

// =========================================================
// AI OPERATIONS DIRECTOR · FASE 9
// =========================================================
const AIOperationsDirector = createAIOperationsDirector({
  intelligenceEngine: IntelligenceEngine,
  io,
});

console.log(
  "✅ AI Operations Director iniciado:",
  AIOperationsDirector.version
);

app.get("/api/ai-director/status", async (req, res) => {
  try {
    return res.json(await AIOperationsDirector.status());
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/ai-director", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const fresh =
      String(req.query.fresh || "").toLowerCase() === "true";

    const result = await AIOperationsDirector.get(date, {
      fresh,
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.post("/api/ai-director/refresh", async (req, res) => {
  try {
    const date = String(
      req.body?.date || req.query.date || todayISO()
    ).trim();

    const result = await AIOperationsDirector.generate(date, {
      freshIntelligence: true,
      reason: "manual-api",
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

// =========================================================
// MOTOR CENTRAL DE EVENTOS · FASE 7
// =========================================================
const EventEngine = createEventEngine({
  io,
  clearRoomCache,
  clearAssignmentCaches,
  onPublished({ payload }) {
    broadcastOpsUpdate({
      type: "action",
      action: payload.action,
      unit: payload.unit,
      employee: payload.employee,
      message: payload.note || "",
      source: "event-engine",
      eventId: payload.eventId,
    });
  },
  onEventCommitted({ workDate, payload }) {
    IntelligenceEngine.scheduleRefresh(
      workDate,
      `event:${payload.action}`
    );

    AIOperationsDirector.schedule(
      workDate,
      `event:${payload.action}`
    );
  },
});

console.log(
  "✅ Event Engine iniciado:",
  EventEngine.version
);

// =========================================================
// ROOM ENGINE · CONTROL CENTRAL DE ACCIONES DE HABITACIONES
// =========================================================
// Este motor evita que los endpoints conozcan la lógica de cada acción.
// PostgreSQL y EventEngine siguen siendo la fuente operativa inmediata;
// Notion se sincroniza en segundo plano por medio de la cola existente.
const CLEANER_ROOM_ACTIONS = new Set([
  "START",
  "DONE",
  "ISSUE",
  "SUPPLIES",
  "LOST_FOUND",
]);

const INSPECTOR_ROOM_ACTIONS = new Set([
  "INSPECTION_START",
  "READY_GUEST",
  "INSPECTION_REPORT",
  "INSPECTION_SUPPLIES",
  "PRE_INSPECTION_START",
  "PRE_INSPECTION_COMPLETE",
  "LOST_FOUND",
]);

function createOperationalRoomEngine({ eventEngine }) {
  async function publishCleanerAction({
    action,
    unit,
    cleaner,
    note = "",
    photoUrl = "",
    eventId = "",
    requestId = "",
  }) {
    const normalizedAction = String(action || "").trim().toUpperCase();
    const normalizedUnit = String(unit || "").trim();
    const normalizedCleaner = String(cleaner || "").trim();
    const normalizedNote = String(note || "").trim();

    if (!CLEANER_ROOM_ACTIONS.has(normalizedAction)) {
      throw new Error(`Acción de limpieza no soportada: ${normalizedAction || "vacía"}`);
    }

    if (!normalizedUnit || !normalizedCleaner) {
      throw new Error("La unidad y el limpiador son obligatorios");
    }

    if (["ISSUE", "SUPPLIES", "LOST_FOUND"].includes(normalizedAction) && !normalizedNote) {
      throw new Error("Debes escribir una nota");
    }

    return eventEngine.publish({
      eventId,
      requestId,
      action: normalizedAction,
      unit: normalizedUnit,
      employee: normalizedCleaner,
      role: "Cleaner",
      note: normalizedNote,
      photoUrl: String(photoUrl || "").trim(),
    });
  }

  async function publishInspectorAction({
    action,
    unit,
    inspector,
    note = "",
    photoUrl = "",
    eventId = "",
    requestId = "",
  }) {
    const normalizedAction = String(action || "").trim().toUpperCase();
    const normalizedUnit = String(unit || "").trim();
    const normalizedInspector = String(inspector || "").trim();
    const normalizedNote = String(note || "").trim();

    if (!INSPECTOR_ROOM_ACTIONS.has(normalizedAction)) {
      throw new Error(`Acción de inspección no soportada: ${normalizedAction || "vacía"}`);
    }

    if (!normalizedUnit || !normalizedInspector) {
      throw new Error("La unidad y el inspector son obligatorios");
    }

    if (
      ["INSPECTION_REPORT", "INSPECTION_SUPPLIES", "LOST_FOUND"].includes(normalizedAction) &&
      !normalizedNote
    ) {
      throw new Error("Debes escribir una nota");
    }

    return eventEngine.publish({
      eventId,
      requestId,
      action: normalizedAction,
      unit: normalizedUnit,
      employee: normalizedInspector,
      role: "Inspector",
      note: normalizedNote,
      photoUrl: String(photoUrl || "").trim(),
    });
  }

  return {
    version: "1.1.0",
    handleCleanerAction: publishCleanerAction,
    handleInspectorAction: publishInspectorAction,
    startCleaning: (input) => publishCleanerAction({ ...input, action: "START" }),
    finishCleaning: (input) => publishCleanerAction({ ...input, action: "DONE" }),
    reportIssue: (input) => publishCleanerAction({ ...input, action: "ISSUE" }),
    requestSupplies: (input) => publishCleanerAction({ ...input, action: "SUPPLIES" }),
    reportLostAndFound: (input) => publishCleanerAction({ ...input, action: "LOST_FOUND" }),
    startInspection: (input) => publishInspectorAction({ ...input, action: "INSPECTION_START" }),
    finishInspection: (input) => publishInspectorAction({ ...input, action: "READY_GUEST" }),
    reportInspectionIssue: (input) => publishInspectorAction({ ...input, action: "INSPECTION_REPORT" }),
    requestInspectionSupplies: (input) => publishInspectorAction({ ...input, action: "INSPECTION_SUPPLIES" }),
    startPreInspection: (input) => publishInspectorAction({ ...input, action: "PRE_INSPECTION_START" }),
    finishPreInspection: (input) => publishInspectorAction({ ...input, action: "PRE_INSPECTION_COMPLETE" }),
  };
}

const RoomEngine = createOperationalRoomEngine({
  eventEngine: EventEngine,
});

console.log("✅ Room Engine iniciado:", RoomEngine.version);

// =========================================================
// ULTRA PERFORMANCE · NON-BLOCKING BACKGROUND WORK
// =========================================================
function runDetached(label, task) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error(`BACKGROUND ${label} ERROR:`, error.message);
      });
  });
}

function queueLegacyActionFallback({
  action,
  unit,
  name,
  note = "",
  photoUrl = "",
  role = "Cleaner",
}) {
  runDetached(`${role}:${action}:${unit}`, async () => {
    await updateNotionRoom(
      unit,
      action,
      name,
      note,
      role.toLowerCase(),
      photoUrl
    );

    try {
      await insertOperationalEventPostgres({
        action,
        unit,
        employee: name,
        role,
        note,
        photoUrl,
        category: ["ISSUE", "INSPECTION_REPORT", "LOST_FOUND"].includes(action)
          ? "Problem"
          : ["SUPPLIES", "INSPECTION_SUPPLIES"].includes(action)
            ? "Supplies"
            : role === "Inspector"
              ? "Inspection"
              : "Other",
        priority: ["ISSUE", "INSPECTION_REPORT"].includes(action)
          ? "High"
          : "Normal",
        source: "notion-fallback-background",
      });
    } catch (logError) {
      console.error("POSTGRES BACKGROUND FALLBACK LOG ERROR:", logError.message);
    }

    runRoomSync("background-action-fallback", todayISO()).catch((error) => {
      console.error("ROOM SYNC AFTER BACKGROUND FALLBACK ERROR:", error.message);
    });

    broadcastOpsUpdate({
      type: "action",
      action,
      unit,
      employee: name,
      message: note || "",
      source: "notion-fallback-background",
    });
  });
}


app.get("/api/event-engine/status", async (req, res) => {
  try {
    return res.json(await EventEngine.getStatus());
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/event-engine/events", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const limit = Number(req.query.limit || 100);
    const events = await EventEngine.listEvents({ date, limit });

    return res.json({
      ok: true,
      source: "postgres",
      date,
      count: events.length,
      events,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
      events: [],
    });
  }
});

// =========================================================
// OPERACIONES EN VIVO · POSTGRESQL FIRST
// =========================================================
function postgresStatusFromAction(action) {
  if (action === "START") return "In Progress";
  if (action === "DONE") return "Cleaned - Awaiting Inspection";
  if (action === "INSPECTION_START") return "Inspection Started";
  if (action === "READY_GUEST") return "Ready for Guest";
  return "";
}

async function updateOperationalRoomPostgres({
  action,
  unit,
  employee,
  role,
  note = "",
  photoUrl = "",
}) {
  if (!postgresStatus.connected) {
    throw new Error("PostgreSQL no está conectado");
  }

  const workDate = todayISO();
  const normalizedRoom = normalizeRoom(unit);
  const eventTime = new Date().toISOString();

  if (!normalizedRoom) {
    throw new Error(`No pude normalizar la unidad ${unit}`);
  }

  let sql = "";

  if (action === "START") {
    sql = `
      UPDATE rooms
      SET cleaning_status = 'In Progress',
          started_at = COALESCE(started_at, $3::timestamptz),
          finished_at = NULL,
          inspection_started_at = NULL,
          ready_at = NULL,
          source = '417-maid-live',
          updated_at = NOW()
      WHERE work_date = $1::date AND normalized_room = $2
      RETURNING *
    `;
  } else if (action === "DONE") {
    sql = `
      UPDATE rooms
      SET cleaning_status = 'Cleaned - Awaiting Inspection',
          started_at = COALESCE(started_at, $3::timestamptz),
          finished_at = $3::timestamptz,
          inspection_started_at = NULL,
          ready_at = NULL,
          source = '417-maid-live',
          updated_at = NOW()
      WHERE work_date = $1::date AND normalized_room = $2
      RETURNING *
    `;
  } else if (action === "INSPECTION_START") {
    sql = `
      UPDATE rooms
      SET cleaning_status = 'Inspection Started',
          inspection_started_at = COALESCE(inspection_started_at, $3::timestamptz),
          ready_at = NULL,
          source = '417-maid-live',
          updated_at = NOW()
      WHERE work_date = $1::date AND normalized_room = $2
      RETURNING *
    `;
  } else if (action === "READY_GUEST") {
    sql = `
      UPDATE rooms
      SET cleaning_status = 'Ready for Guest',
          inspection_started_at = COALESCE(inspection_started_at, $3::timestamptz),
          ready_at = $3::timestamptz,
          source = '417-maid-live',
          updated_at = NOW()
      WHERE work_date = $1::date AND normalized_room = $2
      RETURNING *
    `;
  } else {
    return { updated: false, status: "" };
  }

  const result = await postgresQuery(sql, [workDate, normalizedRoom, eventTime]);

  if (!result.rows.length) {
    throw new Error(`La unidad ${unit} no existe en PostgreSQL para ${workDate}`);
  }

  const room = result.rows[0];
  const status = postgresStatusFromAction(action);
  const externalEventId = `live:${workDate}:${normalizedRoom}:${action}:${Date.now()}`;

  await postgresQuery(
    `
      INSERT INTO operations_logs (
        external_event_id, work_date, event_time, unit, normalized_room,
        action, cleaner, inspector, employee, role_worked, note,
        photo_url, category, priority, source, raw_data
      )
      VALUES (
        $1, $2::date, $3::timestamptz, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, 'Other', 'Normal', '417-maid-live', $13::jsonb
      )
      ON CONFLICT (external_event_id) DO NOTHING
    `,
    [
      externalEventId,
      workDate,
      eventTime,
      room.room_number || unit,
      normalizedRoom,
      action,
      String(role).toLowerCase().includes("cleaner") ? employee : "",
      String(role).toLowerCase().includes("inspector") ? employee : "",
      employee,
      role,
      note || "",
      photoUrl || "",
      JSON.stringify({ roomId: room.id, source: "postgres-first" }),
    ]
  );

  clearRoomCache(workDate);
  clearAssignmentCaches(workDate);

  const payload = {
    module: "rooms",
    date: workDate,
    reason: "operational-action",
    action,
    unit: room.room_number || unit,
    normalizedRoom,
    status,
    employee,
    role,
    startedAt: room.started_at || null,
    finishedAt: room.finished_at || null,
    inspectionStartedAt: room.inspection_started_at || null,
    readyAt: room.ready_at || null,
    updatedAt: new Date().toISOString(),
    source: "postgres",
  };

  io.emit("room-updated", payload);
  io.emit("rooms-updated", payload);
  io.emit("assignments-updated", payload);
  io.emit("data-api-updated", payload);

  return { updated: true, status, room, payload };
}


async function insertOperationalEventPostgres({
  action,
  unit,
  employee = "",
  role = "",
  note = "",
  photoUrl = "",
  category = "Other",
  priority = "Normal",
  source = "417-maid-live",
  externalEventId = "",
}) {
  const workDate = todayISO();
  const normalizedRoom = normalizeRoom(unit);
  const eventTime = new Date().toISOString();
  const normalizedRole = String(role || "").toLowerCase();

  const result = await postgresQuery(
    `
      INSERT INTO operations_logs (
        external_event_id,
        work_date,
        event_time,
        unit,
        normalized_room,
        action,
        cleaner,
        inspector,
        employee,
        role_worked,
        note,
        photo_url,
        category,
        priority,
        source,
        raw_data
      )
      VALUES (
        NULLIF($1, ''),
        $2::date,
        $3::timestamptz,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16::jsonb
      )
      ON CONFLICT (external_event_id)
      WHERE external_event_id IS NOT NULL
        AND external_event_id <> ''
      DO NOTHING
      RETURNING *
    `,
    [
      externalEventId ||
        `ops:${workDate}:${normalizedRoom}:${action}:${Date.now()}`,
      workDate,
      eventTime,
      unit || "",
      normalizedRoom,
      action || "UPDATE",
      normalizedRole.includes("cleaner") ? employee : "",
      normalizedRole.includes("inspector") ? employee : "",
      employee || "",
      role || "",
      note || "",
      photoUrl || "",
      category || "Other",
      priority || "Normal",
      source || "417-maid-live",
      JSON.stringify({
        source,
        capturedBy: "operations-postgres-first",
      }),
    ]
  );

  const event = result.rows[0] || null;

  if (event) {
    io.emit("operations-log-created", {
      id: event.id,
      date: event.work_date,
      eventTime: event.event_time,
      unit: event.unit,
      normalizedRoom: event.normalized_room,
      action: event.action,
      employee: event.employee,
      person: event.employee,
      role: event.role_worked,
      note: event.note,
      photoUrl: event.photo_url,
      category: event.category,
      priority: event.priority,
      source: "postgres",
    });
  }

  return event;
}

function syncOperationalActionToNotionInBackground({
  action,
  unit,
  note,
  name,
  role,
  photoUrl,
}) {
  const dedupeKey = [
    "notion-room-action",
    todayISO(),
    normalizeRoom(unit),
    action,
    cleanEmployeeText(name),
    Date.now(),
  ].join(":");

  enqueueSyncJob({
    jobType: "notion-room-action",
    destination: "notion",
    dedupeKey,
    priority: action === "READY_GUEST" ? 10 : 50,
    payload: {
      action,
      unit,
      note: note || "",
      name,
      role,
      photoUrl: photoUrl || "",
      queuedAt: new Date().toISOString(),
    },
  })
    .then((job) => {
      console.log("📥 Acción guardada en sync_queue:", {
        id: job.id,
        action,
        unit,
        employee: name,
      });

      io.emit("notion-action-queued", {
        ok: true,
        queueId: job.id,
        action,
        unit,
        employee: name,
        updatedAt: new Date().toISOString(),
      });
    })
    .catch((error) => {
      console.error("🔴 No se pudo guardar en sync_queue:", error.message);

      addNotification(
        "🔴 No se pudo crear trabajo de sincronización",
        `${action} · ${unit} · ${name}: ${error.message}`
      );
    });
}

app.post("/action", async (req, res) => {
  try {
    const { action, unit, note, name, photoUrl, eventId, requestId } = req.body;

    if (!action || !unit || !name) {
      return res.status(400).json({
        success: false,
        message: "Faltan datos: nombre, unidad o acción",
      });
    }

    if (["ISSUE", "SUPPLIES", "LOST_FOUND"].includes(action) && !String(note || "").trim()) {
      return res.status(400).json({ success: false, message: "Debes escribir una nota" });
    }

    try {
      const eventResult = await RoomEngine.handleCleanerAction({
        eventId,
        requestId,
        action,
        unit,
        cleaner: name,
        note,
        photoUrl,
      });

      if (action === "DONE") {
        runDetached(`notify-inspectors:${unit}`, () => notifyInspectors(unit));
      }

      return res.json({
        success: true,
        source: "postgres",
        eventId: eventResult?.eventId || "",
        duplicate: Boolean(eventResult?.duplicate),
        postgresUpdated: true,
        notionSync: "queued",
        payroll: eventResult?.payroll || null,
        status: eventResult?.status || notionStatusFromAction(action) || "",
        message: `Enviado correctamente: ${actionLabel(action)} - ${unit}`,
      });
    } catch (postgresError) {
      console.error("⚠️ Event Engine cleaner falló; fallback en background:", postgresError.message);

      if (isDuplicateAction(action, unit, name)) {
        return res.status(400).json({
          success: false,
          message: "Acción ya registrada recientemente",
        });
      }

      queueLegacyActionFallback({ action, unit, name, note, photoUrl, role: "Cleaner" });

      return res.status(202).json({
        success: true,
        accepted: true,
        source: "background-fallback",
        eventId: eventId || requestId || "",
        duplicate: false,
        postgresUpdated: false,
        notionSync: "processing",
        status: notionStatusFromAction(action) || "",
        message: `Acción recibida y procesándose: ${actionLabel(action)} - ${unit}`,
      });
    }
  } catch (error) {
    console.error("Error en /action:", error.message);
    return res.status(503).json({ success: false, retryable:true, message: "Estamos sincronizando. Intenta nuevamente en unos segundos." });
  }
});


// =========================================================
// OPERATIONS INTELLIGENCE · QUALITY CORE v1
// =========================================================
app.post("/api/intelligence/quality/refresh", async (req, res) => {
  try {
    const date = String(req.body?.date || req.query.date || todayISO()).trim();
    const result = await QualityEngine.refreshDate(date);
    io.emit("quality:intelligence-refreshed", result);
    return res.json(result);
  } catch (error) {
    console.error("Quality intelligence refresh error:", error.message);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/intelligence/quality/cleaners", async (req, res) => {
  try {
    const to = String(req.query.to || todayISO()).trim();
    const from = String(req.query.from || dayjs(to).subtract(29, "day").format("YYYY-MM-DD")).trim();
    let cleaners = await QualityEngine.cleanerLeaderboard({ from, to });
    let autoRefresh = null;

    // Para consultas de un solo día, genera las métricas automáticamente si aún no existen.
    // Esto evita devolver una lista vacía solo porque nadie ejecutó previamente el POST /refresh.
    if (!cleaners.length && from === to) {
      autoRefresh = await QualityEngine.refreshDate(to);
      cleaners = await QualityEngine.cleanerLeaderboard({ from, to });
    }

    return res.json({ ok: true, from, to, cleaners, autoRefresh });
  } catch (error) {
    console.error("Quality cleaners leaderboard error:", error.message);
    return res.status(500).json({ ok: false, message: error.message, cleaners: [] });
  }
});

app.get("/api/intelligence/quality/summary", async (req, res) => {
  try {
    const to = String(req.query.to || todayISO()).trim();
    const from = String(req.query.from || to).trim();
    const summary = await QualityEngine.qualitySummary({ from, to });
    return res.json({ ok: true, from, to, summary });
  } catch (error) {
    console.error("Quality summary error:", error.message);
    return res.status(500).json({ ok: false, message: error.message, summary: {} });
  }
});

app.get("/api/intelligence/quality/rooms", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    let result = await postgresQuery(
      `SELECT * FROM room_metrics WHERE work_date=$1::date ORDER BY overall_score ASC, room_number`,
      [date]
    );
    let autoRefresh = null;

    if (!result.rows.length) {
      autoRefresh = await QualityEngine.refreshDate(date);
      result = await postgresQuery(
        `SELECT * FROM room_metrics WHERE work_date=$1::date ORDER BY overall_score ASC, room_number`,
        [date]
      );
    }

    return res.json({ ok: true, date, rooms: result.rows, autoRefresh });
  } catch (error) {
    console.error("Quality room metrics error:", error.message);
    return res.status(500).json({ ok: false, message: error.message, rooms: [] });
  }
});

// =========================================================
// STILL WATERS QUALITY GAME
// =========================================================
app.get("/api/quality/rooms", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO());
    const result = await postgresQuery(
      `SELECT r.id, r.room_number AS unit, r.normalized_room, r.room_type,
              r.building, r.cleaning_status AS status, r.assigned_cleaner AS cleaner,
              r.assigned_inspector AS inspector, r.urgent, r.arrival,
              qr.overall_score, qr.status AS quality_status, qr.scores,
              qr.issues, qr.notes, qr.updated_at AS quality_updated_at
       FROM rooms r
       LEFT JOIN quality_reviews qr
         ON qr.work_date = r.work_date
        AND qr.normalized_room = r.normalized_room
       WHERE r.work_date = $1::date
       ORDER BY r.building, r.room_number`,
      [date]
    );
    res.json({ ok: true, date, units: result.rows });
  } catch (error) {
    console.error("Quality rooms error:", error.message);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/quality/reviews", async (req, res) => {
  try {
    const { unit, inspector, cleaner, scores = {}, issues = [], notes = "", status = "in_progress" } = req.body || {};
    if (!unit || !inspector) {
      return res.status(400).json({ ok: false, message: "Unidad e inspector son obligatorios" });
    }
    const allowedAreas = ["bathrooms", "beds", "carpets", "kitchen", "living", "amenities", "presentation"];
    const cleanScores = {};
    for (const area of allowedAreas) {
      const value = Number(scores[area] || 0);
      cleanScores[area] = Math.max(0, Math.min(5, Number.isFinite(value) ? value : 0));
    }
    const completed = Object.values(cleanScores).filter(v => v > 0);
    const overallScore = completed.length
      ? Math.round((completed.reduce((sum, value) => sum + value, 0) / (completed.length * 5)) * 100)
      : 0;
    const normalizedRoom = normalizeRoom(unit);
    const date = todayISO();
    const finalStatus = ["approved", "correction_required", "in_progress"].includes(status) ? status : "in_progress";
    const result = await postgresQuery(
      `INSERT INTO quality_reviews (
         work_date, room_id, unit, normalized_room, cleaner, inspector,
         overall_score, status, scores, issues, notes, completed_at, updated_at
       ) VALUES (
         $1::date,
         (SELECT id FROM rooms WHERE work_date = $1::date AND normalized_room = $2 LIMIT 1),
         $3, $2, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
         CASE WHEN $7 IN ('approved','correction_required') THEN NOW() ELSE NULL END,
         NOW()
       )
       ON CONFLICT (work_date, normalized_room, inspector)
       DO UPDATE SET cleaner = EXCLUDED.cleaner, overall_score = EXCLUDED.overall_score,
         status = EXCLUDED.status, scores = EXCLUDED.scores, issues = EXCLUDED.issues,
         notes = EXCLUDED.notes, completed_at = EXCLUDED.completed_at, updated_at = NOW()
       RETURNING *`,
      [date, normalizedRoom, String(unit), String(cleaner || ""), String(inspector), overallScore,
       finalStatus, JSON.stringify(cleanScores), JSON.stringify(Array.isArray(issues) ? issues : []), String(notes || "")]
    );
    const review = result.rows[0];
    io.emit("quality:updated", { unit, inspector, overallScore, status: finalStatus, updatedAt: new Date().toISOString() });

    QualityEngine.refreshRoomMetric({ date, normalizedRoom })
      .then(() => QualityEngine.refreshEmployeeMetrics(date))
      .then(() => io.emit("quality:intelligence-refreshed", { date, unit, cleaner }))
      .catch((qualityError) => console.error("Quality intelligence background error:", qualityError.message));

    res.json({ ok: true, review });
  } catch (error) {
    console.error("Quality review error:", error.message);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/quality/leaderboard", async (req, res) => {
  try {
    const dateFrom = String(req.query.from || dayjs().subtract(30, "day").format("YYYY-MM-DD"));
    const result = await postgresQuery(
      `SELECT cleaner, COUNT(*)::int AS inspected,
              ROUND(AVG(overall_score))::int AS average_score,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE status = 'correction_required')::int AS corrections
       FROM quality_reviews
       WHERE work_date >= $1::date AND cleaner <> '' AND status <> 'in_progress'
       GROUP BY cleaner
       ORDER BY average_score DESC, inspected DESC`, [dateFrom]
    );
    res.json({ ok: true, from: dateFrom, cleaners: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/inspector-action", async (req, res) => {
  try {
    const { action, unit, note, name, photoUrl, eventId, requestId } = req.body;

    if (!action || !unit || !name) {
      return res.status(400).json({
        success: false,
        message: "Faltan datos: inspector, unidad o acción",
      });
    }

    if (["INSPECTION_REPORT", "INSPECTION_SUPPLIES", "LOST_FOUND"].includes(action) && !String(note || "").trim()) {
      return res.status(400).json({ success: false, message: "Debes escribir una nota" });
    }

    try {
      const eventResult = await RoomEngine.handleInspectorAction({
        eventId,
        requestId,
        action,
        unit,
        inspector: name,
        note,
        photoUrl,
      });

      return res.json({
        success: true,
        source: "postgres",
        eventId: eventResult?.eventId || "",
        duplicate: Boolean(eventResult?.duplicate),
        postgresUpdated: true,
        notionSync: "queued",
        status: eventResult?.status || notionStatusFromAction(action) || "",
        message: `Inspector: ${actionLabel(action)} - ${unit}`,
      });
    } catch (postgresError) {
      console.error("⚠️ Event Engine inspector falló; fallback en background:", postgresError.message);

      if (isDuplicateAction(action, unit, name)) {
        return res.status(400).json({
          success: false,
          message: "Acción ya registrada recientemente",
        });
      }

      queueLegacyActionFallback({ action, unit, name, note, photoUrl, role: "Inspector" });

      return res.status(202).json({
        success: true,
        accepted: true,
        source: "background-fallback",
        eventId: eventId || requestId || "",
        duplicate: false,
        postgresUpdated: false,
        notionSync: "processing",
        status: notionStatusFromAction(action) || "",
        message: `Inspector: acción recibida y procesándose - ${unit}`,
      });
    }
  } catch (error) {
    console.error("Error inspector:", error.message);
    return res.status(503).json({ success: false, retryable:true, message: "Estamos sincronizando. Intenta nuevamente en unos segundos." });
  }
});

app.get("/operations-events", async (req, res) => {
  try {
    if (!NOTION_LOG_DATABASE_ID) {
      return res.json({
        count: 0,
        events: [],
      });
    }

    const response = await notion.databases.query({
      database_id: NOTION_LOG_DATABASE_ID,
      page_size: 20,
      sorts: [
        {
          property: "Time",
          direction: "descending",
        },
      ],
    });

    const events = response.results.map((page) => {
      const props = page.properties;

      return {
        id: page.id,

        time:
          props.Time?.date?.start
            ? new Date(props.Time.date.start).toLocaleString("en-US", {
                timeZone: "America/Chicago",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
              })
            : "",

        unit:
          props.Unit?.rich_text
            ?.map((t) => t.plain_text)
            .join("") || "",

        action:
          props.Action?.select?.name || "",

        person:
          props.Cleaner?.rich_text
            ?.map((t) => t.plain_text)
            .join("") ||
          props.Inspector?.rich_text
            ?.map((t) => t.plain_text)
            .join("") ||
          "",

        note:
          props.Note?.rich_text
            ?.map((t) => t.plain_text)
            .join("") || "",
        
        photoUrl:
          props["Photo URL"]?.url || "",
      };
    });

    res.json({
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("Error en /operations-events:", error.message);

    res.status(500).json({
      count: 0,
      events: [],
      error: error.message,
    });
  }
});

app.post("/generate-daily-report", async (req, res) => {
  try {
    const date = req.body.date || todayISO();

    const report = await generateDailyReport(date);

    res.json({
      ok: true,
      message: "Daily report generated successfully",
      date,
      totalRecords: report.totalRecords,
      file: report.fileName,
      url: report.fileUrl,
      fullUrl: `${req.protocol}://${req.get("host")}${report.fileUrl}`,
    });
  } catch (error) {
    console.error("Error generating daily report:", error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/generate-daily-report", async (req, res) => {
  try {
    const date = req.query.date || todayISO();

    const report = await generateDailyReport(date);

    res.redirect(report.fileUrl);
  } catch (error) {
    console.error("Error generating daily report:", error.message);
    res.status(500).send(`Error generating report: ${error.message}`);
  }
});

app.get("/finalizar-dia", async (req, res) => {
  try {
    const date = req.query.date || todayISO();

    const report = await generateDailyReport(date);

    const filePath = path.join(reportsDir, report.fileName);

    setTimeout(() => {
      res.download(filePath, report.fileName);
    }, 1500);
  } catch (error) {
    console.error("Error finalizando día:", error.message);
    res.status(500).send(`Error finalizando día: ${error.message}`);
  }
});


// =========================================================
// FIREBASE PUSH · REGISTRO DE DISPOSITIVOS
// =========================================================
app.get("/api/push/config", (req, res) => {
  const publicKey = String(process.env.WEB_PUSH_PUBLIC_KEY || "").trim();
  if (!publicKey) {
    return res.status(503).json({ ok:false, message:"Falta WEB_PUSH_PUBLIC_KEY en Render" });
  }
  return res.json({ ok:true, publicKey });
});

app.post("/api/push/register", async (req, res) => {
  try {
    if (!postgresStatus.connected) return res.status(503).json({ ok:false, message:"PostgreSQL no está conectado" });
    const result = await registerPushToken(postgresQuery, {
      employeeName: req.body.employeeName,
      employeeRole: req.body.employeeRole,
      subscription: req.body.subscription,
      platform: req.body.platform || "web-push",
      userAgent: req.get("user-agent") || "",
    });
    res.json({ ok:true, ...result });
  } catch (error) {
    console.error("PUSH REGISTER ERROR:", error.message);
    res.status(400).json({ ok:false, message:error.message });
  }
});

app.post("/api/push/test", async (req, res) => {
  try {
    const employeeName = String(req.body.employeeName || "").trim();
    if (!employeeName) return res.status(400).json({ ok:false, message:"Falta employeeName" });
    const result = await sendPushToEmployees(postgresQuery, [employeeName], {
      title: "🔔 Care OS",
      body: "Las notificaciones funcionan correctamente en este teléfono.",
      link: "/launch",
      tag: `push-test-${Date.now()}`,
      data: { type:"TEST" },
    });
    if (Number(result.sent || 0) < 1) {
      return res.status(503).json({ ok:false, message:"No hay una suscripción activa para este empleado", ...result });
    }
    return res.json({ ok:true, ...result });
  } catch (error) {
    console.error("PUSH TEST ERROR:", error.message);
    return res.status(500).json({ ok:false, message:"No se pudo enviar la prueba" });
  }
});

app.post("/api/push/unregister", async (req, res) => {
  try {
    await deactivatePushToken(postgresQuery, String(req.body.endpoint || ""));
    res.json({ ok:true });
  } catch (error) {
    res.status(400).json({ ok:false, message:error.message });
  }
});

// =========================================================
// NOTIFICACIONES DIRIGIDAS Y GUEST OUT DESDE HOTSOS
// =========================================================
const employeeNotifications = new Map();

function notificationEmployeeKey(name) {
  return cleanEmployeeText(name || "");
}

function saveEmployeeNotification(employee, payload) {
  const key = notificationEmployeeKey(employee);
  if (!key) return null;

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    employee: normalizeCleaner(employee),
    createdAt: new Date().toISOString(),
    read: false,
    ...payload,
  };

  const current = employeeNotifications.get(key) || [];
  current.unshift(item);
  employeeNotifications.set(key, current.slice(0, 100));

  io.emit("employee-notification", item);
  return item;
}

function notifyAssignedCleaners(cleanerText, payload) {
  return splitCleanerNames(cleanerText).map((employee) =>
    saveEmployeeNotification(employee, payload)
  ).filter(Boolean);
}

app.get("/api/employee-notifications", (req, res) => {
  const employee = String(req.query.employee || "").trim();
  const key = notificationEmployeeKey(employee);

  if (!key) {
    return res.status(400).json({ ok: false, message: "Empleado requerido" });
  }

  return res.json({
    ok: true,
    employee,
    notifications: employeeNotifications.get(key) || [],
  });
});

app.post("/api/employee-notifications/read", (req, res) => {
  const employee = String(req.body.employee || "").trim();
  const notificationId = String(req.body.notificationId || "").trim();
  const key = notificationEmployeeKey(employee);
  const items = employeeNotifications.get(key) || [];

  items.forEach((item) => {
    if (!notificationId || item.id === notificationId) item.read = true;
  });

  employeeNotifications.set(key, items);
  res.json({ ok: true });
});

async function applyGuestOutFromHotSOS(unit, source = "HotSOS") {
  const cleanUnit = String(unit || "").trim();
  if (!cleanUnit) throw new Error("Unidad requerida");

  const pages = await queryTodayRooms(true);
  const normalizedTarget = normalizeRoom(cleanUnit);
  const digits = roomDigits(cleanUnit);
  const page = pages.find((item) => normalizeRoom(getRoomTitleFromPage(item)) === normalizedTarget)
    || pages.find((item) => roomDigits(getRoomTitleFromPage(item)) === digits);

  if (!page) throw new Error(`No encontré la unidad ${cleanUnit} para hoy`);

  const flags = getRoomOpsFlags(page);
  const fullUnit = getRoomTitleFromPage(page) || cleanUnit;
  const assignedCleaner = getAssignedCleaner(page);

  if (!flags.guestOut) {
    await updateNotionRoom(fullUnit, "GUEST_OUT", source, "Guest Out recibido desde HotSOS", "system");
  }

  const notifications = notifyAssignedCleaners(assignedCleaner, {
    type: "GUEST_OUT",
    title: "🚪 Guest Out",
    message: `La unidad ${fullUnit} ya está disponible para comenzar.`,
    unit: fullUnit,
    urgent: false,
    source,
  });

  broadcastAssignmentUpdate("hotsos-guest-out", { unit: fullUnit, assignedCleaner });
  broadcastOpsUpdate({
    type: "guest-out",
    action: "GUEST_OUT",
    unit: fullUnit,
    employee: source,
    message: "Guest Out recibido desde HotSOS",
  });

  return {
    unit: fullUnit,
    assignedCleaner,
    alreadyGuestOut: flags.guestOut,
    notifications: notifications.length,
  };
}

app.post("/api/hotsos/guest-out", async (req, res) => {
  try {
    const configuredSecret = String(process.env.HOTSOS_WEBHOOK_SECRET || "").trim();
    const receivedSecret = String(req.get("x-hotsos-secret") || req.body.secret || "").trim();

    if (configuredSecret && receivedSecret !== configuredSecret) {
      return res.status(401).json({ ok: false, message: "HotSOS secret inválido" });
    }

    const units = Array.isArray(req.body.units)
      ? req.body.units
      : [req.body.unit || req.body.room || req.body.jobSiteName];

    const results = [];
    const errors = [];

    for (const unit of units.filter(Boolean)) {
      try {
        results.push(await applyGuestOutFromHotSOS(unit));
      } catch (error) {
        errors.push({ unit, error: error.message });
      }
    }

    return res.status(errors.length && !results.length ? 400 : 200).json({
      ok: results.length > 0,
      results,
      errors,
    });
  } catch (error) {
    console.error("HotSOS Guest Out error:", error.message);
    return res.status(500).json({ ok: false, message: error.message });
  }
});


// =========================================================
// PAYROLL 2.0 · TARIFAS, AJUSTES, BLOQUEO Y AUDITORÍA
// =========================================================
app.post("/api/payroll/manual-entry", async (req, res) => {
  try {
    if (!postgresStatus.connected) {
      return res.status(503).json({ ok: false, message: "PostgreSQL no está conectado." });
    }
    const record = await createManualPayrollEntry({
      employee: req.body.employee,
      workDate: req.body.date,
      kind: req.body.kind,
      unit: req.body.unit,
      amount: req.body.amount,
      reason: req.body.reason,
      changedBy: req.body.changedBy || "Admin",
    });
    io.emit("payroll-record-updated", record);
    return res.status(201).json({ ok: true, record });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }
});

app.delete("/api/payroll/manual-entry/:id", async (req, res) => {
  try {
    if (!postgresStatus.connected) {
      return res.status(503).json({ ok: false, message: "PostgreSQL no está conectado." });
    }
    const record = await deleteManualPayrollEntry({
      recordId: Number(req.params.id),
      changedBy: req.body?.changedBy || "Admin",
    });
    io.emit("payroll-record-updated", record);
    return res.json({ ok: true, record });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }
});

app.get("/api/payroll/week", async (req, res) => {
  try {
    const currentWeek = getPayrollWeek(new Date());
    const weekStart = String(req.query.start || currentWeek.weekStart).trim();
    const weekEnd = String(req.query.end || currentWeek.weekEnd).trim();
    validatePayrollRange(weekStart, weekEnd);
    const [week, validation] = await Promise.all([
      getPayrollWeekState(weekStart, weekEnd),
      validatePayrollWeek(weekStart, weekEnd),
    ]);
    res.json({ ok: true, weekStart, weekEnd, status: week?.status || "open", week, validation });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/payroll/rates", async (req, res) => {
  try {
    const rates = await listPayrollRates({ includeInactive: req.query.all === "true" });
    res.json({ ok: true, rates });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/payroll/rates", async (req, res) => {
  try {
    const result = await savePayrollRate({
      propertyName: req.body.propertyName,
      roomType: req.body.roomType,
      amount: req.body.amount,
      effectiveFrom: req.body.effectiveFrom,
      changedBy: req.body.changedBy || "Admin",
      reason: req.body.reason || "Rate updated from Payroll 2.0",
      weekStart: req.body.weekStart || "",
      weekEnd: req.body.weekEnd || "",
      applyToWeek: Boolean(req.body.applyToWeek),
    });
    io.emit("payroll-rates-updated", result);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.patch("/api/payroll/records/:id", async (req, res) => {
  try {
    const record = await updatePayrollRecordAmount({
      recordId: Number(req.params.id),
      amount: req.body.amount,
      reason: req.body.reason,
      changedBy: req.body.changedBy || "Admin",
    });
    io.emit("payroll-record-updated", record);
    res.json({ ok: true, record });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post("/api/payroll/records/:id/reset", async (req, res) => {
  try {
    const record = await resetPayrollRecordAmount({
      recordId: Number(req.params.id),
      reason: req.body.reason,
      changedBy: req.body.changedBy || "Admin",
    });
    io.emit("payroll-record-updated", record);
    res.json({ ok: true, record });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post("/api/payroll/week/close", async (req, res) => {
  try {
    const weekStart = String(req.body.start || "").trim();
    const weekEnd = String(req.body.end || "").trim();
    validatePayrollRange(weekStart, weekEnd);
    const week = await closePayrollWeek({
      weekStart,
      weekEnd,
      changedBy: req.body.changedBy || "Admin",
      reason: req.body.reason || "Payroll reviewed and approved",
    });
    io.emit("payroll-week-closed", week);
    res.json({ ok: true, week });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post("/api/payroll/week/reopen", async (req, res) => {
  try {
    const weekStart = String(req.body.start || "").trim();
    const weekEnd = String(req.body.end || "").trim();
    validatePayrollRange(weekStart, weekEnd);
    const week = await reopenPayrollWeek({
      weekStart,
      weekEnd,
      changedBy: req.body.changedBy || "Admin",
      reason: req.body.reason,
    });
    io.emit("payroll-week-reopened", week);
    res.json({ ok: true, week });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get("/api/payroll/audit", async (req, res) => {
  try {
    const currentWeek = getPayrollWeek(new Date());
    const weekStart = String(req.query.start || currentWeek.weekStart).trim();
    const weekEnd = String(req.query.end || currentWeek.weekEnd).trim();
    const audit = await listPayrollAudit(weekStart, weekEnd, req.query.limit || 100);
    res.json({ ok: true, weekStart, weekEnd, audit });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/room-alert", async (req, res) => {
  try {
    const unit = String(req.body.unit || "").trim();
    const type = String(req.body.type || "URGENT").toUpperCase();
    const message = String(req.body.message || "").trim();
    const pages = await queryTodayRooms();
    const page = pages.find((item) => normalizeRoom(getRoomTitleFromPage(item)) === normalizeRoom(unit));

    if (!page) return res.status(404).json({ ok: false, message: "Unidad no encontrada" });

    const fullUnit = getRoomTitleFromPage(page) || unit;
    const assignedCleaner = getAssignedCleaner(page);
    const urgent = type === "URGENT";
    const notifications = notifyAssignedCleaners(assignedCleaner, {
      type,
      title: urgent ? "🚨 Unidad urgente" : "🔔 Actualización de unidad",
      message: message || (urgent
        ? `La unidad ${fullUnit} debe atenderse primero.`
        : `Hay una actualización para la unidad ${fullUnit}.`),
      unit: fullUnit,
      urgent,
      source: "Dispatch",
    });

    broadcastOpsUpdate({
      type: urgent ? "urgent" : "room-alert",
      action: type,
      unit: fullUnit,
      employee: "Dispatch",
      message: message || "Alerta enviada al limpiador asignado",
    });

    res.json({ ok: true, assignedCleaner, notifications: notifications.length });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/payroll-preview", async (req, res) => {
  try {
    const weekStart = String(req.query.start || "").trim();
    const weekEnd = String(req.query.end || "").trim();
    validatePayrollRange(weekStart, weekEnd);

    const requestedSource = String(req.query.source || "auto").trim().toLowerCase();
    const [payrollRead, hourlyRecords] = await Promise.all([
      getPayrollRecordsWithSource(weekStart, weekEnd, {
        source: requestedSource,
        allowFallback: requestedSource === "auto",
      }),
      getHourlyPayrollRecords(weekStart, weekEnd),
    ]);
    const records = payrollRead.records;

    const employees = new Map();
    const warnings = [];

    const ensure = (name) => {
      const employee = normalizeCleaner(name || "Unknown");
      const key = cleanEmployeeText(employee);
      if (!employees.has(key)) employees.set(key, {
        employee,
        units: 0,
        cleaningPay: 0,
        hours: 0,
        hourlyPay: 0,
        roles: new Set(),
      });
      return employees.get(key);
    };

    records.forEach((record) => {
      const person = ensure(record.cleaner);
      if (String(record.payType || "unit").toLowerCase() === "unit") person.units += 1;
      person.cleaningPay += Number(record.amount || 0);
      person.roles.add("Cleaner");
      if (String(record.payType || "unit").toLowerCase() === "unit" &&
          (!record.roomType || Number(record.amount || 0) <= 0)) {
        warnings.push(`${record.unit || "Unidad desconocida"}: tarifa o tipo inválido`);
      }
    });

    hourlyRecords.forEach((record) => {
      const person = ensure(record.employee);
      person.hours += Number(record.hours || 0);
      person.hourlyPay += Number(record.total || 0);
      if (record.role) person.roles.add(record.role);
      if (!record.clockOut) warnings.push(`${record.employee}: falta Clock Out`);
    });

    const people = [...employees.values()].map((person) => ({
      employee: person.employee,
      units: person.units,
      cleaningPay: roundMoney(person.cleaningPay),
      hours: roundMoney(person.hours),
      hourlyPay: roundMoney(person.hourlyPay),
      total: roundMoney(person.cleaningPay + person.hourlyPay),
      roles: [...person.roles],
    })).sort((a, b) => a.employee.localeCompare(b.employee));

    res.json({
      ok: true,
      weekStart,
      weekEnd,
      requestedSource: payrollRead.requestedSource,
      source: payrollRead.source,
      fallback: payrollRead.fallback,
      fallbackReason: payrollRead.fallbackReason || "",
      totals: {
        employees: people.length,
        units: records.filter((record) => String(record.payType || "unit").toLowerCase() === "unit").length,
        hourlyEntries: hourlyRecords.length,
        amount: roundMoney(people.reduce((sum, person) => sum + person.total, 0)),
      },
      people,
      warnings: [...new Set(warnings)],
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post("/generate-payroll-excel", async (req, res) => {
  try {
    const requestedStart = String(req.body.start || "").trim();
    const requestedEnd = String(req.body.end || "").trim();

    let weekStart;
    let weekEnd;

    if (requestedStart && requestedEnd) {
      weekStart = requestedStart;
      weekEnd = requestedEnd;
    } else {
      const selectedDate = req.body.date || todayISO();
      const week = getPayrollWeek(new Date(`${selectedDate}T12:00:00`));
      weekStart = week.weekStart;
      weekEnd = week.weekEnd;
    }

    validatePayrollRange(weekStart, weekEnd);
    const payroll = await generateWeeklyPayrollExcel(weekStart, weekEnd);

    res.json({
      ok: true,
      message: "Payroll Excel updated successfully",
      weekStart,
      weekEnd,
      totalRecords: payroll.totalRecords,
      payrollSource: payroll.payrollSource,
      payrollFallback: payroll.payrollFallback,
      payrollFallbackReason: payroll.payrollFallbackReason,
      file: payroll.fileName,
      url: payroll.fileUrl,
      fullUrl: `${req.protocol}://${req.get("host")}${payroll.fileUrl}`,
    });
  } catch (error) {
    console.error("Error generating payroll Excel:", error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/payroll-excel", async (req, res) => {
  try {
    const requestedStart = String(req.query.start || "").trim();
    const requestedEnd = String(req.query.end || "").trim();

    let weekStart;
    let weekEnd;

    if (requestedStart && requestedEnd) {
      weekStart = requestedStart;
      weekEnd = requestedEnd;
    } else {
      const selectedDate = req.query.date || todayISO();
      const week = getPayrollWeek(new Date(`${selectedDate}T12:00:00`));
      weekStart = week.weekStart;
      weekEnd = week.weekEnd;
    }

    validatePayrollRange(weekStart, weekEnd);
    const payroll = await generateWeeklyPayrollExcel(weekStart, weekEnd);

    res.download(payroll.filePath, payroll.fileName);
  } catch (error) {
    console.error("Error descargando Payroll Excel:", error.message);
    res.status(500).send(`Error descargando Payroll Excel: ${error.message}`);
  }
});
app.get("/backfill-payroll", async (req, res) => {
  try {
    const start = req.query.start || "2026-06-15";
    const end = req.query.end || todayISO();

    let pages = [];
    let cursor = undefined;

    do {
      const body = {
        page_size: 100,
        query: "",
        filter: {
          property: "object",
          value: "page",
        },
      };

      if (cursor) body.start_cursor = cursor;

      const response = await notionFetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_API_VERSION,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        console.log("NOTION BACKFILL SEARCH ERROR:", data);
        throw new Error(data.message || "Error buscando páginas en Notion");
      }

      const filtered = (data.results || []).filter((page) => {
        const props = page.properties || {};

        const date = props.Date?.date?.start || "";
        const unit =
          props["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";

        const cleaner =
          props["Assigned Cleaner"]?.select?.name ||
          props["Assigned Cleaner"]?.rich_text?.map((t) => t.plain_text).join("") ||
          "";

        return date >= start && date <= end && unit && cleaner;
      });

      pages = pages.concat(filtered);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    let created = 0;
    let skipped = 0;
    let errors = [];

    for (const page of pages) {
      const props = page.properties;

      const date = props.Date?.date?.start || "";

      const unit =
        props["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";

      const cleaner =
        props["Assigned Cleaner"]?.select?.name ||
        props["Assigned Cleaner"]?.rich_text?.map((t) => t.plain_text).join("") ||
        "";

      if (!date || !unit || !cleaner) {
        skipped++;
        continue;
      }

      try {
        const result = await createPayrollRecord({ cleaner, unit, date });
        await sleep(350);
        created += Number(result?.created || 0);
        skipped += Number(result?.skipped || 0);
      } catch (error) {
        errors.push({
          unit,
          cleaner,
          date,
          error: error.message,
        });
      }
    }

    await generateWeeklyPayrollExcel(start, end);

    res.json({
      ok: true,
      message: "Backfill payroll completed",
      start,
      end,
      found: pages.length,
      created,
      skipped,
      errors,
    });
  } catch (error) {
    console.error("Error en backfill payroll:", error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/delete-payroll-week", async (req, res) => {
  try {
    const start = req.query.start;
    const end = req.query.end;

    const records = await getPayrollRecords(start, end);

    let deleted = 0;

    for (const record of records) {
      const response = await notion.databases.query({
        database_id: NOTION_PAYROLL_DATABASE_ID,
        filter: {
          and: [
            {
              property: "Date",
              date: {
                equals: record.date,
              },
            },
            {
              property: "Cleaner",
              rich_text: {
                equals: record.cleaner,
              },
            },
            {
              property: "Unit",
              rich_text: {
                equals: record.unit,
              },
            },
          ],
        },
      });

      for (const page of response.results) {
        await notion.pages.update({
          page_id: page.id,
          archived: true,
        });

        deleted++;
      }
    }

    res.json({
      ok: true,
      deleted,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/time-clock", (req, res) => {
  res.sendFile(__dirname + "/public/time-clock.html");
});
app.get("/inspector-assignments", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();

    if (!code) {
      return res.status(400).json({
        ok: false,
        message: "Código requerido",
      });
    }

    const date = todayISO();
    const ttlMs = Number(process.env.ASSIGNMENTS_CACHE_MS || 15000);
    const coreCacheKey = `core:inspector-assignments:${date}:${code}`;

    const payload = await OSCore.cache.remember(
      coreCacheKey,
      ttlMs,
      async () => {
        const employee = await findEmployeeByCode(code);

        if (!employee) {
          const error = new Error("Código no encontrado");
          error.status = 404;
          throw error;
        }

        const user = pageToUser(employee);

        if (!user.active) {
          const error = new Error("Empleado inactivo");
          error.status = 403;
          throw error;
        }

        if (!userCan(user, "inspection")) {
          const error = new Error("Este código no tiene acceso a inspecciones");
          error.status = 403;
          throw error;
        }

        const inspectorName = user.name;
        const role = user.role;
        const canSeeAll = userCan(user, "all") || userCan(user, "operations");
        const pages = await queryRoomsByDate(date);

        const units = pages
          .map((page) => {
            const props = page.properties;
            const assignedInspector =
              props["Assigned Inspector"]?.multi_select?.map((i) => i.name).join(", ") ||
              props["Assigned Inspector"]?.select?.name ||
              props["Assigned Inspector"]?.rich_text?.map((t) => t.plain_text).join("") ||
              "";
            const flags = getRoomOpsFlags(page);

            return {
              id: page.id,
              unit: props["Room Number"]?.title?.map((t) => t.plain_text).join("") || "",
              status: props["Cleaning Status"]?.status?.name || "",
              priority: props.Priority?.select?.name || "Normal",
              assignedInspector,
              arrival: !!props.Arrival?.checkbox,
              guestOut: flags.guestOut,
              guestOutAt: flags.guestOutAt,
              preInspection: flags.preInspection,
              preInspectionStarted: flags.preInspectionStarted,
              preInspectionStartedAt: flags.preInspectionStartedAt,
              preInspectionCompletedAt: flags.preInspectionCompletedAt,
            };
          })
          .filter((item) => {
            if (canSeeAll) return true;

            const inspectorList = String(item.assignedInspector || "")
              .toLowerCase()
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);

            return inspectorList.includes(inspectorName.toLowerCase().trim());
          });

        OSCore.metrics.increment("reads.assignments.inspectorBuilt");

        return {
          ok: true,
          inspector: inspectorName,
          role,
          permissions: user.permissions,
          count: units.length,
          units,
        };
      },
      [`assignments:${date}`, "assignments", `inspector:${code}`]
    );

    return res.json(payload);
  } catch (error) {
    console.error("Error en /inspector-assignments:", error.message);
    return res.status(error.status || 500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.get("/cleaner-assignments", async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Nombre requerido",
      });
    }

    const cleanText = (value) => String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

    const typedName = cleanText(name);
    const date = todayISO();
    const ttlMs = Number(process.env.ASSIGNMENTS_CACHE_MS || 15000);
    const coreCacheKey = `core:cleaner-assignments:${date}:${typedName}`;

    const payload = await OSCore.cache.remember(
      coreCacheKey,
      ttlMs,
      async () => {
        const pages = await queryRoomsByDate(date);

        const units = pages
          .map((page) => {
            const props = page.properties;
            const assignedCleaner =
              props["Assigned Cleaner"]?.select?.name ||
              props["Assigned Cleaner"]?.rich_text?.map((t) => t.plain_text).join("") ||
              "";
            const flags = getRoomOpsFlags(page);

            return {
              id: page.id,
              unit: props["Room Number"]?.title?.map((t) => t.plain_text).join("") || "",
              status: props["Cleaning Status"]?.status?.name || "",
              assignedCleaner,
              arrival: !!props.Arrival?.checkbox,
              guestOut: flags.guestOut,
              guestOutAt: flags.guestOutAt,
              preInspection: flags.preInspection,
              preInspectionStarted: flags.preInspectionStarted,
              preInspectionStartedAt: flags.preInspectionStartedAt,
              preInspectionCompletedAt: flags.preInspectionCompletedAt,
            };
          })
          .filter((item) => {
            const assignedCleaner = cleanText(item.assignedCleaner);
            return !!typedName && !!assignedCleaner && assignedCleaner.includes(typedName);
          });

        OSCore.metrics.increment("reads.assignments.cleanerBuilt");

        return {
          ok: true,
          cleaner: name,
          count: units.length,
          units,
        };
      },
      [`assignments:${date}`, "assignments", `cleaner:${typedName}`]
    );

    return res.json(payload);
  } catch (error) {
    console.error("Error en /cleaner-assignments:", error.message);
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function distanceFeet(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const meters = R * c;

  return meters * 3.28084;
}

function normalizeWorkLocation(value) {
  const clean = String(value || "Hotel").trim();
  const allowed = new Map([
    ["hotel", "Hotel"],
    ["main hotel", "Hotel"],
    ["chateau", "Chateau"],
    ["chateau houses", "Chateau"],
    ["office", "Office"],
    ["oficina", "Office"],
    ["laundry", "Laundry"],
    ["lavanderia", "Laundry"],
    ["other", "Other"],
    ["otro", "Other"],
  ]);
  return allowed.get(clean.toLowerCase()) || "Other";
}

function validateClockLocation(body) {
  const workLocation = normalizeWorkLocation(body.workLocation);
  const locationNote = String(body.locationNote || "").trim().slice(0, 120);
  const base = validateHotelLocation(body);

  // El hotel principal conserva la geocerca estricta.
  if (workLocation === "Hotel") {
    return { ...base, workLocation, locationNote };
  }

  // En oficinas, Chateau y otros lugares se exige GPS como evidencia,
  // pero no se bloquea al empleado por estar fuera del hotel.
  if (base.lat === null || base.lng === null) {
    return {
      ...base,
      ok: false,
      workLocation,
      locationNote,
      status: `${workLocation} - GPS Error`,
      message: "No se pudo obtener tu ubicación. Activa Location Services e intenta de nuevo.",
    };
  }

  return {
    ...base,
    ok: true,
    workLocation,
    locationNote,
    status: workLocation,
    message: `Ubicación registrada para ${workLocation}.`,
  };
}

function getPayrollPropertyFromUnit(unit) {
  const text = String(unit || "").trim();
  const normalized = text.toLowerCase();
  const configured = String(process.env.CHATEAU_UNIT_KEYWORDS || "chateau")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (configured.some((keyword) => normalized.includes(keyword))) {
    return "Chateau";
  }

  return "Hotel";
}

const notionDatabaseSchemaCache = new Map();
async function getNotionDatabaseSchema(databaseId) {
  const cached = notionDatabaseSchemaCache.get(databaseId);
  if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) {
    return cached.properties;
  }
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const properties = database?.properties || {};
  notionDatabaseSchemaCache.set(databaseId, { savedAt: Date.now(), properties });
  return properties;
}

function buildNotionTextValue(propertySchema, value) {
  if (!propertySchema) return null;
  const content = String(value || "").slice(0, 1900);
  if (propertySchema.type === "select") return { select: { name: content || "Unspecified" } };
  if (propertySchema.type === "status") return { status: { name: content || "Unspecified" } };
  if (propertySchema.type === "rich_text") return { rich_text: [{ text: { content } }] };
  if (propertySchema.type === "title") return { title: [{ text: { content } }] };
  return null;
}

function validateHotelLocation(body) {
  const hotelLat = toNumber(process.env.HOTEL_LAT || 36.638366);
  const hotelLng = toNumber(process.env.HOTEL_LNG || -93.350305);
  const radiusFeet = toNumber(process.env.HOTEL_RADIUS_FEET || 300);

  const lat = toNumber(body.lat);
  const lng = toNumber(body.lng);
  const accuracy = toNumber(body.accuracy);

  if (lat === null || lng === null) {
    return {
      ok: false,
      status: "GPS Error",
      message: "No se pudo obtener tu ubicación. Activa Location Services e intenta de nuevo.",
      distanceFeet: null,
      accuracy,
      lat,
      lng,
    };
  }

  const distance = distanceFeet(hotelLat, hotelLng, lat, lng);

  if (distance > radiusFeet) {
    return {
      ok: false,
      status: "Outside Property",
      message: `Debes estar dentro del hotel para registrar tu horario. Distancia aproximada: ${Math.round(distance)} ft.`,
      distanceFeet: Number(distance.toFixed(2)),
      accuracy,
      lat,
      lng,
    };
  }

  return {
    ok: true,
    status: "Inside Property",
    message: "Ubicación validada.",
    distanceFeet: Number(distance.toFixed(2)),
    accuracy,
    lat,
    lng,
  };
}

app.post("/mobile-cleaner-login", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Nombre requerido",
      });
    }

    const cleanText = (value) => {
      return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
    };

    const typedName = cleanText(name);
    const pages = await queryTodayRooms();

    const units = pages
      .map((page) => {
        const props = page.properties;

        const assignedCleaner =
          props["Assigned Cleaner"]?.select?.name ||
          props["Assigned Cleaner"]?.rich_text?.map((t) => t.plain_text).join("") ||
          "";

        const flags = getRoomOpsFlags(page);

        return {
          id: page.id,
          unit: props["Room Number"]?.title?.map((t) => t.plain_text).join("") || "",
          status: props["Cleaning Status"]?.status?.name || "",
          assignedCleaner,
          arrival: !!props.Arrival?.checkbox,
          guestOut: flags.guestOut,
          guestOutAt: flags.guestOutAt,
          preInspection: flags.preInspection,
          preInspectionStarted: flags.preInspectionStarted,
          preInspectionStartedAt: flags.preInspectionStartedAt,
          preInspectionCompletedAt: flags.preInspectionCompletedAt,
        };
      })
      .filter((item) => {
        const assignedCleaner = cleanText(item.assignedCleaner);

        return typedName && assignedCleaner && assignedCleaner.includes(typedName);
      });

    if (units.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "No encontré unidades asignadas para ese nombre hoy.",
      });
    }

    res.json({
      ok: true,
      employee: name,
      role: "Cleaner",
      home: "cleaner",
      count: units.length,
      units,
    });

  } catch (error) {
    console.error("Error en /mobile-cleaner-login:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.post("/mobile-code-login", async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();

    if (!code) {
      return res.status(400).json({
        ok: false,
        message: "Código requerido",
      });
    }

    const employee = await findEmployeeByCode(code);

    if (!employee) {
      return res.status(404).json({
        ok: false,
        message: "Código no encontrado",
      });
    }

    const employeeName =
      getEmployeeNameFromPage(employee);

    const role =
      getEmployeeRoleFromPage(employee);

    const home =
      mobileHomeFromRole(role);

    res.json({
      ok: true,
      employee: employeeName,
      role,
      code,
      home,
      employeeId: employee.id,
    });

  } catch (error) {
    console.error(
      "Error en /mobile-code-login:",
      error
    );

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.post("/clock-in", async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const location = validateClockLocation(req.body);

    if (!code) {
      return res.status(400).json({
        error: "Employee code required",
      });
    }

    if (!location.ok) {
      return res.status(403).json({
        ok: false,
        error: location.message,
        locationStatus: location.status,
        distanceFeet: location.distanceFeet,
        accuracy: location.accuracy,
      });
    }

    const employee = await findEmployeeByCode(code);

    if (!employee) {
      return res.status(404).json({
        error: "Employee not found",
      });
    }

    const activeClockResponse = await notion.databases.query({
      database_id: NOTION_TIME_CLOCK_DATABASE_ID,
      page_size: 20,
      filter: {
        and: [
          { property: "Code", rich_text: { equals: code } },
          { property: "Status", select: { equals: "Working" } },
        ],
      },
    });

    if ((activeClockResponse.results || []).length > 0) {
      return res.status(409).json({
        ok: false,
        error: "Ya tienes un Clock In activo. Haz Clock Out antes de volver a entrar.",
      });
    }

    const props = employee.properties;

    const employeeName =
      props.Employee?.title?.map((t) => t.plain_text).join("") || "";

    const role =
      props.Role?.select?.name || "";

    const hourlyRate =
      props["Hourly Rate"]?.number || 0;

    await notion.pages.create({
      parent: {
        database_id: NOTION_TIME_CLOCK_DATABASE_ID,
      },
      properties: {
        Entry: {
          title: [
            {
              text: {
                content: `${employeeName} Clock In - ${location.workLocation}${location.locationNote ? ` - ${location.locationNote}` : ""}`,
              },
            },
          ],
        },

        Employee: {
          rich_text: [
            {
              text: {
                content: employeeName,
              },
            },
          ],
        },

        Code: {
          rich_text: [
            {
              text: {
                content: code,
              },
            },
          ],
        },

        Role: {
          select: {
            name: role,
          },
        },

        "Hourly Rate": {
          number: hourlyRate,
        },

        "Clock In": {
          date: {
            start: new Date().toISOString(),
          },
        },

        "Clock In Lat": {
          number: location.lat,
        },

        "Clock In Lng": {
          number: location.lng,
        },

        "Clock In Distance": {
          number: location.distanceFeet,
        },

        "Clock In Accuracy": {
          number: location.accuracy,
        },

        "Location Status": {
          select: {
            name: location.status,
          },
        },

        Status: {
          select: {
            name: "Working",
          },
        },
      },
    });

    res.json({
      ok: true,
      message: `${employeeName} hizo Clock In en ${location.workLocation}.`,
      locationStatus: location.status,
      distanceFeet: location.distanceFeet,
      accuracy: location.accuracy,
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/clock-out", async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const location = validateClockLocation(req.body);

    if (!code) {
      return res.status(400).json({
        error: "Employee code required",
      });
    }

    if (!location.ok) {
      return res.status(403).json({
        ok: false,
        error: location.message,
        locationStatus: location.status,
        distanceFeet: location.distanceFeet,
        accuracy: location.accuracy,
      });
    }

    const response = await notion.databases.query({
      database_id: NOTION_TIME_CLOCK_DATABASE_ID,
      page_size: 100,
    });

    const activeEntry = response.results.find((page) => {
      const pageCode =
        page.properties.Code?.rich_text
          ?.map((t) => t.plain_text)
          .join("") || "";

      const status =
        page.properties.Status?.select?.name || "";

      return pageCode === code && status === "Working";
    });

    if (!activeEntry) {
      return res.status(404).json({
        error: "No active clock-in found",
      });
    }

    const clockIn =
      activeEntry.properties["Clock In"]?.date?.start;

    if (!clockIn) {
      return res.status(400).json({
        error: "Clock In not found",
      });
    }

    const clockOut = new Date();

    const hours =
      (clockOut.getTime() - new Date(clockIn).getTime()) /
      (1000 * 60 * 60);

    const rate =
      activeEntry.properties["Hourly Rate"]?.number || 0;

    const total = Number((hours * rate).toFixed(2));

    await notion.pages.update({
      page_id: activeEntry.id,
      properties: {
        "Clock Out": {
          date: {
            start: clockOut.toISOString(),
          },
        },

        "Clock Out Lat": {
          number: location.lat,
        },

        "Clock Out Lng": {
          number: location.lng,
        },

        "Clock Out Distance": {
          number: location.distanceFeet,
        },

        "Clock Out Accuracy": {
          number: location.accuracy,
        },

        "Location Status": {
          select: {
            name: location.status,
          },
        },

        Hours: {
          number: Number(hours.toFixed(2)),
        },

        Total: {
          number: total,
        },

        Status: {
          select: {
            name: "Completed",
          },
        },
      },
    });

    res.json({
      ok: true,
      message: `Clock Out completado en ${location.workLocation} (${hours.toFixed(2)} hrs).`,
      locationStatus: location.status,
      distanceFeet: location.distanceFeet,
      accuracy: location.accuracy,
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message,
    });
  }
});
app.get("/health", (req, res) => {
  res.send("OK");
});
const PORT = process.env.PORT || 3000;
app.post("/upload-photo", upload.single("photo"), async (req, res) => {
  try {
    const { unit, name, role, action, note } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No se recibió ninguna foto"
      });
    }

    const base64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder: `housekeeping/${unit || "unknown"}`,
      resource_type: "image",
      quality: "auto:best"
    });

    res.json({
      success: true,
      photoUrl: result.secure_url,
      publicId: result.public_id,
      unit,
      name,
      role,
      action,
      note
    });

  } catch (err) {
    console.error("❌ Error subiendo foto:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// =========================================================
// DASHBOARD EJECUTIVO CARE OS
// Una sola fuente de datos para dashboard, app y estadísticas.
// =========================================================
function readRoomTextProperty(props, names = []) {
  for (const name of names) {
    const prop = props?.[name];
    if (!prop) continue;

    const value =
      prop.title?.map((t) => t.plain_text).join("") ||
      prop.rich_text?.map((t) => t.plain_text).join("") ||
      prop.select?.name ||
      prop.status?.name ||
      prop.multi_select?.map((item) => item.name).join(", ") ||
      prop.people?.map((person) => person.name).join(", ") ||
      "";

    if (String(value).trim()) return String(value).trim();
  }

  return "";
}

function dashboardStatusKey(status) {
  const value = cleanEmployeeText(status);

  if (value.includes("ready")) return "ready";
  if (value.includes("inspection started")) return "inspectionStarted";
  if (value.includes("awaiting inspection") || value.includes("cleaned")) {
    return "awaitingInspection";
  }
  if (value.includes("progress") || value.includes("cleaning started")) {
    return "inProgress";
  }

  return "pending";
}

function dashboardBuildingFromUnit(unit) {
  const text = String(unit || "").trim().toUpperCase();

  // Acepta formatos como "430 A (2) - G" y "430 A (2) - G URGENTE".
  const explicitBuilding = text.match(/(?:-|–)\s*([A-Z])(?:\s+URGENTE)?\s*$/);
  if (explicitBuilding) return explicitBuilding[1];

  const finalLetter = text.match(/\b([A-Z])(?:\s+URGENTE)?\s*$/);
  return finalLetter ? finalLetter[1] : "OTHER";
}

function pageToDashboardUnit(page) {
  const props = page?.properties || {};
  const flags = getRoomOpsFlags(page);

  return {
    id: page.id,
    unit: readRoomTextProperty(props, ["Room Number", "Unit", "Room"]),
    date: props.Date?.date?.start || "",
    cleaner: readRoomTextProperty(props, ["Assigned Cleaner", "Cleaner"]),
    inspector: readRoomTextProperty(props, ["Assigned Inspector", "Inspector"]),
    status: readRoomTextProperty(props, ["Cleaning Status", "Status"]),
    arrival: readCheckboxProp(page, ["Arrival", "arrival"]),
    stayover: readCheckboxProp(page, ["Stayover", "Stay Over", "stayover"]),
    urgent:
      cleanEmployeeText(readRoomTextProperty(props, ["Priority"])).includes("urgent") ||
      readCheckboxProp(page, ["Urgent", "urgent"]) ||
      cleanEmployeeText(readRoomTextProperty(props, ["Room Number", "Unit", "Room"])).includes("urgente") ||
      cleanEmployeeText(readRoomTextProperty(props, ["Room Number", "Unit", "Room"])).includes("urgent"),
    priority: readRoomTextProperty(props, ["Priority"]) || "Normal",
    startedAt: readDateProp(page, ["Started At", "Cleaning Started At"]),
    finishedAt: readDateProp(page, ["Finished At", "Cleaning Finished At"]),
    inspectionStartedAt: readDateProp(page, [
      "Inspection Started At",
      "Inspection Start At",
    ]),
    readyAt: readDateProp(page, ["Ready At", "Ready for Guest At"]),
    guestOut: flags.guestOut,
    preInspection: flags.preInspection,
    preInspectionStarted: flags.preInspectionStarted,
    building: dashboardBuildingFromUnit(
      readRoomTextProperty(props, ["Room Number", "Unit", "Room"])
    ),
  };
}

async function getDashboardReports(date, forceRefresh = false) {
  if (!NOTION_REPORTS_DATABASE_ID) return [];

  const cacheKey = `dashboard:reports:${date}`;
  const cached = !forceRefresh ? getCache(cacheKey) : null;
  if (cached) return cached;

  let results = [];
  let cursor;

  do {
    const query = {
      database_id: NOTION_REPORTS_DATABASE_ID,
      page_size: 100,
      filter: {
        property: "Date",
        date: { equals: date },
      },
    };

    if (cursor) query.start_cursor = cursor;

    const response = await notion.databases.query(query);
    results = results.concat(response.results || []);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  const reports = results.map(reportPageToObject);
  setCache(cacheKey, reports, date === todayISO() ? 15000 : 120000);
  return reports;
}

async function getDashboardTimeClock(date, forceRefresh = false) {
  if (!NOTION_TIME_CLOCK_DATABASE_ID) return [];

  const cacheKey = `dashboard:timeclock:${date}`;
  const cached = !forceRefresh ? getCache(cacheKey) : null;
  if (cached) return cached;

  let results = [];
  let cursor;

  do {
    const query = {
      database_id: NOTION_TIME_CLOCK_DATABASE_ID,
      page_size: 100,
    };

    if (cursor) query.start_cursor = cursor;

    const response = await notion.databases.query(query);
    results = results.concat(response.results || []);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  const records = results
    .map((page) => {
      const props = page.properties || {};
      return {
        id: page.id,
        employee: readRoomTextProperty(props, ["Employee", "Name"]),
        role: readRoomTextProperty(props, ["Role"]),
        clockIn: props["Clock In"]?.date?.start || "",
        clockOut: props["Clock Out"]?.date?.start || "",
        status: readRoomTextProperty(props, ["Status"]),
        hours: Number(props.Hours?.number || 0),
        total: Number(props.Total?.number || 0),
      };
    })
    .filter((record) => record.clockIn && record.clockIn.slice(0, 10) === date);

  setCache(cacheKey, records, date === todayISO() ? 15000 : 120000);
  return records;
}

async function getDashboardPayroll(date, forceRefresh = false) {
  if (!NOTION_PAYROLL_DATABASE_ID) {
    return { unitPay: 0, hourlyPay: 0, total: 0, unitRecords: 0 };
  }

  const cacheKey = `dashboard:payroll:${date}`;
  const cached = !forceRefresh ? getCache(cacheKey) : null;
  if (cached) return cached;

  let records = [];
  let cursor;

  do {
    const query = {
      database_id: NOTION_PAYROLL_DATABASE_ID,
      page_size: 100,
      filter: {
        property: "Date",
        date: { equals: date },
      },
    };

    if (cursor) query.start_cursor = cursor;

    const response = await notion.databases.query(query);
    records = records.concat(response.results || []);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  const unitPay = records.reduce(
    (sum, page) => sum + Number(page.properties?.Amount?.number || 0),
    0
  );

  const result = {
    unitPay: Number(unitPay.toFixed(2)),
    hourlyPay: 0,
    total: Number(unitPay.toFixed(2)),
    unitRecords: records.length,
  };

  setCache(cacheKey, result, date === todayISO() ? 15000 : 120000);
  return result;
}

function buildDashboardBuildings(units) {
  const buildings = new Map();

  for (const unit of units) {
    const name = unit.building || "OTHER";

    if (!buildings.has(name)) {
      buildings.set(name, {
        building: name,
        total: 0,
        pending: 0,
        inProgress: 0,
        awaitingInspection: 0,
        inspectionStarted: 0,
        ready: 0,
        urgent: 0,
        units: [],
      });
    }

    const group = buildings.get(name);
    const key = dashboardStatusKey(unit.status);
    group.total += 1;
    group[key] += 1;
    if (unit.urgent) group.urgent += 1;
    group.units.push(unit);
  }

  return Array.from(buildings.values()).sort((a, b) => {
    if (a.building === "OTHER") return 1;
    if (b.building === "OTHER") return -1;
    return a.building.localeCompare(b.building);
  });
}

function buildDashboardAlerts(units, reports) {
  const alerts = [];

  for (const unit of units) {
    const status = dashboardStatusKey(unit.status);

    if (unit.urgent && status === "pending") {
      alerts.push({
        type: "urgent_room",
        severity: "high",
        unit: unit.unit,
        message: "Habitación urgente todavía sin comenzar.",
      });
    }

    if (!unit.cleaner && status !== "ready") {
      alerts.push({
        type: "missing_cleaner",
        severity: "high",
        unit: unit.unit,
        message: "Habitación sin limpiador asignado.",
      });
    }

    if (
      ["awaitingInspection", "inspectionStarted"].includes(status) &&
      !unit.inspector
    ) {
      alerts.push({
        type: "missing_inspector",
        severity: "medium",
        unit: unit.unit,
        message: "Habitación terminada sin inspector asignado.",
      });
    }
  }

  for (const report of reports.slice(0, 25)) {
    const category = cleanEmployeeText(report.aiCategory || report.category);
    const priority = cleanEmployeeText(report.aiPriority || report.priority);

    if (
      priority.includes("urgent") ||
      category.includes("maintenance") ||
      category.includes("damage") ||
      category.includes("lost")
    ) {
      alerts.push({
        type: "operations_report",
        severity: priority.includes("urgent") ? "high" : "medium",
        unit: report.unit || "",
        message: report.message || report.note || "Reporte operativo pendiente.",
      });
    }
  }

  return alerts.slice(0, 50);
}

function calculateDashboardAverages(units) {
  const cleaningMinutes = [];

  for (const unit of units) {
    if (!unit.startedAt || !unit.finishedAt) continue;
    const start = new Date(unit.startedAt).getTime();
    const finish = new Date(unit.finishedAt).getTime();
    const minutes = (finish - start) / 60000;

    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 720) {
      cleaningMinutes.push(minutes);
    }
  }

  const averageCleaningMinutes = cleaningMinutes.length
    ? cleaningMinutes.reduce((sum, value) => sum + value, 0) / cleaningMinutes.length
    : 0;

  const inspectionMinutes = [];

  for (const unit of units) {
    if (!unit.inspectionStartedAt || !unit.readyAt) continue;
    const start = new Date(unit.inspectionStartedAt).getTime();
    const finish = new Date(unit.readyAt).getTime();
    const minutes = (finish - start) / 60000;

    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 240) {
      inspectionMinutes.push(minutes);
    }
  }

  const averageInspectionMinutes = inspectionMinutes.length
    ? inspectionMinutes.reduce((sum, value) => sum + value, 0) / inspectionMinutes.length
    : 0;

  return {
    averageCleaningMinutes: Number(averageCleaningMinutes.toFixed(1)),
    averageInspectionMinutes: Number(averageInspectionMinutes.toFixed(1)),
    completedWithTime: cleaningMinutes.length,
    inspectionsWithTime: inspectionMinutes.length,
  };
}

async function buildDashboardData(date = todayISO(), forceRefresh = false) {
  const cacheKey = `dashboard:data:${date}`;
  const memoryCached = !forceRefresh ? ServerCache.get("dashboard", date) : null;
  if (memoryCached) return memoryCached.value;

  const ttlCached = !forceRefresh ? getCache(cacheKey) : null;
  if (ttlCached) {
    ServerCache.set("dashboard", date, ttlCached);
    return ttlCached;
  }

  const pages = await queryRoomsByDate(date, forceRefresh);
  const units = pages.map(pageToDashboardUnit);

  // Las consultas secundarias se hacen en paralelo y usan su propio cache.
  const [reports, timeClock, payroll] = await Promise.all([
    getDashboardReports(date, forceRefresh).catch((error) => {
      console.error("Dashboard reports:", error.message);
      return [];
    }),
    getDashboardTimeClock(date, forceRefresh).catch((error) => {
      console.error("Dashboard time clock:", error.message);
      return [];
    }),
    getDashboardPayroll(date, forceRefresh).catch((error) => {
      console.error("Dashboard payroll:", error.message);
      return { unitPay: 0, hourlyPay: 0, total: 0, unitRecords: 0 };
    }),
  ]);

  const stats = {
    totalUnits: units.length,
    pending: 0,
    inProgress: 0,
    awaitingInspection: 0,
    inspectionStarted: 0,
    ready: 0,
    arrivals: units.filter((unit) => unit.arrival).length,
    stayovers: units.filter((unit) => unit.stayover).length,
    urgent: units.filter((unit) => unit.urgent).length,
    unassignedCleaner: units.filter((unit) => !unit.cleaner).length,
    unassignedInspector: units.filter(
      (unit) =>
        ["awaitingInspection", "inspectionStarted"].includes(
          dashboardStatusKey(unit.status)
        ) && !unit.inspector
    ).length,
    reports: reports.length,
    problems: 0,
  };

  for (const unit of units) stats[dashboardStatusKey(unit.status)] += 1;

  const alerts = buildDashboardAlerts(units, reports);
  stats.problems = alerts.filter((alert) => alert.type === "operations_report").length;

  const activeEmployees = timeClock.filter(
    (record) => record.clockIn && !record.clockOut && cleanEmployeeText(record.status) !== "completed"
  );

  const hourlyPay = timeClock.reduce(
    (sum, record) => sum + Number(record.total || 0),
    0
  );

  payroll.hourlyPay = Number(hourlyPay.toFixed(2));
  payroll.total = Number((payroll.unitPay + payroll.hourlyPay).toFixed(2));

  const payload = {
    ok: true,
    date,
    generatedAt: new Date().toISOString(),
    stats,
    averages: calculateDashboardAverages(units),
    employees: {
      active: activeEmployees.length,
      clockedIn: activeEmployees,
      recordsToday: timeClock.length,
    },
    payroll,
    buildings: buildDashboardBuildings(units),
    alerts,
    units,
    recentReports: reports.slice(0, 10),
    timeline: systemTimeline.slice(0, 100),
  };

  setCache(cacheKey, payload, date === todayISO() ? 10000 : 120000);
  ServerCache.set("dashboard", date, payload);
  return payload;
}

app.get("/dashboard-data", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const forceRefresh = String(req.query.refresh || "") === "1";
    const payload = await buildDashboardData(date, forceRefresh);
    res.json(payload);
  } catch (error) {
    console.error("Error en /dashboard-data:", error.message);
    res.status(500).json({
      ok: false,
      message: error.message,
      date: String(req.query.date || todayISO()),
    });
  }
});

// Compatibilidad con el dashboard anterior.
app.get("/admin-dashboard-data", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const forceRefresh = String(req.query.refresh || "") === "1";
    const payload = await buildDashboardData(date, forceRefresh);
    res.json(payload);
  } catch (error) {
    console.error("Error en /admin-dashboard-data:", error.message);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/master-units", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const forceRefresh = String(req.query.refresh || "") === "1";
    const pages = await queryRoomsByDate(date, forceRefresh);
    const units = pages.map(pageToDashboardUnit);

    res.json({
      ok: true,
      date,
      count: units.length,
      units,
    });
  } catch (error) {
    console.error("Error en /master-units:", error.message);
    res.status(500).json({
      ok: false,
      message: error.message,
      units: [],
    });
  }
});

app.post("/master-action", async (req, res) => {
  try {
    const { action, unit, name, note, role } = req.body;

    if (!action || !unit || !name) {
      return res.status(400).json({
        ok: false,
        message: "Faltan datos: acción, unidad o nombre",
      });
    }

    const mode = role === "inspector" ? "inspector" : "cleaner";

    const result = await updateNotionRoom(
      unit,
      action,
      name,
      note || "Acción realizada desde App Maestra",
      mode,
      ""
    );
    broadcastOpsUpdate({
      type: "action",
      action,
      unit,
      employee: name,
      message: note || "",
    });
    res.json({
      ok: true,
      message: `Acción completada: ${result.label} - ${unit}`,
    });

  } catch (error) {
    console.error("Error en /master-action:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.post("/master-update-unit", async (req, res) => {
  try {
    const { unit, field, value } = req.body;

    if (!unit || !field) {
      return res.status(400).json({
        ok: false,
        message: "Faltan datos: unidad o campo",
      });
    }

    const pages = await queryTodayRooms();
    const normalizedTarget = normalizeRoom(unit);
    const targetDigits = roomDigits(unit);

    let matches = pages.filter((page) => {
      const title =
        page.properties["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";
      return normalizeRoom(title) === normalizedTarget;
    });

    if (matches.length === 0) {
      matches = pages.filter((page) => {
        const title =
          page.properties["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";
        return roomDigits(title) === targetDigits;
      });
    }

    if (matches.length === 0) {
      throw new Error(`No encontré la unidad ${unit} para hoy`);
    }

    const props = {};

    if (field === "priority") {
      props.Priority = {
        select: {
          name: value || "Normal",
        },
      };
    }

    if (field === "cleaner") {
      props["Assigned Cleaner"] = {
        select: {
          name: value,
        },
      };
    }

    if (field === "inspector") {
      props["Assigned Inspector"] = {
        select: {
          name: value,
        },
      };
    }

    if (Object.keys(props).length === 0) {
      throw new Error("Campo no permitido");
    }

    for (const page of matches) {
      await notion.pages.update({
        page_id: page.id,
        properties: props,
      });
    }
    broadcastOpsUpdate({
      type: "action",
      action,
      unit,
      employee: name,
      message: note || "",
    });
    res.json({
      ok: true,
      message: `Unidad ${unit} actualizada correctamente`,
    });

  } catch (error) {
    console.error("Error en /master-update-unit:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.post("/master-create-assignment", async (req, res) => {
  try {
    const {
      unit,
      cleaner,
      inspector,
      arrival,
      priority,
      date,
    } = req.body;

    if (!unit || !cleaner) {
      return res.status(400).json({
        ok: false,
        message: "Falta unidad o limpiador",
      });
    }

    const assignmentDate = date || todayISO();

    const props = {
      "Room Number": {
        title: [
          {
            text: {
              content: unit,
            },
          },
        ],
      },

      Date: {
        date: {
          start: assignmentDate,
        },
      },

      "Assigned Cleaner": {
        select: {
          name: cleaner,
        },
      },

      Arrival: {
        checkbox: !!arrival,
      },

      Priority: {
        select: {
          name: priority || "Normal",
        },
      },

      "Cleaning Status": {
        status: {
          name: "Not Started",
        },
      },
    };

    if (inspector) {
      props["Assigned Inspector"] = {
        select: {
          name: inspector,
        },
      };
    }

    await notion.pages.create({
      parent: {
        database_id: NOTION_DATABASE_ID,
      },
      properties: props,
    });

    res.json({
      ok: true,
      message: `Asignación creada: ${unit}`,
    });

  } catch (error) {
    console.error("Error en /master-create-assignment:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});
app.get("/master-unit-detail", async (req, res) => {
  try {
    const unit = String(req.query.unit || "").trim();

    if (!unit) {
      return res.status(400).json({
        ok: false,
        message: "Unidad requerida",
      });
    }

    const pages = await queryTodayRooms();
    const normalizedTarget = normalizeRoom(unit);
    const targetDigits = roomDigits(unit);

    let roomPage = pages.find((page) => {
      const title =
        page.properties["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";
      return normalizeRoom(title) === normalizedTarget;
    });

    if (!roomPage) {
      roomPage = pages.find((page) => {
        const title =
          page.properties["Room Number"]?.title?.map((t) => t.plain_text).join("") || "";
        return roomDigits(title) === targetDigits;
      });
    }

    if (!roomPage) {
      throw new Error(`No encontré la unidad ${unit} para hoy`);
    }

    const props = roomPage.properties;

    const logs = await getDailyLogsForReport(todayISO());

    const unitLogs = logs
      .map((log) => {
        const p = log.properties;

        return {
          id: log.id,
          time: p.Time?.date?.start || "",
          unit: p.Unit?.rich_text?.map((t) => t.plain_text).join("") || "",
          action: p.Action?.select?.name || "",
          cleaner: p.Cleaner?.rich_text?.map((t) => t.plain_text).join("") || "",
          inspector: p.Inspector?.rich_text?.map((t) => t.plain_text).join("") || "",
          note: p.Note?.rich_text?.map((t) => t.plain_text).join("") || "",
          photoUrl: p["Photo URL"]?.url || "",
          lostAndFound: !!p["Lost and Found"]?.checkbox,
        };
      })
      .filter((log) => {
        return normalizeRoom(log.unit) === normalizedTarget ||
               roomDigits(log.unit) === targetDigits;
      });

    res.json({
      ok: true,
      unit: props["Room Number"]?.title?.map((t) => t.plain_text).join("") || unit,
      cleaner:
        props["Assigned Cleaner"]?.select?.name ||
        props["Assigned Cleaner"]?.rich_text?.map((t) => t.plain_text).join("") ||
        "",
      inspector:
  props["Assigned Inspector"]?.multi_select
    ?.map(i => i.name)
    .join(", ") || "",
      status: props["Cleaning Status"]?.status?.name || "",
      arrival: !!props.Arrival?.checkbox,
      priority: props.Priority?.select?.name || "Normal",
      startedAt: props["Started At"]?.date?.start || "",
      finishedAt: props["Finished At"]?.date?.start || "",
      logs: unitLogs,
    });

  } catch (error) {
    console.error("Error en /master-unit-detail:", error.message);

    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

// =========================================================
// NOTION REALTIME WATCHER
// Revisa una sola vez para todos los teléfonos y avisa por Socket.IO.
// Los cambios hechos desde este servidor se emiten inmediatamente arriba.
// Los cambios hechos directamente en Notion se detectan aquí.
// =========================================================
const NOTION_WATCH_INTERVAL_MS = Math.max(
  3000,
  Number(process.env.NOTION_WATCH_INTERVAL_MS || 5000)
);

let notionWatcherRunning = false;
let notionWatcherSnapshot = "";

function readNotionPropertyValue(property) {
  if (!property) return "";

  if (Array.isArray(property.title)) {
    return property.title.map((item) => item.plain_text || "").join("").trim();
  }

  if (Array.isArray(property.rich_text)) {
    return property.rich_text.map((item) => item.plain_text || "").join("").trim();
  }

  if (property.select) return property.select.name || "";
  if (property.status) return property.status.name || "";

  if (Array.isArray(property.multi_select)) {
    return property.multi_select
      .map((item) => item.name || "")
      .filter(Boolean)
      .sort()
      .join(", ");
  }

  if (Array.isArray(property.people)) {
    return property.people
      .map((person) => person.name || person.id || "")
      .filter(Boolean)
      .sort()
      .join(", ");
  }

  if (typeof property.checkbox === "boolean") return property.checkbox;
  if (property.date) return property.date.start || "";
  if (property.number !== null && property.number !== undefined) return property.number;
  if (property.url) return property.url;

  return "";
}

function getFirstExistingProperty(props, names) {
  for (const name of names) {
    if (props?.[name]) return readNotionPropertyValue(props[name]);
  }

  return "";
}

function buildAssignmentSnapshot(pages = []) {
  const snapshot = pages.map((page) => {
    const props = page.properties || {};
    const flags = getRoomOpsFlags(page);

    return {
      id: page.id,
      archived: page.archived === true,
      unit: getFirstExistingProperty(props, ["Room Number", "Unit", "Room"]),
      cleaner: getFirstExistingProperty(props, [
        "Assigned Cleaner",
        "assigned cleaner",
        "Cleaner",
      ]),
      inspector: getFirstExistingProperty(props, [
        "Assigned Inspector",
        "assigned inspector",
        "Inspector",
      ]),
      status: getFirstExistingProperty(props, [
        "Cleaning Status",
        "Status",
      ]),
      priority: getFirstExistingProperty(props, ["Priority"]),
      urgent: Boolean(getFirstExistingProperty(props, ["Urgent", "urgent"])) || String(getFirstExistingProperty(props, ["Priority"])).toLowerCase().includes("urgent"),
      arrival: getFirstExistingProperty(props, ["Arrival"]),
      guestOut: flags.guestOut,
      guestOutAt: flags.guestOutAt,
      preInspection: flags.preInspection,
      preInspectionStarted: flags.preInspectionStarted,
      preInspectionStartedAt: flags.preInspectionStartedAt,
      preInspectionCompletedAt: flags.preInspectionCompletedAt,
      lastEditedTime: page.last_edited_time || "",
    };
  });

  snapshot.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify(snapshot);
}

function snapshotToMap(snapshotText) {
  try {
    const rows = JSON.parse(snapshotText || "[]");
    return new Map(rows.map(row => [String(row.id), row]));
  } catch (_) {
    return new Map();
  }
}

function namesFromAssignment(value) {
  return splitCleanerNames(value || "").map(name => String(name).trim()).filter(Boolean);
}

function differenceNames(a, b) {
  const bKeys = new Set((b || []).map(notificationEmployeeKey));
  return (a || []).filter(name => !bKeys.has(notificationEmployeeKey(name)));
}

async function sendAssignmentTransitionPushes(previousSnapshot, nextSnapshot) {
  if (!postgresStatus.connected) return;

  const previous = snapshotToMap(previousSnapshot);
  const next = snapshotToMap(nextSnapshot);

  for (const [id, room] of next.entries()) {
    const before = previous.get(id);
    if (!before) continue;

    const unit = room.unit || "Unidad";
    const oldCleaners = namesFromAssignment(before.cleaner);
    const newCleaners = namesFromAssignment(room.cleaner);
    const inspectors = namesFromAssignment(room.inspector);
    const addedCleaners = differenceNames(newCleaners, oldCleaners);
    const removedCleaners = differenceNames(oldCleaners, newCleaners);

    if (addedCleaners.length) {
      await sendPushToEmployees(postgresQuery, addedCleaners, {
        title: "🧹 Nueva unidad asignada",
        body: `Se te asignó ${unit}.`,
        tag: `assigned-${id}-${room.lastEditedTime}`,
        link: "/",
        data: { type:"ASSIGNED", unit },
      });
    }

    if (removedCleaners.length) {
      await sendPushToEmployees(postgresQuery, removedCleaners, {
        title: "↩️ Unidad retirada",
        body: `${unit} fue retirada de tus asignaciones.`,
        tag: `removed-${id}-${room.lastEditedTime}`,
        link: "/",
        data: { type:"REMOVED", unit },
      });
    }

    const becameGuestOut = Boolean(room.guestOut) && !Boolean(before.guestOut);
    if (becameGuestOut) {
      await sendPushToEmployees(postgresQuery, [...newCleaners, ...inspectors], {
        title: "🚪 Guest Out",
        body: `${unit} ya está disponible.`,
        tag: `guest-out-${id}-${room.guestOutAt || room.lastEditedTime}`,
        link: "/launch",
        data: { type:"GUEST_OUT", unit },
      });
    }

    const becameUrgent = Boolean(room.urgent) && !Boolean(before.urgent);
    if (becameUrgent && newCleaners.length) {
      await sendPushToEmployees(postgresQuery, newCleaners, {
        title: "🚨 Limpieza urgente",
        body: `${unit} fue marcada como urgente.`,
        tag: `urgent-${id}-${room.lastEditedTime}`,
        link: "/",
        urgent: true,
        data: { type:"URGENT", unit },
      });
    }
  }
}

async function checkNotionAssignmentChanges() {
  if (notionWatcherRunning || !NOTION_DATABASE_ID || !NOTION_API_KEY) return;

  notionWatcherRunning = true;

  try {
    const date = todayISO();
    const pages = await fetchRoomsFreshFromNotion(date);
    const nextSnapshot = buildAssignmentSnapshot(pages);

    if (!notionWatcherSnapshot) {
      notionWatcherSnapshot = nextSnapshot;
      console.log(
        `👁️ Notion watcher activo: ${pages.length} habitaciones, revisión cada ${NOTION_WATCH_INTERVAL_MS}ms`
      );
      return;
    }

    if (nextSnapshot === notionWatcherSnapshot) return;

    const previousSnapshot = notionWatcherSnapshot;
    notionWatcherSnapshot = nextSnapshot;

    sendAssignmentTransitionPushes(previousSnapshot, nextSnapshot).catch((error) => {
      console.error("⚠️ Error enviando push por cambio de asignación:", error.message);
    });

    broadcastAssignmentUpdate("direct-notion-change", {
      roomCount: pages.length,
    });

    const legacyCacheKey = `todayRooms:${date}`;
    const coreCacheKey = `core:rooms:${date}`;
    const ttlMs = Number(process.env.ROOMS_CACHE_MS || 30000);

    setCache(legacyCacheKey, pages, ttlMs);
    ServerCache.set("rooms", date, pages);
    OSCore.cache.set(
      coreCacheKey,
      pages,
      ttlMs,
      [`rooms:${date}`, "rooms"]
    );

    console.log("🔔 Cambio en Notion detectado y enviado a los paneles");
  } catch (error) {
    console.error("⚠️ Error en Notion watcher:", error.message);
  } finally {
    notionWatcherRunning = false;
  }
}

function startNotionAssignmentWatcher() {
  setTimeout(checkNotionAssignmentChanges, 2500);

  const watcherTimer = setInterval(
    checkNotionAssignmentChanges,
    NOTION_WATCH_INTERVAL_MS
  );

  if (typeof watcherTimer.unref === "function") {
    watcherTimer.unref();
  }
}

startNotionAssignmentWatcher();


// =========================================================
// ESTADÍSTICAS CARE OS v1
// Rendimiento, calidad y rankings usando datos reales.
// =========================================================
function statisticsMinutesBetween(startValue, endValue, options = {}) {
  if (!startValue || !endValue) {
    return { valid: false, minutes: 0, reason: "missing_time" };
  }

  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  const minutes = (end - start) / 60000;
  const minMinutes = Number(options.minMinutes ?? 5);
  const maxMinutes = Number(options.maxMinutes ?? 720);

  if (!Number.isFinite(minutes)) {
    return { valid: false, minutes: 0, reason: "invalid_time" };
  }

  if (minutes < 0) {
    return { valid: false, minutes, reason: "negative_time" };
  }

  if (minutes < minMinutes) {
    return { valid: false, minutes, reason: "too_short" };
  }

  if (minutes > maxMinutes) {
    return { valid: false, minutes, reason: "too_long" };
  }

  return {
    valid: true,
    minutes: Number(minutes.toFixed(1)),
    reason: "",
  };
}

function statisticsAverage(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;

  return Number(
    (valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1)
  );
}

function statisticsNormalizePerson(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function statisticsSplitPeople(value) {
  return String(value || "")
    .split(/[,|]+/)
    .map(statisticsNormalizePerson)
    .filter(Boolean);
}

function statisticsReadLogPage(page) {
  const props = page?.properties || {};

  return {
    id: page.id,
    date:
      props.Date?.date?.start ||
      props.date?.date?.start ||
      "",
    time:
      props.Time?.date?.start ||
      props.time?.date?.start ||
      page.created_time ||
      "",
    unit: readRoomTextProperty(props, ["Unit", "unit", "Room"]),
    cleaner: readRoomTextProperty(props, ["Cleaner", "cleaner"]),
    inspector: readRoomTextProperty(props, ["Inspector", "inspector"]),
    cleanerError: readRoomTextProperty(props, ["Cleaner Error", "cleaner error"]),
    action: readRoomTextProperty(props, ["Action", "action"]),
    note: readRoomTextProperty(props, ["Note", "note"]),
    category: readRoomTextProperty(props, ["Category", "category"]),
    priority: readRoomTextProperty(props, ["Priority", "priority"]),
    status: readRoomTextProperty(props, ["Status", "status"]),
  };
}

async function getStatisticsLogs(date, forceRefresh = false) {
  if (!NOTION_LOG_DATABASE_ID) return [];

  const cacheKey = `statistics:logs:${date}`;
  const cached = !forceRefresh ? getCache(cacheKey) : null;
  if (cached) return cached;

  let results = [];
  let cursor;

  do {
    const query = {
      database_id: NOTION_LOG_DATABASE_ID,
      page_size: 100,
      filter: {
        property: "Date",
        date: {
          equals: date,
        },
      },
      sorts: [
        {
          property: "Time",
          direction: "ascending",
        },
      ],
    };

    if (cursor) query.start_cursor = cursor;

    const response = await notion.databases.query(query);
    results = results.concat(response.results || []);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  const logs = results.map(statisticsReadLogPage);
  setCache(cacheKey, logs, date === todayISO() ? 15000 : 120000);
  return logs;
}

function statisticsPayrollByCleaner(units) {
  const result = {};

  for (const unit of units) {
    const cleaner = statisticsNormalizePerson(unit.cleaner);
    if (!cleaner || dashboardStatusKey(unit.status) !== "ready") continue;

    const pay = getUnitPay(unit.unit);
    if (!result[cleaner]) result[cleaner] = 0;
    result[cleaner] += Number(pay.amount || 0);
  }

  for (const name of Object.keys(result)) {
    result[name] = Number(result[name].toFixed(2));
  }

  return result;
}

function buildCleanerStatistics(units, logs) {
  const cleaners = new Map();
  const payrollByCleaner = statisticsPayrollByCleaner(units);

  const ensureCleaner = (name) => {
    const cleanName = statisticsNormalizePerson(name);
    if (!cleanName) return null;

    if (!cleaners.has(cleanName)) {
      cleaners.set(cleanName, {
        name: cleanName,
        assigned: 0,
        completed: 0,
        inProgress: 0,
        pending: 0,
        arrivals: 0,
        urgent: 0,
        payroll: payrollByCleaner[cleanName] || 0,
        validTimes: [],
        unreliableTimes: 0,
        issues: 0,
        inspectionReports: 0,
        supplyRequests: 0,
        qualityScore: 100,
        completionRate: 0,
        fastestUnit: null,
        slowestUnit: null,
        units: [],
      });
    }

    return cleaners.get(cleanName);
  };

  for (const unit of units) {
    const cleaner = ensureCleaner(unit.cleaner);
    if (!cleaner) continue;

    cleaner.assigned += 1;
    if (unit.arrival) cleaner.arrivals += 1;
    if (unit.urgent) cleaner.urgent += 1;

    const status = dashboardStatusKey(unit.status);
    if (status === "ready") cleaner.completed += 1;
    else if (status === "inProgress") cleaner.inProgress += 1;
    else cleaner.pending += 1;

    const duration = statisticsMinutesBetween(
      unit.startedAt,
      unit.finishedAt,
      { minMinutes: 5, maxMinutes: 720 }
    );

    if (unit.startedAt || unit.finishedAt) {
      if (duration.valid) {
        cleaner.validTimes.push(duration.minutes);

        const unitTime = {
          unit: unit.unit,
          minutes: duration.minutes,
        };

        if (
          !cleaner.fastestUnit ||
          unitTime.minutes < cleaner.fastestUnit.minutes
        ) {
          cleaner.fastestUnit = unitTime;
        }

        if (
          !cleaner.slowestUnit ||
          unitTime.minutes > cleaner.slowestUnit.minutes
        ) {
          cleaner.slowestUnit = unitTime;
        }
      } else {
        cleaner.unreliableTimes += 1;
      }
    }

    cleaner.units.push({
      unit: unit.unit,
      status: unit.status,
      building: unit.building,
      arrival: unit.arrival,
      urgent: unit.urgent,
      minutes: duration.valid ? duration.minutes : null,
      reliableTime: duration.valid,
    });
  }

  for (const log of logs) {
    const action = String(log.action || "").toUpperCase();

    const errorCleaner =
      statisticsNormalizePerson(log.cleanerError) ||
      statisticsNormalizePerson(log.cleaner);

    if (["ISSUE", "LOST_FOUND"].includes(action)) {
      const cleaner = ensureCleaner(log.cleaner);
      if (cleaner) cleaner.issues += 1;
    }

    if (action === "SUPPLIES") {
      const cleaner = ensureCleaner(log.cleaner);
      if (cleaner) cleaner.supplyRequests += 1;
    }

    if (action === "INSPECTION_REPORT") {
      const cleaner = ensureCleaner(errorCleaner);
      if (cleaner) cleaner.inspectionReports += 1;
    }
  }

  return Array.from(cleaners.values())
    .map((cleaner) => {
      const averageMinutes = statisticsAverage(cleaner.validTimes);
      const completionRate = cleaner.assigned
        ? Number(((cleaner.completed / cleaner.assigned) * 100).toFixed(1))
        : 0;

      const qualityBase = cleaner.completed || cleaner.assigned;
      const qualityScore = qualityBase
        ? Math.max(
            0,
            Number(
              (
                ((qualityBase - cleaner.inspectionReports) / qualityBase) *
                100
              ).toFixed(1)
            )
          )
        : 100;

      return {
        ...cleaner,
        averageMinutes,
        completionRate,
        qualityScore,
        roomsPerHour:
          averageMinutes > 0
            ? Number((60 / averageMinutes).toFixed(2))
            : 0,
        validTimeCount: cleaner.validTimes.length,
        validTimes: undefined,
      };
    })
    .sort((a, b) => {
      if (b.completed !== a.completed) return b.completed - a.completed;
      return a.averageMinutes - b.averageMinutes;
    });
}

function buildInspectorStatistics(units, logs, reports) {
  const inspectors = new Map();

  const ensureInspector = (name) => {
    const cleanName = statisticsNormalizePerson(name);
    if (!cleanName) return null;

    if (!inspectors.has(cleanName)) {
      inspectors.set(cleanName, {
        name: cleanName,
        assigned: 0,
        inspectionsStarted: 0,
        readyCompleted: 0,
        inspectionReports: 0,
        supplyRequests: 0,
        reportsCreated: 0,
        validTimes: [],
        unreliableTimes: 0,
        averageMinutes: 0,
        qualityFindRate: 0,
      });
    }

    return inspectors.get(cleanName);
  };

  // Assigned muestra carga planificada, no se usa como "completadas".
  for (const unit of units) {
    for (const person of statisticsSplitPeople(unit.inspector)) {
      const inspector = ensureInspector(person);
      if (inspector) inspector.assigned += 1;
    }

    const duration = statisticsMinutesBetween(
      unit.inspectionStartedAt,
      unit.readyAt,
      { minMinutes: 1, maxMinutes: 240 }
    );

    if (duration.valid) {
      // Sólo se puede atribuir con certeza si hay un único inspector asignado.
      const people = statisticsSplitPeople(unit.inspector);
      if (people.length === 1) {
        ensureInspector(people[0]).validTimes.push(duration.minutes);
      }
    }
  }

  for (const log of logs) {
    const inspectorName = statisticsNormalizePerson(log.inspector);
    const inspector = ensureInspector(inspectorName);
    if (!inspector) continue;

    const action = String(log.action || "").toUpperCase();

    if (action === "INSPECTION_START") inspector.inspectionsStarted += 1;
    if (action === "READY_GUEST") inspector.readyCompleted += 1;
    if (action === "INSPECTION_REPORT") inspector.inspectionReports += 1;
    if (action === "INSPECTION_SUPPLIES") inspector.supplyRequests += 1;
  }

  for (const report of reports) {
    const role = cleanEmployeeText(report.role);
    if (!role.includes("inspect")) continue;

    const inspector = ensureInspector(report.employee);
    if (inspector) inspector.reportsCreated += 1;
  }

  return Array.from(inspectors.values())
    .map((inspector) => {
      const totalInspectionActions =
        inspector.readyCompleted + inspector.inspectionReports;

      return {
        ...inspector,
        averageMinutes: statisticsAverage(inspector.validTimes),
        validTimeCount: inspector.validTimes.length,
        qualityFindRate: totalInspectionActions
          ? Number(
              (
                (inspector.inspectionReports / totalInspectionActions) *
                100
              ).toFixed(1)
            )
          : 0,
        validTimes: undefined,
      };
    })
    .sort((a, b) => {
      if (b.readyCompleted !== a.readyCompleted) {
        return b.readyCompleted - a.readyCompleted;
      }

      return b.inspectionsStarted - a.inspectionsStarted;
    });
}

function buildBuildingStatistics(buildings) {
  return buildings
    .map((building) => {
      const validTimes = [];
      let unreliableTimes = 0;

      for (const unit of building.units || []) {
        const duration = statisticsMinutesBetween(
          unit.startedAt,
          unit.finishedAt,
          { minMinutes: 5, maxMinutes: 720 }
        );

        if (duration.valid) validTimes.push(duration.minutes);
        else if (unit.startedAt || unit.finishedAt) unreliableTimes += 1;
      }

      return {
        building: building.building,
        total: building.total,
        ready: building.ready,
        pending:
          building.pending +
          building.inProgress +
          building.awaitingInspection +
          building.inspectionStarted,
        urgent: building.urgent,
        completionRate: building.total
          ? Number(((building.ready / building.total) * 100).toFixed(1))
          : 0,
        averageCleaningMinutes: statisticsAverage(validTimes),
        validTimeCount: validTimes.length,
        unreliableTimes,
      };
    })
    .sort((a, b) => {
      if (b.completionRate !== a.completionRate) {
        return b.completionRate - a.completionRate;
      }

      return a.averageCleaningMinutes - b.averageCleaningMinutes;
    });
}

function buildStatisticsRankings(cleaners, inspectors, buildings) {
  const withReliableTime = cleaners.filter(
    (cleaner) => cleaner.validTimeCount > 0
  );

  const fastestCleaner = [...withReliableTime].sort(
    (a, b) => a.averageMinutes - b.averageMinutes
  )[0] || null;

  const mostRoomsCleaner = [...cleaners].sort(
    (a, b) => b.completed - a.completed
  )[0] || null;

  const bestQualityCleaner = [...cleaners]
    .filter((cleaner) => cleaner.completed > 0)
    .sort((a, b) => {
      if (b.qualityScore !== a.qualityScore) {
        return b.qualityScore - a.qualityScore;
      }

      return b.completed - a.completed;
    })[0] || null;

  const topInspector = [...inspectors].sort((a, b) => {
    if (b.readyCompleted !== a.readyCompleted) {
      return b.readyCompleted - a.readyCompleted;
    }

    return b.inspectionsStarted - a.inspectionsStarted;
  })[0] || null;

  const mostEfficientBuilding = [...buildings]
    .filter((building) => building.validTimeCount > 0)
    .sort((a, b) => {
      if (b.completionRate !== a.completionRate) {
        return b.completionRate - a.completionRate;
      }

      return a.averageCleaningMinutes - b.averageCleaningMinutes;
    })[0] || null;

  const mostDelayedBuilding = [...buildings].sort((a, b) => {
    if (b.pending !== a.pending) return b.pending - a.pending;
    return b.urgent - a.urgent;
  })[0] || null;

  return {
    fastestCleaner: fastestCleaner
      ? {
          name: fastestCleaner.name,
          averageMinutes: fastestCleaner.averageMinutes,
          completed: fastestCleaner.completed,
        }
      : null,
    mostRoomsCleaner: mostRoomsCleaner
      ? {
          name: mostRoomsCleaner.name,
          completed: mostRoomsCleaner.completed,
          assigned: mostRoomsCleaner.assigned,
        }
      : null,
    bestQualityCleaner: bestQualityCleaner
      ? {
          name: bestQualityCleaner.name,
          qualityScore: bestQualityCleaner.qualityScore,
          completed: bestQualityCleaner.completed,
        }
      : null,
    topInspector: topInspector
      ? {
          name: topInspector.name,
          readyCompleted: topInspector.readyCompleted,
          inspectionsStarted: topInspector.inspectionsStarted,
        }
      : null,
    mostEfficientBuilding: mostEfficientBuilding
      ? {
          building: mostEfficientBuilding.building,
          completionRate: mostEfficientBuilding.completionRate,
          averageCleaningMinutes:
            mostEfficientBuilding.averageCleaningMinutes,
        }
      : null,
    mostDelayedBuilding:
      mostDelayedBuilding && mostDelayedBuilding.pending > 0
        ? {
            building: mostDelayedBuilding.building,
            pending: mostDelayedBuilding.pending,
            urgent: mostDelayedBuilding.urgent,
          }
        : null,
  };
}

async function buildStatisticsData(date = todayISO(), forceRefresh = false) {
  const cacheKey = `statistics:data:${date}`;
  const cached = !forceRefresh ? getCache(cacheKey) : null;
  if (cached) return cached;

  const [dashboard, logs] = await Promise.all([
    buildDashboardData(date, forceRefresh),
    getStatisticsLogs(date, forceRefresh).catch((error) => {
      console.error("Statistics logs:", error.message);
      return [];
    }),
  ]);

  const cleaners = buildCleanerStatistics(dashboard.units || [], logs);
  const inspectors = buildInspectorStatistics(
    dashboard.units || [],
    logs,
    dashboard.recentReports || []
  );
  const buildings = buildBuildingStatistics(dashboard.buildings || []);
  const rankings = buildStatisticsRankings(
    cleaners,
    inspectors,
    buildings
  );

  const completedRooms = cleaners.reduce(
    (sum, cleaner) => sum + cleaner.completed,
    0
  );
  const inspectionErrors = cleaners.reduce(
    (sum, cleaner) => sum + cleaner.inspectionReports,
    0
  );
  const reliableCleaningTimes = cleaners.reduce(
    (sum, cleaner) => sum + cleaner.validTimeCount,
    0
  );
  const unreliableCleaningTimes = cleaners.reduce(
    (sum, cleaner) => sum + cleaner.unreliableTimes,
    0
  );

  const payload = {
    ok: true,
    date,
    generatedAt: new Date().toISOString(),
    summary: {
      totalUnits: dashboard.stats?.totalUnits || 0,
      ready: dashboard.stats?.ready || 0,
      completionRate: dashboard.stats?.totalUnits
        ? Number(
            (
              ((dashboard.stats?.ready || 0) /
                dashboard.stats.totalUnits) *
              100
            ).toFixed(1)
          )
        : 0,
      averageCleaningMinutes:
        dashboard.averages?.averageCleaningMinutes || 0,
      averageInspectionMinutes:
        dashboard.averages?.averageInspectionMinutes || 0,
      payroll: dashboard.payroll?.total || 0,
      activeEmployees: dashboard.employees?.active || 0,
      reports: dashboard.stats?.reports || 0,
      problems: dashboard.stats?.problems || 0,
      completedRooms,
      inspectionErrors,
      reliableCleaningTimes,
      unreliableCleaningTimes,
    },
    quality: {
      inspectionErrors,
      estimatedPassRate: completedRooms
        ? Math.max(
            0,
            Number(
              (
                ((completedRooms - inspectionErrors) /
                  completedRooms) *
                100
              ).toFixed(1)
            )
          )
        : 100,
      reports: dashboard.stats?.reports || 0,
      openProblems: dashboard.stats?.problems || 0,
    },
    rankings,
    cleaners,
    inspectors,
    buildings,
    timeRules: {
      cleaningMinimumMinutes: 5,
      cleaningMaximumMinutes: 720,
      inspectionMinimumMinutes: 1,
      inspectionMaximumMinutes: 240,
      note:
        "Los tiempos fuera de estos rangos se marcan como no confiables y no afectan los promedios.",
    },
  };

  setCache(cacheKey, payload, date === todayISO() ? 15000 : 120000);
  return payload;
}

app.get("/statistics-data", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const forceRefresh = String(req.query.refresh || "") === "1";
    const payload = await buildStatisticsData(date, forceRefresh);
    res.json(payload);
  } catch (error) {
    console.error("Error en /statistics-data:", error.message);
    res.status(500).json({
      ok: false,
      date: String(req.query.date || todayISO()),
      message: error.message,
    });
  }
});



function statisticsDateRange(startDate, endDate, maxDays = 31) {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error("Rango de fechas inválido");
  }

  const dates = [];
  const cursor = new Date(start);

  while (cursor <= end && dates.length < maxDays) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  if (cursor <= end) throw new Error(`El rango máximo permitido es de ${maxDays} días`);
  return dates;
}

async function queryPagesByDateRange(databaseId, start, end, options = {}) {
  if (!databaseId) return [];

  const cacheKey = `range:${idWithoutDashes(databaseId)}:${start}:${end}:${options.dateProperty || "Date"}`;
  const cached = options.forceRefresh ? null : getCache(cacheKey);
  if (cached) return cached;

  const results = [];
  let cursor;

  do {
    const query = {
      database_id: databaseId,
      page_size: 100,
      filter: {
        and: [
          { property: options.dateProperty || "Date", date: { on_or_after: start } },
          { property: options.dateProperty || "Date", date: { on_or_before: end } },
        ],
      },
    };

    if (cursor) query.start_cursor = cursor;
    const response = await notion.databases.query(query);
    results.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  setCache(cacheKey, results, end === todayISO() ? 30000 : 5 * 60 * 1000);
  return results;
}

function groupByDate(items, getDate) {
  const grouped = new Map();
  for (const item of items) {
    const date = String(getDate(item) || "").slice(0, 10);
    if (!date) continue;
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(item);
  }
  return grouped;
}

app.get("/statistics-history", async (req, res) => {
  try {
    const end = String(req.query.end || todayISO()).trim();
    const defaultStartDate = new Date(`${end}T12:00:00`);
    defaultStartDate.setDate(defaultStartDate.getDate() - 6);
    const start = String(req.query.start || defaultStartDate.toISOString().slice(0, 10)).trim();
    const forceRefresh = String(req.query.refresh || "") === "1";

    const dates = statisticsDateRange(start, end, 31);
    const cacheKey = `statistics:history:v2:${start}:${end}`;
    const cached = forceRefresh ? null : getCache(cacheKey);
    if (cached) return res.json(cached);

    const [roomPages, payrollPages, reportPages, logPages] = await Promise.all([
      queryPagesByDateRange(NOTION_DATABASE_ID, start, end, { forceRefresh }),
      queryPagesByDateRange(NOTION_PAYROLL_DATABASE_ID, start, end, { forceRefresh }).catch(() => []),
      queryPagesByDateRange(NOTION_REPORTS_DATABASE_ID, start, end, { forceRefresh }).catch(() => []),
      queryPagesByDateRange(NOTION_LOG_DATABASE_ID, start, end, { forceRefresh }).catch(() => []),
    ]);

    const roomsByDate = groupByDate(roomPages, page => page.properties?.Date?.date?.start);
    const payrollByDate = groupByDate(payrollPages, page => page.properties?.Date?.date?.start);
    const reportsByDate = groupByDate(reportPages, page => page.properties?.Date?.date?.start);
    const logsByDate = groupByDate(logPages, page => page.properties?.Date?.date?.start);

    const days = dates.map(date => {
      const units = (roomsByDate.get(date) || []).map(pageToDashboardUnit);
      const payrollRecords = payrollByDate.get(date) || [];
      const reports = (reportsByDate.get(date) || []).map(reportPageToObject);
      const logs = (logsByDate.get(date) || []).map(statisticsReadLogPage);

      const ready = units.filter(unit => dashboardStatusKey(unit.status) === "ready").length;
      const totalUnits = units.length;

      const reliableCleaning = [];
      let unreliableCleaningTimes = 0;
      for (const unit of units) {
        const duration = statisticsMinutesBetween(unit.startedAt, unit.finishedAt, { minMinutes: 5, maxMinutes: 720 });
        if (duration.valid) reliableCleaning.push(duration.minutes);
        else if (unit.startedAt || unit.finishedAt) unreliableCleaningTimes += 1;
      }

      const inspectionTimes = [];
      for (const unit of units) {
        const duration = statisticsMinutesBetween(unit.inspectionStartedAt, unit.readyAt, { minMinutes: 1, maxMinutes: 240 });
        if (duration.valid) inspectionTimes.push(duration.minutes);
      }

      const payroll = payrollRecords.reduce(
        (sum, page) => sum + Number(page.properties?.Amount?.number || 0),
        0
      );

      const inspectionErrors = logs.filter(log => String(log.action || "").toUpperCase() === "INSPECTION_REPORT").length;
      const problems = reports.filter(report => {
        const category = cleanEmployeeText(report.aiCategory || report.category);
        const priority = cleanEmployeeText(report.aiPriority || report.priority);
        return priority.includes("urgent") || category.includes("maintenance") || category.includes("damage") || category.includes("lost");
      }).length;

      return {
        date,
        totalUnits,
        ready,
        completionRate: totalUnits ? Number(((ready / totalUnits) * 100).toFixed(1)) : 0,
        averageCleaningMinutes: statisticsAverage(reliableCleaning),
        averageInspectionMinutes: statisticsAverage(inspectionTimes),
        payroll: Number(payroll.toFixed(2)),
        problems,
        qualityScore: ready ? Math.max(0, Number((((ready - inspectionErrors) / ready) * 100).toFixed(1))) : 100,
        inspectionErrors,
        reliableCleaningTimes: reliableCleaning.length,
        unreliableCleaningTimes,
      };
    });

    const totalUnits = days.reduce((sum, day) => sum + day.totalUnits, 0);
    const totalReady = days.reduce((sum, day) => sum + day.ready, 0);
    const totalPayroll = days.reduce((sum, day) => sum + day.payroll, 0);
    const totalProblems = days.reduce((sum, day) => sum + day.problems, 0);

    const payload = {
      ok: true,
      start,
      end,
      generatedAt: new Date().toISOString(),
      source: "range-query-v2",
      summary: {
        days: days.length,
        totalUnits,
        totalReady,
        completionRate: totalUnits ? Number(((totalReady / totalUnits) * 100).toFixed(1)) : 0,
        totalPayroll: Number(totalPayroll.toFixed(2)),
        totalProblems,
        averageCleaningMinutes: statisticsAverage(days.filter(day => day.averageCleaningMinutes > 0).map(day => day.averageCleaningMinutes)),
        averageQualityScore: statisticsAverage(days.map(day => day.qualityScore)),
      },
      days,
    };

    setCache(cacheKey, payload, end === todayISO() ? 10 * 60 * 1000 : 30 * 60 * 1000);
    res.json(payload);
  } catch (error) {
    console.error("Error en /statistics-history:", error.message);
    res.status(400).json({ ok: false, message: error.message });
  }
});


app.post("/statistics-preload", async (req, res) => {
  try {
    const end = String(req.body?.end || todayISO()).trim();
    const ranges = [7, 14, 30];

    res.json({
      ok: true,
      end,
      ranges,
      message: "Precarga iniciada",
    });

    setImmediate(async () => {
      for (const rangeDays of ranges) {
        try {
          const endDate = new Date(`${end}T12:00:00`);
          const startDate = new Date(endDate);
          startDate.setDate(startDate.getDate() - (rangeDays - 1));

          const start = startDate.toISOString().slice(0, 10);
          const cacheKey = `statistics:history:${start}:${end}`;

          if (getCache(cacheKey)) continue;

          const dates = statisticsDateRange(start, end, 31);
          const days = [];

          for (const date of dates) {
            try {
              const day = await buildStatisticsData(date, false);

              days.push({
                date,
                totalUnits: day.summary?.totalUnits || 0,
                ready: day.summary?.ready || 0,
                completionRate: day.summary?.completionRate || 0,
                averageCleaningMinutes:
                  day.summary?.averageCleaningMinutes || 0,
                averageInspectionMinutes:
                  day.summary?.averageInspectionMinutes || 0,
                payroll: day.summary?.payroll || 0,
                problems: day.summary?.problems || 0,
                qualityScore:
                  day.quality?.estimatedPassRate ?? 100,
                inspectionErrors:
                  day.quality?.inspectionErrors || 0,
                reliableCleaningTimes:
                  day.summary?.reliableCleaningTimes || 0,
                unreliableCleaningTimes:
                  day.summary?.unreliableCleaningTimes || 0,
              });
            } catch (error) {
              days.push({
                date,
                totalUnits: 0,
                ready: 0,
                completionRate: 0,
                averageCleaningMinutes: 0,
                averageInspectionMinutes: 0,
                payroll: 0,
                problems: 0,
                qualityScore: 100,
                inspectionErrors: 0,
                reliableCleaningTimes: 0,
                unreliableCleaningTimes: 0,
                error: error.message,
              });
            }
          }

          const totalUnits = days.reduce((sum, day) => sum + day.totalUnits, 0);
          const totalReady = days.reduce((sum, day) => sum + day.ready, 0);
          const totalPayroll = days.reduce((sum, day) => sum + day.payroll, 0);
          const totalProblems = days.reduce((sum, day) => sum + day.problems, 0);

          const payload = {
            ok: true,
            source: "preloaded-range-v3",
            start,
            end,
            generatedAt: new Date().toISOString(),
            summary: {
              days: days.length,
              totalUnits,
              totalReady,
              completionRate: totalUnits
                ? Number(((totalReady / totalUnits) * 100).toFixed(1))
                : 0,
              totalPayroll: Number(totalPayroll.toFixed(2)),
              totalProblems,
              averageCleaningMinutes: statisticsAverage(
                days
                  .filter((day) => day.averageCleaningMinutes > 0)
                  .map((day) => day.averageCleaningMinutes)
              ),
              averageQualityScore: statisticsAverage(
                days
                  .filter((day) => Number.isFinite(day.qualityScore))
                  .map((day) => day.qualityScore)
              ),
            },
            days,
          };

          setCache(
            cacheKey,
            payload,
            end === todayISO() ? 10 * 60 * 1000 : 30 * 60 * 1000
          );
        } catch (error) {
          console.error(`Statistics preload ${rangeDays}:`, error.message);
        }
      }
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
    });
  }
});


// =========================================================
// PERFIL INDIVIDUAL DE LIMPIADOR v1
// Una consulta por rango, caché y máximo 31 días.
// =========================================================
function cleanerProfileNameMatches(value, targetName) {
  const target = cleanEmployeeText(targetName);
  const raw = String(value || "");

  if (!target || !raw.trim()) return false;
  if (cleanEmployeeText(raw) === target) return true;

  return raw
    .split(/[,|]+/)
    .map((name) => cleanEmployeeText(name))
    .filter(Boolean)
    .includes(target);
}

function cleanerProfilePayrollObject(page) {
  const props = page?.properties || {};

  return {
    date: props.Date?.date?.start || "",
    cleaner: readRoomTextProperty(props, ["Cleaner", "cleaner"]),
    unit: readRoomTextProperty(props, ["Unit", "unit"]),
    amount: Number(props.Amount?.number || 0),
    roomType: readRoomTextProperty(props, ["Room Type", "room type"]),
  };
}

function cleanerProfilePhotoObject(page) {
  const props = page?.properties || {};

  return {
    id: page.id,
    date: readPlainTextFromProp(props.Date || props.date),
    reportId: readPlainTextFromProp(props["Report ID"] || props.Report),
    unit: readPlainTextFromProp(props.Unit || props.unit),
    employee: readPlainTextFromProp(
      props.Employee || props["Employee Name"] || props.Name
    ),
    url: (props["Photo URL"] || props.URL || props["Image URL"] || {})?.url || "",
  };
}

function cleanerProfileReportId(value) {
  let reportId = String(value || "").trim().split(" - ")[0];
  if (reportId && !reportId.startsWith("RPT-")) reportId = `RPT-${reportId}`;
  return reportId;
}

async function buildCleanerProfileData({ name, start, end, forceRefresh = false }) {
  const cleanName = statisticsNormalizePerson(name);

  if (!cleanName) {
    throw new Error("Nombre del limpiador requerido");
  }

  const dates = statisticsDateRange(start, end, 31);
  const cacheKey = `cleaner-profile:v2:${cleanEmployeeText(cleanName)}:${start}:${end}`;
  const cached = forceRefresh ? null : getCache(cacheKey);
  if (cached) return cached;

  const [roomPages, payrollPages, logPages, reportPages, photoPages] = await Promise.all([
    queryPagesByDateRange(NOTION_DATABASE_ID, start, end, { forceRefresh }),
    queryPagesByDateRange(NOTION_PAYROLL_DATABASE_ID, start, end, { forceRefresh }).catch(() => []),
    queryPagesByDateRange(NOTION_LOG_DATABASE_ID, start, end, { forceRefresh }).catch(() => []),
    queryPagesByDateRange(NOTION_REPORTS_DATABASE_ID, start, end, { forceRefresh }).catch(() => []),
    queryPagesByDateRange(NOTION_REPORT_PHOTOS_DATABASE_ID, start, end, { forceRefresh }).catch(() => []),
  ]);

  const allUnits = roomPages.map(pageToDashboardUnit);
  const units = allUnits.filter((unit) => cleanerProfileNameMatches(unit.cleaner, cleanName));

  if (!units.length) {
    const knownFromPayroll = payrollPages.some((page) =>
      cleanerProfileNameMatches(
        readRoomTextProperty(page.properties || {}, ["Cleaner", "cleaner"]),
        cleanName
      )
    );

    if (!knownFromPayroll) {
      const error = new Error(`No encontré actividad para ${cleanName} en este rango`);
      error.status = 404;
      throw error;
    }
  }

  const payroll = payrollPages
    .map(cleanerProfilePayrollObject)
    .filter((record) => cleanerProfileNameMatches(record.cleaner, cleanName));

  const logs = logPages
    .map(statisticsReadLogPage)
    .filter((log) =>
      cleanerProfileNameMatches(log.cleaner, cleanName) ||
      cleanerProfileNameMatches(log.cleanerError, cleanName)
    );

  const reports = reportPages
    .map(reportPageToObject)
    .filter((report) => cleanerProfileNameMatches(report.employee, cleanName));

  const photos = photoPages
    .map(cleanerProfilePhotoObject)
    .filter((photo) =>
      cleanerProfileNameMatches(photo.employee, cleanName) ||
      reports.some((report) =>
        cleanerProfileReportId(report.reportId) === cleanerProfileReportId(photo.reportId)
      )
    )
    .filter((photo) => !!photo.url);

  const photosByReportId = new Map();
  for (const photo of photos) {
    const reportId = cleanerProfileReportId(photo.reportId);
    if (!photosByReportId.has(reportId)) photosByReportId.set(reportId, []);
    photosByReportId.get(reportId).push(photo);
  }

  const reportsByUnitDate = new Map();
  for (const report of reports) {
    const key = `${String(report.date).slice(0, 10)}|${normalizeRoom(report.unit)}`;
    const reportId = cleanerProfileReportId(report.reportId);

    if (!reportsByUnitDate.has(key)) reportsByUnitDate.set(key, []);
    reportsByUnitDate.get(key).push({
      ...report,
      reportId,
      photos: photosByReportId.get(reportId) || [],
    });
  }

  const payrollByUnitDate = new Map();
  for (const record of payroll) {
    payrollByUnitDate.set(
      `${String(record.date).slice(0, 10)}|${normalizeRoom(record.unit)}`,
      record.amount
    );
  }

  const logsByUnitDate = new Map();
  for (const log of logs) {
    const key = `${String(log.date).slice(0, 10)}|${normalizeRoom(log.unit)}`;
    if (!logsByUnitDate.has(key)) logsByUnitDate.set(key, []);
    logsByUnitDate.get(key).push(log);
  }

  const dailyMap = new Map(
    dates.map((date) => [
      date,
      {
        date,
        assigned: 0,
        completed: 0,
        arrivals: 0,
        urgent: 0,
        payroll: 0,
        validTimes: [],
        unreliableTimes: 0,
        inspectionErrors: 0,
        issues: 0,
        supplies: 0,
      },
    ])
  );

  const unitRows = units.map((unit) => {
    const date = String(unit.date || "").slice(0, 10);
    const day = dailyMap.get(date);
    const statusKey = dashboardStatusKey(unit.status);
    const completed = statusKey === "ready";
    const duration = statisticsMinutesBetween(unit.startedAt, unit.finishedAt, {
      minMinutes: 5,
      maxMinutes: 720,
    });
    const key = `${date}|${normalizeRoom(unit.unit)}`;
    const unitLogs = logsByUnitDate.get(key) || [];
    const inspectionErrors = unitLogs.filter(
      (log) => String(log.action || "").toUpperCase() === "INSPECTION_REPORT"
    ).length;
    const issues = unitLogs.filter((log) =>
      ["ISSUE", "LOST_FOUND"].includes(String(log.action || "").toUpperCase())
    ).length;
    const supplies = unitLogs.filter(
      (log) => String(log.action || "").toUpperCase() === "SUPPLIES"
    ).length;
    const amount = payrollByUnitDate.get(key) ?? (completed ? Number(getUnitPay(unit.unit).amount || 0) : 0);
    const qualityScore = completed
      ? Math.max(0, Number((((1 - inspectionErrors) / 1) * 100).toFixed(1)))
      : null;
    const unitReports = reportsByUnitDate.get(key) || [];
    const unitPhotos = unitReports.flatMap((report) => report.photos || []);
    const actionHistory = unitLogs
      .map((log) => ({
        action: log.action || "",
        time: log.time || "",
        note: log.note || "",
        category: log.category || "",
        priority: log.priority || "",
        inspector: log.inspector || "",
      }))
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));

    if (day) {
      day.assigned += 1;
      if (completed) day.completed += 1;
      if (unit.arrival) day.arrivals += 1;
      if (unit.urgent) day.urgent += 1;
      day.payroll += amount;
      day.inspectionErrors += inspectionErrors;
      day.issues += issues;
      day.supplies += supplies;

      if (duration.valid) day.validTimes.push(duration.minutes);
      else if (unit.startedAt || unit.finishedAt) day.unreliableTimes += 1;
    }

    return {
      id: unit.id,
      date,
      unit: unit.unit,
      building: unit.building,
      status: unit.status,
      arrival: !!unit.arrival,
      urgent: !!unit.urgent,
      startedAt: unit.startedAt,
      finishedAt: unit.finishedAt,
      minutes: duration.valid ? duration.minutes : null,
      reliableTime: duration.valid,
      timeReason: duration.reason || "",
      payroll: Number(amount.toFixed(2)),
      inspectionErrors,
      issues,
      supplies,
      qualityScore,
      reportsCount: unitReports.length,
      photosCount: unitPhotos.length,
      reports: unitReports.map((report) => ({
        reportId: report.reportId,
        action: report.action,
        message: report.message,
        aiCategory: report.aiCategory,
        aiPriority: report.aiPriority,
        aiSummary: report.aiSummary,
        status: report.status,
        time: report.time,
        photos: (report.photos || []).map((photo) => ({
          id: photo.id,
          url: photo.url,
        })),
      })),
      actions: actionHistory,
    };
  });

  for (const log of logs) {
    const date = String(log.date || "").slice(0, 10);
    const day = dailyMap.get(date);
    if (!day) continue;

    const action = String(log.action || "").toUpperCase();
    if (action === "INSPECTION_REPORT") day.inspectionErrors += 1;
    if (["ISSUE", "LOST_FOUND"].includes(action)) day.issues += 1;
    if (action === "SUPPLIES") day.supplies += 1;
  }

  const daily = Array.from(dailyMap.values()).map((day) => {
    const averageMinutes = statisticsAverage(day.validTimes);
    const qualityBase = day.completed || day.assigned;

    return {
      date: day.date,
      assigned: day.assigned,
      completed: day.completed,
      completionRate: day.assigned
        ? Number(((day.completed / day.assigned) * 100).toFixed(1))
        : 0,
      arrivals: day.arrivals,
      urgent: day.urgent,
      payroll: Number(day.payroll.toFixed(2)),
      averageMinutes,
      validTimeCount: day.validTimes.length,
      unreliableTimes: day.unreliableTimes,
      inspectionErrors: day.inspectionErrors,
      issues: day.issues,
      supplies: day.supplies,
      qualityScore: qualityBase
        ? Math.max(
            0,
            Number(
              (((qualityBase - day.inspectionErrors) / qualityBase) * 100).toFixed(1)
            )
          )
        : 100,
    };
  });

  const assigned = unitRows.length;
  const completed = unitRows.filter((unit) => dashboardStatusKey(unit.status) === "ready").length;
  const validTimes = unitRows.filter((unit) => unit.reliableTime).map((unit) => unit.minutes);
  const unreliableTimes = unitRows.filter(
    (unit) => !unit.reliableTime && (unit.startedAt || unit.finishedAt)
  ).length;
  const totalPayroll = payroll.length
    ? payroll.reduce((sum, record) => sum + record.amount, 0)
    : unitRows.reduce((sum, unit) => sum + unit.payroll, 0);
  const inspectionErrors = logs.filter(
    (log) => String(log.action || "").toUpperCase() === "INSPECTION_REPORT"
  ).length;
  const issues = logs.filter((log) =>
    ["ISSUE", "LOST_FOUND"].includes(String(log.action || "").toUpperCase())
  ).length;
  const supplies = logs.filter(
    (log) => String(log.action || "").toUpperCase() === "SUPPLIES"
  ).length;
  const qualityBase = completed || assigned;

  const daysWithWork = daily.filter((day) => day.assigned > 0);
  const bestDay = [...daysWithWork].sort((a, b) => {
    if (b.completed !== a.completed) return b.completed - a.completed;
    return a.averageMinutes - b.averageMinutes;
  })[0] || null;
  const fastestDay = [...daysWithWork]
    .filter((day) => day.validTimeCount > 0)
    .sort((a, b) => a.averageMinutes - b.averageMinutes)[0] || null;
  const highestPayrollDay = [...daysWithWork].sort((a, b) => b.payroll - a.payroll)[0] || null;
  const mostErrorsDay = [...daysWithWork].sort((a, b) => b.inspectionErrors - a.inspectionErrors)[0] || null;

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    start,
    end,
    cleaner: {
      name: cleanName,
      role: "Cleaner",
    },
    summary: {
      assigned,
      completed,
      completionRate: assigned
        ? Number(((completed / assigned) * 100).toFixed(1))
        : 0,
      arrivals: unitRows.filter((unit) => unit.arrival).length,
      urgent: unitRows.filter((unit) => unit.urgent).length,
      averageMinutes: statisticsAverage(validTimes),
      roomsPerHour: statisticsAverage(validTimes) > 0
        ? Number((60 / statisticsAverage(validTimes)).toFixed(2))
        : 0,
      payroll: Number(totalPayroll.toFixed(2)),
      qualityScore: qualityBase
        ? Math.max(
            0,
            Number((((qualityBase - inspectionErrors) / qualityBase) * 100).toFixed(1))
          )
        : 100,
      inspectionErrors,
      issues,
      supplies,
      reports: reports.length,
      validTimeCount: validTimes.length,
      unreliableTimes,
    },
    highlights: {
      bestDay,
      fastestDay,
      highestPayrollDay,
      mostErrorsDay: mostErrorsDay?.inspectionErrors > 0 ? mostErrorsDay : null,
    },
    daily,
    units: unitRows.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return a.unit.localeCompare(b.unit);
    }),
  };

  setCache(cacheKey, payload, end === todayISO() ? 10 * 60 * 1000 : 30 * 60 * 1000);
  return payload;
}

app.get("/cleaner-profile-data", async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    const end = String(req.query.end || todayISO()).trim();
    const defaultStart = new Date(`${end}T12:00:00`);
    defaultStart.setDate(defaultStart.getDate() - 6);
    const start = String(req.query.start || defaultStart.toISOString().slice(0, 10)).trim();
    const forceRefresh = String(req.query.refresh || "") === "1";

    const payload = await buildCleanerProfileData({
      name,
      start,
      end,
      forceRefresh,
    });

    res.json(payload);
  } catch (error) {
    console.error("Error en /cleaner-profile-data:", error.message);
    res.status(error.status || 400).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/cleaner-profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cleaner-profile.html"));
});

app.get("/statistics", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "statistics.html"));
});



// =========================================================
// DATA API CENTRAL · POSTGRESQL FIRST · FASE 1
// =========================================================
// Estas rutas son la nueva fuente común para Dashboard, Cleaning,
// Inspectores, Payroll y la futura app móvil. Los paneles anteriores
// siguen funcionando mientras migramos uno por uno.
app.get("/api/v2/health", async (req, res) => {
  try {
    res.json(await getDataApiHealth());
  } catch (error) {
    res.status(503).json({
      ok: false,
      source: "postgres",
      message: error.message,
    });
  }
});

app.get("/api/v2/employees", async (req, res) => {
  try {
    const activeOnly = String(req.query.active || "1") !== "0";
    const employees = await listDataApiEmployees({ activeOnly });

    res.json({
      ok: true,
      source: "postgres",
      count: employees.length,
      employees,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/v2/rooms", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const elevated = /admin|manager|operations|dispatch/i.test(String(req.auth?.role || ""));
    const employee = elevated
      ? String(req.query.employee || "").trim()
      : String(req.auth?.employee_name || "").trim();
    const role = elevated ? String(req.query.role || "").trim() : "";

    const rooms = await listDataApiRooms({
      date,
      employee,
      role,
    });

    // Pre-inspection is currently event-backed in PostgreSQL.
    // The rooms table does not yet expose these fields, so derive the latest
    // authoritative state from operations_logs instead of falling back to Notion.
    const preInspectionResult = await postgresQuery(
      `
        SELECT DISTINCT ON (normalized_room)
          normalized_room,
          action,
          event_time
        FROM operations_logs
        WHERE work_date = $1::date
          AND action IN ('PRE_INSPECTION_START', 'PRE_INSPECTION_COMPLETE')
        ORDER BY normalized_room, event_time DESC, id DESC
      `,
      [date]
    );

    const preInspectionByRoom = new Map(
      preInspectionResult.rows.map((row) => [
        String(row.normalized_room || ""),
        row
      ])
    );

    const enrichedRooms = rooms.map((room) => {
      const latest = preInspectionByRoom.get(
        String(room.normalizedRoom || "")
      );

      if (!latest) {
        return {
          ...room,
          preInspection: Boolean(room.preInspection),
          preInspectionStarted: Boolean(room.preInspectionStarted),
        };
      }

      const completed = latest.action === "PRE_INSPECTION_COMPLETE";

      return {
        ...room,
        preInspection: completed,
        preInspectionStarted: !completed,
        preInspectionStartedAt: !completed ? latest.event_time : null,
        preInspectionCompletedAt: completed ? latest.event_time : null,
      };
    });

    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({
      ok: true,
      source: "postgres",
      date,
      count: enrichedRooms.length,
      rooms: enrichedRooms,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
    });
  }
});


app.get("/api/v2/operations", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const requestedLimit = Number(req.query.limit || 250);
    const limit = Math.min(Math.max(requestedLimit, 1), 500);

    const result = await postgresQuery(
      `
        SELECT
          id,
          notion_id,
          external_event_id,
          work_date,
          event_time,
          unit,
          normalized_room,
          action,
          cleaner,
          inspector,
          employee,
          role_worked,
          note,
          photo_url,
          category,
          priority,
          source,
          created_at
        FROM operations_logs
        WHERE work_date = $1::date
        ORDER BY event_time DESC, id DESC
        LIMIT $2
      `,
      [date, limit]
    );

    const events = result.rows.map((row) => ({
      id: String(row.id),
      notionId: row.notion_id || "",
      externalEventId: row.external_event_id || "",
      date: row.work_date,
      eventTime: row.event_time,
      time: row.event_time
        ? new Date(row.event_time).toLocaleString("en-US", {
            timeZone: "America/Chicago",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          })
        : "",
      unit: row.unit || "",
      normalizedRoom: row.normalized_room || "",
      action: row.action || "",
      cleaner: row.cleaner || "",
      inspector: row.inspector || "",
      employee:
        row.employee ||
        row.cleaner ||
        row.inspector ||
        "",
      person:
        row.employee ||
        row.cleaner ||
        row.inspector ||
        "",
      role: row.role_worked || "",
      note: row.note || "",
      photoUrl: row.photo_url || "",
      category: row.category || "Other",
      priority: row.priority || "Normal",
      source: row.source || "postgres",
      createdAt: row.created_at,
    }));

    return res.json({
      ok: true,
      source: "postgres",
      date,
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("Error en /api/v2/operations:", error.message);

    return res.status(500).json({
      ok: false,
      source: "postgres",
      count: 0,
      events: [],
      message: error.message,
    });
  }
});

app.get("/api/v2/dashboard", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    res.json(await getDataApiDashboard(date));
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/v2/payroll", async (req, res) => {
  try {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();

    res.json(
      await getDataApiPayrollWeek({
        start,
        end,
      })
    );
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/v2/bootstrap", async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    const employee = String(req.query.employee || "").trim();
    const role = String(req.query.role || "").trim();
    const weekStart = String(req.query.weekStart || "").trim();
    const weekEnd = String(req.query.weekEnd || "").trim();

    res.json(
      await getDataApiBootstrap({
        date,
        employee,
        role,
        weekStart,
        weekEnd,
      })
    );
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
    });
  }
});



// =========================================================
// SYNC QUEUE WORKER · NOTION
// =========================================================
let syncQueueTimer = null;
let syncQueueBusy = false;

async function processNotionQueueOnce() {
  if (syncQueueBusy || !postgresStatus.connected) {
    return;
  }

  syncQueueBusy = true;

  try {
    const result = await processNextSyncJob({
      destination: "notion",
      processors: {
        "notion-room-action": async (payload) => {
          const result = await updateNotionRoom(
            payload.unit,
            payload.action,
            payload.name,
            payload.note || "",
            payload.role || "",
            payload.photoUrl || ""
          );

          io.emit("notion-action-synced", {
            ok: true,
            action: payload.action,
            unit: payload.unit,
            employee: payload.name,
            updatedAt: new Date().toISOString(),
          });

          return result;
        },
      },
    });

    if (result.processed && !result.ok) {
      const payload = result.job?.payload || {};

      console.error("⚠️ sync_queue reintentará trabajo:", {
        id: result.job?.id,
        action: payload.action,
        unit: payload.unit,
        attempts: result.job?.attempts,
        error: result.error?.message || result.job?.last_error,
      });

      if (result.exhausted) {
        addNotification(
          "🔴 Sincronización con Notion agotada",
          `${payload.action || "ACTION"} · ${payload.unit || ""}: ${
            result.error?.message || result.job?.last_error || "Error desconocido"
          }`
        );
      }
    }
  } catch (error) {
    console.error("SYNC QUEUE WORKER ERROR:", error.message);
  } finally {
    syncQueueBusy = false;
  }
}

function startSyncQueueWorker() {
  if (syncQueueTimer) {
    return;
  }

  const intervalMs = Math.max(
    2000,
    Number(process.env.SYNC_QUEUE_INTERVAL_MS || 5000)
  );

  recoverStaleJobs(
    Number(process.env.SYNC_QUEUE_STALE_MINUTES || 10)
  ).catch((error) => {
    console.error("SYNC QUEUE RECOVERY ERROR:", error.message);
  });

  processNotionQueueOnce();

  syncQueueTimer = setInterval(
    processNotionQueueOnce,
    intervalMs
  );

  console.log(`✅ Sync Queue Worker activo cada ${intervalMs}ms`);
}

app.get("/api/sync-queue/status", async (req, res) => {
  try {
    const status = await getSyncQueueStatus();

    return res.json({
      ok: true,
      ...status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.post("/api/sync-queue/retry", async (req, res) => {
  try {
    const retried = await retryFailedJobs();

    setImmediate(() => {
      processNotionQueueOnce();
    });

    return res.json({
      ok: true,
      retried,
      message: `${retried} trabajos enviados de nuevo a la cola`,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});


// =========================================================
// ADMIN CENTER · ROOMS MANAGER
// =========================================================
// =========================================================
// SERVICE ORDERS · HOTSOS-STYLE ROOM REQUESTS
// =========================================================
// =========================================================
// CARE COMMUNICATIONS · CHAT + ANNOUNCEMENTS
// =========================================================
app.get("/api/communications", async (req, res) => {
  try {
    if (!postgresStatus.connected) return res.status(503).json({ ok:false, message:"PostgreSQL no está conectado" });
    const [messages, announcements] = await Promise.all([
      postgresQuery(`SELECT id,sender,sender_role AS "senderRole",message,channel,created_at AS "createdAt" FROM team_messages WHERE channel=$1 ORDER BY created_at DESC LIMIT 100`, [String(req.query.channel || "general")]),
      postgresQuery(`SELECT id,title,body,priority,author,active,expires_at AS "expiresAt",created_at AS "createdAt" FROM announcements WHERE active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'important' THEN 2 ELSE 3 END, created_at DESC LIMIT 50`),
    ]);
    return res.json({ ok:true, messages:messages.rows.reverse(), announcements:announcements.rows });
  } catch (error) {
    console.error("COMMUNICATIONS LIST ERROR:", error.message);
    return res.status(500).json({ ok:false, message:error.message });
  }
});

app.post("/api/communications/messages", async (req, res) => {
  try {
    const sender=String(req.body.sender || "").trim();
    const message=String(req.body.message || "").trim().slice(0,2000);
    if(!sender || !message) return res.status(400).json({ok:false,message:"Nombre y mensaje son requeridos"});
    const result=await postgresQuery(`INSERT INTO team_messages(sender,sender_role,message,channel) VALUES($1,$2,$3,$4) RETURNING id,sender,sender_role AS "senderRole",message,channel,created_at AS "createdAt"`,[sender,String(req.body.senderRole||""),message,String(req.body.channel||"general")]);
    io.emit("communications:message",result.rows[0]);
    return res.json({ok:true,message:result.rows[0]});
  } catch(error){return res.status(500).json({ok:false,message:error.message});}
});

app.post("/api/communications/announcements", async (req, res) => {
  try {
    const title=String(req.body.title||"").trim().slice(0,160), body=String(req.body.body||"").trim().slice(0,4000);
    if(!title||!body)return res.status(400).json({ok:false,message:"Título y anuncio son requeridos"});
    const priority=["normal","important","urgent"].includes(req.body.priority)?req.body.priority:"normal";
    const result=await postgresQuery(`INSERT INTO announcements(title,body,priority,author,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id,title,body,priority,author,active,expires_at AS "expiresAt",created_at AS "createdAt"`,[title,body,priority,String(req.body.author||""),req.body.expiresAt||null]);
    io.emit("communications:announcement",result.rows[0]);
    return res.json({ok:true,announcement:result.rows[0]});
  }catch(error){return res.status(500).json({ok:false,message:error.message});}
});

app.patch("/api/communications/announcements/:id", async (req,res)=>{
  try{
    const result=await postgresQuery(`UPDATE announcements SET active=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[Number(req.params.id),req.body.active!==false]);
    io.emit("communications:updated",{type:"announcement",id:Number(req.params.id)});
    return res.json({ok:true,announcement:result.rows[0]||null});
  }catch(error){return res.status(500).json({ok:false,message:error.message});}
});

// =========================================================
// ROOM CATALOG · REFERENCE PHOTOS + INVENTORY
// =========================================================
app.get("/api/rooms/:roomNumber/catalog", async (req,res)=>{
  try{
    const roomNumber=String(req.params.roomNumber||"").trim();
    const [room,photos,inventory,history]=await Promise.all([
      postgresQuery(`SELECT * FROM rooms WHERE normalized_room=$1 OR room_number=$2 ORDER BY work_date DESC LIMIT 1`,[normalizeRoom(roomNumber),roomNumber]),
      postgresQuery(`SELECT id,room_number AS "roomNumber",category,photo_url AS "photoUrl",caption,uploaded_by AS "uploadedBy",created_at AS "createdAt" FROM room_photos WHERE room_number=$1 ORDER BY created_at DESC`,[roomNumber]),
      postgresQuery(`SELECT id,room_number AS "roomNumber",item_name AS "itemName",expected_quantity AS "expectedQuantity",location,notes,active,updated_by AS "updatedBy",updated_at AS "updatedAt" FROM room_inventory WHERE room_number=$1 AND active=TRUE ORDER BY item_name`,[roomNumber]),
      postgresQuery(`SELECT id,event_time AS "eventTime",action,employee,note,photo_url AS "photoUrl" FROM operations_logs WHERE normalized_room=$1 ORDER BY event_time DESC LIMIT 100`,[normalizeRoom(roomNumber)]),
    ]);
    return res.json({ok:true,room:room.rows[0]||null,photos:photos.rows,inventory:inventory.rows,history:history.rows});
  }catch(error){return res.status(500).json({ok:false,message:error.message});}
});

app.post("/api/rooms/:roomNumber/catalog/photos", upload.single("photo"), async (req,res)=>{
  try{
    if(!req.file)return res.status(400).json({ok:false,message:"Selecciona una fotografía"});
    const roomNumber=String(req.params.roomNumber||"").trim();
    const dataUri=`data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const uploaded=await cloudinary.uploader.upload(dataUri,{folder:`care-os/room-catalog/${normalizeRoom(roomNumber)}`,resource_type:"image",quality:"auto:good"});
    const result=await postgresQuery(`INSERT INTO room_photos(room_number,category,photo_url,caption,uploaded_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[roomNumber,String(req.body.category||"reference"),uploaded.secure_url,String(req.body.caption||""),String(req.body.uploadedBy||"")]);
    io.emit("room-catalog:updated",{roomNumber,type:"photo"});
    return res.json({ok:true,photo:result.rows[0]});
  }catch(error){return res.status(500).json({ok:false,message:error.message});}
});

app.post("/api/rooms/:roomNumber/catalog/inventory", async (req,res)=>{
  try{
    const roomNumber=String(req.params.roomNumber||"").trim(), itemName=String(req.body.itemName||"").trim();
    if(!itemName)return res.status(400).json({ok:false,message:"Escribe el artículo"});
    const result=await postgresQuery(`INSERT INTO room_inventory(room_number,item_name,expected_quantity,location,notes,updated_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[roomNumber,itemName,Math.max(0,Number(req.body.expectedQuantity)||0),String(req.body.location||""),String(req.body.notes||""),String(req.body.updatedBy||"")]);
    io.emit("room-catalog:updated",{roomNumber,type:"inventory"});
    return res.json({ok:true,item:result.rows[0]});
  }catch(error){return res.status(500).json({ok:false,message:error.message});}
});

app.get("/service-orders", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "service-orders.html"));
});

app.get("/runner-orders", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "runner-orders.html"));
});

const VOICE_REQUEST_ITEM_ALIASES = {
  "king sheet":"King sheet", "king sheets":"King sheet", "sabana king":"King sheet", "sabanas king":"King sheet",
  "queen sheet":"Queen sheet", "queen sheets":"Queen sheet", "sabana queen":"Queen sheet", "sabanas queen":"Queen sheet",
  pillowcase:"Pillowcase", pillowcases:"Pillowcase", funda:"Pillowcase", fundas:"Pillowcase",
  "bath towel":"Bath towel", "bath towels":"Bath towel", "toalla grande":"Bath towel", "toallas grandes":"Bath towel",
  "hand towel":"Hand towel", "hand towels":"Hand towel", "toalla de mano":"Hand towel", "toallas de mano":"Hand towel",
  washcloth:"Washcloth", washcloths:"Washcloth", "face towel":"Washcloth", "face towels":"Washcloth", "toalla facial":"Washcloth", "toallas faciales":"Washcloth",
  duvet:"Duvet", duvets:"Duvet", comforter:"Duvet", comforters:"Duvet", blanket:"Blanket", blankets:"Blanket", cobija:"Blanket", cobijas:"Blanket",
  pillow:"Pillow", pillows:"Pillow", almohada:"Pillow", almohadas:"Pillow",
  "trash bag":"Trash bag", "trash bags":"Trash bag", "bolsa de basura":"Trash bag", "bolsas de basura":"Trash bag",
  "toilet paper":"Toilet paper", "papel de bano":"Toilet paper", "paper towel":"Paper towel", "paper towels":"Paper towel", "papel de cocina":"Paper towel",
  soap:"Soap", jabon:"Soap", shampoo:"Shampoo", conditioner:"Conditioner", coffee:"Coffee", cafe:"Coffee",
};

function foldVoiceText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function normalizeVoiceRequestItems(items) {
  const merged = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const rawName = String(item?.name || "").trim();
    const name = VOICE_REQUEST_ITEM_ALIASES[foldVoiceText(rawName)] || rawName;
    const quantity = Math.min(100, Math.max(1, Math.round(Number(item?.quantity) || 1)));
    if (name) merged.set(name, (merged.get(name) || 0) + quantity);
  });
  return [...merged.entries()].map(([name, quantity]) => ({ name, quantity }));
}

app.post("/api/voice-supply-request/interpret", voiceUpload.single("audio"), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(503).json({ ok:false, error:"Falta OPENAI_API_KEY en Render." });
    if (!req.file?.buffer?.length) return res.status(400).json({ ok:false, error:"No se recibió el audio." });

    const room = String(req.body.room || "").trim().toUpperCase();
    const requestedBy = String(req.body.requestedBy || "Cleaner").trim();
    const mimeType = String(req.file.mimetype || "audio/webm");
    const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
    const audioFile = new File([req.file.buffer], `voice-request.${extension}`, { type:mimeType });
    const transcription = await openai.audio.transcriptions.create({
      file:audioFile,
      model:"gpt-4o-mini-transcribe",
      response_format:"json",
      prompt:"Care OS housekeeping voice assistant. The speaker may mix Spanish and English. Preserve room numbers, commands, linen names, supply names and exact quantities.",
    });
    const transcript = String(transcription?.text || "").trim();
    if (!transcript) return res.status(422).json({ ok:false, error:"No pude escuchar una solicitud. Intenta grabarla otra vez." });

    const interpretation = await openai.chat.completions.create({
      model:"gpt-4o-mini",
      temperature:0,
      response_format:{ type:"json_schema", json_schema:{ name:"housekeeping_supply_request", strict:true, schema:{
        type:"object", additionalProperties:false,
        properties:{
          intent:{type:"string",enum:["start_cleaning","finish_cleaning","request_supplies","report_issue","unknown"]},
          room:{type:"string"},
          category:{type:"string",enum:["Linen","Amenities","Cleaning Supplies","Maintenance","Safety","Lost and Found","Other"]},
          priority:{type:"string",enum:["normal","high","urgent"]},
          items:{type:"array",items:{type:"object",additionalProperties:false,properties:{name:{type:"string"},quantity:{type:"integer",minimum:1,maximum:100}},required:["name","quantity"]}},
          notes:{type:"string"}, needs_clarification:{type:"boolean"}, clarification_question:{type:"string"}
        },
        required:["intent","room","category","priority","items","notes","needs_clarification","clarification_question"]
      }}},
      messages:[
        {role:"system",content:"You are the Care OS housekeeping voice router. Identify whether the cleaner wants to start cleaning a room, finish cleaning a room, request supplies, or report an issue. Extract the spoken room number; if none is spoken, use the assigned room. Never invent a room, item or quantity. Spanish phrases like 'empieza', 'inicia', 'voy a comenzar' mean start_cleaning. Phrases like 'termine', 'ya acabé', 'finaliza' mean finish_cleaning. Use urgent only for safety, active leaks, smoke, gas, injury, an unsecured guest room, or an immediate guest-impacting emergency; high for a blocked turnover; otherwise normal. If a required room or item is unclear, set needs_clarification true. Keep standard hotel supply names in concise English."},
        {role:"user",content:`Assigned room: ${room || "unknown"}\nCleaner: ${requestedBy}\nTranscript: ${transcript}`},
      ],
    });
    const parsed = JSON.parse(interpretation.choices?.[0]?.message?.content || "{}");
    const intent = ["start_cleaning","finish_cleaning","request_supplies","report_issue"].includes(parsed.intent) ? parsed.intent : "unknown";
    const spokenRoom = String(parsed.room || room || "").trim().toUpperCase().replace(/\s+/g, "");
    const items = normalizeVoiceRequestItems(parsed.items);
    const needsItems = intent === "request_supplies";
    const needsClarification = Boolean(parsed.needs_clarification) || !spokenRoom || (needsItems && !items.length) || intent === "unknown";
    return res.json({ok:true,request:{
      room:spokenRoom, requestedBy, intent, category:parsed.category || "Other",
      priority:["normal","high","urgent"].includes(parsed.priority) ? parsed.priority : "normal",
      items, notes:String(parsed.notes || "").trim(), transcript, needsClarification,
      clarificationQuestion:String(parsed.clarification_question || (!spokenRoom ? "¿En qué unidad estás?" : needsItems && !items.length ? "¿Qué necesitas y cuántos?" : intent === "unknown" ? "¿Quieres iniciar, terminar, reportar o pedir algo?" : "")).trim(),
    }});
  } catch (error) {
    console.error("VOICE SUPPLY REQUEST ERROR:", error.message);
    const tooLarge = error?.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 500).json({ok:false,error:tooLarge ? "El audio es demasiado largo." : "No pude interpretar el audio. Intenta nuevamente."});
  }
});

function normalizeServiceOrder(row) {
  return {
    ...row,
    items: Array.isArray(row.items) ? row.items : [],
  };
}

app.get("/api/service-orders", async (req, res) => {
  try {
    if (!postgresStatus.connected) return res.status(503).json({ ok:false, error:"PostgreSQL no está conectado." });
    const status = String(req.query.status || "").trim();
    const room = String(req.query.room || "").trim();
    const values = [];
    const where = [];
    if (status && status !== "all") { values.push(status); where.push(`status = $${values.length}`); }
    if (room) { values.push(`%${room}%`); where.push(`room ILIKE $${values.length}`); }
    const result = await postgresQuery(`
      SELECT * FROM service_orders
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
        CASE status WHEN 'new' THEN 1 WHEN 'accepted' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'delivered' THEN 4 ELSE 5 END,
        created_at DESC
      LIMIT 500
    `, values);
    res.json({ ok:true, orders:result.rows.map(normalizeServiceOrder) });
  } catch (error) {
    console.error("SERVICE ORDERS LIST ERROR:", error.message);
    res.status(500).json({ ok:false, error:error.message });
  }
});

app.get("/api/service-orders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok:false, error:"Orden inválida." });
    const [orderResult, eventResult] = await Promise.all([
      postgresQuery("SELECT * FROM service_orders WHERE id=$1", [id]),
      postgresQuery("SELECT * FROM service_order_events WHERE order_id=$1 ORDER BY created_at ASC", [id]),
    ]);
    if (!orderResult.rows[0]) return res.status(404).json({ ok:false, error:"Orden no encontrada." });
    res.json({ ok:true, order:normalizeServiceOrder(orderResult.rows[0]), events:eventResult.rows });
  } catch (error) {
    res.status(500).json({ ok:false, error:error.message });
  }
});

app.post("/api/service-orders", async (req, res) => {
  const client = await getPool().connect();
  try {
    const room = String(req.body.room || "").trim().toUpperCase();
    const category = String(req.body.category || "Other").trim();
    const priority = ["normal","high","urgent"].includes(req.body.priority) ? req.body.priority : "normal";
    const assignedTo = String(req.body.assignedTo || "").trim();
    const requestedBy = String(req.body.requestedBy || "").trim();
    const notes = String(req.body.notes || "").trim();
    const scheduledFor = req.body.scheduledFor || null;
    const items = Array.isArray(req.body.items) ? req.body.items
      .map(item => ({ name:String(item.name || "").trim(), quantity:Math.max(1, Number(item.quantity) || 1) }))
      .filter(item => item.name) : [];
    if (!room) return res.status(400).json({ ok:false, error:"Selecciona una habitación." });
    if (!items.length) return res.status(400).json({ ok:false, error:"Agrega al menos un artículo o servicio." });
    await client.query("BEGIN");
    const result = await client.query(`
      INSERT INTO service_orders (room, category, items, priority, assigned_to, requested_by, notes, scheduled_for)
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8) RETURNING *
    `, [room, category, JSON.stringify(items), priority, assignedTo, requestedBy, notes, scheduledFor]);
    await client.query(`INSERT INTO service_order_events (order_id,event_type,actor,note) VALUES ($1,'created',$2,$3)`, [result.rows[0].id, requestedBy, notes]);
    await client.query("COMMIT");
    const order = normalizeServiceOrder(result.rows[0]);
    io.emit("service-order:created", order);

    // Push notification for runners. The API response is not delayed if push fails.
    const itemSummary = items.slice(0, 3).map(item => `${item.quantity} ${item.name}`).join(" · ");
    const pushMessage = {
      title: priority === "urgent" ? `🚨 Orden urgente · ${room}` : `📦 Nueva orden · ${room}`,
      body: itemSummary || category,
      link: "/runner-orders",
      tag: `service-order-${order.id}`,
      urgent: priority === "urgent",
      data: { type:"SERVICE_ORDER", orderId:order.id, room, priority },
    };
    const assignedKey = assignedTo.toLowerCase();
    const genericRunner = !assignedTo || ["runner","unassigned","sin asignar"].includes(assignedKey);
    Promise.resolve(
      genericRunner
        ? sendPushToRole(postgresQuery, "runner", pushMessage)
        : sendPushToEmployees(postgresQuery, [assignedTo], pushMessage)
    ).then(result => {
      console.log("SERVICE ORDER PUSH:", { orderId:order.id, assignedTo:assignedTo || "Runner", ...result });
    }).catch(error => console.error("SERVICE ORDER PUSH ERROR:", error.message));

    const adminOrderAlert = {
      kind: "request",
      title: priority === "urgent" ? `🚨 Nueva solicitud urgente · ${room}` : `📦 Nueva solicitud · ${room}`,
      body: `${requestedBy || "Operations"}: ${itemSummary || category}`,
      link: "/service-orders",
      orderId: order.id,
      room,
      createdAt: new Date().toISOString(),
    };
    io.emit("admin-operation-alert", adminOrderAlert);
    Promise.resolve(sendPushToRole(postgresQuery, "admin", {
      title: adminOrderAlert.title,
      body: adminOrderAlert.body,
      link: adminOrderAlert.link,
      tag: `admin-service-order-${order.id}`,
      urgent: priority === "urgent",
      data: { type:"ADMIN_SERVICE_ORDER", soundType:"request", orderId:order.id, room },
    })).then(result => {
      console.log("ADMIN SERVICE ORDER PUSH:", { orderId:order.id, ...result });
    }).catch(error => console.error("ADMIN SERVICE ORDER PUSH ERROR:", error.message));

    res.status(201).json({ ok:true, order });
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("SERVICE ORDER CREATE ERROR:", error.message);
    res.status(500).json({ ok:false, error:error.message });
  } finally { client.release(); }
});


app.post("/api/operations-report-to-service-order", async (req, res) => {
  const client = await getPool().connect();
  try {
    if (!postgresStatus.connected) {
      return res.status(503).json({ ok:false, error:"PostgreSQL no está conectado." });
    }

    const sourceReportId = String(req.body.sourceReportId || req.body.reportPageId || "").trim();
    const room = String(req.body.room || "").trim().toUpperCase();
    const category = String(req.body.category || "General").trim();
    const priority = ["normal","high","urgent"].includes(req.body.priority) ? req.body.priority : "normal";
    const assignedTo = String(req.body.assignedTo || "Runner").trim() || "Runner";
    const requestedBy = String(req.body.requestedBy || "Operations").trim();
    const notes = String(req.body.notes || "").trim();
    const items = Array.isArray(req.body.items) ? req.body.items
      .map(item => ({ name:String(item.name || "").trim(), quantity:Math.max(1, Number(item.quantity) || 1) }))
      .filter(item => item.name) : [];

    if (!sourceReportId) return res.status(400).json({ ok:false, error:"Falta el reporte de origen." });
    if (!room) return res.status(400).json({ ok:false, error:"Selecciona una habitación." });
    if (!items.length) return res.status(400).json({ ok:false, error:"Agrega al menos un artículo o servicio." });

    await client.query("BEGIN");
    await client.query("ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS source_report_id TEXT");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS service_orders_source_report_uidx ON service_orders (source_report_id) WHERE source_report_id IS NOT NULL AND source_report_id <> ''");

    const existing = await client.query("SELECT * FROM service_orders WHERE source_report_id=$1 LIMIT 1", [sourceReportId]);
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok:false, alreadySent:true, order:normalizeServiceOrder(existing.rows[0]), error:"Este reporte ya fue enviado a Service Orders." });
    }

    const result = await client.query(`
      INSERT INTO service_orders
        (room, category, items, priority, assigned_to, requested_by, notes, source_report_id)
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
      RETURNING *
    `, [room, category, JSON.stringify(items), priority, assignedTo, requestedBy, notes, sourceReportId]);

    await client.query(
      `INSERT INTO service_order_events (order_id,event_type,actor,note)
       VALUES ($1,'created_from_operations',$2,$3)`,
      [result.rows[0].id, requestedBy, `Operations report: ${sourceReportId}${notes ? ` · ${notes}` : ""}`]
    );
    await client.query("COMMIT");

    const order = normalizeServiceOrder(result.rows[0]);

    // Mark the source report only after PostgreSQL successfully created the order.
    let sourceMarked = false;
    let sourceMarkError = "";
    try {
      if (!NOTION_REPORTS_DATABASE_ID) throw new Error("Falta NOTION_REPORTS_DB_ID en Render");
      const schema = await getDatabaseSchema(NOTION_REPORTS_DATABASE_ID);
      const props = {};
      addNotionProp(props, schema, ["HotSOS Sent", "HOTSOS Sent", "Service Order Sent"], true, "checkbox");
      addNotionProp(props, schema, ["Status", "status"], "Sent to Service Orders", "select");
      await notion.pages.update({ page_id: sourceReportId, properties: props });
      sourceMarked = true;
    } catch (markError) {
      sourceMarkError = markError.message;
      console.error("OPERATIONS REPORT SOURCE MARK ERROR:", markError.message);
    }

    io.emit("service-order:created", order);
    broadcastOpsUpdate({ type:"service-order-created", reportPageId:sourceReportId, orderId:order.id });

    const itemSummary = items.slice(0, 3).map(item => `${item.quantity} ${item.name}`).join(" · ");
    const pushMessage = {
      title: priority === "urgent" ? `🚨 Orden urgente · ${room}` : `📦 Nueva orden · ${room}`,
      body: itemSummary || category,
      link: "/runner-orders",
      tag: `service-order-${order.id}`,
      urgent: priority === "urgent",
      data: { type:"SERVICE_ORDER", orderId:order.id, room, priority },
    };
    const assignedKey = assignedTo.toLowerCase();
    const genericRunner = !assignedTo || ["runner","unassigned","sin asignar"].includes(assignedKey);
    Promise.resolve(
      genericRunner
        ? sendPushToRole(postgresQuery, "runner", pushMessage)
        : sendPushToEmployees(postgresQuery, [assignedTo], pushMessage)
    ).catch(error => console.error("OPERATIONS TO SERVICE ORDER PUSH ERROR:", error.message));

    res.status(201).json({ ok:true, order, sourceMarked, sourceMarkError });
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("OPERATIONS REPORT TO SERVICE ORDER ERROR:", error.message);
    res.status(500).json({ ok:false, error:error.message });
  } finally {
    client.release();
  }
});

app.patch("/api/service-orders/:id/status", async (req, res) => {
  const client = await getPool().connect();
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || "");
    const actor = String(req.body.actor || "").trim();
    const note = String(req.body.note || "").trim();
    const allowed = ["new","accepted","in_progress","delivered","completed","cancelled"];
    if (!allowed.includes(status)) return res.status(400).json({ ok:false, error:"Estado inválido." });
    const timestampColumn = {accepted:"accepted_at",in_progress:"started_at",delivered:"delivered_at",completed:"completed_at"}[status];
    await client.query("BEGIN");
    const sql = `UPDATE service_orders SET status=$1, updated_at=NOW()${timestampColumn ? `, ${timestampColumn}=COALESCE(${timestampColumn},NOW())` : ""}${actor && status==='accepted' ? ', assigned_to=CASE WHEN assigned_to=\'\' THEN $3 ELSE assigned_to END' : ''} WHERE id=$2 RETURNING *`;
    const params = actor && status==='accepted' ? [status,id,actor] : [status,id];
    const result = await client.query(sql, params);
    if (!result.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ ok:false, error:"Orden no encontrada." }); }
    await client.query(`INSERT INTO service_order_events (order_id,event_type,actor,note) VALUES ($1,$2,$3,$4)`, [id,status,actor,note]);
    await client.query("COMMIT");
    const order = normalizeServiceOrder(result.rows[0]);
    io.emit("service-order:updated", order);
    res.json({ ok:true, order });
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    res.status(500).json({ ok:false, error:error.message });
  } finally { client.release(); }
});

app.patch("/api/service-orders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const assignedTo = String(req.body.assignedTo || "").trim();
    const priority = ["normal","high","urgent"].includes(req.body.priority) ? req.body.priority : "normal";
    const notes = String(req.body.notes || "").trim();
    const result = await postgresQuery(`UPDATE service_orders SET assigned_to=$1, priority=$2, notes=$3, updated_at=NOW() WHERE id=$4 RETURNING *`, [assignedTo,priority,notes,id]);
    if (!result.rows[0]) return res.status(404).json({ ok:false, error:"Orden no encontrada." });
    const order=normalizeServiceOrder(result.rows[0]);
    io.emit("service-order:updated", order);
    res.json({ok:true,order});
  } catch(error) { res.status(500).json({ok:false,error:error.message}); }
});

app.get("/rooms-manager", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "rooms-manager.html"));
});

function adminRoomDate(value) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayISO();
}

function adminRoomBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

function adminRoomText(value, maxLength = 250) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function adminRoomJsonArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => adminRoomText(item, 120)).filter(Boolean))];
  }

  return [...new Set(
    String(value || "")
      .split(/[,;/\n]+/)
      .map((item) => adminRoomText(item, 120))
      .filter(Boolean)
  )];
}

function adminRoomResponse(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    notionId: row.notion_id || "",
    workDate: row.work_date,
    roomNumber: row.room_number || "",
    normalizedRoom: row.normalized_room || "",
    roomType: row.room_type || "",
    building: row.building || "OTHER",
    cleaningStatus: row.cleaning_status || "",
    guestOut: row.guest_out === true,
    guestOutAt: row.guest_out_at || null,
    urgent: row.urgent === true,
    arrival: row.arrival === true,
    stayover: row.stayover === true,
    assignedCleaner: row.assigned_cleaner || "",
    assignedCleaners: Array.isArray(row.assigned_cleaners)
      ? row.assigned_cleaners
      : [],
    assignedInspector: row.assigned_inspector || "",
    assignedInspectors: Array.isArray(row.assigned_inspectors)
      ? row.assigned_inspectors
      : [],
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    inspectionStartedAt: row.inspection_started_at || null,
    readyAt: row.ready_at || null,
    preInspection: row.pre_inspection === true,
    preInspectionStarted: row.pre_inspection_started === true,
    preInspectionStartedAt: row.pre_inspection_started_at || null,
    preInspectionCompletedAt: row.pre_inspection_completed_at || null,
    source: row.source || "postgres",
    updatedBy: row.updated_by || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function adminRoomSqlValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

app.get("/api/admin/rooms", async (req, res) => {
  try {
    if (!postgresStatus.connected) {
      return res.status(503).json({
        ok: false,
        message: "PostgreSQL no está conectado",
      });
    }

    const workDate = adminRoomDate(req.query.date || req.query.workDate);
    const search = adminRoomText(req.query.search, 120);
    const status = adminRoomText(req.query.status, 120);
    const building = adminRoomText(req.query.building, 30).toUpperCase();
    const urgentOnly = adminRoomBoolean(req.query.urgent, false);
    const arrivalOnly = adminRoomBoolean(req.query.arrival, false);
    const stayoverOnly = adminRoomBoolean(req.query.stayover, false);

    const where = ["work_date = $1"];
    const values = [workDate];

    if (search) {
      values.push(`%${search}%`);
      where.push(`(
        room_number ILIKE $${values.length}
        OR normalized_room ILIKE $${values.length}
        OR assigned_cleaner ILIKE $${values.length}
        OR assigned_inspector ILIKE $${values.length}
      )`);
    }

    if (status && status.toLowerCase() !== "all") {
      values.push(status);
      where.push(`cleaning_status = $${values.length}`);
    }

    if (building && building !== "ALL") {
      values.push(building);
      where.push(`UPPER(building) = $${values.length}`);
    }

    if (urgentOnly) where.push("urgent = TRUE");
    if (arrivalOnly) where.push("arrival = TRUE");
    if (stayoverOnly) where.push("stayover = TRUE");

    const result = await postgresQuery(
      `SELECT *
       FROM rooms
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE WHEN urgent THEN 0 ELSE 1 END,
         building ASC,
         NULLIF(regexp_replace(normalized_room, '[^0-9]', '', 'g'), '')::INTEGER NULLS LAST,
         normalized_room ASC`,
      values
    );

    const rooms = result.rows.map(adminRoomResponse);
    const statuses = [...new Set(rooms.map((room) => room.cleaningStatus).filter(Boolean))].sort();
    const buildings = [...new Set(rooms.map((room) => room.building).filter(Boolean))].sort();

    return res.json({
      ok: true,
      workDate,
      count: rooms.length,
      rooms,
      filters: { statuses, buildings },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("GET /api/admin/rooms ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.get("/api/admin/rooms/:id/history", async (req, res) => {
  try {
    const roomId = Number(req.params.id);

    if (!Number.isInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ ok: false, message: "ID de habitación inválido" });
    }

    const result = await postgresQuery(
      `SELECT *
       FROM admin_audit_logs
       WHERE entity_type = 'room'
         AND entity_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [String(roomId)]
    );

    return res.json({
      ok: true,
      roomId,
      count: result.rows.length,
      history: result.rows,
    });
  } catch (error) {
    console.error("GET /api/admin/rooms/:id/history ERROR:", error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/admin/rooms/:id", async (req, res) => {
  try {
    const roomId = Number(req.params.id);

    if (!Number.isInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ ok: false, message: "ID de habitación inválido" });
    }

    const result = await postgresQuery(
      "SELECT * FROM rooms WHERE id = $1 LIMIT 1",
      [roomId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: "Habitación no encontrada" });
    }

    return res.json({
      ok: true,
      room: adminRoomResponse(result.rows[0]),
    });
  } catch (error) {
    console.error("GET /api/admin/rooms/:id ERROR:", error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.patch("/api/admin/rooms/:id", async (req, res) => {
  const roomId = Number(req.params.id);

  if (!Number.isInteger(roomId) || roomId <= 0) {
    return res.status(400).json({ ok: false, message: "ID de habitación inválido" });
  }

  const allowedFields = {
    roomNumber: "room_number",
    roomType: "room_type",
    building: "building",
    cleaningStatus: "cleaning_status",
    guestOut: "guest_out",
    guestOutAt: "guest_out_at",
    urgent: "urgent",
    arrival: "arrival",
    stayover: "stayover",
    assignedCleaner: "assigned_cleaner",
    assignedCleaners: "assigned_cleaners",
    assignedInspector: "assigned_inspector",
    assignedInspectors: "assigned_inspectors",
    preInspection: "pre_inspection",
    preInspectionStarted: "pre_inspection_started",
    preInspectionStartedAt: "pre_inspection_started_at",
    preInspectionCompletedAt: "pre_inspection_completed_at",
  };

  const booleanFields = new Set([
    "guestOut",
    "urgent",
    "arrival",
    "stayover",
    "preInspection",
    "preInspectionStarted",
  ]);

  const dateFields = new Set([
    "guestOutAt",
    "preInspectionStartedAt",
    "preInspectionCompletedAt",
  ]);

  const arrayFields = new Set(["assignedCleaners", "assignedInspectors"]);
  const actor = adminRoomText(
    req.body?.updatedBy || req.body?.changedBy || req.headers["x-admin-name"] || "Admin",
    120
  ) || "Admin";
  const actorId = adminRoomText(
    req.body?.updatedById || req.body?.changedById || req.headers["x-admin-id"] || "",
    120
  );

  const requested = Object.entries(allowedFields).filter(([apiField]) =>
    Object.prototype.hasOwnProperty.call(req.body || {}, apiField)
  );

  if (!requested.length) {
    return res.status(400).json({
      ok: false,
      message: "No se recibió ningún campo permitido para actualizar",
    });
  }

  let client;

  try {
    client = await getPool().connect();
    await client.query("BEGIN");

    const currentResult = await client.query(
      "SELECT * FROM rooms WHERE id = $1 FOR UPDATE",
      [roomId]
    );
    const current = currentResult.rows[0];

    if (!current) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Habitación no encontrada" });
    }

    const assignments = [];
    const values = [];
    const changes = [];

    for (const [apiField, column] of requested) {
      let nextValue = req.body[apiField];

      if (booleanFields.has(apiField)) {
        nextValue = adminRoomBoolean(nextValue, current[column] === true);
      } else if (arrayFields.has(apiField)) {
        nextValue = adminRoomJsonArray(nextValue);
      } else if (dateFields.has(apiField)) {
        const raw = String(nextValue ?? "").trim();
        if (!raw) {
          nextValue = null;
        } else {
          const parsed = new Date(raw);
          if (Number.isNaN(parsed.getTime())) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              ok: false,
              message: `${apiField} contiene una fecha inválida`,
            });
          }
          nextValue = parsed.toISOString();
        }
      } else {
        nextValue = adminRoomText(nextValue, apiField === "roomNumber" ? 180 : 250);
        if (apiField === "building") nextValue = nextValue.toUpperCase() || "OTHER";
      }

      const oldComparable = JSON.stringify(adminRoomSqlValue(current[column]));
      const newComparable = JSON.stringify(adminRoomSqlValue(nextValue));

      if (oldComparable === newComparable) continue;

      values.push(arrayFields.has(apiField) ? JSON.stringify(nextValue) : nextValue);
      assignments.push(
        `${column} = $${values.length}${arrayFields.has(apiField) ? "::jsonb" : ""}`
      );
      changes.push({
        apiField,
        column,
        oldValue: current[column],
        newValue: nextValue,
      });
    }

    if (!changes.length) {
      await client.query("ROLLBACK");
      return res.json({
        ok: true,
        unchanged: true,
        room: adminRoomResponse(current),
        message: "No había cambios nuevos para guardar",
      });
    }

    values.push(actor);
    assignments.push(`updated_by = $${values.length}`);
    assignments.push("updated_at = NOW()");
    values.push(roomId);

    const updatedResult = await client.query(
      `UPDATE rooms
       SET ${assignments.join(", ")}
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    for (const change of changes) {
      await client.query(
        `INSERT INTO admin_audit_logs (
          entity_type,
          entity_id,
          action,
          field_name,
          old_value,
          new_value,
          changed_by,
          changed_by_id,
          work_date,
          metadata
        ) VALUES (
          'room', $1, 'update', $2, $3::jsonb, $4::jsonb,
          $5, $6, $7, $8::jsonb
        )`,
        [
          String(roomId),
          change.apiField,
          JSON.stringify(change.oldValue ?? null),
          JSON.stringify(change.newValue ?? null),
          actor,
          actorId,
          current.work_date,
          JSON.stringify({
            column: change.column,
            source: "rooms-manager",
          }),
        ]
      );
    }

    await client.query("COMMIT");

    const room = adminRoomResponse(updatedResult.rows[0]);
    clearRoomCache(String(room.workDate).slice(0, 10));
    clearAssignmentCaches(String(room.workDate).slice(0, 10));

    const payload = {
      reason: "admin-room-update",
      roomId: room.id,
      workDate: room.workDate,
      room,
      changedFields: changes.map((change) => change.apiField),
      updatedBy: actor,
      timestamp: new Date().toISOString(),
    };

    io.emit("room-updated", payload);
    io.emit("rooms-updated", payload);
    io.emit("assignments-updated", payload);

    setImmediate(() => {
      Promise.resolve()
        .then(() => IntelligenceEngine.refresh(String(room.workDate).slice(0, 10), "admin-room-update"))
        .then(() => AIOperationsDirector.generate(String(room.workDate).slice(0, 10), {
          reason: "admin-room-update",
        }))
        .catch((error) => {
          console.error("ADMIN ROOM BACKGROUND INTELLIGENCE ERROR:", error.message);
        });
    });

    return res.json({
      ok: true,
      room,
      changedFields: payload.changedFields,
      message: "Habitación actualizada correctamente",
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    if (error?.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "Ya existe otra habitación con ese número para la misma fecha",
      });
    }

    console.error("PATCH /api/admin/rooms/:id ERROR:", error);
    return res.status(500).json({ ok: false, message: error.message });
  } finally {
    client?.release?.();
  }
});


async function startServer() {
  initializeFirebaseAdmin();
  const databaseStatus = await startPostgres();

  if (databaseStatus.connected) {
    startSyncQueueWorker();

    try {
      await runEmployeeSync("startup");
      startEmployeeSyncSchedule();

      await runRoomSync("startup", todayISO());
      startRoomSyncSchedule();

      const payrollWeek = getPayrollWeek(new Date());
      await runPayrollSync("startup", payrollWeek.weekStart, payrollWeek.weekEnd);
      startPayrollSyncSchedule();
    } catch (error) {
      // La sincronización no bloquea el panel. Notion sigue disponible.
      console.error(
        "⚠️ El servidor arrancará sin la sincronización inicial de Employees:",
        error.message
      );

      startEmployeeSyncSchedule();

      try {
        await runRoomSync("startup-recovery", todayISO());
      } catch (roomError) {
        console.error(
          "⚠️ El servidor arrancará sin la sincronización inicial de Rooms:",
          roomError.message
        );
      }

      startRoomSyncSchedule();

      try {
        const payrollWeek = getPayrollWeek(new Date());
        await runPayrollSync("startup-recovery", payrollWeek.weekStart, payrollWeek.weekEnd);
      } catch (payrollError) {
        console.error(
          "⚠️ El servidor arrancará sin la sincronización inicial de Payroll:",
          payrollError.message
        );
      }

      startPayrollSyncSchedule();
    }
  } else {
    console.warn(
      "⚠️ Employee sync no se inició porque PostgreSQL no está conectado."
    );
  }

  if (databaseStatus.connected) {
    setTimeout(() => {
      IntelligenceEngine.refresh(todayISO(), "server-start")
        .then(() =>
          AIOperationsDirector.generate(todayISO(), {
            reason: "server-start",
          })
        )
        .catch((error) => {
          console.error(
            "INITIAL INTELLIGENCE / AI DIRECTOR ERROR:",
            error.message
          );
        });
    }, 2500);
  }

  server.listen(PORT, () => {
    console.log(`Panel web activo en puerto ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("SERVER START ERROR:", error);

  // Último salvavidas: incluso si falla el bootstrap, intenta abrir el panel.
  server.listen(PORT, () => {
    console.log(`Panel web activo en puerto ${PORT} (modo de respaldo)`);
  });
});
