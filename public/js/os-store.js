window.OSStore = {
  data: {
    session: null,
    assignments: [],
    notifications: [],
    stats: {},
    settings: {},
    lastSync: null
  },

  set(key, value) {
    this.data[key] = value;
    this.data.lastSync = new Date().toISOString();

    window.dispatchEvent(new CustomEvent("os-store-updated", {
      detail: { key, value }
    }));
  },

  get(key) {
    return this.data[key];
  },

  merge(key, value) {
    this.data[key] = {
      ...(this.data[key] || {}),
      ...(value || {})
    };

    this.data.lastSync = new Date().toISOString();

    window.dispatchEvent(new CustomEvent("os-store-updated", {
      detail: { key, value: this.data[key] }
    }));
  },

  push(key, item, limit = 100) {
    if (!Array.isArray(this.data[key])) {
      this.data[key] = [];
    }

    this.data[key].unshift(item);

    if (this.data[key].length > limit) {
      this.data[key] = this.data[key].slice(0, limit);
    }

    this.data.lastSync = new Date().toISOString();

    window.dispatchEvent(new CustomEvent("os-store-updated", {
      detail: { key, value: this.data[key] }
    }));
  }
};
