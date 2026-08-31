"use strict";

const STORAGE_KEY = "drcomAssistantState";
const SESSION_KEY = "drcomAssistantSession";
const SCHEMA_VERSION = 11;
const KEEPALIVE_ALARM = "drcomAssistant.keepAlive";
const RETRY_ALARM = "drcomAssistant.retry";
const RECENT_REQUEST_LIMIT = 10;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const CUSTOM_PORTAL_SCRIPT_ID = "drcom-custom-portal";

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
      hideOriginalPortal: true,
      title: "徐医校园网",
      subtitle: "多账号登录、状态守护和跳转拦截都在这里。",
      accent: "#007aff",
      theme: "system",
      background: "fresh",
      backgroundImage: "",
      backgroundBlur: 14,
      backgroundDim: 0.42,
      backgroundScale: 1.04,
      density: "comfortable"
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
  "account:save",
  "account:network:update",
  "drcom:login",
  "drcom:logout",
  "redirect:markPortalTab"
]);
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

void restrictLocalStorageAccess();

chrome.runtime.onInstalled.addListener(handleInstalled);

async function handleInstalled(details = {}) {
  const state = await getState();
  await setupAutomation(state);
  await syncPortalContentScript(state);
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
}

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  await setupAutomation(state);
  await syncPortalContentScript(state);
  if (state.config.automation.loginOnStartup) {
    await loginSelectedAccount("浏览器启动自动登录", { automatic: true });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    void keepAliveTick();
  }
  if (alarm.name === RETRY_ALARM) {
    void loginSelectedAccount("网络失败自动重试", { automatic: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((payload) => sendResponse(payload))
    .catch((error) => sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    void handleTabRedirect(tabId, changeInfo.url);
  }
});

async function restrictLocalStorageAccess() {
  const storage = chrome.storage && chrome.storage.local;
  if (!storage || typeof storage.setAccessLevel !== "function") return false;
  try {
    await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return true;
  } catch (error) {
    return false;
  }
}

async function handleMessage(message, sender) {
  const action = message && message.action;
  const fromWebPage = isWebPageSender(sender);

  if (fromWebPage && !WEB_PAGE_ACTIONS.has(action)) {
    if (action === "state:get") {
      throw new Error("网页内容脚本不能读取完整扩展状态");
    }
    throw new Error("网页内容脚本无权执行此操作");
  }

  switch (action) {
    case "state:get":
      return { ok: true, state: await getState() };

    case "connection:get":
      return { ok: true, connection: await getConnectionState() };

    case "portal:config:get": {
      const state = await getState();
      return {
        ok: true,
        portal: {
          enabled: state.config.ui.modernizePortal !== false,
          title: stringValue(state.config.ui.title).trim() || DEFAULT_STATE.config.ui.title,
          portalUrl: state.config.portalUrl,
          appearance: publicAppearance(state.config.ui)
        }
      };
    }

    case "account:save": {
      const result = await saveAccount(message.account || {});
      if (message.openOptions) {
        // 抓到真实登录请求后准备打开配置页，此时解除该网关标签页的短时间防跳转。
        await clearSenderTab(sender);
        setTimeout(() => {
          chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
        }, 2000);
      }
      return fromWebPage ? { ok: true, accountId: result.account.id } : result;
    }

    case "account:delete":
      return deleteAccount(message.accountId || "");

    case "account:select":
      return selectAccount(message.accountId || "");

    case "account:network:update": {
      const result = await updateAccountNetwork(message.userAccount || "", message.network || {});
      return fromWebPage ? { ok: result.ok, message: result.message || "" } : result;
    }

    case "requestLog:clear":
      return clearRequestLog();

    case "config:save":
      return saveConfig(message.config || {});

    case "config:reset":
      return resetConfig();

    case "drcom:login":
      await markSenderTab(sender);
      return loginAccount(message.accountId || "", message.account || null);

    case "drcom:logout":
      return logout(message.accountId || "", message.account || null);

    case "drcom:status":
      return checkStatus();

    case "redirect:markPortalTab":
      await markSenderTab(sender);
      return { ok: true };

    case "redirect:clearPortalTab":
      await clearSenderTab(sender);
      return { ok: true };

    case "options:open":
      await clearSenderTab(sender);
      chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      throw new Error(`未知操作：${action || "空"}`);
  }
}

async function getState() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, "username", "password"]);
  let state = stored[STORAGE_KEY];

  if (!state && stored.username && stored.password) {
    state = {
      ...clone(DEFAULT_STATE),
      accounts: [{
        id: createId(),
        label: "默认账号",
        username: String(stored.username),
        suffix: "",
        password: String(stored.password),
        network: clone(DEFAULT_STATE.config.network),
        note: "从旧版配置迁移",
        updatedAt: new Date().toISOString()
      }]
    };
    state.selectedAccountId = state.accounts[0].id;
  }

  const normalized = normalizeState(state || DEFAULT_STATE);
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    await setState(normalized);
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
  if (previousSchemaVersion < 11 && state.config.ui.background === "paper") state.config.ui.theme = "light";
  if (previousSchemaVersion < 11 && state.config.ui.background === "night") state.config.ui.theme = "dark";
  state.config.ui.background = state.config.ui.background === "custom" ? "custom" : DEFAULT_STATE.config.ui.background;
  state.config.ui.backgroundImage = normalizeImageUrl(state.config.ui.backgroundImage);
  if (state.config.ui.background === "custom" && !state.config.ui.backgroundImage) {
    state.config.ui.background = DEFAULT_STATE.config.ui.background;
  }
  state.config.ui.backgroundBlur = clampNumber(state.config.ui.backgroundBlur, 0, 32, DEFAULT_STATE.config.ui.backgroundBlur);
  state.config.ui.backgroundDim = clampNumber(state.config.ui.backgroundDim, 0.2, 0.72, DEFAULT_STATE.config.ui.backgroundDim);
  state.config.ui.backgroundScale = clampNumber(state.config.ui.backgroundScale, 1, 1.15, DEFAULT_STATE.config.ui.backgroundScale);
  state.config.ui.density = state.config.ui.density === "compact" ? "compact" : "comfortable";
  
  state.config.redirect.guardSeconds = clampNumber(state.config.redirect.guardSeconds, 1, 120, 4);
  
  state.config.automation.intervalMinutes = clampNumber(state.config.automation.intervalMinutes, 0.5, 30, 3);
  if (previousSchemaVersion < 8) {
    state.config.automation.loginOnStartup = true;
    state.config.automation.keepAlive = true;
    state.config.redirect.returnToPortal = true;
  }
  if (previousSchemaVersion < 10) {
    state.config.ui.modernizePortal = true;
    state.config.ui.hideOriginalPortal = true;
    if (String(state.config.ui.accent).toLowerCase() === "#14b8a6") {
      state.config.ui.accent = DEFAULT_STATE.config.ui.accent;
    }
  }
  return state;
}

function sanitizeAccount(input) {
  input = input && typeof input === "object" ? input : {};
  const parsed = splitAccountValue(input.username, input.suffix);
  const updatedAt = normalizeTimestamp(input.updatedAt);
  return {
    id: stringValue(input.id) || createId(),
    label: stringValue(input.label).trim() || makeAccountLabel(parsed.username, parsed.suffix),
    username: parsed.username,
    suffix: parsed.suffix,
    password: stringValue(input.password),
    network: {
      wlanUserIp: stringValue(input.network && input.network.wlanUserIp).trim(),
      wlanUserIpv6: stringValue(input.network && input.network.wlanUserIpv6).trim(),
      wlanUserMac: normalizeMac(input.network && input.network.wlanUserMac),
      wlanAcIp: stringValue(input.network && input.network.wlanAcIp).trim(),
      wlanAcName: stringValue(input.network && input.network.wlanAcName).trim()
    },
    note: stringValue(input.note).trim(),
    updatedAt
  };
}

function accountNaturalKey(input) {
  const parsed = splitAccountValue(input && input.username, input && input.suffix);
  return parsed.username ? `${parsed.username}\u0000${parsed.suffix.toLowerCase()}` : "";
}

function deduplicateAccounts(inputs, selectedAccountId = "") {
  const groups = new Map();
  for (const raw of inputs) {
    const account = sanitizeAccount(raw);
    if (!account.username || !account.password) continue;
    const key = accountNaturalKey(account);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ raw: raw || {}, account });
  }

  const remappedIds = new Map();
  const accounts = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (
      Date.parse(left.account.updatedAt) - Date.parse(right.account.updatedAt)
    ));
    const selected = group.find((entry) => entry.account.id === selectedAccountId);
    const keeper = selected || ordered[ordered.length - 1];
    const merged = {
      ...keeper.raw,
      id: keeper.account.id,
      label: "",
      username: keeper.account.username,
      suffix: keeper.account.suffix,
      password: "",
      network: {},
      updatedAt: ordered[ordered.length - 1].account.updatedAt
    };

    for (const entry of ordered) {
      const raw = entry.raw && typeof entry.raw === "object" ? entry.raw : {};
      const label = stringValue(raw.label).trim();
      const password = stringValue(raw.password);
      if (label) merged.label = label;
      if (password) merged.password = password;
      for (const field of ["wlanUserIp", "wlanUserIpv6", "wlanUserMac", "wlanAcIp", "wlanAcName"]) {
        const value = stringValue(raw.network && raw.network[field]).trim();
        if (value) merged.network[field] = value;
      }
      remappedIds.set(entry.account.id, keeper.account.id);
    }

    accounts.push(sanitizeAccount(merged));
  }

  return {
    accounts,
    selectedAccountId: remappedIds.get(selectedAccountId) || selectedAccountId
  };
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

function normalizeAccountValue(value) {
  let raw = stringValue(value).trim();
  if (!raw) {
    return "";
  }

  for (let i = 0; i < 2; i += 1) {
    if (!/%[0-9a-f]{2}/i.test(raw)) break;
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded === raw) break;
      raw = decoded;
    } catch (error) {
      break;
    }
  }
  return raw;
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

async function saveAccount(input) {
  const mutation = await mutateState((state) => {
    const account = sanitizeAccount({
      ...input,
      updatedAt: new Date().toISOString()
    });

    if (!account.username || !account.password) {
      throw new Error("账号和密码不能为空");
    }

    const idIndex = stringValue(input && input.id)
      ? state.accounts.findIndex((item) => item.id === account.id)
      : -1;
    const naturalKey = accountNaturalKey(account);
    const naturalKeyIndex = state.accounts.findIndex((item) => accountNaturalKey(item) === naturalKey);
    const index = idIndex >= 0 ? idIndex : naturalKeyIndex;
    if (index >= 0) {
      account.id = state.accounts[index].id;
      state.accounts[index] = account;
    }
    else state.accounts.unshift(account);
    state.selectedAccountId = account.id;
    return account.id;
  });
  const state = mutation.state;
  const account = state.accounts.find((item) => item.id === mutation.value);
  return { ok: true, state, account };
}

async function deleteAccount(accountId) {
  const { state } = await mutateState((draft) => {
    draft.accounts = draft.accounts.filter((account) => account.id !== accountId);
    if (draft.selectedAccountId === accountId) {
      draft.selectedAccountId = draft.accounts[0] ? draft.accounts[0].id : "";
    }
  });
  return { ok: true, state };
}

async function selectAccount(accountId) {
  const { state } = await mutateState((draft) => {
    if (accountId && !draft.accounts.some((account) => account.id === accountId)) {
      throw new Error("找不到这个账号");
    }
    draft.selectedAccountId = accountId;
  });
  return { ok: true, state };
}

async function updateAccountNetwork(userAccount, patch) {
  const parsed = splitAccountValue(userAccount);
  const mutation = await mutateState((state) => {
    const selected = state.accounts.find((account) => account.id === state.selectedAccountId) || null;
    const matched = state.accounts.find((item) => {
      const current = splitAccountValue(item.username, item.suffix);
      if (!parsed.username || current.username !== parsed.username) return false;
      return parsed.suffix ? current.suffix === parsed.suffix : true;
    }) || null;
    const account = parsed.username ? matched : selected;
    if (!account) return STATE_UNCHANGED;

    account.network = account.network || {};
    const networkPatch = {
      wlanUserIp: stringValue(patch.wlanUserIp).trim(),
      wlanUserIpv6: stringValue(patch.wlanUserIpv6).trim(),
      wlanUserMac: normalizeMac(patch.wlanUserMac),
      wlanAcIp: stringValue(patch.wlanAcIp).trim(),
      wlanAcName: stringValue(patch.wlanAcName).trim()
    };
    for (const [key, value] of Object.entries(networkPatch)) {
      if (value) account.network[key] = value;
    }
    account.updatedAt = new Date().toISOString();
    return account.id;
  });
  if (!mutation.value) {
    return { ok: false, state: mutation.state, message: parsed.username ? "未找到抓包对应的账号，未修改当前账号" : "没有可更新的账号" };
  }
  const account = mutation.state.accounts.find((item) => item.id === mutation.value);
  return { ok: true, state: mutation.state, account };
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

async function loginSelectedAccount(reason, options = {}) {
  const state = await getState();
  if (!state.selectedAccountId) {
    return { ok: false, success: false, message: `${reason}跳过：还没有保存账号` };
  }

  return loginAccount(state.selectedAccountId, null, options);
}

async function loginAccount(accountId, transientAccount, options = {}) {
  const key = "drcom-login";
  return runLoginSingleFlight(key, async () => {
    const automatic = options.automatic === true;
    const runtime = await getConnectionState();
    if (automatic && !canAttemptAutomaticLogin(runtime)) {
      return {
        ok: false,
        success: false,
        online: false,
        skipped: true,
        phase: runtime.phase,
        retryAt: runtime.nextRetryAt,
        message: runtime.blocked
          ? runtime.message || "自动登录已暂停，请检查账号配置。"
          : "仍在等待下一次自动重试。"
      };
    }

    if (!automatic) {
      await chrome.alarms.clear(RETRY_ALARM);
      await setConnectionState({
        attempt: 0,
        nextRetryAt: 0,
        blocked: false
      });
    }

    await setConnectionState({
      phase: "authenticating",
      message: options.reason || (automatic ? "正在自动恢复连接。" : "正在登录校园网。"),
      updatedAt: Date.now()
    });
    const result = await performLoginAccount(accountId, transientAccount);
    return recordLoginOutcome(result);
  });
}

async function performLoginAccount(accountId, transientAccount) {
  const state = await getState();
  const isTransient = Boolean(transientAccount);
  const account = transientAccount
    ? sanitizeAccount(transientAccount)
    : state.accounts.find((item) => item.id === (accountId || state.selectedAccountId));

  if (!account) {
    throw new Error("请先保存或选择账号");
  }

  if (state.config.login.findMacBeforeLogin !== false) {
    try {
      await fetchDrcom(buildFindMacRequest(account, state.config), "find_mac");
    } catch (error) {}
  }

  const request = buildLoginRequest(account, state.config);
  const result = await fetchDrcom(request, "login");
  return {
    ...result,
    authenticatedIdentity: sanitizeActiveIdentity({
      accountId: isTransient ? "" : account.id,
      username: account.username,
      suffix: account.suffix,
      network: account.network,
      source: isTransient ? "transient" : "saved",
      authenticatedAt: Date.now()
    })
  };
}

function runLoginSingleFlight(key, task) {
  const normalizedKey = stringValue(key) || "default";
  const existing = loginFlights.get(normalizedKey);
  if (existing) return existing;

  const pending = Promise.resolve().then(task);
  loginFlights.set(normalizedKey, pending);
  const cleanup = () => {
    if (loginFlights.get(normalizedKey) === pending) {
      loginFlights.delete(normalizedKey);
    }
  };
  pending.then(cleanup, cleanup);
  return pending;
}

function calculateRetryDelay(attempt, randomValue = Math.random()) {
  const count = Math.max(1, Math.floor(Number(attempt) || 1));
  const jitter = Math.min(1, Math.max(0, Number(randomValue) || 0));
  const exponential = RETRY_BASE_MS * (2 ** (count - 1));
  return Math.min(RETRY_MAX_MS, Math.round(exponential * (1 + jitter * 0.2)));
}

function classifyLoginFailure(result) {
  const message = stringValue(result && result.message);
  if (/密码|password|账号不存在|用户不存在|userid error/i.test(message)) {
    return {
      category: "credentials",
      retryable: false,
      action: "请检查账号、运营商后缀和认证密码。"
    };
  }
  if (/设备数量|MAC 冲突|AC999|绑定/i.test(message)) {
    return {
      category: "device",
      retryable: false,
      action: "请先下线其他设备，或重新采集当前设备的网络参数。"
    };
  }
  if (/流量|余额|欠费|停机|flux out|balance/i.test(message)) {
    return {
      category: "account",
      retryable: false,
      action: "请检查账号流量、余额或校园网服务状态。"
    };
  }
  return {
    category: "network",
    retryable: true,
    action: "助手会在稍后自动重试。"
  };
}

function canAttemptAutomaticLogin(runtime, now = Date.now()) {
  const state = runtime && typeof runtime === "object" ? runtime : DEFAULT_CONNECTION_STATE;
  if (state.blocked) return false;
  return !state.nextRetryAt || Number(now) >= Number(state.nextRetryAt);
}

async function recordLoginOutcome(result, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const runtime = await getConnectionState();
  const authenticatedIdentity = sanitizeActiveIdentity(result && result.authenticatedIdentity);
  const publicResult = { ...(result || {}) };
  delete publicResult.authenticatedIdentity;

  if (result && result.success) {
    await chrome.alarms.clear(RETRY_ALARM);
    if (authenticatedIdentity) await setActiveIdentity(authenticatedIdentity);
    await setConnectionState({
      phase: "online",
      attempt: 0,
      nextRetryAt: 0,
      blocked: false,
      message: result.message || "登录成功。",
      updatedAt: now
    });
    return { ...publicResult, phase: "online", retryable: false, retryAt: 0 };
  }

  const failure = classifyLoginFailure(result);
  const attempt = Math.max(0, Number(runtime.attempt) || 0) + 1;
  const retryAt = failure.retryable
    ? now + calculateRetryDelay(attempt, options.randomValue)
    : 0;
  const phase = failure.retryable ? "waiting" : "action_required";

  if (failure.retryable) {
    chrome.alarms.create(RETRY_ALARM, { when: retryAt });
  } else {
    await chrome.alarms.clear(RETRY_ALARM);
  }

  await setConnectionState({
    phase,
    attempt,
    nextRetryAt: retryAt,
    blocked: !failure.retryable,
    message: stringValue(result && result.message) || failure.action,
    updatedAt: now
  });
  return {
    ...publicResult,
    phase,
    retryable: failure.retryable,
    retryAt,
    action: failure.action
  };
}

async function logout(accountId = "", transientAccount = null) {
  const state = await getState();
  const session = await getSessionState();
  const activeIdentity = session.activeIdentity;
  const requestedAccount = transientAccount
    ? sanitizeAccount(transientAccount)
    : state.accounts.find((item) => item.id === accountId);
  const account = activeIdentity || requestedAccount;

  if (!account) {
    const legacyRequest = buildLegacyLogoutRequest(state.config);
    const legacyResult = await fetchDrcom(legacyRequest, "logout");
    if (legacyResult.success) await setActiveIdentity(null);
    return legacyResult;
  }

  const network = await resolveLogoutNetwork(account, state.config);
  const request = buildLogoutRequest(account, state.config, network);
  const result = await fetchDrcom(request, "logout");

  if (!result.success && !isUsableMac(network.wlanUserMac)) {
    return {
      ...result,
      message: `${result.message || "下线失败"}；当前账号没有有效 wlan_user_mac，DrCOM 的 unbind_mac 下线通常需要真实 MAC。请在账号设置的抓包参数里填入类似 580205DC58C2 的 MAC，或先在原认证页下线一次让插件自动记录。`
    };
  }

  if (result.success) await setActiveIdentity(null);
  return result;
}

async function resolveLogoutNetwork(account, config) {
  const network = { ...config.network, ...account.network };
  if (isUsableMac(network.wlanUserMac)) {
    network.wlanUserMac = normalizeMac(network.wlanUserMac);
    return network;
  }

  for (const includeSuffix of [true, false]) {
    try {
      const probe = await fetchDrcom(buildFindMacRequest(account, config, includeSuffix), "find_mac");
      const mac = extractMacFromResponse(probe.data, probe.raw);
      if (isUsableMac(mac)) {
        network.wlanUserMac = mac;
        break;
      }
    } catch (error) {}
  }

  network.wlanUserMac = normalizeMac(network.wlanUserMac) || "000000000000";
  return network;
}

async function checkStatus() {
  const state = await getState();
  await setConnectionState({
    phase: "checking",
    message: "正在检查校园网连接状态。",
    updatedAt: Date.now()
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(state.config.portalUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      signal: controller.signal
    });
    const text = await response.text();
    const result = parsePortalStatus(response.status, text, state.config.portalUrl);
    const now = Date.now();
    const runtime = await getConnectionState();
    const phase = result.online
      ? "online"
      : runtime.blocked
        ? "action_required"
        : runtime.nextRetryAt > now
          ? "waiting"
          : "captive";
    if (result.online) {
      await chrome.alarms.clear(RETRY_ALARM);
    }
    await setConnectionState({
      phase,
      attempt: result.online ? 0 : runtime.attempt,
      nextRetryAt: result.online ? 0 : runtime.nextRetryAt,
      blocked: result.online ? false : runtime.blocked,
      message: result.message,
      updatedAt: now
    });
    await addRequestRecord({ kind: "status", ...result });
    return { ...result, phase };
  } catch (error) {
    const result = {
      ok: false,
      success: false,
      online: false,
      message: error && error.name === "AbortError" ? "访问 10.10.10.2 超时，请确认已连接校园网。" : `无法访问认证页：${error.message || error}`,
      statusCode: 0,
      url: state.config.portalUrl,
      raw: ""
    };
    const now = Date.now();
    const runtime = await getConnectionState();
    const phase = runtime.blocked
      ? "action_required"
      : runtime.nextRetryAt > now
        ? "waiting"
        : "offline";
    await setConnectionState({
      phase,
      message: result.message,
      updatedAt: now
    });
    await addRequestRecord({ kind: "status", ...result });
    return { ...result, phase };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDrcom(request, kind) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(request.url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      redirect: "manual",
      headers: {
        "Accept": "application/javascript, application/json, text/plain, */*",
        "Cache-Control": "no-cache"
      },
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = parseDrcomText(text);
    const result = normalizeDrcomResult(kind, response.status, parsed, text);
    const payload = {
      ok: response.ok || result.success,
      statusCode: response.status,
      url: request.redactedUrl,
      raw: trimRaw(text),
      ...result
    };

    if (kind === "login" || kind === "logout") {
      await addRequestRecord({ kind, ...payload });
    }
    return payload;
  } catch (error) {
    const payload = {
      ok: false,
      success: false,
      online: false,
      message: error && error.name === "AbortError" ? "DrCOM 接口超时，请确认校园网网关可访问。" : `请求失败：${error.message || error}`,
      statusCode: 0,
      url: request.redactedUrl,
      raw: ""
    };
    if (kind === "login" || kind === "logout") {
      await addRequestRecord({ kind, ...payload });
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function buildLoginRequest(account, config) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  const network = { ...config.network, ...account.network };

  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "login");
  url.searchParams.set("callback", `${config.login.callbackPrefix}${ts}`);
  url.searchParams.set("login_method", config.login.loginMethod || "1");
  url.searchParams.set("user_account", composeUserAccount(account, config));
  url.searchParams.set("user_password", account.password);
  url.searchParams.set("wlan_user_ip", network.wlanUserIp || "");
  url.searchParams.set("wlan_user_ipv6", network.wlanUserIpv6 || "");
  url.searchParams.set("wlan_user_mac", normalizeMac(network.wlanUserMac) || "000000000000");
  url.searchParams.set("wlan_ac_ip", network.wlanAcIp || "");
  url.searchParams.set("wlan_ac_name", network.wlanAcName || "");
  url.searchParams.set("jsVersion", config.login.jsVersion || "3.3.2");
  url.searchParams.set("v", createNonce());

  return { url: url.toString(), redactedUrl: redactSensitiveUrl(url.toString()) };
}

function buildFindMacRequest(account, config, includeSuffix = false) {
  const url = new URL(config.apiUrl);
  const network = { ...config.network, ...account.network };
  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "find_mac");
  url.searchParams.set("callback", "dr1004");
  url.searchParams.set("user_account", includeSuffix ? composeLogoutUserAccount(account) : plainStudentId(account.username));
  url.searchParams.set("login_method", config.login.loginMethod || "1");
  url.searchParams.set("find_mac", "0");
  url.searchParams.set("wlan_user_ip", network.wlanUserIp || "");
  url.searchParams.set("jsVersion", config.login.jsVersion || "3.3.2");
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: url.toString() };
}

function buildLogoutRequest(account, config, networkOverride = null) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  const network = networkOverride || { ...config.network, ...account.network };

  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "unbind_mac");
  url.searchParams.set("callback", `${config.login.callbackPrefix}${ts}`);
  url.searchParams.set("user_account", composeLogoutUserAccount(account));
  url.searchParams.set("wlan_user_mac", normalizeMac(network.wlanUserMac) || "000000000000");
  url.searchParams.set("wlan_user_ip", network.wlanUserIp || "");
  url.searchParams.set("jsVersion", config.login.jsVersion || "3.3.2");
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: redactSensitiveUrl(url.toString()) };
}

function buildLegacyLogoutRequest(config) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "logout");
  url.searchParams.set("callback", `${config.login.callbackPrefix}${ts}`);
  url.searchParams.set("login_method", config.login.loginMethod || "1");
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: url.toString() };
}

function plainStudentId(value) {
  return splitAccountValue(value).username;
}

function composeUserAccount(account, config) {
  const parsed = splitAccountValue(account.username, account.suffix);
  const prefix = stringValue(config.login.accountPrefix) || ",0,";
  return `${prefix}${parsed.username}${parsed.suffix}`;
}

function composeLogoutUserAccount(account) {
  const parsed = splitAccountValue(account.username, account.suffix);
  return `${parsed.username}${parsed.suffix}`;
}

function parseDrcomText(text) {
  const clean = stringValue(text).trim().replace(/^\uFEFF/, "");
  if (!clean) {
    return {};
  }

  const direct = tryJson(clean);
  if (direct) {
    return direct;
  }

  const jsonp = clean.match(/^[\w$.]+\(([\s\S]*)\)\s*;?$/);
  if (jsonp) {
    return tryJson(jsonp[1]) || {};
  }

  const loose = {};
  for (const match of clean.matchAll(/["']?([a-zA-Z][\w-]*)["']?\s*[:=]\s*["']?([^"',;}\n\r]+)/g)) {
    loose[match[1]] = match[2].trim();
  }
  return loose;
}

function normalizeDrcomResult(kind, statusCode, data, rawText) {
  const raw = stringValue(rawText);
  const msg = decodeMessage(data.msg || data.msga || data.message || data.error || data.result || raw);
  const result = stringValue(data.result ?? data.ret_code ?? data.ret ?? data.success).toLowerCase();
  const alreadyOnline = /已经在线|已在线|has been online|already online|E2620/i.test(`${msg} ${raw}`);
  const explicitFailure = ["0", "false", "fail", "failed", "error", "-1"].includes(result);
  const explicitSuccess = ["1", "ok", "true", "success"].includes(result);
  const successMessage = /登录成功|认证成功|(?:^|\s)(?:success|ok)(?:$|[\s,.!])/i.test(msg);
  const success = alreadyOnline || (!explicitFailure && (explicitSuccess || successMessage));

  if (kind === "logout") {
    const logoutFailure = explicitFailure || /logout\s*(?:fail|error)|unbind_mac\s*(?:fail|error)|注销失败|下线失败|解绑失败|拒绝/i.test(`${msg} ${raw}`);
    const logoutMessage = /注销成功|下线成功|解绑成功|解除绑定成功|(?:logout|unbind_mac)\s*(?:success|ok)|\boffline\b/i.test(`${msg} ${raw}`);
    const logoutOk = !logoutFailure && (success || logoutMessage);
    return {
      success: logoutOk,
      online: false,
      message: logoutOk ? "下线成功。" : humanizeError(msg, data),
      data
    };
  }

  return {
    success,
    online: success,
    message: success ? (alreadyOnline ? "账号已经在线，无需重复登录。" : "登录成功。") : humanizeError(msg, data),
    data,
    httpOk: statusCode >= 200 && statusCode < 400
  };
}

function parsePortalStatus(statusCode, text, url) {
  const raw = stringValue(text);
  const online = /name=["']logout["']|data-localize=["'][^"']*logout|注销|下线|已连接|在线/i.test(raw);
  const loginPage = /name=["']DDDDD["']|name=["']upass["']|user_account|登录|认证/i.test(raw);

  return {
    ok: statusCode >= 200 && statusCode < 400,
    success: online,
    online,
    statusCode,
    url,
    message: online ? "当前页面显示已在线。" : loginPage ? "当前需要登录。" : "已访问认证页，但状态不明确。",
    raw: trimRaw(raw)
  };
}

function humanizeError(message, data) {
  const msg = decodeMessage(message);
  const retCode = stringValue(data.ret_code || data.ret);

  if (/AC999/i.test(msg) || retCode === "2" || retCode === "3") {
    return `设备数量超限或 MAC 冲突：${msg}`;
  }
  if (/userid error1|用户不存在|账号不存在/i.test(msg)) {
    return `账号不存在，请检查学号、后缀或抓包账号标识：${msg}`;
  }
  if (/userid error2|密码|password/i.test(msg)) {
    return `密码错误或密钥失效：${msg}`;
  }
  if (/flux out|balance|欠费|流量/i.test(msg)) {
    return `流量或余额异常：${msg}`;
  }
  if (/ip|mac|bind|绑定/i.test(msg)) {
    return `IP/MAC 参数可能不匹配，建议用设置页重新解析抓包 URL：${msg}`;
  }
  return msg ? `登录失败：${msg}` : "登录失败：网关没有返回明确原因。";
}

function decodeMessage(value) {
  const text = stringValue(value).trim();
  if (!text) {
    return "";
  }

  try {
    if (/^[a-zA-Z0-9+/]+={0,2}$/.test(text) && !/[\u4e00-\u9fa5]/.test(text) && text.length % 4 === 0) {
      const binary = atob(text);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch (error) {
    return text;
  }
  return text;
}

async function keepAliveTick() {
  const state = await getState();
  if (!state.config.automation.keepAlive || !state.selectedAccountId) {
    return;
  }

  const runtime = await getConnectionState();
  if (!canAttemptAutomaticLogin(runtime)) return;

  const status = await checkStatus();
  if (!status.online) {
    await loginAccount(state.selectedAccountId, null, {
      automatic: true,
      reason: "连接守护正在恢复校园网。"
    });
  }
}

async function setupAutomation(state) {
  const automation = state.config.automation;
  if (!automation.keepAlive) {
    await chrome.alarms.clear(KEEPALIVE_ALARM);
    return;
  }

  const interval = automation.intervalMinutes;
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing || Number(existing.periodInMinutes) !== Number(interval)) {
    chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: interval
    });
  }
}

function portalMatchPattern(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.protocol}//${url.hostname}/*`;
  } catch (error) {
    return "";
  }
}

async function syncPortalContentScript(state) {
  const scripting = chrome.scripting;
  if (!scripting?.getRegisteredContentScripts || !scripting?.registerContentScripts || !scripting?.unregisterContentScripts) {
    return false;
  }

  const portalUrl = state?.config?.portalUrl || DEFAULT_STATE.config.portalUrl;
  const pattern = portalMatchPattern(portalUrl);
  const hostname = (() => {
    try { return new URL(portalUrl).hostname; }
    catch (error) { return ""; }
  })();
  const shouldRegister = state?.config?.ui?.modernizePortal !== false && pattern && hostname !== "10.10.10.2";
  const existing = await scripting.getRegisteredContentScripts({ ids: [CUSTOM_PORTAL_SCRIPT_ID] });

  if (!shouldRegister) {
    if (existing.length) await scripting.unregisterContentScripts({ ids: [CUSTOM_PORTAL_SCRIPT_ID] });
    return false;
  }

  const hasAccess = await chrome.permissions.contains({
    origins: [pattern],
    permissions: ["scripting"]
  });
  if (!hasAccess) return false;

  const current = existing[0];
  if (current && Array.isArray(current.matches) && current.matches.length === 1 && current.matches[0] === pattern) {
    return true;
  }
  if (existing.length) await scripting.unregisterContentScripts({ ids: [CUSTOM_PORTAL_SCRIPT_ID] });
  await scripting.registerContentScripts([{
    id: CUSTOM_PORTAL_SCRIPT_ID,
    matches: [pattern],
    css: ["design-tokens.css", "portal.css"],
    js: ["appearance.js", "portal-ui.js", "portal-modernizer.js"],
    runAt: "document_start",
    persistAcrossSessions: true
  }]);
  return true;
}

async function handleTabRedirect(tabId, targetUrl) {
  const guard = await getTabGuard(tabId);
  if (!guard || Date.now() > guard.until) {
    await setTabGuard(tabId, null);
    return;
  }

  const state = await getState();
  if (!state.config.redirect.returnToPortal) {
    await setTabGuard(tabId, null);
    return;
  }

  if (isPortalUrl(targetUrl, state.config.portalUrl)) {
    return;
  }

  // 只防一次“登录后的自动离开网关页”，防完立即解除；不再做长期外站拦截。
  await setTabGuard(tabId, null);
  chrome.tabs.update(tabId, { url: `${state.config.portalUrl}?drcom_kept=1` }, () => {
    void chrome.runtime.lastError;
  });
}

async function markSenderTab(sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return;
  }

  const state = await getState();
  if (state.config.redirect.returnToPortal === false) return;
  await setTabGuard(sender.tab.id, {
    until: Date.now() + state.config.redirect.guardSeconds * 1000
  });
}

async function clearSenderTab(sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return;
  }
  await setTabGuard(sender.tab.id, null);
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
  const parsed = splitAccountValue(input.username, input.suffix);
  if (!parsed.username) return null;
  return {
    accountId: stringValue(input.accountId),
    username: parsed.username,
    suffix: parsed.suffix,
    network: {
      wlanUserIp: stringValue(input.network && input.network.wlanUserIp).trim(),
      wlanUserIpv6: stringValue(input.network && input.network.wlanUserIpv6).trim(),
      wlanUserMac: normalizeMac(input.network && input.network.wlanUserMac),
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

function isPortalUrl(targetUrl, portalUrl) {
  try {
    const target = new URL(targetUrl);
    const portal = new URL(portalUrl);
    return target.protocol === portal.protocol && target.hostname === portal.hostname;
  } catch (error) {
    return false;
  }
}

function splitAccountValue(value, fallbackSuffix = "") {
  let raw = normalizeAccountValue(value).trim();
  raw = raw.replace(/^\s*0+\s*$/, "");
  if (raw.startsWith(",0,")) {
    raw = raw.slice(3);
  }

  const suffixMatch = raw.match(/@(telecom|unicom|cmcc)$/i);
  const suffixFromRaw = suffixMatch ? `@${suffixMatch[1].toLowerCase()}` : "";
  const suffix = suffixFromRaw || normalizeSuffix(fallbackSuffix);
  const username = suffixFromRaw ? raw.slice(0, -suffixFromRaw.length) : raw;
  return { username: username.trim(), suffix };
}

function normalizeSuffix(value) {
  const raw = normalizeAccountValue(value).trim().toLowerCase();
  if (!raw || raw === "校园网" || raw === "campus" || raw === "none") {
    return "";
  }
  const aliases = {
    telecom: "@telecom",
    "@telecom": "@telecom",
    "电信": "@telecom",
    unicom: "@unicom",
    "@unicom": "@unicom",
    "联通": "@unicom",
    cmcc: "@cmcc",
    "@cmcc": "@cmcc",
    "mobile": "@cmcc",
    "移动": "@cmcc"
  };
  if (aliases[raw]) {
    return aliases[raw];
  }
  return /^@[a-z0-9._-]+$/i.test(raw) ? raw : "";
}

function suffixLabel(suffix) {
  return { "": "校园网", "@telecom": "电信", "@unicom": "联通", "@cmcc": "移动" }[normalizeSuffix(suffix)] || normalizeSuffix(suffix) || "校园网";
}

function makeAccountLabel(username, suffix) {
  const name = stringValue(username).trim() || "未命名账号";
  return `${name} ${suffixLabel(suffix)}`;
}

function maskUsername(value) {
  const text = stringValue(value).trim();
  if (text.length <= 4) {
    return text ? "****" : "";
  }
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function redactSensitiveUrl(value) {
  const raw = stringValue(value).trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    for (const key of ["user_password", "password", "upass", "0MKKey"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "******");
      }
    }
    if (url.searchParams.has("user_account")) {
      const current = url.searchParams.get("user_account") || "";
      const parsed = splitAccountValue(current);
      const hasPrefix = normalizeAccountValue(current).startsWith(",0,");
      url.searchParams.set("user_account", `${hasPrefix ? ",0," : ""}${maskUsername(parsed.username)}${parsed.suffix}`);
    }
    return url.toString();
  } catch (error) {
    return raw.replace(/(user_password|password|upass|0MKKey)=([^&\s]+)/gi, "$1=******");
  }
}

function redactSensitiveText(value) {
  const raw = stringValue(value);
  if (!raw) {
    return "";
  }

  const quotedPasswordPattern = /(["']?(?:user_password|password|upass|0MKKey)["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi;
  const quotedAccountPattern = /(["']?user_account["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi;
  const passwordPattern = /(["']?(?:user_password|password|upass|0MKKey)["']?\s*[:=]\s*)([^"'&,;\s}]+)/gi;
  const accountPattern = /(["']?user_account["']?\s*[:=]\s*)([^"'&;\s}]+)/gi;
  return raw
    .replace(quotedPasswordPattern, (match, prefix, quote) => `${prefix}${quote}******${quote}`)
    .replace(quotedAccountPattern, (match, prefix, quote, accountValue) => {
      const normalized = normalizeAccountValue(accountValue);
      const parsed = splitAccountValue(normalized);
      const hasPrefix = normalized.startsWith(",0,");
      return `${prefix}${quote}${hasPrefix ? ",0," : ""}${maskUsername(parsed.username)}${parsed.suffix}${quote}`;
    })
    .replace(passwordPattern, "$1******")
    .replace(accountPattern, (match, prefix, accountValue) => {
      const normalized = normalizeAccountValue(accountValue);
      const parsed = splitAccountValue(normalized);
      const hasPrefix = normalized.startsWith(",0,");
      return `${prefix}${hasPrefix ? ",0," : ""}${maskUsername(parsed.username)}${parsed.suffix}`;
    });
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

function isUsableMac(value) {
  const mac = normalizeMac(value);
  return /^[0-9A-F]{12}$/.test(mac) && mac !== "000000000000";
}

function extractMacFromResponse(data, raw) {
  const candidates = [];
  if (data && typeof data === "object") {
    for (const key of ["mac", "user_mac", "wlan_user_mac", "wlanUserMac", "online_user_mac", "onlineUserMac"]) {
      if (data[key]) candidates.push(data[key]);
    }
  }
  candidates.push(raw);

  for (const candidate of candidates) {
    const text = stringValue(candidate);
    const direct = normalizeMac(text);
    if (isUsableMac(direct)) return direct;
    const match = text.match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|\b[0-9a-f]{12}\b/i);
    if (match && isUsableMac(match[0])) return normalizeMac(match[0]);
  }
  return "";
}

function normalizeMac(value) {
  return stringValue(value).replace(/[^0-9a-f]/gi, "").toUpperCase();
}

function normalizeAccent(value) {
  const color = stringValue(value).trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_STATE.config.ui.accent;
}

function normalizeImageUrl(value) {
  const raw = stringValue(value).trim();
  if (!raw || raw.length > 6000000) {
    return "";
  }
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(raw)) {
    return raw;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function assertStateStorageBudget(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > MAX_STATE_BYTES) {
    throw new Error("本地存储空间不足。请清除或更换尺寸更小的自定义背景后再保存。");
  }
  return bytes;
}

function publicAppearance(input) {
  const ui = input && typeof input === "object" ? input : {};
  const backgroundImage = normalizeImageUrl(ui.backgroundImage);
  const background = ui.background === "custom" && backgroundImage ? "custom" : "fresh";
  return {
    theme: ["system", "light", "dark"].includes(ui.theme) ? ui.theme : DEFAULT_STATE.config.ui.theme,
    accent: normalizeAccent(ui.accent),
    background,
    backgroundImage: background === "custom" ? backgroundImage : "",
    backgroundBlur: clampNumber(ui.backgroundBlur, 0, 32, DEFAULT_STATE.config.ui.backgroundBlur),
    backgroundDim: clampNumber(ui.backgroundDim, 0.2, 0.72, DEFAULT_STATE.config.ui.backgroundDim),
    backgroundScale: clampNumber(ui.backgroundScale, 1, 1.15, DEFAULT_STATE.config.ui.backgroundScale)
  };
}

function normalizeTimestamp(value) {
  const raw = stringValue(value).trim();
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function isWebPageSender(sender) {
  return Boolean(sender && typeof sender.url === "string" && /^https?:/i.test(sender.url));
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
