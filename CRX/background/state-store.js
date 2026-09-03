"use strict";

var accountUtils = globalThis.DrcomAccountUtils;

const STORAGE_KEY = "drcomAssistantState";
const SESSION_KEY = "drcomAssistantSession";
const SCHEMA_VERSION = 12;
const KEEPALIVE_ALARM = "drcomAssistant.keepAlive";
const RETRY_ALARM = "drcomAssistant.retry";
const RECENT_REQUEST_LIMIT = 10;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const CUSTOM_PORTAL_SCRIPT_ID = "drcom-custom-portal";
const DEPRECATED_UI_FIELDS = ["hideOriginalPortal", "subtitle", "density"];

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  selectedAccountId: "",
  accounts: [],
  recentRequests: [],
  config: {
    portalUrl: "http://10.10.10.2/",
    apiUrl: "http://10.10.10.2:801/eportal/",
    login: {
      accountPrefix: ",0,",
      callbackPrefix: "dr",
      loginMethod: "1",
      jsVersion: "3.3.2",
      findMacBeforeLogin: true
    },
    network: {
      wlanUserIp: "",
      wlanUserIpv6: "",
      wlanUserMac: "000000000000",
      wlanAcIp: "",
      wlanAcName: ""
    },
    ui: {
      modernizePortal: true,
      onlineDetailMode: "classic",
      autoRefreshSettings: true,
      title: "徐医校园网",
      accent: "#007aff",
      theme: "system",
      background: "fresh",
      backgroundImage: "",
      backgroundBlur: 14,
      backgroundDim: 0.42,
      backgroundScale: 1.04,
      backgroundPosition: "center",
      backgroundFit: "cover",
      material: "acrylic",
      navTransition: "entrance",
      navPanePosition: "left",
      panelColor: "",
      panelPattern: "grid",
      scrimStrength: 1
    },
    redirect: {
      // 只保留登录后的短时间防重定向；不再做长期外站/主机名单拦截。
      returnToPortal: true,
      guardSeconds: 4
    },
    automation: {
      loginOnStartup: true,
      keepAlive: true,
      intervalMinutes: 3
    }
  }
};

const loginFlights = new Map();
const STATE_UNCHANGED = Symbol("state-unchanged");
const WEB_PAGE_ACTIONS = new Set([
  "portal:config:get",
  "portal:appearance:get",
  "portal:status:get",
  "account:save",
  "account:network:update",
  "drcom:login",
  "drcom:logout",
  "redirect:markPortalTab",
  "options:open"
]);
const PORTAL_DIAGNOSTIC_WEB_ACTIONS = new Set([
  "diagnostics:status",
  "diagnostics:start",
  "diagnostics:append",
  "diagnostics:end"
]);
for (const action of PORTAL_DIAGNOSTIC_WEB_ACTIONS) WEB_PAGE_ACTIONS.add(action);

let stateMutationQueue = Promise.resolve();
let sessionMutationQueue = Promise.resolve();
const DEFAULT_CONNECTION_STATE = {
  phase: "idle",
  attempt: 0,
  nextRetryAt: 0,
  blocked: false,
  message: "",
  updatedAt: 0
};

async function getState() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, "username", "password"]);
  const storedState = stored[STORAGE_KEY];
  let state = storedState ? clone(storedState) : null;
  const hasLegacyCredentials = Boolean(stored.username && stored.password);

  if (hasLegacyCredentials) {
    state = state || clone(DEFAULT_STATE);
    const legacyAccount = {
      id: createId(),
      label: "默认账号",
      username: String(stored.username),
      suffix: "",
      password: String(stored.password),
      network: clone(DEFAULT_STATE.config.network),
      updatedAt: new Date().toISOString()
    };
    state.accounts = [...(Array.isArray(state.accounts) ? state.accounts : []), legacyAccount];
    if (!state.selectedAccountId) state.selectedAccountId = legacyAccount.id;
  }

  const normalized = normalizeState(state || DEFAULT_STATE);
  const needsWrite = !storedState
    || storedState.schemaVersion !== SCHEMA_VERSION
    || hasLegacyCredentials
    || JSON.stringify(storedState) !== JSON.stringify(normalized);
  if (needsWrite) {
    await setState(normalized);
  }
  if (hasLegacyCredentials) {
    await chrome.storage.local.remove(["username", "password"]);
  }

  return normalized;
}

async function setState(state) {
  const normalized = normalizeState(state);
  assertStateStorageBudget(normalized);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

function normalizeState(input) {
  const previousSchemaVersion = Number(input && input.schemaVersion) || 0;
  const state = mergeDefaults(input || {}, DEFAULT_STATE);
  state.schemaVersion = SCHEMA_VERSION;
  const deduplicated = deduplicateAccounts(
    Array.isArray(state.accounts) ? state.accounts : [],
    stringValue(state.selectedAccountId)
  );
  state.accounts = deduplicated.accounts;
  state.selectedAccountId = deduplicated.selectedAccountId;

  if (!state.accounts.some((account) => account.id === state.selectedAccountId)) {
    state.selectedAccountId = state.accounts[0] ? state.accounts[0].id : "";
  }

  state.recentRequests = Array.isArray(state.recentRequests)
    ? state.recentRequests.map(sanitizeRequestRecord).slice(0, RECENT_REQUEST_LIMIT)
    : [];

  state.config.portalUrl = normalizeUrl(state.config.portalUrl, DEFAULT_STATE.config.portalUrl);
  state.config.apiUrl = normalizeUrl(state.config.apiUrl, DEFAULT_STATE.config.apiUrl);
  state.config.ui.accent = normalizeAccent(state.config.ui.accent);
  state.config.ui.theme = ["system", "light", "dark"].includes(state.config.ui.theme)
    ? state.config.ui.theme
    : DEFAULT_STATE.config.ui.theme;
  state.config.ui.onlineDetailMode = ["classic", "full", "minimal", "hidden"].includes(state.config.ui.onlineDetailMode)
    ? state.config.ui.onlineDetailMode
    : DEFAULT_STATE.config.ui.onlineDetailMode;
  state.config.ui.autoRefreshSettings = state.config.ui.autoRefreshSettings !== false;
  if (previousSchemaVersion < 11 && state.config.ui.background === "paper") state.config.ui.theme = "light";
  if (previousSchemaVersion < 11 && state.config.ui.background === "night") state.config.ui.theme = "dark";
  state.config.ui.background = state.config.ui.background === "custom" || state.config.ui.background === "daily"
    ? state.config.ui.background
    : DEFAULT_STATE.config.ui.background;
  state.config.ui.backgroundImage = normalizeImageUrl(state.config.ui.backgroundImage);
  if (state.config.ui.background === "custom" && !state.config.ui.backgroundImage) {
    state.config.ui.background = DEFAULT_STATE.config.ui.background;
  }
  state.config.ui.backgroundPosition = [
    "left top", "center top", "right top",
    "left center", "center", "right center",
    "left bottom", "center bottom", "right bottom"
  ].includes(state.config.ui.backgroundPosition)
    ? state.config.ui.backgroundPosition
    : "center";
  state.config.ui.backgroundFit = ["cover", "contain", "fill"].includes(state.config.ui.backgroundFit)
    ? state.config.ui.backgroundFit
    : "cover";
  state.config.ui.material = ["solid", "mica", "acrylic", "acrylicStrong", "custom"].includes(state.config.ui.material)
    ? state.config.ui.material
    : "acrylic";
  state.config.ui.navTransition = ["entrance", "slide", "drillIn", "suppress"].includes(state.config.ui.navTransition)
    ? state.config.ui.navTransition
    : "entrance";
  state.config.ui.navPanePosition = ["left", "top"].includes(state.config.ui.navPanePosition)
    ? state.config.ui.navPanePosition
    : "left";
  state.config.ui.panelColor = /^#[0-9a-f]{6}$/i.test(String(state.config.ui.panelColor || "").trim())
    ? String(state.config.ui.panelColor).trim()
    : "";
  state.config.ui.panelPattern = ["grid", "dots", "diagonal", "cross", "none"].includes(state.config.ui.panelPattern)
    ? state.config.ui.panelPattern
    : "grid";
  state.config.ui.scrimStrength = Number.isFinite(Number(state.config.ui.scrimStrength))
    ? Math.min(1.4, Math.max(0.4, Number(state.config.ui.scrimStrength)))
    : 1;
  state.config.ui.backgroundBlur = clampNumber(state.config.ui.backgroundBlur, 0, 32, DEFAULT_STATE.config.ui.backgroundBlur);
  state.config.ui.backgroundDim = clampNumber(state.config.ui.backgroundDim, 0.2, 0.72, DEFAULT_STATE.config.ui.backgroundDim);
  state.config.ui.backgroundScale = clampNumber(state.config.ui.backgroundScale, 1, 1.15, DEFAULT_STATE.config.ui.backgroundScale);
  for (const field of DEPRECATED_UI_FIELDS) delete state.config.ui[field];

  state.config.redirect.guardSeconds = clampNumber(state.config.redirect.guardSeconds, 1, 120, 4);

  state.config.automation.intervalMinutes = clampNumber(state.config.automation.intervalMinutes, 0.5, 30, 3);
  if (previousSchemaVersion < 8) {
    state.config.automation.loginOnStartup = true;
    state.config.automation.keepAlive = true;
    state.config.redirect.returnToPortal = true;
  }
  if (previousSchemaVersion < 10) {
    state.config.ui.modernizePortal = true;
    if (String(state.config.ui.accent).toLowerCase() === "#14b8a6") {
      state.config.ui.accent = DEFAULT_STATE.config.ui.accent;
    }
  }
  return state;
}

function sanitizeRequestRecord(input) {
  const statusCode = Number(input && input.statusCode);
  return {
    id: stringValue(input && input.id) || createId(),
    createdAt: stringValue(input && input.createdAt) || new Date().toISOString(),
    kind: stringValue(input && input.kind).trim() || "unknown",
    ok: Boolean(input && input.ok),
    success: Boolean(input && input.success),
    online: Boolean(input && input.online),
    statusCode: Number.isFinite(statusCode) ? statusCode : 0,
    message: trimRaw(redactSensitiveText(input && input.message)),
    url: redactSensitiveUrl(input && input.url),
    raw: trimRaw(redactSensitiveText(input && input.raw))
  };
}

function mergeDefaults(input, defaults) {
  if (Array.isArray(defaults)) {
    return Array.isArray(input) ? clone(input) : clone(defaults);
  }

  if (!defaults || typeof defaults !== "object") {
    return input === undefined || input === null ? defaults : input;
  }

  const result = {};
  for (const key of Object.keys(defaults)) {
    result[key] = mergeDefaults(input ? input[key] : undefined, defaults[key]);
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of Object.keys(input)) {
      if (!(key in result)) {
        result[key] = clone(input[key]);
      }
    }
  }

  return result;
}

function mergePatch(target, patch) {
  const result = clone(target);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return result;
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = mergePatch(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

async function clearRequestLog() {
  const { state } = await mutateState((draft) => { draft.recentRequests = []; });
  return { ok: true, state };
}

async function addRequestRecord(input) {
  await mutateState((state) => {
    state.recentRequests = [sanitizeRequestRecord(input), ...(state.recentRequests || [])].slice(0, RECENT_REQUEST_LIMIT);
  });
}

async function saveConfig(patch) {
  const { state } = await mutateState((draft) => {
    draft.config = normalizeState({ ...draft, config: mergePatch(draft.config, patch) }).config;
  });
  await setupAutomation(state);
  await syncPortalContentScript(state);
  return { ok: true, state };
}

async function resetConfig() {
  const { state } = await mutateState((draft) => { draft.config = clone(DEFAULT_STATE.config); });
  await setupAutomation(state);
  await syncPortalContentScript(state);
  return { ok: true, state };
}

function mutateState(mutator) {
  const operation = stateMutationQueue.then(async () => {
    const draft = await getState();
    const value = await mutator(draft);
    if (value === STATE_UNCHANGED) {
      return { state: draft, value: null, changed: false };
    }
    const state = await setState(draft);
    return { state, value, changed: true };
  });
  stateMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function getSessionState() {
  const stored = await chrome.storage.session.get([SESSION_KEY]);
  const value = stored && stored[SESSION_KEY];
  return {
    guards: value && value.guards && typeof value.guards === "object" ? value.guards : {},
    connection: {
      ...DEFAULT_CONNECTION_STATE,
      ...(value && value.connection && typeof value.connection === "object" ? value.connection : {})
    },
    activeIdentity: sanitizeActiveIdentity(value && value.activeIdentity)
  };
}

function sanitizeActiveIdentity(input) {
  if (!input || typeof input !== "object") return null;
  const parsed = accountUtils.parse(input.username, input.suffix);
  if (!parsed.username) return null;
  return {
    accountId: stringValue(input.accountId),
    username: parsed.username,
    suffix: parsed.suffix,
    network: {
      wlanUserIp: stringValue(input.network && input.network.wlanUserIp).trim(),
      wlanUserIpv6: stringValue(input.network && input.network.wlanUserIpv6).trim(),
      wlanUserMac: accountUtils.normalizeMac(input.network && input.network.wlanUserMac),
      wlanAcIp: stringValue(input.network && input.network.wlanAcIp).trim(),
      wlanAcName: stringValue(input.network && input.network.wlanAcName).trim()
    },
    source: input.source === "transient" ? "transient" : "saved",
    authenticatedAt: Math.max(0, Number(input.authenticatedAt) || Date.now())
  };
}

async function setActiveIdentity(identity) {
  const normalized = sanitizeActiveIdentity(identity);
  const { session } = await mutateSession((draft) => {
    draft.activeIdentity = normalized;
  });
  return session.activeIdentity;
}

async function setTabGuard(tabId, guard) {
  await mutateSession((session) => {
    const key = String(tabId);
    if (guard) session.guards[key] = guard;
    else delete session.guards[key];
  });
}

async function getTabGuard(tabId) {
  const session = await getSessionState();
  return session.guards[String(tabId)] || null;
}

async function getConnectionState() {
  const session = await getSessionState();
  return session.connection;
}

async function setConnectionState(patch) {
  const { session } = await mutateSession((draft) => {
    draft.connection = {
      ...DEFAULT_CONNECTION_STATE,
      ...draft.connection,
      ...(patch && typeof patch === "object" ? patch : {})
    };
  });
  await updateActionBadge(session.connection);
  return session.connection;
}

function mutateSession(mutator) {
  const operation = sessionMutationQueue.then(async () => {
    const session = await getSessionState();
    const value = await mutator(session);
    await chrome.storage.session.set({ [SESSION_KEY]: session });
    return { session, value };
  });
  sessionMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function updateActionBadge(connection) {
  if (!chrome.action || typeof chrome.action.setBadgeText !== "function") return;
  const requiresAction = connection.phase === "action_required";
  const waiting = connection.phase === "waiting";
  await chrome.action.setBadgeText({ text: requiresAction ? "!" : waiting ? "…" : "" });
  if (requiresAction || waiting) {
    await chrome.action.setBadgeBackgroundColor({
      color: requiresAction ? "#b42318" : "#8a5a00"
    });
  }
  if (typeof chrome.action.setTitle === "function") {
    await chrome.action.setTitle({
      title: connection.message || "校园网助手"
    });
  }
}

function normalizeUrl(value, fallback) {
  try {
    const raw = stringValue(value).trim() || fallback;
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fallback;
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch (error) {
    return fallback;
  }
}

function assertStateStorageBudget(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > MAX_STATE_BYTES) {
    throw new Error("本地存储空间不足。请清除或更换尺寸更小的自定义背景后再保存。");
  }
  return bytes;
}

function normalizeTimestamp(value) {
  const raw = stringValue(value).trim();
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function tryJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

function createTimestamp() {
  return Date.now().toString();
}

function createNonce() {
  return Math.floor(Math.random() * 10000).toString();
}

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function trimRaw(text) {
  const value = stringValue(text).replace(/\s+/g, " ").trim();
  return value.length > 600 ? `${value.slice(0, 600)}...` : value;
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
