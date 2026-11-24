"use strict";

const accountUtils = globalThis.DrcomAccountUtils;
const splitAccount = accountUtils.parse;
const suffixLabel = accountUtils.suffixLabel;
const makeAccountLabel = accountUtils.label;
const i18n = globalThis.DrcomI18n;
i18n.setLanguage("zh-CN");

const STATUS_KEYS = Object.freeze({
  checking: "status_checking",
  authenticating: "status_authenticating",
  online: "status_online",
  captive: "status_sign_in_required",
  waiting: "status_waiting",
  action_required: "status_action_required",
  offline: "status_offline"
});

const $ = (id) => document.getElementById(id);
let state = null;
let languagePreference = "auto";
let currentResult = null;
let languageControlsBound = false;
let isCreatingNewAccount = false;
let refreshingStatus = false;
let cachedDailyWallpaperUrl = "";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  try {
    await Promise.all([loadLanguage(), loadState()]);
    await refreshStatus(false);
  } catch (error) {
    renderResult({
      phase: "offline",
      message: error.message || String(error)
    });
  }
}

function bindEvents() {
  bindLanguageControls();
  $("account-select").addEventListener("change", runAsync(async (event) => {
    isCreatingNewAccount = false;
    await sendMessage({ action: "account:select", accountId: event.target.value });
    await loadState();
  }));
  $("new-account")?.addEventListener("click", startNewAccount);
  $("refresh-status").addEventListener("click", () => refreshStatus(true));
  $("save-account").addEventListener("click", runAsync(saveCurrentAccount));
  $("login").addEventListener("click", login);
  $("logout").addEventListener("click", logout);
  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("open-portal").addEventListener("click", openConfiguredPortal);
  $("reveal-password").addEventListener("change", (event) => {
    $("password").type = event.target.checked ? "text" : "password";
  });

  const submitOnEnter = (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (document.body?.dataset?.busy === "true") return;
    event.preventDefault?.();
    login();
  };
  for (const id of ["label", "username", "password", "wlan-user-ip", "wlan-user-mac"]) {
    $(id)?.addEventListener("keydown", submitOnEnter);
  }

  $("account-list").addEventListener("click", runAsync(async (event) => {
    const selectButton = event.target.closest("[data-select]");
    const deleteButton = event.target.closest("[data-delete]");
    if (selectButton) {
      isCreatingNewAccount = false;
      await sendMessage({ action: "account:select", accountId: selectButton.dataset.select });
      await loadState();
    }
    if (deleteButton) {
      await deleteAccount(deleteButton.dataset.delete);
    }
  }));
}

function bindLanguageControls() {
  if (languageControlsBound) return;
  languageControlsBound = true;
  $("language-toggle")?.addEventListener("click", runAsync(async () => {
    const preference = i18n.getLanguage() === "zh-CN" ? "en" : "zh-CN";
    applyLanguage(preference);
    try {
      await sendMessage({ action: "language:set", preference });
    } catch (error) {
      toast(i18n.t("language_not_saved"));
    }
  }));
  chrome.runtime.onMessage?.addListener((message, sender) => {
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    if (message?.action !== "language:changed") return;
    applyLanguage(message.preference);
  });
}

async function loadLanguage() {
  try {
    const response = await sendMessage({ action: "language:get" });
    applyLanguage(response.preference);
  } catch (error) {
    applyLanguage("auto");
  }
}

function applyLanguage(preference) {
  languagePreference = i18n.normalizePreference(preference);
  i18n.setLanguage(languagePreference);
  const language = i18n.getLanguage();
  i18n.apply(document, language);
  if (document.documentElement) document.documentElement.lang = language;
  const toggle = $("language-toggle");
  if (toggle) toggle.textContent = language === "zh-CN" ? "EN" : "中文";
  const newAccountButton = $("new-account");
  if (newAccountButton) {
    const translated = i18n.t("new_account");
    const label = translated && translated !== "new_account" ? translated : "新建账号";
    newAccountButton.setAttribute?.("aria-label", label);
    newAccountButton.setAttribute?.("title", label);
  }
  if (currentResult) renderResult(currentResult);
  if (state) {
    const selectedAccountId = $("account-select")?.value;
    renderAccountSelect();
    if (!isCreatingNewAccount && selectedAccountId && Array.from($("account-select")?.options || []).some((option) => option.value === selectedAccountId)) {
      $("account-select").value = selectedAccountId;
    }
    renderAccountList();
  }
}

function startNewAccount() {
  isCreatingNewAccount = true;
  const select = $("account-select");
  if (select) {
    select.value = "";
    select.selectedIndex = -1;
  }
  if ($("label")) $("label").value = "";
  if ($("username")) $("username").value = "";
  if ($("suffix")) $("suffix").value = "";
  if ($("password")) $("password").value = "";
  if ($("wlan-user-ip")) $("wlan-user-ip").value = "";
  if ($("wlan-user-mac")) $("wlan-user-mac").value = "";
  if (state) renderAccountList();
  $("username")?.focus?.();
}

async function deleteAccount(accountId) {
  if (!state || !Array.isArray(state.accounts)) return;
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  const accountLabel = account.label || makeAccountLabel(account.username, account.suffix);
  const confirmed = await globalThis.DrcomConfirmDialog.ask({
    title: i18n.t("delete_account_title"),
    message: i18n.t("delete_account_message", [accountLabel, maskAccount(account)]),
    confirmLabel: i18n.t("delete_account_confirm")
  });
  if (!confirmed) return;

  await sendMessage({ action: "account:delete", accountId });
  await loadState();
  toast(i18n.t("account_deleted"));
}

function openConfiguredPortal() {
  const portalUrl = state?.config?.portalUrl;
  if (!portalUrl) {
    toast(i18n.t("settings_loading"));
    return false;
  }
  chrome.tabs.create({ url: portalUrl });
  return true;
}

function runAsync(fn) {
  return (...args) => {
    Promise.resolve(fn(...args)).catch((error) => {
      toast(error.message || String(error));
    });
  };
}

function parsePortalHost(portalUrl) {
  try {
    return new URL(portalUrl).host || portalUrl || "10.10.10.2";
  } catch (error) {
    return portalUrl || "10.10.10.2";
  }
}

function applyState(nextState) {
  state = nextState || null;
  if (!state) return;
  if (state.config?.ui && globalThis.DrcomAppearance) {
    applyAppearance(state.config.ui);
  }
  const hostEl = $("portal-host");
  if (hostEl) hostEl.textContent = parsePortalHost(state.config?.portalUrl);
  renderAccountSelect();
  renderAccountList();
  if (!isCreatingNewAccount) fillSelectedAccount();
}

async function loadState() {
  const response = await sendMessage({ action: "state:get" });
  applyState(response.state);
}

function applyAppearance(ui) {
  const appearance = globalThis.DrcomAppearance.applyToRoot(document.documentElement, ui);
  if (!ui || ui.background !== "daily") return appearance;
  if (cachedDailyWallpaperUrl) {
    return globalThis.DrcomAppearance.applyToRoot(document.documentElement, {
      ...ui,
      background: "custom",
      backgroundImage: cachedDailyWallpaperUrl
    });
  }
  chrome.runtime.sendMessage({ action: "wallpaper:get" }, (response) => {
    if (chrome.runtime.lastError) return;
    const wallpaper = response && response.wallpaper;
    if (wallpaper && wallpaper.ok && wallpaper.dataUrl) {
      cachedDailyWallpaperUrl = wallpaper.dataUrl;
      globalThis.DrcomAppearance.applyToRoot(document.documentElement, {
        ...ui,
        background: "custom",
        backgroundImage: wallpaper.dataUrl
      });
    }
  });
  return appearance;
}

function renderAccountSelect() {
  const select = $("account-select");
  if (!select) return;
  select.innerHTML = "";
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  if (!accounts.length) {
    select.append(new Option(i18n.t("no_saved_accounts"), ""));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const account of accounts) {
    const option = new Option(account.label || account.username, account.id);
    option.selected = !isCreatingNewAccount && account.id === state.selectedAccountId;
    select.append(option);
  }
  if (isCreatingNewAccount) {
    select.value = "";
    select.selectedIndex = -1;
  }
}

function renderAccountList() {
  const list = $("account-list");
  if (!list) return;
  list.innerHTML = "";
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  if (!accounts.length) {
    list.innerHTML = `<li class="empty">${escapeHtml(i18n.t("empty_accounts_hint"))}</li>`;
    return;
  }

  for (const account of accounts) {
    const item = document.createElement("li");
    const accountLabel = account.label || account.username;
    const isActive = !isCreatingNewAccount && account.id === state.selectedAccountId;
    item.className = isActive ? "account active" : "account";
    item.innerHTML = `
      <button type="button" class="account-main" data-select="${escapeHtml(account.id)}">
        <strong>${escapeHtml(accountLabel)}</strong>
        <span>${escapeHtml(maskAccount(account))}</span>
      </button>
      <button type="button" class="small-danger" title="${escapeHtml(i18n.t("delete_account_label", [accountLabel]))}" aria-label="${escapeHtml(i18n.t("delete_account_label", [accountLabel]))}" data-delete="${escapeHtml(account.id)}">${escapeHtml(i18n.t("delete_short"))}</button>
    `;
    list.append(item);
  }
}

function fillSelectedAccount() {
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const account = accounts.find((item) => item.id === state?.selectedAccountId);
  const parsed = account ? splitAccount(account.username, account.suffix) : { username: "", suffix: "" };
  if ($("label")) $("label").value = account ? account.label : "";
  if ($("username")) $("username").value = parsed.username;
  if ($("suffix")) $("suffix").value = parsed.suffix;
  if ($("password")) $("password").value = account ? account.password : "";
  if ($("wlan-user-ip")) $("wlan-user-ip").value = account?.network?.wlanUserIp || "";
  if ($("wlan-user-mac")) $("wlan-user-mac").value = account?.network?.wlanUserMac || "";
}

async function saveCurrentAccount() {
  if (document.body?.dataset?.busy === "true") return;
  const account = readAccountForm();
  if (!account.username) throw new Error(i18n.t("username_required"));
  if (!account.password) throw new Error(i18n.t("password_required"));
  setBusy(true);
  try {
    const response = await sendMessage({ action: "account:save", account });
    isCreatingNewAccount = false;
    if (response.state) applyState(response.state);
    else await loadState();
    toast(i18n.t("account_saved"));
  } finally {
    setBusy(false);
  }
}

async function login() {
  setBusy(true);
  try {
    const account = readAccountForm();
    if (!account.username) throw new Error(i18n.t("username_required"));
    if (!account.password) throw new Error(i18n.t("password_required"));
    let result;
    if ($("remember").checked) {
      const saved = await sendMessage({ action: "account:save", account });
      isCreatingNewAccount = false;
      result = await sendMessage({ action: "drcom:login", accountId: saved.account.id });
      if (saved.state) applyState(saved.state);
      else await loadState();
    } else {
      result = await sendMessage({ action: "drcom:login", account });
    }
    renderResult(result);
  } catch (error) {
    renderResult({ ok: false, online: false, success: false, message: error.message || String(error) });
  } finally {
    setBusy(false);
  }
}

async function logout() {
  setBusy(true);
  try {
    renderResult(await sendMessage({ action: "drcom:logout" }));
  } catch (error) {
    renderResult({ ok: false, online: false, success: false, message: error.message || String(error) });
  } finally {
    setBusy(false);
  }
}

async function refreshStatus(showToast) {
  if (refreshingStatus) return;
  refreshingStatus = true;
  const refreshButton = $("refresh-status");
  const glyph = refreshButton?.querySelector?.(".win-glyph");
  if (refreshButton) refreshButton.disabled = true;
  glyph?.classList?.add("spinning");
  try {
    const result = await sendMessage({ action: "drcom:status" });
    renderResult(result);
    if (showToast) toast(i18n.t("status_refreshed"));
  } catch (error) {
    renderResult({
      ok: false,
      online: false,
      success: false,
      phase: "offline",
      message: i18n.t("refresh_failed", [error.message || error])
    });
  } finally {
    refreshingStatus = false;
    glyph?.classList?.remove("spinning");
    if (refreshButton && document.body?.dataset?.busy !== "true") {
      refreshButton.disabled = false;
    }
  }
}

function renderResult(result) {
  currentResult = result;
  const online = Object.prototype.hasOwnProperty.call(result, "online") ? Boolean(result.online) : Boolean(result.success);
  const phase = result.phase || (online ? "online" : "offline");
  $("status-dot").dataset.state = phase;
  const statusPanel = $("status-panel");
  if (statusPanel?.dataset) statusPanel.dataset.state = phase;
  $("status-label").textContent = i18n.t(STATUS_KEYS[phase] || "status_unknown");
  $("status-message").textContent = result.message
    ? i18n.localizeKnownMessage(result.message)
    : i18n.t("status_waiting_action");
  $("request-url").textContent = result.url ? i18n.t("request_url", [result.url]) : "";
}

function readAccountForm() {
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const existing = isCreatingNewAccount
    ? null
    : accounts.find((account) => account.id === state?.selectedAccountId);
  const parsed = splitAccount($("username").value.trim(), $("suffix").value.trim());
  return {
    id: existing ? existing.id : "",
    label: $("label").value.trim() || makeAccountLabel(parsed.username, parsed.suffix),
    username: parsed.username,
    suffix: parsed.suffix,
    password: $("password").value,
    network: {
      wlanUserIp: $("wlan-user-ip").value.trim(),
      wlanUserMac: $("wlan-user-mac").value.trim()
    }
  };
}

function setBusy(isBusy) {
  document.body.dataset.busy = isBusy ? "true" : "false";
  document.querySelectorAll("button, input, select").forEach((element) => {
    element.disabled = isBusy;
  });
  if (!isBusy) {
    const accountSelect = $("account-select");
    if (accountSelect) {
      accountSelect.disabled = !(state && Array.isArray(state.accounts) && state.accounts.length);
    }
    const refreshButton = $("refresh-status");
    if (refreshButton && refreshingStatus) {
      refreshButton.disabled = true;
    }
  }
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
        reject(new Error(i18n.t("backend_no_response")));
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

function maskAccount(account) {
  const parsed = splitAccount(account.username || "", account.suffix || "");
  const suffixKeys = {
    "": "carrier_campus",
    "@telecom": "carrier_telecom",
    "@unicom": "carrier_unicom",
    "@cmcc": "carrier_mobile"
  };
  return `${accountUtils.mask(parsed.username)} · ${suffixKeys[parsed.suffix] ? i18n.t(suffixKeys[parsed.suffix]) : suffixLabel(parsed.suffix)}`;
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 1800);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
