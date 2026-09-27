(() => {
  const BUTTON_ID = "enablePushNotifications417";

  function employee() {
    return {
      name: localStorage.getItem("employeeName") || localStorage.getItem("cleanerName") || localStorage.getItem("inspectorName") || window.OS?.user?.name || "",
      role: localStorage.getItem("employeeRole") || window.OS?.user?.role || "",
    };
  }

  function eligible(role) {
    const value = String(role || "").toLowerCase();
    return value.includes("cleaner") || value.includes("inspector") || value.includes("runner") || value.includes("admin") || value.includes("limpi") || value.includes("inspect");
  }

  function base64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  }

  function isStandalone() {
    return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
  }

  function paintButton(enabled) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.textContent = enabled ? "🔔" : "🔔";
    button.style.background = enabled ? "#16a34a" : "#111827";
    button.style.opacity = "1";
    button.disabled = false;
    button.title = enabled ? "Notificaciones activadas" : "Activar notificaciones";
  }

  function makeButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "🔔";
    button.title = "Activar notificaciones";
    button.style.cssText = "position:fixed;right:16px;bottom:84px;z-index:99999;width:44px;height:44px;border:1px solid rgba(255,255,255,.16);background:#111827;color:#fff;border-radius:999px;font-size:20px;box-shadow:0 10px 30px rgba(0,0,0,.28);cursor:pointer";
    button.addEventListener("click", enable);
    document.body.appendChild(button);
  }

  async function enable() {
    try {
      const person = employee();
      if (!person.name) throw new Error("Primero entra con tu código de empleado.");
      if (!eligible(person.role)) throw new Error("Las notificaciones no están disponibles para este rol.");
      if (!window.isSecureContext) throw new Error("Las notificaciones requieren HTTPS.");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Este navegador no tiene Web Push disponible.");
      }

      const isiPhone = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isiPhone && !isStandalone()) {
        throw new Error("En iPhone abre Care desde el icono de la pantalla de inicio.");
      }

      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Activa las notificaciones en Configuración → Notificaciones → Care.");
      }

      const configResponse = await fetch("/api/push/config", { cache: "no-store", credentials: "same-origin" });
      const config = await configResponse.json();
      if (!configResponse.ok || !config.ok || !config.publicKey) {
        throw new Error(config.message || "Web Push todavía no está configurado en el servidor.");
      }

      const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64ToUint8Array(config.publicKey),
        });
      }

      const response = await fetch("/api/push/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeName: person.name,
          employeeRole: person.role,
          subscription: subscription.toJSON(),
          platform: isiPhone ? "ios-web-push" : "web-push",
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "No pude registrar este dispositivo.");

      localStorage.setItem("push417Enabled", "true");
      localStorage.setItem("push417Endpoint", subscription.endpoint);
      paintButton(true);

      const testResponse = await fetch("/api/push/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeName: person.name }),
      });
      const test = await testResponse.json();
      if (!testResponse.ok || !test.ok || Number(test.sent || 0) < 1) {
        throw new Error(test.message || "El teléfono se registró, pero la prueba no pudo enviarse.");
      }

      window.OS?.notify?.({ type: "success", title: "Notificaciones activadas", message: "La prueba fue enviada a este dispositivo." });
      if (!window.OS?.notify) alert("Notificaciones activadas. La prueba fue enviada.");
    } catch (error) {
      console.error("PUSH ENABLE ERROR:", error);
      alert(error?.message || "No se pudieron activar las notificaciones.");
    }
  }

  async function boot() {
    const person = employee();
    if (!eligible(person.role)) return;
    makeButton();
    try {
      const registration = await navigator.serviceWorker?.getRegistration("/");
      const subscription = await registration?.pushManager?.getSubscription();
      paintButton(Notification.permission === "granted" && Boolean(subscription));
    } catch {
      paintButton(false);
    }
  }

  window.addEventListener("os-ready", boot, { once: true });
  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 300))
    : setTimeout(boot, 300);
  window.enable417PushNotifications = enable;
})();
