window.NotificationCenter = {
  container: null,

  init() {
    if (this.container) return;

    this.container = document.createElement("div");
    this.container.id = "notificationCenter";

    Object.assign(this.container.style, {
      position: "fixed",
      top: "calc(env(safe-area-inset-top) + 14px)",
      right: "14px",
      left: "14px",
      maxWidth: "420px",
      marginLeft: "auto",
      zIndex: "2147483647",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      pointerEvents: "none"
    });

    document.body.appendChild(this.container);
  },

  escape(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  show({ type = "info", title = "", message = "", duration = 5000 } = {}) {
    this.init();

    const card = document.createElement("div");

    const colors = {
      success: "#16a34a",
      error: "#dc2626",
      warning: "#ea580c",
      info: "#2563eb"
    };

    const icons = {
      success: "✅",
      error: "⚠️",
      warning: "🟠",
      info: "🔔"
    };

    card.innerHTML = `
      <div style="
        background:white;
        border-left:6px solid ${colors[type] || colors.info};
        border-radius:18px;
        padding:16px 16px 16px 14px;
        box-shadow:0 16px 38px rgba(15,23,42,.22);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
        pointer-events:auto;
        color:#111827;
        border:1px solid rgba(226,232,240,.9);
      ">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <div style="font-size:22px;line-height:1;">${icons[type] || icons.info}</div>
          <div style="min-width:0;flex:1;">
            <div style="font-weight:950;font-size:15px;margin-bottom:5px;">
              ${this.escape(title)}
            </div>
            <div style="font-size:13px;color:#475467;line-height:1.35;">
              ${this.escape(message)}
            </div>
          </div>
          <button type="button" aria-label="Cerrar" style="
            width:28px;
            height:28px;
            border:none;
            border-radius:999px;
            background:#f1f5f9;
            color:#334155;
            font-weight:900;
            cursor:pointer;
            padding:0;
            margin:0;
          ">×</button>
        </div>
      </div>
    `;

    card.style.opacity = "0";
    card.style.transform = "translateY(-12px)";
    card.style.transition = "opacity .28s ease, transform .28s ease";

    const closeButton = card.querySelector("button");
    if (closeButton) {
      closeButton.addEventListener("click", () => this.remove(card));
    }

    this.container.prepend(card);

    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
    });

    if (duration > 0) {
      setTimeout(() => this.remove(card), duration);
    }
  },

  remove(card) {
    if (!card) return;

    card.style.opacity = "0";
    card.style.transform = "translateY(-12px)";

    setTimeout(() => {
      if (card && card.parentNode) {
        card.remove();
      }
    }, 300);
  }
};

function initNotificationCenter() {
  if (window.NotificationCenter) {
    window.NotificationCenter.init();
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initNotificationCenter);
} else {
  initNotificationCenter();
}

window.addEventListener("os-notification", (event) => {
  if (window.NotificationCenter) {
    window.NotificationCenter.show(event.detail || {});
  }
});
if (window.OSEvents) {
  OSEvents.on("notification", (data) => {
    NotificationCenter.show(data);
  });
}
