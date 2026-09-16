(() => {
  "use strict";

  const state = {
    start: "",
    end: "",
    preview: null,
    raw: null,
    syncStatus: null,
    comparison: null,
    weekState: null,
    rates: [],
    selectedRecord: null,
    hourly: null,
    loading: false,
  };

  const $ = (id) => document.getElementById(id);
  const money = (value) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value || 0));


  function safeDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function safeFormatDate(value, options, fallback = "Fecha no disponible") {
    const date = safeDate(value);
    if (!date) return fallback;
    try {
      return new Intl.DateTimeFormat("es-US", options).format(date);
    } catch (_) {
      return fallback;
    }
  }

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const isoLocal = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  function getWeek(date = new Date()) {
    const current = new Date(date);
    current.setHours(12, 0, 0, 0);
    const day = current.getDay();
    current.setDate(current.getDate() + (day === 0 ? -6 : 1 - day));
    const end = new Date(current);
    end.setDate(current.getDate() + 6);
    return { start: isoLocal(current), end: isoLocal(end) };
  }

  function parseLocalDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
    return safeDate(`${value}T12:00:00`);
  }

  function formatRange(start, end) {
    const formatter = new Intl.DateTimeFormat("es-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const startDate = parseLocalDate(start);
    const endDate = parseLocalDate(end);
    if (!startDate || !endDate) return "Semana sin fecha válida";
    return `${formatter.format(startDate)} – ${formatter.format(endDate)}`;
  }

  function normalizeISODate(...values) {
    for (const value of values) {
      if (!value) continue;

      const raw = String(value).trim();
      const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return isoMatch[1];

      const parsed = safeDate(value);
      if (parsed) return isoLocal(parsed);
    }

    return "";
  }

  function dayName(dateValue) {
    const parsed = parseLocalDate(normalizeISODate(dateValue));
    if (!parsed) return "Fecha no disponible";

    const value = new Intl.DateTimeFormat("es-US", {
      weekday: "long",
    }).format(parsed);

    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function shortDailyDate(dateValue) {
    const parsed = parseLocalDate(normalizeISODate(dateValue));
    if (!parsed) return "Fecha no disponible";

    return new Intl.DateTimeFormat("es-US", {
      day: "numeric",
      month: "short",
    }).format(parsed);
  }

  function setBadge(element, text, type = "blue") {
    element.className = `badge ${type}`;
    element.textContent = text;
  }

  function showToast(message, type = "") {
    const toast = $("toast");
    toast.textContent = message;
    toast.className = `toast ${type}`.trim();
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function setLoading(loading, message = "") {
    state.loading = loading;
    ["syncButton", "compareButton", "ratesButton", "weekLockButton", "auditButton", "excelButton", "refreshButton", "prevWeek", "nextWeek", "currentWeek"]
      .forEach((id) => { $(id).disabled = loading; });

    if (message) {
      $("systemBadge").textContent = message;
      $("systemBadge").className = "badge blue";
    }
  }

  function readRangeFromInputs() {
    state.start = $("startDate").value;
    state.end = $("endDate").value;

    if (!state.start || !state.end) {
      throw new Error("Selecciona el inicio y final de la semana.");
    }

    if (state.end < state.start) {
      throw new Error("La fecha final no puede ser anterior a la inicial.");
    }
  }

  function writeRange(range) {
    state.start = range.start;
    state.end = range.end;
    $("startDate").value = range.start;
    $("endDate").value = range.end;
    $("weekLabel").textContent = formatRange(range.start, range.end);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 409) {
      throw new Error(data.message || data.error || `Error HTTP ${response.status}`);
    }
    return { response, data };
  }

  async function loadDashboard({ compare = false } = {}) {
    try {
      readRangeFromInputs();
      setLoading(true, "Cargando");
      $("weekLabel").textContent = formatRange(state.start, state.end);

      const range = `start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`;
      const requests = [
        fetchJson(`/payroll-preview?${range}`),
        fetchJson(`/api/payroll/preview?${range}`),
        fetchJson(`/api/sync/payroll/status?${range}`),
        fetchJson(`/api/payroll/week?${range}`),
        fetchJson(`/api/payroll/hourly?${range}`),
      ];

      if (compare) requests.push(fetchJson(`/api/payroll/compare?${range}`));

      const results = await Promise.allSettled(requests);
      if (results[0].status !== "fulfilled") throw results[0].reason;
      state.preview = results[0].value.data;
      state.raw = results[1].status === "fulfilled" ? results[1].value.data : { records: state.preview.records || [], count: state.preview.count || 0, total: state.preview.total || 0, source: state.preview.source };
      state.syncStatus = results[2].status === "fulfilled" ? results[2].value.data : { postgresConnected: false };
      state.weekState = results[3].status === "fulfilled" ? results[3].value.data : { status: "open", validation: { valid: true, errors: [] } };
      state.hourly = results[4].status === "fulfilled" ? results[4].value.data : { records: [], totalHours: 0, totalPay: 0 };
      if (compare) state.comparison = results[5]?.status === "fulfilled" ? results[5].value.data : null;

      renderAll();
      setBadge($("systemBadge"), "Actualizado", "green");
    } catch (error) {
      console.error(error);
      setBadge($("systemBadge"), "Error", "red");
      showToast(error.message || "No se pudo cargar Payroll.", "error");
    } finally {
      setLoading(false);
      if (state.weekState) renderWeekState();
    }
  }

  function renderAll() {
    renderStats();
    renderSource();
    renderSyncStatus();
    renderComparison();
    renderWeekState();
    renderEmployees();
    renderHourly();
    renderDaily();
    renderWarnings();
  }

  function renderStats() {
    const totals = state.preview?.totals || {};
    $("totalPayroll").textContent = money(totals.amount);
    $("totalEmployees").textContent = Number(totals.employees || 0).toLocaleString();
    $("totalUnits").textContent = Number(totals.units || 0).toLocaleString();
    $("totalWarnings").textContent = Number(state.preview?.warnings?.length || 0).toLocaleString();
    $("hourlyCount").textContent = Number(totals.hourlyEntries || 0).toLocaleString();
    $("postgresCount").textContent = Number(state.raw?.count || 0).toLocaleString();
    $("postgresTotal").textContent = money(state.raw?.total || 0);
  }

  function renderSource() {
    const source = state.preview?.source || state.raw?.source || "unknown";
    const fallback = Boolean(state.preview?.fallback || state.raw?.fallback);
    const sourceText = source === "central-notion" ? "Página central de Notion" : source === "notion" ? "Notion" : source;

    $("sourceText").textContent = fallback ? `${sourceText} · fallback` : sourceText;
    $("activeSourceText").textContent = fallback
      ? `Modo fallback: ${state.preview?.fallbackReason || "PostgreSQL no disponible"}`
      : `${sourceText} está alimentando Payroll`;

    setBadge($("activeSourceBadge"), fallback ? "FALLBACK" : sourceText.toUpperCase(), fallback ? "amber" : "green");
    $("sourceDot").style.background = fallback ? "#fdba74" : "#86efac";
  }

  function renderSyncStatus() {
    const payload = state.syncStatus || {};
    const status = payload.status;

    if (!payload.postgresConnected) {
      $("lastSyncText").textContent = "PostgreSQL no está conectado";
      setBadge($("syncBadge"), "Sin conexión", "red");
      return;
    }

    if (payload.running) {
      $("lastSyncText").textContent = "Sincronización en proceso";
      setBadge($("syncBadge"), "Ejecutando", "blue");
      return;
    }

    if (!status) {
      $("lastSyncText").textContent = "Esta semana aún no tiene registro de sincronización";
      setBadge($("syncBadge"), "Pendiente", "amber");
      return;
    }

    const timeValue = status.last_success_at || status.last_run_at || status.updated_at;
    $("lastSyncText").textContent = safeFormatDate(
      timeValue,
      { dateStyle: "medium", timeStyle: "short" }
    );

    const success = status.status === "success" || status.last_status === "success" || !status.last_error;
    setBadge($("syncBadge"), success ? "Sincronizado" : "Con error", success ? "green" : "red");
  }

  function renderComparison() {
    const comparison = state.comparison;
    if (!comparison) {
      $("comparisonText").textContent = "Presiona Comparar para validar ambas fuentes";
      setBadge($("comparisonBadge"), "Pendiente", "blue");
      return;
    }

    const matches = Boolean(comparison.matches);
    $("comparisonText").textContent = matches
      ? `${comparison.notion?.count || 0} registros y ${money(comparison.notion?.total || 0)} coinciden`
      : `Diferencia: ${comparison.difference?.count || 0} registros y ${money(comparison.difference?.total || 0)}`;
    setBadge($("comparisonBadge"), matches ? "Coinciden" : "Revisar", matches ? "green" : "red");
  }


  function renderWeekState() {
    const closed = state.weekState?.status === "closed";
    const week = state.weekState?.week || {};
    const validation = state.weekState?.validation || {};
    const banner = $("weekStateBanner");
    banner.classList.toggle("closed", closed);
    $("weekStateTitle").textContent = closed ? "🔒 Semana cerrada" : "🟢 Semana abierta";
    $("weekStateText").textContent = closed
      ? `Cerrada por ${week.closed_by || "Admin"}. Total congelado: ${money(week.snapshot_total || 0)}.`
      : validation.valid
        ? "Lista para revisar, ajustar o cerrar."
        : (validation.errors || []).join(" ") || "Puedes sincronizar, editar tarifas y ajustar pagos.";
    setBadge($("weekStateBadge"), closed ? "CLOSED" : "OPEN", closed ? "amber" : "green");
    $("weekLockButton").textContent = closed ? "🔓 Reabrir semana" : "🔒 Cerrar semana";
    $("weekLockButton").className = `btn ${closed ? "danger" : "amber"}`;
    $("syncButton").disabled = state.loading || closed;
    $("ratesButton").disabled = state.loading || closed;
  }

  function employeeRecords(employeeName) {
    const normalized = String(employeeName || "").trim().toLowerCase();
    return (state.raw?.records || []).filter((record) => {
      const name = String(record.cleaner || record.employee || "").trim().toLowerCase();
      return name === normalized;
    });
  }

  function renderEmployees() {
    const people = state.preview?.people || [];
    const container = $("employeeList");

    if (!people.length) {
      container.innerHTML = '<div class="empty">No hay empleados con actividad en esta semana.</div>';
      return;
    }

    container.innerHTML = people.map((person, index) => {
      const records = employeeRecords(person.employee);
      const closed = state.weekState?.status === "closed";
      const detailRows = records.length
        ? records.map((record) => `
          <tr>
            <td>${escapeHtml(String(record.date || record.work_date || "").slice(0, 10))}</td>
            <td>${escapeHtml(record.unit || "Sin unidad")}${Number(record.splitCount || 1) > 1 ? `<span class="split-note">Compartida entre ${Number(record.splitCount)} · Base ${money(record.grossUnitAmount)}</span>` : ""}</td>
            <td>${escapeHtml(record.roomType || record.room_type || "-")}</td>
            <td>
              <div class="record-actions">
                <strong>${money(record.amount)}</strong>
                ${record.manualOverride ? '<span class="adjusted">AJUSTADO</span>' : ""}
                ${!closed && record.id ? `<button class="mini-btn edit-payment" data-record-id="${record.id}">Editar</button>` : ""}
                ${!closed && record.id && record.manualOverride ? `<button class="mini-btn reset delete-entry" data-record-id="${record.id}">Eliminar</button>` : ""}
              </div>
            </td>
          </tr>`).join("")
        : '<tr><td colspan="4">Los pagos por hora se muestran en el total, pero todavía se leen desde Time Clock.</td></tr>';

      return `
        <article class="employee-card" data-employee-index="${index}">
          <button class="employee-main" type="button">
            <div>
              <div class="employee-name">${escapeHtml(person.employee)}</div>
              <div class="employee-meta">${escapeHtml((person.roles || []).join(" · ") || "Sin rol")}</div>
            </div>
            <div class="mobile-hide"><div class="metric-label">Unidades</div><div class="metric-value">${Number(person.units || 0)}</div></div>
            <div class="hide-tablet mobile-hide"><div class="metric-label">Limpieza</div><div class="metric-value">${money(person.cleaningPay)}</div></div>
            <div class="hide-tablet mobile-hide"><div class="metric-label">Horas</div><div class="metric-value">${Number(person.hours || 0).toFixed(2)}</div></div>
            <div><div class="metric-label">Total</div><div class="metric-value">${money(person.total)}</div></div>
            <span class="chevron">⌄</span>
          </button>
          <div class="employee-detail">
            ${!closed ? `<div style="padding:10px 0"><button class="mini-btn add-person-entry" data-employee="${escapeHtml(person.employee)}">+ Unidad, bono o descuento</button></div>` : ""}
            <table class="detail-table">
              <thead><tr><th>Fecha</th><th>Unidad</th><th>Tipo</th><th>Pago</th></tr></thead>
              <tbody>${detailRows}</tbody>
            </table>
          </div>
        </article>`;
    }).join("");

    container.querySelectorAll(".employee-main").forEach((button) => {
      button.addEventListener("click", () => button.closest(".employee-card").classList.toggle("open"));
    });
    container.querySelectorAll(".edit-payment").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openAdjustment(button.dataset.recordId);
      });
    });
    container.querySelectorAll(".add-person-entry").forEach((button) => {
      button.addEventListener("click", (event) => { event.stopPropagation(); openManualEntry(button.dataset.employee || ""); });
    });
    container.querySelectorAll(".delete-entry").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm("¿Eliminar este movimiento manual de la nómina?")) return;
        try {
          await fetchJson(`/api/payroll/manual-entry/${encodeURIComponent(button.dataset.recordId)}`, { method: "DELETE" });
          showToast("Movimiento eliminado.", "success");
          await loadDashboard();
        } catch (error) { showToast(error.message, "error"); }
      });
    });
  }


  function formatClock(value) {
    const date = safeDate(value);
    if (!date) return "—";
    return new Intl.DateTimeFormat("es-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function renderHourly() {
    const payload = state.hourly || {};
    const records = payload.records || [];
    $("hourlyHoursTotal").textContent = Number(payload.totalHours || 0).toFixed(2);
    $("hourlyPayTotal").textContent = money(payload.totalPay || 0);
    const container = $("hourlyTableBody");
    if (!records.length) {
      container.innerHTML = '<tr><td colspan="8"><div class="empty">No hay horas completadas para esta semana.</div></td></tr>';
      return;
    }
    container.innerHTML = records.map((record) => `
      <tr>
        <td><strong>${escapeHtml(record.employee || "Sin empleado")}</strong><div class="employee-meta">${escapeHtml(record.role || "Hourly")}</div></td>
        <td>${escapeHtml(record.workDate || "")}</td>
        <td>${escapeHtml(formatClock(record.clockIn))}</td>
        <td>${escapeHtml(formatClock(record.clockOut))}</td>
        <td>${Number(record.hours || 0).toFixed(2)}</td>
        <td>${money(record.hourlyRate)}</td>
        <td><strong>${money(record.total)}</strong>${record.manual ? '<div class="employee-meta">Manual</div>' : ''}</td>
        <td>${record.manual ? `<button class="mini-btn reset delete-hour" data-id="${escapeHtml(record.id)}">Eliminar</button>` : '<span class="badge green">Clock</span>'}</td>
      </tr>`).join("");
    container.querySelectorAll(".delete-hour").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("¿Eliminar estas horas manuales de Notion?")) return;
        try {
          await fetchJson(`/api/payroll/hourly/manual/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
          showToast("Horas manuales eliminadas.", "success");
          await loadDashboard();
        } catch (error) { showToast(error.message, "error"); }
      });
    });
  }

  function openManualHours() {
    $("manualDate").value = state.start || isoLocal(new Date());
    $("manualEmployee").value = "";
    $("manualRole").value = "Hourly";
    $("manualClockIn").value = "08:00";
    $("manualClockOut").value = "16:00";
    $("manualRate").value = "";
    $("manualReason").value = "";
    openModal("manualHoursModal");
  }

  function openManualEntry(employee = "") {
    $("entryEmployee").value = employee;
    $("entryDate").value = state.start || isoLocal(new Date());
    $("entryKind").value = "Bonus";
    $("entryUnit").value = "";
    $("entryAmount").value = "";
    $("entryReason").value = "";
    openModal("manualEntryModal");
  }

  async function saveManualEntry() {
    try {
      const payload = {
        employee: $("entryEmployee").value.trim(), date: $("entryDate").value,
        kind: $("entryKind").value, unit: $("entryUnit").value.trim(),
        amount: Number($("entryAmount").value), reason: $("entryReason").value.trim(),
      };
      await fetchJson("/api/payroll/manual-entry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      closeModal("manualEntryModal");
      showToast("Movimiento agregado a la nómina.", "success");
      await loadDashboard();
    } catch (error) { showToast(error.message, "error"); }
  }

  async function saveManualHours() {
    try {
      const payload = {
        employee: $("manualEmployee").value.trim(),
        role: $("manualRole").value.trim(),
        date: $("manualDate").value,
        clockIn: $("manualClockIn").value,
        clockOut: $("manualClockOut").value,
        hourlyRate: Number($("manualRate").value || 0),
        reason: $("manualReason").value.trim(),
      };
      const { data } = await fetchJson("/api/payroll/hourly/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      closeModal("manualHoursModal");
      showToast(`${data.hours.toFixed(2)} horas agregadas · ${money(data.total)}`, "success");
      await loadDashboard();
    } catch (error) { showToast(error.message, "error"); }
  }

  function renderDaily() {
    const records = state.raw?.records || [];
    const daily = new Map();

    for (const record of records) {
      const date = normalizeISODate(
        record.work_date,
        record.workDate,
        record.date,
        record.Date
      );

      if (!date) continue;

      const current = daily.get(date) || { date, total: 0, units: 0 };
      current.total += Number(record.amount ?? record.paid_amount ?? 0);
      current.units += 1;
      daily.set(date, current);
    }

    const items = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
    const container = $("dailyList");

    if (!items.length) {
      container.innerHTML = '<div class="empty">No hay pagos por unidad para esta semana.</div>';
      return;
    }

    const max = Math.max(...items.map((item) => item.total), 1);
    container.innerHTML = items.map((item) => `
      <div class="daily-card">
        <div class="daily-head">
          <span>${escapeHtml(dayName(item.date))}</span>
          <span>${money(item.total)}</span>
        </div>
        <div class="daily-meta">
          <span>${escapeHtml(shortDailyDate(item.date))}</span>
          <span>${item.units} unidades</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.max(4, (item.total / max) * 100).toFixed(1)}%"></div>
        </div>
      </div>`).join("");
  }

  function renderWarnings() {
    const warnings = [...new Set(state.preview?.warnings || [])];
    const comparison = state.comparison;

    if (comparison && !comparison.matches) {
      if (comparison.missingInPostgres?.length) warnings.push(`${comparison.missingInPostgres.length} registros faltan en PostgreSQL.`);
      if (comparison.extraInPostgres?.length) warnings.push(`${comparison.extraInPostgres.length} registros adicionales existen en PostgreSQL.`);
      if (comparison.amountMismatches?.length) warnings.push(`${comparison.amountMismatches.length} pagos tienen cantidades diferentes.`);
    }

    const container = $("warningList");
    $("totalWarnings").textContent = warnings.length.toLocaleString();

    if (!warnings.length) {
      container.innerHTML = '<div class="empty">✅ No se detectaron advertencias en la semana seleccionada.</div>';
      return;
    }

    container.innerHTML = warnings.map((warning) => `
      <div class="warning-item"><span>⚠️</span><span>${escapeHtml(warning)}</span></div>`).join("");
  }


  function openModal(id) { $(id).classList.add("open"); }
  function closeModal(id) { $(id).classList.remove("open"); }

  async function loadRates() {
    const { data } = await fetchJson("/api/payroll/rates");
    state.rates = data.rates || [];
    $("rateList").innerHTML = state.rates.length
      ? state.rates.map((rate) => `<div class="rate-row"><span class="property">${escapeHtml(rate.property_name)}</span><strong>${escapeHtml(rate.room_type)}</strong><b>${money(rate.amount)}</b></div>`).join("")
      : '<div class="empty">No hay tarifas configuradas.</div>';
  }

  async function openRates() {
    try {
      $("rateEffectiveFrom").value = state.start;
      openModal("rateModal");
      await loadRates();
    } catch (error) { showToast(error.message, "error"); }
  }

  async function saveRate() {
    try {
      const payload = {
        propertyName: $("rateProperty").value || "ALL",
        roomType: $("rateRoomType").value,
        amount: Number($("rateAmount").value),
        effectiveFrom: $("rateEffectiveFrom").value,
        reason: $("rateReason").value,
        applyToWeek: $("rateApplyWeek").checked,
        weekStart: state.start,
        weekEnd: state.end,
        changedBy: "Admin",
      };
      const { data } = await fetchJson("/api/payroll/rates", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      showToast(`Tarifa guardada. ${data.appliedRecords || 0} registros actualizados.`, "success");
      $("rateRoomType").value = ""; $("rateAmount").value = ""; $("rateReason").value = "";
      await loadRates();
      await loadDashboard();
    } catch (error) { showToast(error.message, "error"); }
  }

  function findRecord(recordId) {
    return (state.raw?.records || []).find((record) => String(record.id) === String(recordId));
  }

  function openAdjustment(recordId) {
    const record = findRecord(recordId);
    if (!record) return showToast("Registro no encontrado", "error");
    state.selectedRecord = record;
    $("adjustDescription").textContent = `${record.cleaner} · ${record.unit} · Pago actual ${money(record.amount)}`;
    $("adjustAmount").value = Number(record.amount || 0).toFixed(2);
    $("adjustReason").value = record.adjustmentReason || "";
    openModal("adjustModal");
  }

  async function saveAdjustment() {
    try {
      if (!state.selectedRecord?.id) throw new Error("Registro no seleccionado");
      await fetchJson(`/api/payroll/records/${encodeURIComponent(state.selectedRecord.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: Number($("adjustAmount").value), reason: $("adjustReason").value, changedBy: "Admin" }),
      });
      closeModal("adjustModal");
      showToast("Pago ajustado y registrado en auditoría.", "success");
      await loadDashboard();
    } catch (error) { showToast(error.message, "error"); }
  }

  async function resetAdjustment(recordId) {
    const reason = window.prompt("Motivo para restaurar el pago calculado:");
    if (!reason) return;
    try {
      await fetchJson(`/api/payroll/records/${recordId}/reset`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, changedBy: "Admin" }),
      });
      showToast("Pago restaurado al cálculo base.", "success");
      await loadDashboard();
    } catch (error) { showToast(error.message, "error"); }
  }

  function openWeekAction() {
    const closed = state.weekState?.status === "closed";
    $("weekModalTitle").textContent = closed ? "🔓 Reabrir semana" : "🔒 Cerrar semana";
    $("weekModalDescription").textContent = closed
      ? "La semana volverá a aceptar sincronizaciones, cambios de tarifa y ajustes manuales."
      : "Se congelarán los totales y los pagos no podrán cambiar hasta que la semana sea reabierta.";
    $("weekReason").value = closed ? "" : "Payroll reviewed and approved";
    $("confirmWeekButton").textContent = closed ? "Reabrir" : "Cerrar semana";
    openModal("weekModal");
  }

  async function confirmWeekAction() {
    const closed = state.weekState?.status === "closed";
    const endpoint = closed ? "/api/payroll/week/reopen" : "/api/payroll/week/close";
    try {
      await fetchJson(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: state.start, end: state.end, reason: $("weekReason").value, changedBy: "Admin" }),
      });
      closeModal("weekModal");
      showToast(closed ? "Semana reabierta." : "Semana cerrada y congelada.", "success");
      await loadDashboard();
    } catch (error) { showToast(error.message, "error"); }
  }

  async function openAudit() {
    openModal("auditModal");
    try {
      const range = `start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`;
      const { data } = await fetchJson(`/api/payroll/audit?${range}`);
      const audit = data.audit || [];
      $("auditList").innerHTML = audit.length ? audit.map((item) => `
        <div class="audit-row"><strong>${escapeHtml(item.action)}</strong><br>
        ${escapeHtml([item.employee, item.unit].filter(Boolean).join(" · "))}
        <small>${escapeHtml(item.reason || "Sin nota")} · ${new Date(item.created_at).toLocaleString("es-US")}</small></div>`).join("")
        : '<div class="empty">Todavía no hay cambios registrados.</div>';
    } catch (error) { $("auditList").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
  }

  async function syncPayroll() {
    try {
      readRangeFromInputs();
      setLoading(true, "Sincronizando");
      const { data } = await fetchJson("/api/sync/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: state.start, end: state.end }),
      });

      if (!data.ok) throw new Error(data.message || "La sincronización no terminó correctamente.");
      showToast(`Sincronización terminada: ${data.saved ?? 0} guardados.`, "success");
      await loadDashboard({ compare: true });
    } catch (error) {
      showToast(error.message, "error");
      setLoading(false);
    }
  }

  async function comparePayroll() {
    try {
      readRangeFromInputs();
      setLoading(true, "Comparando");
      const range = `start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`;
      const { data } = await fetchJson(`/api/payroll/compare?${range}`);
      state.comparison = data;
      renderComparison();
      renderWarnings();
      showToast(data.matches ? "Notion y PostgreSQL coinciden." : "Se encontraron diferencias.", data.matches ? "success" : "error");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setLoading(false);
    }
  }

  function downloadExcel() {
    try {
      readRangeFromInputs();
      window.location.href = `/payroll-excel?start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`;
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function moveWeek(delta) {
    const base = $("startDate").value ? parseLocalDate($("startDate").value) : new Date();
    base.setDate(base.getDate() + delta * 7);
    writeRange(getWeek(base));
    state.comparison = null;
    loadDashboard();
  }

  function bindEvents() {
    $("prevWeek").addEventListener("click", () => moveWeek(-1));
    $("nextWeek").addEventListener("click", () => moveWeek(1));
    $("currentWeek").addEventListener("click", () => {
      writeRange(getWeek(new Date()));
      state.comparison = null;
      loadDashboard();
    });
    $("syncButton").addEventListener("click", syncPayroll);
    $("compareButton").addEventListener("click", comparePayroll);
    $("ratesButton").addEventListener("click", openRates);
    $("weekLockButton").addEventListener("click", openWeekAction);
    $("auditButton").addEventListener("click", openAudit);
    $("saveRateButton").addEventListener("click", saveRate);
    $("saveAdjustmentButton").addEventListener("click", saveAdjustment);
    $("confirmWeekButton").addEventListener("click", confirmWeekAction);
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.closeModal)));
    document.querySelectorAll(".modal-backdrop").forEach((modal) => modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(modal.id); }));
    $("excelButton").addEventListener("click", downloadExcel);
    $("manualHoursButton").addEventListener("click", openManualHours);
    $("manualEntryButton").addEventListener("click", () => openManualEntry());
    $("saveManualEntryButton").addEventListener("click", saveManualEntry);
    $("saveManualHoursButton").addEventListener("click", saveManualHours);
    $("refreshButton").addEventListener("click", () => loadDashboard());
    $("startDate").addEventListener("change", () => {
      const start = parseLocalDate($("startDate").value);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      $("endDate").value = isoLocal(end);
      state.comparison = null;
      loadDashboard();
    });
    $("endDate").addEventListener("change", () => {
      state.comparison = null;
      loadDashboard();
    });
  }

  bindEvents();
  writeRange(getWeek(new Date()));
  loadDashboard();
})();
