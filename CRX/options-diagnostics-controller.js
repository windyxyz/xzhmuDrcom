(function attachOptionsDiagnostics(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DrcomOptionsDiagnostics = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  function limitBytes(diagnostics) {
    return Number(diagnostics?.limits?.maxBytes ?? diagnostics?.limits?.bytes) || 1024 * 1024;
  }

  function limitSessions(diagnostics) {
    return Number(diagnostics?.limits?.maxSessions ?? diagnostics?.limits?.sessions) || 10;
  }

  function formatSize(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
    return `${Math.round(value / (1024 * 1024) * 10) / 10} MiB`;
  }

  function exportFilename(now = new Date()) {
    return `drcom-portal-diagnostics-${now.toISOString().replace(/[:.]/g, "-")}.json`;
  }

  function createController({ $, sendMessage, toast, t, confirmDialog, BlobCtor = Blob, URLApi = URL, documentRef = document }) {
    let latest = null;

    function render(diagnostics) {
      latest = diagnostics;
      const input = $("portal-diagnostics-enabled");
      const status = $("portal-diagnostics-status");
      const storage = $("portal-diagnostics-storage");
      const sessions = $("portal-diagnostics-sessions");
      const dropped = $("portal-diagnostics-dropped");
      if (!diagnostics || diagnostics.ok === false) return;
      const enabled = diagnostics.enabled === true;
      const bytes = Math.max(0, Number(diagnostics.bytes) || 0);
      const sessionCount = Math.max(0, Number(diagnostics.sessionCount) || 0);
      const droppedRecords = Math.max(0, Math.floor(Number(diagnostics.droppedRecords) || 0));
      if (input) input.checked = enabled;
      if (status) status.textContent = diagnostics.paused === true ? t("diagnostics_paused") : enabled ? t("diagnostics_enabled") : t("diagnostics_disabled");
      if (storage) storage.textContent = `${formatSize(bytes)} / ${formatSize(limitBytes(diagnostics))}`;
      if (sessions) sessions.textContent = `${sessionCount} / ${limitSessions(diagnostics)}`;
      if (dropped) dropped.textContent = t("record_count", [droppedRecords]);
    }

    async function load() {
      const result = await sendMessage({ action: "diagnostics:get" });
      render(result);
      return result;
    }

    async function setEnabled(enabled, previous = null) {
      const input = $("portal-diagnostics-enabled");
      const before = previous === null ? Boolean(input?.checked) : Boolean(previous);
      if (input) { input.checked = before; input.disabled = true; }
      try {
        const result = await sendMessage({ action: "diagnostics:set", enabled: enabled === true });
        await load();
        return result;
      } catch (error) {
        if (input) input.checked = before;
        toast(error.message || String(error));
        return false;
      } finally {
        if (input) input.disabled = false;
      }
    }

    async function exportData() {
      const button = $("export-portal-diagnostics");
      if (button) button.disabled = true;
      try {
        const result = await sendMessage({ action: "diagnostics:export" });
        const blob = new BlobCtor([`${JSON.stringify(result.export, null, 2)}\n`], { type: "application/json" });
        const url = URLApi.createObjectURL(blob);
        try {
          const link = documentRef.createElement("a");
          link.href = url;
          link.download = exportFilename();
          link.click();
        } finally {
          URLApi.revokeObjectURL(url);
        }
        return true;
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function clear() {
      if (!confirmDialog || typeof confirmDialog.ask !== "function") throw new Error(t("confirm_unavailable"));
      const confirmed = await confirmDialog.ask({
        title: t("clear_diagnostics_title"),
        message: t("clear_diagnostics_message"),
        confirmLabel: t("clear_records"),
        danger: true
      });
      if (!confirmed) return false;
      const button = $("clear-portal-diagnostics");
      if (button) button.disabled = true;
      try {
        await sendMessage({ action: "diagnostics:clear" });
        await load();
        return true;
      } finally {
        if (button) button.disabled = false;
      }
    }

    return { render, load, setEnabled, exportData, clear, latest: () => latest };
  }

  return { limitBytes, limitSessions, formatSize, exportFilename, createController };
});
