"use strict";

const $ = (id) => document.getElementById(id);
let state = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  try {
    await loadState();
    await refreshStatus(false);
  } catch (error) {
    renderResult({
      phase: "offline",
      message: error.message || String(error)
    });
  }
}

function bindEvents() {
  $("account-select").addEventListener("change", runAsync(async (event) => {
    await sendMessage({ action: "account:select", accountId: event.target.value });
    await loadState();
  }));
  $("refresh-status").addEventListener("click", () => refreshStatus(true));
  $("save-account").addEventListener("click", runAsync(saveCurrentAccount));
  $("login").addEventListener("click", login);
  $("logout").addEventListener("click", logout);
  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("open-portal").addEventListener("click", openConfiguredPortal);
  $("reveal-password").addEventListener("change", (event) => {
    $("password").type = event.target.checked ? "text" : "password";
  });

  $("account-list").addEventListener("click", runAsync(async (event) => {
    const selectButton = event.target.closest("[data-select]");
    const deleteButton = event.target.closest("[data-delete]");
    if (selectButton) {
      await sendMessage({ action: "account:select", accountId: selectButton.dataset.select });
      await loadState();
    }
    if (deleteButton) {
      await sendMessage({ action: "account:delete", accountId: deleteButton.dataset.delete });
      await loadState();
      toast("账号已删除");
    }
  }));
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

function runAsync(fn) {
  return (...args) => {
    Promise.resolve(fn(...args)).catch((error) => {
      toast(error.message || String(error));
    });
  };
}

async function loadState() {
  const response = await sendMessage({ action: "state:get" });
  state = response.state;
  globalThis.DrcomAppearance.applyToRoot(document.documentElement, state.config.ui);
  $("portal-host").textContent = new URL(state.config.portalUrl).host;
  renderAccountSelect();
  renderAccountList();
  fillSelectedAccount();
}

function renderAccountSelect() {
  const select = $("account-select");
  select.innerHTML = "";
  if (!state.accounts.length) {
    select.append(new Option("还没有保存账号", ""));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const account of state.accounts) {
    const option = new Option(account.label || account.username, account.id);
    option.selected = account.id === state.selectedAccountId;
    select.append(option);
  }
}

function renderAccountList() {
  const list = $("account-list");
  list.innerHTML = "";
  if (!state.accounts.length) {
    list.innerHTML = '<li class="empty">保存账号后可以一键切换。</li>';
    return;
  }

  for (const account of state.accounts) {
    const item = document.createElement("li");
    const accountLabel = account.label || account.username;
    item.className = account.id === state.selectedAccountId ? "account active" : "account";
    item.innerHTML = `
      <button type="button" class="account-main" data-select="${escapeHtml(account.id)}">
        <strong>${escapeHtml(accountLabel)}</strong>
        <span>${escapeHtml(maskAccount(account))}</span>
      </button>
      <button type="button" class="small-danger" title="删除账号：${escapeHtml(accountLabel)}" aria-label="删除账号：${escapeHtml(accountLabel)}" data-delete="${escapeHtml(account.id)}">删</button>
    `;
    list.append(item);
  }
}

function fillSelectedAccount() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId);
  const parsed = account ? splitAccount(account.username, account.suffix) : { username: "", suffix: "" };
  $("label").value = account ? account.label : "";
  $("username").value = parsed.username;
  $("suffix").value = parsed.suffix;
  $("password").value = account ? account.password : "";
  $("wlan-user-ip").value = account ? account.network.wlanUserIp : "";
  $("wlan-user-mac").value = account ? account.network.wlanUserMac : "";
}

async function saveCurrentAccount() {
  const account = readAccountForm();
  const response = await sendMessage({ action: "account:save", account });
  state = response.state;
  await loadState();
  toast("账号已保存");
}

async function login() {
  setBusy(true);
  try {
    let result;
    if ($("remember").checked) {
      const saved = await sendMessage({ action: "account:save", account: readAccountForm() });
      result = await sendMessage({ action: "drcom:login", accountId: saved.account.id });
      await loadState();
    } else {
      result = await sendMessage({ action: "drcom:login", account: readAccountForm() });
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
  try {
    const result = await sendMessage({ action: "drcom:status" });
    renderResult(result);
    if (showToast) toast("状态已刷新");
  } catch (error) {
    renderResult({
      ok: false,
      online: false,
      success: false,
      phase: "offline",
      message: `无法刷新状态：${error.message || error}`
    });
  }
}

function renderResult(result) {
  const online = Object.prototype.hasOwnProperty.call(result, "online") ? Boolean(result.online) : Boolean(result.success);
  const phase = result.phase || (online ? "online" : "offline");
  const labels = {
    checking: "检查中",
    authenticating: "登录中",
    online: "已在线",
    captive: "需要登录",
    waiting: "等待重试",
    action_required: "需要处理",
    offline: "未连接"
  };
  $("status-dot").dataset.state = phase;
  $("status-label").textContent = labels[phase] || (online ? "已在线" : "未连接");
  $("status-message").textContent = result.message || "等待操作";
  $("request-url").textContent = result.url ? `请求：${result.url}` : "";
}

function readAccountForm() {
  const existing = state.accounts.find((account) => account.id === state.selectedAccountId);
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

function maskAccount(account) {
  const parsed = splitAccount(account.username || "", account.suffix || "");
  const name = parsed.username;
  const masked = name.length <= 4 ? name : `${name.slice(0, 2)}***${name.slice(-2)}`;
  return `${masked} · ${suffixLabel(parsed.suffix)}`;
}

function splitAccount(value, fallbackSuffix = "") {
  let raw = decodeMaybe(String(value || "").trim());
  raw = raw.replace(/^\s*0+\s*$/, "");
  if (raw.startsWith(",0,")) raw = raw.slice(3);
  const match = raw.match(/@(telecom|unicom|cmcc)$/i);
  const suffixFromRaw = match ? "@" + match[1].toLowerCase() : "";
  const suffix = suffixFromRaw || normalizeSuffix(fallbackSuffix);
  const username = suffixFromRaw ? raw.slice(0, -suffixFromRaw.length) : raw;
  return { username: username.trim(), suffix };
}

function normalizeSuffix(value) {
  const raw = decodeMaybe(String(value || "").trim()).toLowerCase();
  if (!raw || raw === "校园网" || raw === "campus" || raw === "none") return "";
  const aliases = {
    telecom: "@telecom",
    "@telecom": "@telecom",
    "电信": "@telecom",
    unicom: "@unicom",
    "@unicom": "@unicom",
    "联通": "@unicom",
    cmcc: "@cmcc",
    "@cmcc": "@cmcc",
    mobile: "@cmcc",
    "移动": "@cmcc"
  };
  if (aliases[raw]) return aliases[raw];
  return /^@[a-z0-9._-]+$/i.test(raw) ? raw : "";
}

function suffixLabel(suffix) {
  return { "": "校园网", "@telecom": "电信", "@unicom": "联通", "@cmcc": "移动" }[normalizeSuffix(suffix)] || normalizeSuffix(suffix) || "校园网";
}

function makeAccountLabel(username, suffix) {
  return (username || "未命名账号") + " " + suffixLabel(suffix);
}

function decodeMaybe(value) {
  let text = String(value || "");
  for (let i = 0; i < 2; i += 1) {
    if (!/%[0-9a-f]{2}/i.test(text)) break;
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch (error) {
      break;
    }
  }
  return text;
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
