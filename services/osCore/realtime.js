class RealtimeHub {
  constructor({ io, metrics = null } = {}) {
    this.io = io;
    this.metrics = metrics;
    this.connected = 0;
    this.totalConnections = 0;
    this.bound = false;
  }

  bind() {
    if (!this.io || this.bound) return;
    this.bound = true;

    this.io.on("connection", (socket) => {
      this.connected += 1;
      this.totalConnections += 1;

      this.metrics?.gauge?.("socket.connected", this.connected);
      this.metrics?.increment?.("socket.totalConnections");

      socket.on("disconnect", () => {
        this.connected = Math.max(0, this.connected - 1);
        this.metrics?.gauge?.("socket.connected", this.connected);
        this.metrics?.increment?.("socket.disconnects");
      });
    });
  }

  emit(eventName, payload) {
    if (!this.io) return false;

    this.io.emit(eventName, payload);
    this.metrics?.increment?.(`socket.events.${eventName}`);
    return true;
  }

  roomUpdate(payload) {
    return this.emit("room-updated", {
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }

  assignmentsUpdate(payload) {
    return this.emit("assignments-updated", {
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }

  stats() {
    return {
      connected: this.connected,
      totalConnections: this.totalConnections,
      bound: this.bound,
    };
  }
}

module.exports = RealtimeHub;
