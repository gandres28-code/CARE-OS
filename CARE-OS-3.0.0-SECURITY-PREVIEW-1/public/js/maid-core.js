window.OS = {
  user: null,
  socket: null,
  initPromise: null,
  userRequest: null,
  bootstrapRequest: null,

  SESSION_TTL_MS: 5 * 60 * 1000,
  REQUEST_TIMEOUT_MS: 12000,

  modules: {
    dashboard: { title: "Dashboard", url: "/app", permission: "operations" },
    cleaning: { title: "Limpieza", url: "/", permission: "cleaning" },
    inspection: { title: "Inspecciones", url: "/inspector", permission: "inspection" },
    operations: { title: "Operaciones", url: "/operations.html", permission: "operations" },
    clock: { title: "Clock In/Out", url: "/time-clock", permission: "clock" },
    payroll: { title: "Nómina", url: "/payroll", permission: "reports" },
    launch: { title: "Launch", url: "/launch", permission: "public" },
  },

  permissionsByRole: {
    cleaner: ["cleaning"],
    inspector: ["inspection"],

    "cleaner / inspector": ["cleaning", "inspection"],
    "inspector / cleaner": ["cleaning", "inspection"],

    "dispatch / inspector": ["inspection", "operations", "rooms", "reports"],

    "laundry / activities": ["clock"],
    "laundry / activities / runner": ["clock"],
    laundry: ["clock"],
    activities: ["clock"],
    runner: ["clock"],

    dispatch: ["operations", "rooms", "reports"],
    operations: ["operations", "rooms", "reports"],

    admin: ["all"],
    manager: ["all"],
    owner: ["all"],
    "company owner": ["all"],
  },

  normalizeRole(role) {
    return String(role || "").trim().toLowerCase();
  },

  getStoredUser() {
    const code = localStorage.getItem("employeeCode") || "";
    const name = localStorage.getItem("employeeName") || "";
    const role = localStorage.getItem("employeeRole") || "";
    const rawUpdatedAt = localStorage.getItem("employeeSessionUpdatedAt") || "0";
    const updatedAt = Number(rawUpdatedAt);

    if (!code || !name || !role) {
      return null;
    }

    return {
      code,
      name,
      role,
      active: true,
      updatedAt,
      permissions:
        this.permissionsByRole[this.normalizeRole(role)] || [],
    };
  },

  saveUser(user) {
    if (!user) return;

    this.user = {
      ...user,
      code: String(user.code || localStorage.getItem("employeeCode") || "").trim(),
      name: String(user.name || "").trim(),
      role: String(user.role || "").trim(),
    };

    if (this.user.code) {
      localStorage.setItem("employeeCode", this.user.code);
    }

    if (this.user.name) {
      localStorage.setItem("employeeName", this.user.name);
    }

    if (this.user.role) {
      localStorage.setItem("employeeRole", this.user.role);
    }

    localStorage.setItem("employeeSessionUpdatedAt", String(Date.now()));

    if (window.OSStore) {
      OSStore.set("session", {
        user: this.user,
        permissions:
          this.user.permissions ||
          this.permissionsByRole[this.normalizeRole(this.user.role)] ||
          [],
        startedAt: new Date().toISOString(),
      });
    }
  },

  clearSession() {
    [
      "employeeCode",
      "employeeName",
      "employeeRole",
      "employeeSessionUpdatedAt",
      "cleanerName",
    ].forEach((key) => localStorage.removeItem(key));

    this.user = null;

    if (window.OSStore) {
      OSStore.set("session", null);
    }
  },

  isStoredSessionFresh(user) {
    if (!user || !user.updatedAt) return false;
    return Date.now() - Number(user.updatedAt) < this.SESSION_TTL_MS;
  },

  can(permission) {
    if (!permission || !this.user) return false;

    const directPermissions = Array.isArray(this.user.permissions)
      ? this.user.permissions
      : [];

    const role = this.normalizeRole(this.user.role);
    const rolePermissions = this.permissionsByRole[role] || [];
    const allowed = [...new Set([...directPermissions, ...rolePermissions])];

    return allowed.includes("all") || allowed.includes(permission);
  },

  require(permission) {
    if (!this.user) {
      console.log("Esperando usuario...");
      return false;
    }

    if (this.can("all") || this.can(permission)) {
      return true;
    }

    console.warn("Acceso denegado:", permission);
    this.clearSession();
    window.location.replace("/launch");
    return false;
  },

  open(moduleName) {
    const module = this.modules[moduleName];

    if (!module) {
      console.warn("Módulo no encontrado:", moduleName);
      return;
    }

    const isPublic = module.permission === "public";
    const hasAccess =
      isPublic || this.can("all") || this.can(module.permission);

    if (!hasAccess) {
      console.warn("Acceso denegado al módulo:", moduleName);
      window.location.replace("/launch");
      return;
    }

    window.location.replace(module.url);
  },

  notify({ type = "info", title = "", message = "", duration = 5000 } = {}) {
    console.log(`[${type}] ${title}: ${message}`);

    const notification = {
      type,
      title,
      message,
      time: new Date().toISOString(),
    };

    if (window.OSEvents) {
      OSEvents.emit("notification", notification);
    }

    if (window.OSStore) {
      OSStore.push("notifications", notification);
    }

    if (
      window.NotificationCenter &&
      typeof window.NotificationCenter.show === "function"
    ) {
      window.NotificationCenter.show({
        type,
        title,
        message,
        duration,
      });
      return;
    }

    window.dispatchEvent(
      new CustomEvent("os-notification", {
        detail: {
          type,
          title,
          message,
          duration,
        },
      })
    );
  },

  async fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(options.headers || {}),
        },
      });

      let data = {};

      try {
        data = await response.json();
      } catch {
        throw new Error("El servidor devolvió una respuesta inválida");
      }

      if (!response.ok) {
        throw new Error(
          data.message || `Error del servidor (${response.status})`
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
  },

  api: {
    async get(url) {
      return window.OS.fetchJson(url);
    },

    async post(url, body) {
      return window.OS.fetchJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
      });
    },
  },

  initSocket() {
    if (this.socket) return this.socket;

    try {
      if (typeof io !== "undefined") {
        this.socket = io({
          transports: ["websocket", "polling"],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          timeout: 10000,
        });

        this.socket.on("connect", () => {
          console.log("C.A.R.E Socket connected");
        });

        this.socket.on("connect_error", (error) => {
          console.log("Socket connection error:", error.message);
        });

        this.socket.on("disconnect", (reason) => {
          console.log("C.A.R.E Socket disconnected:", reason);
        });
      }
    } catch (error) {
      console.log("Socket error:", error.message);
    }

    return this.socket;
  },

  dispatchUserLoaded() {
    window.dispatchEvent(
      new CustomEvent("os-user-loaded", {
        detail: this.user,
      })
    );
  },

  async loadUser(forceRefresh = false) {
    const code = localStorage.getItem("employeeCode");

    if (!code) {
      console.log("No hay código de empleado");
      this.user = null;
      return null;
    }

    const storedUser = this.getStoredUser();

    if (!forceRefresh && storedUser && this.isStoredSessionFresh(storedUser)) {
      this.user = storedUser;
      this.dispatchUserLoaded();
      return this.user;
    }

    if (this.userRequest) {
      return this.userRequest;
    }

    this.userRequest = (async () => {
      try {
        const data = await this.fetchJson(
          `/api/me?code=${encodeURIComponent(code)}`
        );

        if (!data.ok || !data.user || data.user.active === false) {
          this.clearSession();
          return null;
        }

        this.saveUser(data.user);
        this.dispatchUserLoaded();

        console.log("Usuario validado", this.user);
        return this.user;
      } catch (error) {
        console.log("Error cargando usuario:", error.message);

        if (storedUser) {
          this.user = storedUser;
          this.dispatchUserLoaded();
          return this.user;
        }

        this.user = null;
        return null;
      } finally {
        this.userRequest = null;
      }
    })();

    return this.userRequest;
  },

  shouldLoadBootstrap() {
    const path = window.location.pathname;

    return (
      path === "/app" ||
      path.endsWith("/app.html") ||
      path.endsWith("/operations.html") ||
      path === "/master" ||
      path.endsWith("/master.html")
    );
  },

  async loadBootstrap(forceRefresh = false) {
    const code = localStorage.getItem("employeeCode");

    if (!code || !window.OSServices || !window.OSStore) {
      return null;
    }

    if (!forceRefresh && !this.shouldLoadBootstrap()) {
      return null;
    }

    if (this.bootstrapRequest) {
      return this.bootstrapRequest;
    }

    this.bootstrapRequest = (async () => {
      try {
        const data = await OSServices.bootstrap(code);

        if (!data || !data.ok) {
          return null;
        }

        if (data.session?.user) {
          this.saveUser(data.session.user);
        }

        OSStore.set("session", data.session || null);
        OSStore.set("assignments", data.assignments || []);
        OSStore.set("notifications", data.notifications || []);
        OSStore.set("timeline", data.timeline || []);
        OSStore.set("stats", data.stats || {});
        OSStore.set("hotel", data.hotel || {});
        OSStore.set("settings", data.settings || {});

        if (window.OSEvents) {
          OSEvents.emit("bootstrap-loaded", data);
        }

        return data;
      } catch (error) {
        console.log("Bootstrap error:", error.message);
        return null;
      } finally {
        this.bootstrapRequest = null;
      }
    })();

    return this.bootstrapRequest;
  },

  async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      this.initSocket();

      const storedUser = this.getStoredUser();

      if (storedUser) {
        this.user = storedUser;
        this.dispatchUserLoaded();
      }

      await this.loadUser(false);

      // Bootstrap sólo se carga en dashboard, operaciones y master.
      // Limpieza e inspecciones cargan directamente sus asignaciones,
      // evitando una segunda consulta innecesaria al entrar.
      if (this.shouldLoadBootstrap()) {
        await this.loadBootstrap(false);
      }

      console.log("C.A.R.E Core loaded", {
        user: this.user,
      });

      window.dispatchEvent(
        new CustomEvent("os-ready", {
          detail: {
            user: this.user,
          },
        })
      );

      return this.user;
    })();

    return this.initPromise;
  },
};

window.OS.init();
