self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "Tienes una actualización." };
  }

  const data = payload.data || {};
  const soundType = data.soundType || "default";
  const vibrationPatterns = {
    cleaning_start: [90, 50, 140],
    cleaning_done: [100, 45, 100, 45, 220],
    request: [220, 90, 220, 90, 360],
    default: [120, 60, 120],
  };
  const options = {
    body: payload.body || "Tienes una actualización.",
    icon: payload.icon || "/icons/icon-192.png",
    badge: payload.badge || "/icons/badge-96.png",
    tag: payload.tag || `417maid-${Date.now()}`,
    renotify: Boolean(payload.urgent) || soundType === "request",
    requireInteraction: Boolean(payload.urgent) || soundType === "request",
    vibrate: vibrationPatterns[soundType] || vibrationPatterns.default,
    data: { url: payload.url || "/launch", ...data },
  };

  event.waitUntil(self.registration.showNotification(payload.title || "Care", options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || "/launch";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(target) : null;
    })
  );
});
