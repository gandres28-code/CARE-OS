function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

let moduleReturnTarget = null;
let dashboardRequest = null;
let dashboardLastLoadedAt = 0;
let dashboardRefreshTimer = null;
let shellProtected = false;

const DASHBOARD_CACHE_MS = 15000;
const DASHBOARD_TIMEOUT_MS = 12000;

const SIDEBAR_STORAGE_KEY = "maidOsSidebarCollapsed";

function setSidebarCollapsed(collapsed, persist = true) {
  const isCollapsed = Boolean(collapsed);
  document.documentElement.classList.toggle("sidebar-collapsed", isCollapsed);

  const button = document.getElementById("sidebarToggle");
  if (button) {
    button.textContent = isCollapsed ? "☰" : "✕";
    button.setAttribute("aria-expanded", String(!isCollapsed));
    button.setAttribute(
      "aria-label",
      isCollapsed ? "Mostrar menú lateral" : "Ocultar menú lateral"
    );
  }

  if (persist) {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, isCollapsed ? "1" : "0");
  }
}

function toggleSidebar() {
  setSidebarCollapsed(
    !document.documentElement.classList.contains("sidebar-collapsed")
  );
}

function restoreSidebarState() {
  const collapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  setSidebarCollapsed(collapsed, false);
}

function syncShellTheme() {
  const savedTheme = localStorage.getItem("maidOsTheme") || "light";
  document.documentElement.classList.toggle("dark", savedTheme === "dark");
}

async function fetchJsonWithTimeout(
  url,
  options = {},
  timeoutMs = DASHBOARD_TIMEOUT_MS
) {
  if (window.OS && typeof OS.fetchJson === "function") {
    return OS.fetchJson(url, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        ok: false,
        message: text || "Respuesta inválida del servidor",
      };
    }

    if (!response.ok) {
      throw new Error(
        data.message ||
        data.error ||
        `Error del servidor (${response.status})`
      );
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("La solicitud tardó demasiado");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function updateDashboardStats(data) {
  const s = data?.stats || {};

  setText("dashTotal", s.totalUnits || 0);
  setText("dashProgress", s.inProgress || 0);
  setText("dashInspect", s.awaitingInspection || 0);
  setText("dashReady", s.ready || 0);
}

async function loadAdminDashboard(forceRefresh = false) {
  const now = Date.now();

  if (
    !forceRefresh &&
    dashboardLastLoadedAt &&
    now - dashboardLastLoadedAt < DASHBOARD_CACHE_MS
  ) {
    return null;
  }

  if (dashboardRequest) {
    return dashboardRequest;
  }

  dashboardRequest = (async () => {
    try {
      const data = await fetchJsonWithTimeout("/admin-dashboard-data");

      if (!data?.ok) {
        return null;
      }

      updateDashboardStats(data);
      dashboardLastLoadedAt = Date.now();

      if (window.OSStore) {
        OSStore.set("stats", data.stats || {});
      }

      return data;
    } catch (error) {
      console.log("Dashboard error:", error.message);
      return null;
    } finally {
      dashboardRequest = null;
    }
  })();

  return dashboardRequest;
}

function scheduleDashboardRefresh(forceRefresh = true, delay = 180) {
  clearTimeout(dashboardRefreshTimer);

  dashboardRefreshTimer = setTimeout(() => {
    loadAdminDashboard(forceRefresh);
  }, delay);
}

function setFrameSource(frame, url, forceReload = false) {
  if (!frame || !url) return;

  const currentUrl = frame.getAttribute("src") || "";

  if (!forceReload && currentUrl === url) {
    return;
  }

  frame.src = url;
}

function setActiveNavButton(navButton = null) {
  document
    .querySelectorAll(".os-nav button")
    .forEach(button => button.classList.remove("active"));

  if (navButton) {
    navButton.classList.add("active");
  }
}

function showPage(pageId, subtitle, navButton) {
  document
    .querySelectorAll(".os-page")
    .forEach(page => page.classList.remove("active"));

  const page = document.getElementById(pageId);
  if (page) {
    page.classList.add("active");
  }

  setActiveNavButton(navButton);
  setText("pageSubtitle", subtitle);
  moduleReturnTarget = null;

  if (pageId === "dashboardPage") {
    const frame = document.getElementById("dashboardFrame");
    setFrameSource(frame, "/dashboard.html");
    scheduleDashboardRefresh(false, 0);
  }
}

function getOSModule(moduleName) {
  if (!window.OS || !OS.modules) return null;
  return OS.modules[moduleName] || null;
}

function canOpenModule(module) {
  if (!module) return false;

  if (module.permission === "public") {
    return true;
  }

  if (!window.OS || typeof OS.can !== "function") {
    return true;
  }

  return OS.can(module.permission) || OS.can("all");
}

function openOSModule(moduleName) {
  const module = getOSModule(moduleName);

  if (!module) {
    console.warn("Módulo no encontrado:", moduleName);
    showComingSoon(moduleName);
    return;
  }

  if (!canOpenModule(module)) {
    if (window.OS?.notify) {
      OS.notify({
        type: "warning",
        title: "Acceso denegado",
        message: "No tienes permiso para abrir este módulo.",
      });
    }

    return;
  }

  openModule(module.title, module.url);
}

function openDirectModule(title, url) {
  if (!url || !String(url).startsWith("/")) {
    console.warn("URL de módulo inválida:", url);
    return;
  }

  openModule(title, url);
}

function openModule(title, url, options = {}) {
  if (!url || !String(url).startsWith("/")) {
    console.warn("No se pudo abrir el módulo:", title, url);
    return;
  }

  // Cada módulo abre como página completa. Esto evita páginas anidadas
  // dentro de iframes y permite que cada vista use todo el espacio disponible.
  const targetUrl = new URL(url, window.location.origin);

  if (options.returnUrl) {
    targetUrl.searchParams.set("returnTo", options.returnUrl);
  }

  window.location.assign(targetUrl.pathname + targetUrl.search + targetUrl.hash);
}

function backToDashboard() {
  window.location.assign("/app");
}

function showComingSoon(name) {
  if (!window.OS || !OS.notify) {
    alert(`${name} estará disponible próximamente en Care OS.`);
    return;
  }

  OS.notify({
    type: "info",
    title: "Próximamente",
    message: `${name} estará disponible próximamente en Care OS.`,
  });
}

function redirectToLaunch() {
  window.location.replace("/launch");
}

function protectAppShell() {
  if (shellProtected) return;

  const user = window.OS?.user;

  if (!user) {
    return;
  }

  shellProtected = true;

  const allowed =
    OS.can("operations") ||
    OS.can("rooms") ||
    OS.can("reports") ||
    OS.can("all");

  if (!allowed) {
    redirectToLaunch();
  }
}

function notifyOpsUpdate(event) {
  if (!window.OS || !OS.notify) return;

  const unit =
    event?.unit ||
    event?.room ||
    event?.roomName ||
    event?.room_name ||
    "";

  const employee =
    event?.employee ||
    event?.person ||
    event?.name ||
    event?.updatedBy ||
    event?.updated_by ||
    "Operación";

  const action = String(
    event?.action ||
    event?.type ||
    event?.eventType ||
    "Nueva actividad"
  ).toUpperCase();

  let title = "Nueva actividad";
  let type = "info";

  if (action.includes("DONE")) {
    title = "Unidad terminada";
    type = "success";
  } else if (action.includes("READY")) {
    title = "Ready for Guest";
    type = "success";
  } else if (
    action.includes("ISSUE") ||
    action.includes("REPORT")
  ) {
    title = "Nuevo reporte";
    type = "warning";
  } else if (action.includes("START")) {
    title = "Actividad iniciada";
    type = "info";
  } else if (action.includes("ROOM_UPDATED")) {
    title = "Habitación actualizada";
    type = "info";
  }

  OS.notify({
    type,
    title,
    message: unit
      ? `${employee} · ${unit}`
      : "Actividad actualizada",
  });
}

function refreshDashboardFrame(event = null) {
  const dashboardFrame = document.getElementById("dashboardFrame");
  const contentWindow = dashboardFrame?.contentWindow;

  if (!contentWindow) return;

  if (
    typeof contentWindow.applyRealtimeUpdate === "function" &&
    event
  ) {
    contentWindow.applyRealtimeUpdate(event);
    return;
  }

  if (typeof contentWindow.refreshAll === "function") {
    contentWindow.refreshAll();
  }
}

function refreshOpenModule() {
  // Los módulos ahora son páginas independientes y reciben sus propios
  // eventos en tiempo real. El shell ya no intenta controlar un iframe.
}

function emitLocalEvent(name, payload) {
  if (window.OSEvents) {
    OSEvents.emit(name, payload);
  }
}

function bindSocketEvents() {
  const socket = window.OS?.socket;

  if (!socket || socket.__appShellBound) {
    return;
  }

  socket.__appShellBound = true;

  socket.on("ops-update", event => {
    scheduleDashboardRefresh(true);
    notifyOpsUpdate(event);

    if (window.OSStore) {
      OSStore.push("timeline", event, 300);
    }

    emitLocalEvent("ops-update", event);
    refreshDashboardFrame(event);
    refreshOpenModule("ops-update", event);
  });

  socket.on("system-notification", notification => {
    if (!window.OS || !OS.notify) return;

    OS.notify({
      type: notification?.type || "info",
      title: notification?.title || "Notificación",
      message: notification?.message || "",
    });
  });

  socket.on("assignments-updated", payload => {
    scheduleDashboardRefresh(true);
    emitLocalEvent("assignments-updated", payload);
    refreshOpenModule("assignments-updated", payload);
  });

  socket.on("rooms-updated", payload => {
    scheduleDashboardRefresh(true);
    emitLocalEvent("rooms-updated", payload);
    refreshDashboardFrame(payload);
    refreshOpenModule("rooms-updated", payload);
  });

  socket.on("room-updated", payload => {
    scheduleDashboardRefresh(true);
    emitLocalEvent("room-updated", payload);
    refreshDashboardFrame(payload);
    refreshOpenModule("room-updated", payload);
  });

  socket.on("room-created", payload => {
    scheduleDashboardRefresh(true);
    emitLocalEvent("room-created", payload);
    refreshDashboardFrame(payload);
    refreshOpenModule("room-created", payload);
  });

  socket.on("room-deleted", payload => {
    scheduleDashboardRefresh(true);
    emitLocalEvent("room-deleted", payload);
    refreshDashboardFrame(payload);
    refreshOpenModule("room-deleted", payload);
  });
}

function initializeAppShell() {
  protectAppShell();
  bindSocketEvents();
  loadAdminDashboard(false);
}

window.addEventListener("message", event => {
  const data = event.data || {};

  if (data.type !== "417-open-module") return;
  if (!data.url || !String(data.url).startsWith("/")) return;

  openModule(data.title || "Módulo", data.url, {
    returnTitle: data.returnTitle,
    returnUrl: data.returnUrl,
    forceReload: Boolean(data.forceReload),
  });
});

window.addEventListener("os-user-loaded", initializeAppShell);
window.addEventListener("os-ready", initializeAppShell);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    const age = Date.now() - dashboardLastLoadedAt;

    if (!dashboardLastLoadedAt || age > 60000) {
      scheduleDashboardRefresh(true, 100);
    }
  }
});

window.addEventListener("focus", () => {
  const age = Date.now() - dashboardLastLoadedAt;

  if (!dashboardLastLoadedAt || age > 60000) {
    scheduleDashboardRefresh(true, 100);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  restoreSidebarState();
  syncShellTheme();
  initializeAppShell();
});

window.addEventListener("storage", event => {
  if (event.key === "maidOsTheme") syncShellTheme();
});
