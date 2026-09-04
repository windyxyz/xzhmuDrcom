"use strict";

(() => {
  const SETTINGS_REFRESH_INTERVAL_MS = 15_000;

function createSettingsRefreshController(deps) {
  let enabled = deps.initialEnabled !== false;
  let interval = null;
  let refreshFlight = null;

  const stopInterval = () => {
    if (interval === null) return;
    deps.clearIntervalFn(interval);
    interval = null;
  };

  const ensureInterval = () => {
    if (!enabled || !deps.isVisible() || interval !== null) return;
    interval = deps.setIntervalFn(() => {
      requestRefresh({ full: false, diagnostics: false }).catch(() => undefined);
    }, SETTINGS_REFRESH_INTERVAL_MS);
  };

  const requestRefresh = (options = {}) => {
    if (refreshFlight) return refreshFlight;
    const full = options.full !== false;
    const diagnostics = options.diagnostics !== false;
    const manual = options.manual === true;
    const protectedForm = full && deps.hasUnsavedChanges();
    const task = (async () => {
      deps.setStatus({ busy: true, protected: protectedForm, enabled });
      try {
        const loads = [deps.loadConnection()];
        if (diagnostics) loads.push(deps.loadDiagnostics());
        if (full && !protectedForm) loads.push(deps.loadFull());
        await Promise.all(loads);
        deps.setStatus({
          busy: false,
          protected: protectedForm,
          enabled,
          syncedAt: deps.now()
        });
        return { ok: true, protected: protectedForm };
      } catch (error) {
        deps.setStatus({ busy: false, protected: protectedForm, enabled, error });
        if (manual) deps.reportManualError(error);
        return { ok: false, error };
      }
    })();
    refreshFlight = task.finally(() => {
      refreshFlight = null;
    });
    return refreshFlight;
  };

  const setEnabled = async (nextValue) => {
    const next = nextValue === true;
    if (next !== enabled) {
      await deps.persistEnabled(next);
      enabled = next;
    }
    if (enabled) ensureInterval();
    else stopInterval();
    deps.setStatus({ busy: false, enabled });
    return enabled;
  };

  const handleStorageChange = (changes, areaName) => {
    if (!enabled || !changes || typeof changes !== "object") return Promise.resolve(false);
    if (areaName === "local" && changes.drcomAssistantState) {
      return requestRefresh({ full: true, diagnostics: true });
    }
    if (areaName === "session" && changes.drcomAssistantSession) {
      return requestRefresh({ full: false, diagnostics: false });
    }
    return Promise.resolve(false);
  };

  const handleVisibilityChange = () => {
    if (!deps.isVisible()) {
      stopInterval();
      return Promise.resolve(false);
    }
    if (!enabled) return Promise.resolve(false);
    ensureInterval();
    return requestRefresh({ full: true, diagnostics: true });
  };

  const handleFocus = () => {
    if (!enabled || !deps.isVisible()) return Promise.resolve(false);
    ensureInterval();
    return requestRefresh({ full: true, diagnostics: true });
  };

  const reload = async () => {
    if (deps.hasUnsavedChanges() && !(await deps.confirmReload())) return false;
    deps.reloadPage();
    return true;
  };

  const destroy = () => {
    stopInterval();
  };

  const start = (initialEnabled = true) => {
    enabled = initialEnabled !== false;
    if (enabled) ensureInterval();
    else stopInterval();
    deps.setStatus({ busy: false, enabled });
    return enabled;
  };

  return {
    destroy,
    handleFocus,
    handleStorageChange,
    handleVisibilityChange,
    isEnabled: () => enabled,
    reload,
    requestRefresh,
    setEnabled,
    start
  };
}

  globalThis.DrcomOptionsRefresh = {
    createSettingsRefreshController
  };
  globalThis.createSettingsRefreshController = createSettingsRefreshController;
})();
