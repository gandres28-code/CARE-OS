window.OSEvents = {
  on(eventName, handler) {
    window.addEventListener(`os:${eventName}`, (event) => {
      handler(event.detail);
    });
  },

  emit(eventName, data = {}) {
    window.dispatchEvent(
      new CustomEvent(`os:${eventName}`, {
        detail: data,
      })
    );
  },

  off(eventName, handler) {
    window.removeEventListener(`os:${eventName}`, handler);
  },
};
