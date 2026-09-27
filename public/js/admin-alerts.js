(() => {
  const role = String(localStorage.getItem("employeeRole") || window.OS?.user?.role || "").trim().toLowerCase();
  if (!role.includes("admin")) return;

  let audioContext = null;
  let toastTimer = null;

  function getAudioContext() {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioContext = new AudioContextClass();
    }
    if (audioContext?.state === "suspended") audioContext.resume().catch(() => {});
    return audioContext;
  }

  function tone(ctx, frequency, start, duration, gainValue = 0.16, type = "sine") {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }

  function playSound(kind) {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime + 0.02;
    if (kind === "cleaning_start") {
      tone(ctx, 660, now, 0.16, 0.14, "sine");
      tone(ctx, 880, now + 0.18, 0.22, 0.16, "sine");
    } else if (kind === "cleaning_done") {
      tone(ctx, 523, now, 0.14, 0.14, "sine");
      tone(ctx, 659, now + 0.14, 0.14, 0.15, "sine");
      tone(ctx, 784, now + 0.28, 0.30, 0.17, "sine");
    } else {
      tone(ctx, 880, now, 0.12, 0.18, "square");
      tone(ctx, 880, now + 0.18, 0.12, 0.18, "square");
      tone(ctx, 660, now + 0.36, 0.28, 0.18, "square");
    }
  }

  function showToast(alert) {
    let toast = document.getElementById("adminOpsAlert417");
    if (!toast) {
      toast = document.createElement("button");
      toast.id = "adminOpsAlert417";
      toast.type = "button";
      toast.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%) translateY(-140%);z-index:100000;max-width:min(92vw,520px);width:max-content;border:1px solid rgba(255,255,255,.18);border-radius:16px;padding:13px 16px;background:#111827;color:#fff;box-shadow:0 18px 50px rgba(0,0,0,.38);text-align:left;font:600 14px/1.35 system-ui;transition:transform .22s ease;cursor:pointer";
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<div style="font-size:15px;font-weight:800">${escapeHtml(alert.title || "Care")}</div><div style="margin-top:3px;opacity:.82;font-weight:600">${escapeHtml(alert.body || "Nueva actualización")}</div>`;
    toast.onclick = () => { window.location.href = alert.link || "/operations.html"; };
    requestAnimationFrame(() => { toast.style.transform = "translateX(-50%) translateY(0)"; });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.transform = "translateX(-50%) translateY(-140%)"; }, alert.kind === "request" ? 9000 : 5500);
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  }

  function handle(alert = {}) {
    playSound(alert.kind || "request");
    if (navigator.vibrate) {
      navigator.vibrate(alert.kind === "request" ? [220,90,220,90,360] : [120,60,160]);
    }
    showToast(alert);
  }

  function connect() {
    if (typeof io !== "function") return;
    const socket = io({ transports:["websocket","polling"] });
    socket.on("admin-operation-alert", handle);
  }

  // iOS/Safari requires a user gesture before Web Audio can play.
  const unlock = () => { getAudioContext(); document.removeEventListener("pointerdown", unlock); };
  document.addEventListener("pointerdown", unlock, { once:true });

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", connect, { once:true })
    : connect();
})();
