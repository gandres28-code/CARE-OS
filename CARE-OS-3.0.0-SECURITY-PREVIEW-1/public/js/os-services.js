window.OSServices = {
  async get(url) {
    const response = await fetch(url);
    return response.json();
  },

  async post(url, body = {}) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return response.json();
  },
bootstrap(code) {
  return OSServices.get(`/api/bootstrap?code=${encodeURIComponent(code)}&t=${Date.now()}`);
},
  auth: {
    me(code) {
      return OSServices.get(`/api/me?code=${encodeURIComponent(code)}&t=${Date.now()}`);
    },

    login(code) {
      return OSServices.get(`/login-role?code=${encodeURIComponent(code)}&t=${Date.now()}`);
    },
  },

  dashboard: {
    stats() {
      return OSServices.get(`/admin-dashboard-data?t=${Date.now()}`);
    },
  },

  operations: {
    events() {
      return OSServices.get(`/operations-events?t=${Date.now()}`);
    },
  },

  cleaning: {
    assignments(name) {
      return OSServices.get(`/cleaner-assignments?name=${encodeURIComponent(name)}&t=${Date.now()}`);
    },

    action(payload) {
      return OSServices.post("/action", payload);
    },
  },

  inspection: {
    assignments(code) {
      return OSServices.get(`/inspector-assignments?code=${encodeURIComponent(code)}&t=${Date.now()}`);
    },

    action(payload) {
      return OSServices.post("/inspector-action", payload);
    },
  },
};
