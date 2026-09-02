"use strict";

const accountUtils = globalThis.DrcomAccountUtils;
const splitAccount = accountUtils.parse;
const suffixLabel = accountUtils.suffixLabel;
const makeAccountLabel = accountUtils.label;
const naturalAccountKey = accountUtils.naturalKey;

const BACKGROUND_IMAGE_BUDGET_BYTES = 3 * 1024 * 1024;
const BACKGROUND_SOURCE_LIMIT_BYTES = 48 * 1024 * 1024;
const BACKGROUND_TARGET_DIMENSIONS = [2560, 2240, 1920, 1600, 1280, 960];
const BACKGROUND_WEBP_QUALITIES = [0.92, 0.88, 0.84];
const SETTINGS_REFRESH_INTERVAL_MS = 15_000;
const $ = (id) => document.getElementById(id);
let state = null;
let editingAccountId = "";
let settingsFormDirty = false;
let accountFormDirty = false;
let settingsRefreshController = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupSettingsNavigation();
  if (!globalThis.chrome?.runtime?.sendMessage) return;
  bindEvents();
  try {
    await loadState();
    await loadPortalDiagnostics();
    settingsRefreshController.start(state.config.ui.autoRefreshSettings !== false);
  } catch (error) {
    toast(error.message || String(error));
  }
}

function bindEvents() {
  settingsRefreshController = createSettingsRefreshController({
    loadFull: () => loadState({ includeConnection: false }),
    loadConnection: refreshConnectionState,
    loadDiagnostics: loadPortalDiagnostics,
    hasUnsavedChanges: () => settingsFormDirty || accountFormDirty,
    setStatus: renderSettingsRefreshStatus,
    reportManualError: (error) => toast(error.message || String(error)),
    persistEnabled: persistAutoRefreshPreference,
    confirmReload: confirmSettingsReload,
    reloadPage: () => globalThis.location.reload(),
    isVisible: () => document.visibilityState !== "hidden",
    setIntervalFn: (callback, delay) => globalThis.setInterval(callback, delay),
    clearIntervalFn: (interval) => globalThis.clearInterval(interval),
    now: () => Date.now()
  });

  $("auto-refresh-settings").addEventListener("change", (event) => {
    const input = event.currentTarget;
    const previous = settingsRefreshController.isEnabled();
    input.disabled = true;
    Promise.resolve(settingsRefreshController.setEnabled(input.checked))
      .then(() => { input.checked = settingsRefreshController.isEnabled(); })
      .catch((error) => {
        input.checked = previous;
        toast(error.message || String(error));
      })
      .finally(() => { input.disabled = false; });
  });
  $("refresh-settings").addEventListener("click", () => {
    settingsRefreshController.requestRefresh({ full: true, diagnostics: true, manual: true });
  });
  $("reload-settings-page").addEventListener("click", () => {
    settingsRefreshController.reload().catch((error) => toast(error.message || String(error)));
  });
  $("account-form").addEventListener("input", markAccountFormDirty);
  $("account-form").addEventListener("change", markAccountFormDirty);
  $("settings-form").addEventListener("input", () => { settingsFormDirty = true; });
  $("settings-form").addEventListener("change", () => { settingsFormDirty = true; });
  chrome.storage?.onChanged?.addListener(settingsRefreshController.handleStorageChange);
  document.addEventListener("visibilitychange", settingsRefreshController.handleVisibilityChange);
  globalThis.addEventListener("focus", settingsRefreshController.handleFocus);
  globalThis.addEventListener("pagehide", settingsRefreshController.destroy, { once: true });

  $("parse-url").addEventListener("click", parseCapturedUrl);
  $("save-parsed-account").addEventListener("click", runAsync(saveParsedAccount));
  $("settings-form").addEventListener("submit", runAsync(saveSettings));
  $("reset-config").addEventListener("click", runAsync(resetConfig));
  $("clear-request-log").addEventListener("click", runAsync(clearRequestLog));
  $("portal-diagnostics-enabled").addEventListener("change", (event) => {
    const desired = event.target.checked;
    const previous = !desired;
    runAsync(() => setPortalDiagnosticsEnabled(desired, previous))();
  });
  $("export-portal-diagnostics").addEventListener("click", runAsync(exportPortalDiagnostics));
  $("clear-portal-diagnostics").addEventListener("click", runAsync(clearPortalDiagnostics));
  $("overview-open-portal").addEventListener("click", openConfiguredPortal);
  $("test-connection").addEventListener("click", runAsync(testConnection));
  $("account-form").addEventListener("submit", runAsync(saveEditedAccount));
  $("account-login").addEventListener("click", runAsync(loginEditedAccount));
  $("account-logout").addEventListener("click", runAsync(logoutAccount));
  $("account-delete").addEventListener("click", runAsync(deleteEditedAccount));
  $("account-reveal").addEventListener("change", (event) => {
    $("account-password").type = event.target.checked ? "text" : "password";
  });
  $("keep-alive").addEventListener("change", syncDependentControls);
  ["interval-minutes", "interval-seconds"].forEach((id) => {
    $(id).addEventListener("change", syncIntervalControls);
  });
  $("account-list").addEventListener("click", runAsync(handleAccountListClick));
  $("appearance-theme").addEventListener("change", runAsync(async () => {
    applyCurrentAppearance();
    await persistAppearance();
    toast("显示模式已应用");
  }));
  $("appearance-accent").addEventListener("input", applyCurrentAppearance);
  $("appearance-accent").addEventListener("change", runAsync(async () => {
    await persistAppearance();
    toast("强调色已应用");
  }));
  $("online-detail-mode").addEventListener("change", runAsync(async () => {
    await persistAppearance();
    toast("在线信息显示已应用");
  }));
  $("appearance-background").addEventListener("change", runAsync(async () => {
    syncAppearanceControls();
    applyCurrentAppearance();
    await persistAppearance();
    toast("背景设置已应用");
  }));
  $("background-file").addEventListener("change", runAsync(handleBackgroundFile));
  $("clear-background").addEventListener("click", runAsync(clearBackgroundImage));
  ["background-blur", "background-dim", "background-scale"].forEach((id) => {
    $(id).addEventListener("input", () => {
      syncAppearanceControls();
      applyCurrentAppearance();
    });
    $(id).addEventListener("change", runAsync(async () => {
      await persistAppearance();
      toast("背景参数已应用");
    }));
  });
}

function runAsync(fn) {
  return (...args) => {
    Promise.resolve(fn(...args)).catch((error) => {
      toast(error.message || String(error));
    });
  };
}

function markAccountFormDirty(event) {
  if (event.target?.id !== "account-reveal") accountFormDirty = true;
}

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

async function loadState({ includeConnection = true } = {}) {
  const response = await sendMessage({ action: "state:get" });
  state = response.state;
  hydrateForm();
  renderAccounts();
  renderRequestLog();
  const selected = state.accounts.find((account) => account.id === state.selectedAccountId) || state.accounts[0] || null;
  fillAccountEditor(selected);
  if (includeConnection) {
    try {
      await refreshConnectionState();
    } catch (error) {
      renderConnectionOverview(null);
    }
  }
  return state;
}

async function refreshConnectionState() {
  const connection = await sendMessage({ action: "connection:get" });
  renderConnectionOverview(connection.connection);
  return connection;
}

function portalDiagnosticsLimitBytes(diagnostics) {
  return Number(diagnostics && diagnostics.limits && (diagnostics.limits.maxBytes ?? diagnostics.limits.bytes)) || 1024 * 1024;
}

function portalDiagnosticsLimitSessions(diagnostics) {
  return Number(diagnostics && diagnostics.limits && (diagnostics.limits.maxSessions ?? diagnostics.limits.sessions)) || 10;
}

function formatPortalDiagnosticsSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return Math.round(value) + " B";
  if (value < 1024 * 1024) return Math.round(value / 102.4) / 10 + " KB";
  return Math.round(value / (1024 * 1024) * 10) / 10 + " MiB";
}

function renderPortalDiagnostics(diagnostics) {
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
  if (status) status.textContent = diagnostics.paused === true
    ? "诊断记录已暂停"
    : enabled ? "诊断模式已开启" : "诊断模式已关闭";
  if (storage) storage.textContent = formatPortalDiagnosticsSize(bytes) + " / " + formatPortalDiagnosticsSize(portalDiagnosticsLimitBytes(diagnostics));
  if (sessions) sessions.textContent = sessionCount + " / " + portalDiagnosticsLimitSessions(diagnostics);
  if (dropped) dropped.textContent = droppedRecords + " 条";
}

async function loadPortalDiagnostics() {
  const result = await sendMessage({ action: "diagnostics:get" });
  renderPortalDiagnostics(result);
  return result;
}

function portalDiagnosticsExportFilename(now = new Date()) {
  return "drcom-portal-diagnostics-" + now.toISOString().replace(/[:.]/g, "-") + ".json";
}

async function setPortalDiagnosticsEnabled(enabled, previous = null) {
  const input = $("portal-diagnostics-enabled");
  const before = previous === null ? Boolean(input && input.checked) : Boolean(previous);
  if (input) {
    input.checked = before;
    input.disabled = true;
  }
  try {
    const result = await sendMessage({ action: "diagnostics:set", enabled: enabled === true });
    await loadPortalDiagnostics();
    return result;
  } catch (error) {
    if (input) input.checked = before;
    toast(error.message || String(error));
    return false;
  } finally {
    if (input) input.disabled = false;
  }
}

async function exportPortalDiagnostics() {
  const button = $("export-portal-diagnostics");
  if (button) button.disabled = true;
  try {
    const result = await sendMessage({ action: "diagnostics:export" });
    const blob = new Blob([JSON.stringify(result.export, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = portalDiagnosticsExportFilename();
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
    return true;
  } finally {
    if (button) button.disabled = false;
  }
}

async function clearPortalDiagnostics() {
  const confirmer = globalThis.DrcomConfirm?.confirm || globalThis.DrcomConfirmDialog?.ask;
  if (typeof confirmer !== "function") throw new Error("确认对话框不可用");
  const controller = globalThis.DrcomConfirm || globalThis.DrcomConfirmDialog;
  const confirmed = await confirmer.call(controller, {
    title: "清空门户诊断记录？",
    message: "将删除本机保存的全部门户诊断会话，诊断开关保持不变。此操作无法撤销。",
    confirmText: "清空记录",
    confirmLabel: "清空记录",
    danger: true
  });
  if (!confirmed) return false;
  const button = $("clear-portal-diagnostics");
  if (button) button.disabled = true;
  try {
    await sendMessage({ action: "diagnostics:clear" });
    await loadPortalDiagnostics();
    return true;
  } finally {
    if (button) button.disabled = false;
  }
}

function hydrateForm() {
  const { config } = state;
  $("portal-url").value = config.portalUrl;
  $("api-url").value = config.apiUrl;
  $("account-prefix").value = config.login.accountPrefix;
  $("login-method").value = config.login.loginMethod;
  $("callback-prefix").value = config.login.callbackPrefix;
  $("js-version").value = config.login.jsVersion;
  $("default-ip").value = config.network.wlanUserIp;
  $("default-mac").value = config.network.wlanUserMac;
  $("default-ipv6").value = config.network.wlanUserIpv6;
  $("default-ac-ip").value = config.network.wlanAcIp;
  $("default-ac-name").value = config.network.wlanAcName;
  $("login-on-startup").checked = config.automation.loginOnStartup;
  $("return-to-portal").checked = config.redirect.returnToPortal !== false;
  $("keep-alive").checked = config.automation.keepAlive;
  const interval = splitKeepAliveInterval(config.automation.intervalMinutes);
  $("interval-minutes").value = String(interval.minutes);
  $("interval-seconds").value = String(interval.seconds);
  $("guard-seconds").value = config.redirect.guardSeconds;
  $("modernize-portal").checked = config.ui.modernizePortal !== false;
  $("auto-refresh-settings").checked = config.ui.autoRefreshSettings !== false;
  hydrateAppearance(config.ui);
  const overviewHost = $("overview-gateway-host");
  if (overviewHost) overviewHost.textContent = gatewayHost(config.portalUrl);
  const pageStatusHost = $("page-status-host");
  if (pageStatusHost) pageStatusHost.textContent = gatewayHost(config.portalUrl);
  syncDependentControls();
  syncIntervalControls();
  settingsFormDirty = false;
}

function hydrateAppearance(input) {
  const appearance = globalThis.DrcomAppearance.normalizeAppearance(input);
  $("online-detail-mode").value = ["classic", "full", "minimal", "hidden"].includes(input?.onlineDetailMode)
    ? input.onlineDetailMode
    : "classic";
  $("appearance-theme").value = appearance.theme;
  $("appearance-accent").value = appearance.accent;
  $("appearance-background").value = appearance.background;
  $("background-image-data").value = appearance.backgroundImage;
  $("background-blur").value = appearance.backgroundBlur;
  $("background-dim").value = appearance.backgroundDim;
  $("background-scale").value = appearance.backgroundScale;
  syncAppearanceControls();
  applyCurrentAppearance();
}

function connectionSummary(connection) {
  if (!connection || typeof connection !== "object") {
    return { label: "无法检查", detail: "后台暂时不可用", tone: "action" };
  }
  const online = connection.online === true || connection.phase === "online";
  const phase = online ? "online" : String(connection.phase || "idle");
  const presentations = {
    online: { label: "已连接", detail: "当前认证状态正常", tone: "online" },
    captive: { label: "需要登录", detail: "当前网络尚未完成认证", tone: "action" },
    action_required: { label: "需要处理", detail: "请检查账号或认证信息", tone: "action" },
    waiting: { label: "等待重试", detail: "助手会在稍后继续检查", tone: "waiting" },
    checking: { label: "检查中", detail: "正在读取校园网状态", tone: "waiting" },
    authenticating: { label: "登录中", detail: "正在向认证网关发送请求", tone: "waiting" },
    offline: { label: "未连接", detail: "可以打开认证页完成登录", tone: "action" },
    idle: { label: "尚未检查", detail: "点击测试连接获取当前状态", tone: "neutral" }
  };
  const presentation = presentations[phase] || presentations.offline;
  return {
    ...presentation,
    detail: String(connection.message || presentation.detail)
  };
}

function renderConnectionOverview(connection) {
  const element = $("settings-connection-status");
  const presentation = connectionSummary(connection);
  if (element) {
    element.textContent = `${presentation.label} · ${presentation.detail}`;
    element.dataset.tone = presentation.tone;
  }
  const pageStatus = $("page-connection-status");
  const pageLabel = $("page-status-label");
  if (pageStatus) pageStatus.dataset.tone = presentation.tone;
  if (pageLabel) pageLabel.textContent = presentation.label;
}

function formatSettingsRefreshTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderSettingsRefreshStatus(status = {}) {
  const element = $("settings-refresh-status");
  const button = $("refresh-settings");
  if (!element) return;
  if (button) button.disabled = status.busy === true;
  element.dataset.tone = status.error ? "error" : status.protected ? "warning" : "neutral";
  if (status.busy) {
    element.textContent = status.protected
      ? "正在同步安全区域；未保存编辑已受保护"
      : "正在同步设置…";
    return;
  }
  if (status.error) {
    element.textContent = "同步失败：" + (status.error.message || String(status.error));
    return;
  }
  if (status.protected) {
    element.textContent = "检测到未保存编辑；已更新连接状态和诊断摘要";
    return;
  }
  if (status.syncedAt) {
    element.textContent = "最近同步 " + formatSettingsRefreshTime(status.syncedAt);
    return;
  }
  element.textContent = status.enabled === false ? "自动同步已关闭" : "自动同步已开启";
}

async function persistAutoRefreshPreference(enabled) {
  const response = await sendMessage({
    action: "config:save",
    config: { ui: { autoRefreshSettings: enabled === true } }
  });
  if (response.state) state = response.state;
  return response;
}

function confirmSettingsReload() {
  return globalThis.DrcomConfirmDialog.ask({
    title: "重新加载设置页？",
    message: "当前有尚未保存的账号或设置。重新加载会丢弃这些编辑。",
    confirmLabel: "放弃编辑并重新加载"
  });
}

async function testConnection() {
  const button = $("test-connection");
  const status = $("settings-connection-status");
  if (button) {
    button.disabled = true;
    button.textContent = "检查中…";
  }
  if (status) {
    status.textContent = "检查中 · 正在联系认证网关";
    status.dataset.tone = "waiting";
  }
  try {
    const result = await sendMessage({ action: "drcom:status" });
    renderConnectionOverview(result);
  } catch (error) {
    renderConnectionOverview({ phase: "action_required", message: error.message || String(error) });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "测试连接";
    }
  }
}

function openConfiguredPortal() {
  const portalUrl = state?.config?.portalUrl;
  if (!portalUrl) {
    toast("设置仍在加载，请稍后再试");
    return false;
  }
  chrome.tabs.create({ url: portalUrl });
  return true;
}

function setupSettingsNavigation() {
  if (!document.querySelectorAll) return;
  const buttons = Array.from(document.querySelectorAll("[data-settings-target]"));
  const panels = Array.from(document.querySelectorAll("[data-settings-panel]"));
  if (!buttons.length || !panels.length) return;

  const activate = (button) => {
    const targetId = button.dataset.settingsTarget;
    for (const panel of panels) {
      panel.hidden = panel.id !== targetId && panel.dataset.settingsGroup !== targetId;
    }
    for (const item of buttons) {
      if (item === button) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    $("settings-title").textContent = button.dataset.settingsTitle || button.textContent.trim();
    $("settings-description").textContent = button.dataset.settingsDescription || "";
    const titleIcon = $("settings-title-icon");
    const sourceIcon = button.querySelector?.(".nav-icon");
    if (titleIcon && sourceIcon) {
      const tone = Array.from(sourceIcon.classList).find((name) => name.startsWith("tone-"));
      titleIcon.className = `page-title-icon ${tone || "tone-blue"}`;
      const svg = sourceIcon.querySelector("svg");
      if (svg) titleIcon.replaceChildren(svg.cloneNode(true));
    }
    const actions = $("settings-actions");
    if (actions) actions.hidden = !["connection-overview", "advanced-settings"].includes(targetId);
    if (targetId === "advanced-settings") $("advanced-settings").open = true;
    try { localStorage.setItem("drcom-settings-panel", targetId); } catch (error) {}
  };

  for (const button of buttons) button.addEventListener("click", () => activate(button));
  let savedTarget = "";
  try { savedTarget = localStorage.getItem("drcom-settings-panel") || ""; } catch (error) {}
  activate(buttons.find((button) => button.dataset.settingsTarget === savedTarget) || buttons[0]);
}

function syncDependentControls() {
  const keepAlive = $("keep-alive");
  const minutes = $("interval-minutes");
  const seconds = $("interval-seconds");
  if (!keepAlive || !minutes) return;
  minutes.disabled = !keepAlive.checked;
  if (seconds) seconds.disabled = !keepAlive.checked;
}

function splitKeepAliveInterval(value) {
  const safe = Math.min(30, Math.max(0.5, Number(value) || 0.5));
  const totalSeconds = Math.round(safe * 60 / 15) * 15;
  return {
    minutes: Math.min(30, Math.floor(totalSeconds / 60)),
    seconds: totalSeconds >= 1800 ? 0 : totalSeconds % 60
  };
}

function readKeepAliveInterval() {
  const minutes = Number($("interval-minutes")?.value) || 0;
  const seconds = Number($("interval-seconds")?.value) || 0;
  return Math.min(30, Math.max(0.5, minutes + seconds / 60));
}

function syncIntervalControls() {
  const minutes = $("interval-minutes");
  const seconds = $("interval-seconds");
  if (!minutes || !seconds) return;
  const normalized = splitKeepAliveInterval(readKeepAliveInterval());
  minutes.value = String(normalized.minutes);
  seconds.value = String(normalized.seconds);
  const summary = $("interval-summary");
  if (summary) {
    const parts = [];
    if (normalized.minutes) parts.push(`${normalized.minutes} 分钟`);
    if (normalized.seconds) parts.push(`${normalized.seconds} 秒`);
    summary.textContent = `每 ${parts.join(" ")}检查一次`;
  }
}

function gatewayHost(value) {
  try { return new URL(value).host || "认证页"; }
  catch (error) { return "认证页"; }
}

function gatewayOriginPattern(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.protocol}//${url.hostname}/*`;
  } catch (error) {
    return "";
  }
}

async function requestGatewayAccess(config) {
  if (!globalThis.chrome?.permissions?.request) return true;
  const builtIn = new Set(["http://10.10.10.2/*", "https://10.10.10.2/*"]);
  const origins = Array.from(new Set([
    gatewayOriginPattern(config?.portalUrl),
    gatewayOriginPattern(config?.apiUrl)
  ].filter((origin) => origin && !builtIn.has(origin))));
  if (!origins.length) return true;

  const request = { origins };
  if (config?.ui?.modernizePortal !== false) request.permissions = ["scripting"];
  const granted = await chrome.permissions.request(request);
  if (!granted) throw new Error("需要允许访问自定义校园网网关，才能保存并应用该配置");
  return true;
}

function renderAccounts() {
  const list = $("account-list");
  const sidebarSummary = $("sidebar-account-summary");
  const selected = state.accounts.find((account) => account.id === state.selectedAccountId) || state.accounts[0] || null;
  if (sidebarSummary) sidebarSummary.textContent = selected ? (selected.label || maskAccount(selected)) : "未保存账号";
  if (!state.accounts.length) {
    list.innerHTML = '<p class="empty-note">还没有保存账号。先在校园网认证页登录一次，或手动保存账号。</p>';
    return;
  }
  list.innerHTML = state.accounts.map((account) => {
    const parsed = splitAccount(account.username, account.suffix);
    const accountLabel = account.label || makeAccountLabel(parsed.username, parsed.suffix);
    return '<div class="simple-account' + (account.id === state.selectedAccountId ? ' active' : '') + '">' +
      '<button type="button" class="account-row" data-edit="' + escapeHtml(account.id) + '">' +
      '<strong>' + escapeHtml(accountLabel) + '</strong>' +
      '<span>' + escapeHtml(maskAccount(account)) + '</span></button>' +
      '<button type="button" class="small-danger" title="删除账号：' + escapeHtml(accountLabel) + '" aria-label="删除账号：' + escapeHtml(accountLabel) + '" data-delete="' + escapeHtml(account.id) + '">删</button></div>';
  }).join("");
}

function renderRequestLog() {
  const list = $("request-log");
  const records = Array.isArray(state.recentRequests) ? state.recentRequests : [];
  if (!records.length) {
    list.innerHTML = '<p class="empty-note">暂无记录。点击登录、下线或刷新状态后，这里会显示最近 10 次请求。</p>';
    return;
  }
  list.innerHTML = records.map((record) => {
    const ok = isRequestRecordOk(record);
    const kind = record.kind === "login" ? "登录" : record.kind === "logout" ? "下线" : record.kind === "status" ? "状态检测" : record.kind || "请求";
    const badge = record.kind === "logout" ? (ok ? "成功/离线" : "失败") : record.kind === "status" ? (ok ? "在线" : "未在线") : (ok ? "成功/在线" : "失败/离线");
    return '<article class="request-log-item">' +
      '<div class="request-log-head"><strong>' + escapeHtml(kind) + '</strong>' +
      '<span class="request-badge ' + (ok ? 'ok' : 'fail') + '">' + badge + '</span>' +
      '<time>' + escapeHtml(formatTime(record.createdAt)) + '</time></div>' +
      '<p>' + escapeHtml(record.message || '无明确消息') + '</p>' +
      '<details><summary>查看脱敏 URL 与返回文本</summary>' +
      '<code>' + escapeHtml(record.url || '无 URL') + '</code>' +
      '<pre>' + escapeHtml(record.raw || '无返回文本') + '</pre>' +
      '</details></article>';
  }).join("");
}


function isRequestRecordOk(record) {
  if (!record) return false;
  if (record.kind === "login" || record.kind === "logout") return Boolean(record.success);
  if (record.kind === "status") return Boolean(record.online);
  return Boolean(record.success || record.online);
}

async function handleAccountListClick(event) {
  const editButton = event.target.closest("[data-edit]");
  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) {
    await deleteAccount(deleteButton.dataset.delete);
    return;
  }
  if (editButton) {
    const account = state.accounts.find((item) => item.id === editButton.dataset.edit);
    fillAccountEditor(account);
    await selectAccount(editButton.dataset.edit);
  }
}

function fillAccountEditor(account) {
  const parsed = account ? splitAccount(account.username, account.suffix) : { username: "", suffix: "" };
  editingAccountId = account ? account.id : "";
  $("account-id").value = editingAccountId;
  $("account-label").value = account ? account.label : "";
  $("account-suffix").value = parsed.suffix;
  $("account-username").value = parsed.username;
  $("account-password").value = account ? account.password : "";
  $("account-ip").value = account && account.network ? account.network.wlanUserIp : "";
  $("account-mac").value = account && account.network ? account.network.wlanUserMac : "000000000000";
  $("account-ipv6").value = account && account.network ? account.network.wlanUserIpv6 : "";
  $("account-ac-ip").value = account && account.network ? account.network.wlanAcIp : "";
  $("account-ac-name").value = account && account.network ? account.network.wlanAcName : "";
  accountFormDirty = false;
}

function readEditedAccount() {
  const parsed = splitAccount($("account-username").value.trim(), $("account-suffix").value.trim());
  const label = $("account-label").value.trim() || makeAccountLabel(parsed.username, parsed.suffix);
  return {
    id: editingAccountId,
    label,
    username: parsed.username,
    suffix: parsed.suffix,
    password: $("account-password").value,
    network: {
      wlanUserIp: $("account-ip").value.trim(),
      wlanUserMac: $("account-mac").value.trim() || "000000000000",
      wlanUserIpv6: $("account-ipv6").value.trim(),
      wlanAcIp: $("account-ac-ip").value.trim(),
      wlanAcName: $("account-ac-name").value.trim()
    }
  };
}

async function saveEditedAccount(event) {
  event.preventDefault();
  const response = await sendMessage({ action: "account:save", account: readEditedAccount() });
  state = response.state;
  fillAccountEditor(response.account);
  renderAccounts();
  renderRequestLog();
  toast("账号已保存");
}

async function loginEditedAccount() {
  const saved = await sendMessage({ action: "account:save", account: readEditedAccount() });
  state = saved.state;
  fillAccountEditor(saved.account);
  renderAccounts();
  const result = await sendMessage({ action: "drcom:login", accountId: saved.account.id });
  await loadState();
  toast(result.message || "已发送登录请求");
}

async function logoutAccount() {
  const result = await sendMessage({ action: "drcom:logout" });
  await loadState();
  toast(result.message || "已发送下线请求");
}

async function deleteEditedAccount() {
  if (!editingAccountId) return;
  await deleteAccount(editingAccountId);
}

async function deleteAccount(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  const accountLabel = account.label || makeAccountLabel(account.username, account.suffix);
  const confirmed = await globalThis.DrcomConfirmDialog.ask({
    title: "删除账号？",
    message: `将永久删除账号“${accountLabel}”（${maskAccount(account)}）。此操作无法撤销。`,
    confirmLabel: "删除账号"
  });
  if (!confirmed) return;

  const response = await sendMessage({ action: "account:delete", accountId });
  state = response.state;
  renderAccounts();
  renderRequestLog();
  fillAccountEditor(state.accounts.find((account) => account.id === state.selectedAccountId) || state.accounts[0] || null);
  toast("账号已删除");
}

async function selectAccount(accountId) {
  const response = await sendMessage({ action: "account:select", accountId });
  state = response.state;
  renderAccounts();
}

function parseCapturedUrl() {
  const raw = $("raw-url").value.trim();
  if (!raw) return toast("请先粘贴抓包 URL");
  try {
    const url = new URL(raw);
    const params = url.searchParams;
    const parsed = splitAccount(params.get("user_account") || "");
    $("api-url").value = url.origin + url.pathname;
    $("parsed-label").value = makeAccountLabel(parsed.username, parsed.suffix);
    $("parsed-username").value = parsed.username;
    $("parsed-suffix").value = parsed.suffix;
    $("parsed-password").value = params.get("user_password") || "";
    $("parsed-ip").value = params.get("wlan_user_ip") || "";
    $("parsed-mac").value = params.get("wlan_user_mac") || "000000000000";
    $("login-method").value = params.get("login_method") || $("login-method").value || "1";
    $("js-version").value = params.get("jsVersion") || $("js-version").value || "3.3.2";
    settingsFormDirty = true;
    toast("解析成功：" + suffixLabel(parsed.suffix));
  } catch (error) {
    toast("URL 格式不正确");
  }
}

async function saveParsedAccount() {
  const parsed = splitAccount($("parsed-username").value.trim(), $("parsed-suffix").value.trim());
  const account = {
    label: $("parsed-label").value.trim() || makeAccountLabel(parsed.username, parsed.suffix),
    username: parsed.username,
    suffix: parsed.suffix,
    password: $("parsed-password").value,
    network: {
      wlanUserIp: $("parsed-ip").value.trim(),
      wlanUserMac: $("parsed-mac").value.trim() || "000000000000"
    }
  };
  const existing = state.accounts.find((item) => naturalAccountKey(item) === naturalAccountKey(account));
  if (existing) {
    const existingLabel = existing.label || makeAccountLabel(existing.username, existing.suffix);
    const confirmed = await globalThis.DrcomConfirmDialog.ask({
      title: "覆盖导入账号？",
      message: `导入数据将覆盖账号“${existingLabel}”的名称、密码和网络参数。此操作无法撤销。`,
      confirmLabel: "覆盖导入"
    });
    if (!confirmed) return;
    account.id = existing.id;
  }
  const response = await sendMessage({ action: "account:save", account });
  state = response.state;
  fillAccountEditor(response.account);
  renderAccounts();
  renderRequestLog();
  toast("账号已保存：" + suffixLabel(response.account.suffix));
}

async function saveSettings(event) {
  event.preventDefault();
  const config = readConfig();
  await requestGatewayAccess(config);
  const response = await sendMessage({ action: "config:save", config });
  state = response.state;
  hydrateForm();
  renderAccounts();
  renderRequestLog();
  toast("配置已保存");
}

async function resetConfig() {
  const accountCount = state.accounts.length;
  const confirmed = await globalThis.DrcomConfirmDialog.ask({
    title: "恢复默认设置？",
    message: `将把网关、认证协议、自动化、门户和外观设置恢复为默认值。现有的 ${accountCount} 个已保存账号不会删除。`,
    confirmLabel: "恢复默认"
  });
  if (!confirmed) return;

  const response = await sendMessage({ action: "config:reset" });
  state = response.state;
  hydrateForm();
  renderAccounts();
  renderRequestLog();
  toast("已恢复默认配置");
}

async function clearRequestLog() {
  const recordCount = state.recentRequests.length;
  if (!recordCount) return toast("没有请求记录可清空");
  const confirmed = await globalThis.DrcomConfirmDialog.ask({
    title: "清空请求记录？",
    message: `将永久清空当前保存的 ${recordCount} 条脱敏请求记录。此操作无法撤销。`,
    confirmLabel: "清空记录"
  });
  if (!confirmed) return;

  const response = await sendMessage({ action: "requestLog:clear" });
  state = response.state;
  renderRequestLog();
  toast("请求记录已清空");
}

function readConfig() {
  return {
    portalUrl: $("portal-url").value.trim(),
    apiUrl: $("api-url").value.trim(),
    login: {
      accountPrefix: $("account-prefix").value,
      loginMethod: $("login-method").value.trim(),
      callbackPrefix: $("callback-prefix").value.trim(),
      jsVersion: $("js-version").value.trim(),
      findMacBeforeLogin: true
    },
    network: {
      wlanUserIp: $("default-ip").value.trim(),
      wlanUserMac: $("default-mac").value.trim() || "000000000000",
      wlanUserIpv6: $("default-ipv6").value.trim(),
      wlanAcIp: $("default-ac-ip").value.trim(),
      wlanAcName: $("default-ac-name").value.trim()
    },
    ui: {
      modernizePortal: $("modernize-portal").checked,
      autoRefreshSettings: $("auto-refresh-settings").checked,
      title: "徐医校园网",
      ...readAppearanceConfig()
    },
    redirect: {
      returnToPortal: $("return-to-portal").checked,
      guardSeconds: Number($("guard-seconds").value) || 4
    },
    automation: {
      loginOnStartup: $("login-on-startup").checked,
      keepAlive: $("keep-alive").checked,
      intervalMinutes: readKeepAliveInterval()
    }
  };
}

function readAppearanceConfig() {
  return {
    onlineDetailMode: $("online-detail-mode").value,
    theme: $("appearance-theme").value,
    accent: $("appearance-accent").value,
    background: $("appearance-background").value,
    backgroundImage: $("background-image-data").value,
    backgroundBlur: Number($("background-blur").value),
    backgroundDim: Number($("background-dim").value),
    backgroundScale: Number($("background-scale").value)
  };
}

function applyCurrentAppearance() {
  const config = readAppearanceConfig();
  const appearance = globalThis.DrcomAppearance.applyToRoot(document.documentElement, config);
  const preview = $("background-preview");
  preview.style.setProperty("--preview-accent", appearance.accent);
  preview.style.backgroundImage = appearance.backgroundImage ? `url("${appearance.backgroundImage}")` : "none";
  preview.dataset.hasImage = appearance.backgroundImage ? "true" : "false";
}

async function persistAppearance() {
  const previousAppearance = state?.config?.ui || null;
  const dirtyBeforePersist = settingsFormDirty;
  try {
    const response = await sendMessage({
      action: "config:save",
      config: { ui: readAppearanceConfig() }
    });
    if (response.state) {
      state = response.state;
      hydrateAppearance(response.state.config.ui);
    }
    return response;
  } catch (error) {
    if (previousAppearance) hydrateAppearance(previousAppearance);
    throw error;
  } finally {
    settingsFormDirty = dirtyBeforePersist;
  }
}

function syncAppearanceControls() {
  const custom = $("appearance-background").value === "custom";
  const imageData = $("background-image-data").value;
  const hasImage = Boolean(imageData);
  $("background-controls").hidden = !custom;
  $("clear-background").disabled = !hasImage;
  $("background-blur-value").value = `${Number($("background-blur").value)} px`;
  $("background-dim-value").value = `${Math.round(Number($("background-dim").value) * 100)}%`;
  $("background-scale-value").value = `${Math.round(Number($("background-scale").value) * 100)}%`;
  const storageNote = $("background-storage-note");
  if (storageNote) {
    storageNote.textContent = hasImage
      ? `当前约 ${formatStorageSize(imageData.length)}，保存上限 3 MB`
      : "选择后立即保存并应用；超过 3 MB 时自动高质量压缩";
  }
}

async function handleBackgroundFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  event.target.disabled = true;
  toast("正在优化背景图片…");
  try {
    const dataUrl = await optimizeBackgroundImage(file);
    $("background-image-data").value = dataUrl;
    $("appearance-background").value = "custom";
    syncAppearanceControls();
    applyCurrentAppearance();
    await persistAppearance();
    toast(`背景已应用，当前约 ${formatStorageSize(dataUrl.length)}`);
  } finally {
    event.target.value = "";
    event.target.disabled = false;
  }
}

async function clearBackgroundImage() {
  if (!$("background-image-data").value) return;
  const confirmed = await globalThis.DrcomConfirmDialog.ask({
    title: "清除背景图片？",
    message: "将删除当前保存的自定义背景图片并恢复简洁背景。重新使用时需要再次选择原图片。",
    confirmLabel: "清除图片"
  });
  if (!confirmed) return;

  $("background-image-data").value = "";
  $("appearance-background").value = "fresh";
  syncAppearanceControls();
  applyCurrentAppearance();
  await persistAppearance();
  toast("已恢复简洁背景");
}

async function optimizeBackgroundImage(file) {
  const supported = ["image/png", "image/jpeg", "image/webp", "image/avif"];
  if (!supported.includes(file.type)) throw new Error("请选择 PNG、JPEG、WebP 或 AVIF 图片");
  if (file.size > BACKGROUND_SOURCE_LIMIT_BYTES) throw new Error("原图不能超过 48 MB");

  if (estimatedDataUrlSize(file.size, file.type) <= BACKGROUND_IMAGE_BUDGET_BYTES) {
    const original = await readBlobAsDataUrl(file);
    assertBackgroundImageBudget(original);
    return original;
  }

  if (typeof createImageBitmap !== "function") {
    throw new Error("当前浏览器无法自动压缩图片，请换用尺寸更小的图片");
  }

  const bitmap = await createImageBitmap(file);
  try {
    return await compressBackgroundBitmap(bitmap);
  } finally {
    bitmap.close();
  }
}

async function compressBackgroundBitmap(bitmap) {
  const sourceMax = Math.max(bitmap.width, bitmap.height);
  const dimensions = BACKGROUND_TARGET_DIMENSIONS
    .filter((dimension) => dimension < sourceMax)
    .concat(Math.min(sourceMax, BACKGROUND_TARGET_DIMENSIONS.at(-1)))
    .filter((dimension, index, values) => values.indexOf(dimension) === index);
  const canvas = document.createElement("canvas");

  for (const targetMax of dimensions) {
    const ratio = Math.min(1, targetMax / sourceMax);
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法处理这张图片");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const qualities = targetMax === dimensions.at(-1)
      ? [...BACKGROUND_WEBP_QUALITIES, 0.8, 0.76, 0.72]
      : BACKGROUND_WEBP_QUALITIES;

    for (const quality of qualities) {
      const blob = await encodeCanvas(canvas, quality);
      if (estimatedDataUrlSize(blob.size, blob.type) > BACKGROUND_IMAGE_BUDGET_BYTES) continue;
      const dataUrl = await readBlobAsDataUrl(blob);
      if (dataUrl.length <= BACKGROUND_IMAGE_BUDGET_BYTES) return dataUrl;
    }
  }

  throw new Error("图片自动压缩后仍超过 3 MB，请换用更简单的背景图");
}

function encodeCanvas(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("无法压缩这张图片"));
    }, "image/webp", quality);
  });
}

function estimatedDataUrlSize(blobBytes, mimeType = "image/webp") {
  const headerLength = `data:${mimeType || "image/webp"};base64,`.length;
  return headerLength + Math.ceil(Math.max(0, Number(blobBytes) || 0) / 3) * 4;
}

function assertBackgroundImageBudget(dataUrl) {
  const bytes = String(dataUrl || "").length;
  if (bytes > BACKGROUND_IMAGE_BUDGET_BYTES) {
    throw new Error("图片处理后仍然过大，请换一张尺寸更小的图片");
  }
  return bytes;
}

function formatStorageSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / (1024 * 102.4)) / 10} MB`;
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(new Error("读取图片失败")), { once: true });
    reader.readAsDataURL(blob);
  });
}

function maskAccount(account) {
  const parsed = splitAccount(account.username || "", account.suffix || "");
  return accountUtils.mask(parsed.username) + " · " + suffixLabel(parsed.suffix);
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response) {
        reject(new Error("后台服务没有返回结果，请刷新后重试。"));
        return;
      }
      if (response.ok === false && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 1800);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
