"use strict";

var accountUtils = globalThis.DrcomAccountUtils;

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
    const result = await performLoginAccount(accountId, transientAccount, options);
    return recordLoginOutcome(result);
  });
}

async function performLoginAccount(accountId, transientAccount, options = {}) {
  const state = await getState();
  const isTransient = Boolean(transientAccount);
  const account = transientAccount
    ? sanitizeAccount(transientAccount)
    : state.accounts.find((item) => item.id === (accountId || state.selectedAccountId));

  if (!account) {
    throw new Error("请先保存或选择账号");
  }

  const currentStatus = await queryPortalSessionStatus(state.config);
  if (currentStatus.state === "online") {
    return {
      ...currentStatus,
      ok: true,
      success: true,
      online: true,
      message: "账号已经在线，无需重复登录。"
    };
  }

  const portalContext = await resolvePortalRuntimeContext(state.config, options.portalPageUrl || "");
  if (!portalContext.ok) {
    return {
      ok: false,
      success: false,
      online: false,
      failureCode: portalContext.failureCode || "portal_context_missing",
      message: portalContext.message || "未取得当前校园网 IP，认证密码尚未发送。",
      diagnostic: portalContext.diagnostic || {}
    };
  }

  const network = mergeRuntimeLoginNetwork(account, state.config, portalContext.network);

  if (state.config.login.findMacBeforeLogin !== false) {
    for (const includeSuffix of [false, true]) {
      try {
        const probe = await fetchDrcom(buildFindMacRequest(account, state.config, {
          networkOverride: network,
          includeSuffix
        }), "find_mac");
        const mac = extractMacFromResponse(probe.data, probe.raw);
        if (isUsableMac(mac)) {
          network.wlanUserMac = accountUtils.normalizeMac(mac);
          break;
        }
      } catch (error) {}
    }
  }

  const request = buildLoginRequest(account, state.config, network);
  let result = await fetchDrcom(request, "login");
  if (result.requiresStatusConfirmation) {
    const confirmed = await queryPortalSessionStatus(state.config);
    result = confirmed.state === "online"
      ? { ...result, success: true, online: true, message: "账号已经在线，无需重复登录。" }
      : { ...result, success: false, online: false, message: "网关提示账号可能在线，但状态复核未确认在线。" };
  }
  return {
    ...result,
    authenticatedIdentity: sanitizeActiveIdentity({
      accountId: isTransient ? "" : account.id,
      username: account.username,
      suffix: account.suffix,
      network,
      source: isTransient ? "transient" : "saved",
      authenticatedAt: Date.now()
    })
  };
}


function mergeRuntimeLoginNetwork(account, config, runtimeNetwork) {
  const accountNetwork = account && account.network || {};
  const configNetwork = config && config.network || {};
  const fresh = runtimeNetwork || {};
  const wlanUserMac = [fresh.wlanUserMac, accountNetwork.wlanUserMac, configNetwork.wlanUserMac]
    .map((value) => accountUtils.normalizeMac(value))
    .find((value) => isUsableMac(value)) || "000000000000";
  return {
    wlanUserIp: stringValue(fresh.wlanUserIp).trim(),
    wlanUserIpv6: stringValue(fresh.wlanUserIpv6 || accountNetwork.wlanUserIpv6 || configNetwork.wlanUserIpv6).trim(),
    wlanUserMac,
    wlanAcIp: stringValue(fresh.wlanAcIp || accountNetwork.wlanAcIp || configNetwork.wlanAcIp).trim(),
    wlanAcName: stringValue(fresh.wlanAcName || accountNetwork.wlanAcName || configNetwork.wlanAcName).trim()
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

async function logout() {
  const state = await getState();
  const session = await getSessionState();
  const account = session.activeIdentity;

  const network = await resolveCurrentLogoutNetwork(account, state.config);
  let unbindResult = null;
  let confirmation = null;

  if (account && isUsableMac(network.wlanUserMac)) {
    unbindResult = await fetchDrcom(buildUnbindRequest(account, state.config, network), "logout");
    if (unbindResult.success) {
      confirmation = await confirmPortalOffline(state.config);
      if (confirmation.state === "offline") {
        return recordLogoutOutcome(unbindResult, confirmation);
      }
    }
  }

  const portalResult = await fetchDrcom(buildPortalLogoutRequest(state.config, network), "logout");
  confirmation = await confirmPortalOffline(state.config);
  if (confirmation.state === "offline") {
    return recordLogoutOutcome(portalResult, confirmation);
  }

  const stateMessage = confirmation.state === "online"
    ? "注销未完成，校园网会话仍然在线。"
    : "注销请求已发送，但无法确认已经离线。";
  return {
    ...(portalResult || unbindResult || {}),
    ok: false,
    success: false,
    online: confirmation.state === "online" || session.connection.phase === "online",
    phase: session.connection.phase,
    message: stateMessage,
    confirmationState: confirmation.state
  };
}

async function recordLogoutOutcome(result, confirmation) {
  if (!confirmation || confirmation.state !== "offline") {
    return {
      ...(result || {}),
      ok: false,
      success: false,
      message: "注销请求已发送，但尚未确认已经离线。"
    };
  }
  await chrome.alarms.clear(RETRY_ALARM);
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  const { session } = await mutateSession((draft) => {
    draft.activeIdentity = null;
    draft.connection = {
      ...DEFAULT_CONNECTION_STATE,
      phase: "offline",
      message: "已确认校园网会话离线。",
      updatedAt: Date.now()
    };
  });
  await updateActionBadge(session.connection);
  return {
    ...(result || {}),
    ok: true,
    success: true,
    online: false,
    phase: "offline",
    message: "已确认校园网会话离线。",
    confirmationState: "offline"
  };
}

async function resolveCurrentLogoutNetwork(account, config) {
  const stored = account && account.network || {};
  const configured = config && config.network || {};
  let fresh = {};
  try {
    const context = await resolvePortalRuntimeContext(config, config.portalUrl || "");
    if (context.ok) fresh = context.network || {};
  } catch (error) {}

  const wlanUserMac = [fresh.wlanUserMac, stored.wlanUserMac, configured.wlanUserMac]
    .map((value) => accountUtils.normalizeMac(value))
    .find((value) => isUsableMac(value)) || "000000000000";
  return {
    wlanUserIp: stringValue(fresh.wlanUserIp || stored.wlanUserIp || configured.wlanUserIp).trim(),
    wlanUserIpv6: stringValue(fresh.wlanUserIpv6 || stored.wlanUserIpv6 || configured.wlanUserIpv6).trim(),
    wlanUserMac,
    wlanAcIp: stringValue(fresh.wlanAcIp || stored.wlanAcIp || configured.wlanAcIp).trim(),
    wlanAcName: stringValue(fresh.wlanAcName || stored.wlanAcName || configured.wlanAcName).trim()
  };
}

async function confirmPortalOffline(config) {
  let status = { state: "unknown" };
  for (const delay of [300, 800, 1500]) {
    await waitForLogoutDelay(delay);
    status = await queryPortalSessionStatus(config);
    if (status.state === "offline") return status;
  }
  return status;
}

function waitForLogoutDelay(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function checkStatus() {
  const state = await getState();
  const previousRuntime = await getConnectionState();
  await setConnectionState({
    phase: "checking",
    message: "正在检查校园网连接状态。",
    updatedAt: Date.now()
  });

  let result = await queryPortalSessionStatus(state.config);
  if (result.state === "unknown") {
    const pageResult = await queryPortalPageStatus(state.config);
    if (pageResult.state !== "unknown") result = pageResult;
  }

  const now = Date.now();
  const runtime = await getConnectionState();
  const phase = resolveStatusPhase(result.state, runtime, previousRuntime, now);
  if (result.state === "online") await chrome.alarms.clear(RETRY_ALARM);
  await setConnectionState({
    phase,
    attempt: result.state === "online" ? 0 : runtime.attempt,
    nextRetryAt: result.state === "online" ? 0 : runtime.nextRetryAt,
    blocked: result.state === "online" ? false : runtime.blocked,
    message: result.message,
    updatedAt: now
  });
  await addRequestRecord({ kind: "status", ...result });
  return { ...result, phase };
}

async function queryPortalPageStatus(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(config.portalUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      signal: controller.signal
    });
    return parsePortalStatus(response.status, await response.text(), config.portalUrl);
  } catch (error) {
    return {
      ok: false,
      success: false,
      online: false,
      state: "unknown",
      message: error && error.name === "AbortError"
        ? "访问 10.10.10.2 超时，无法确认校园网状态。"
        : "无法确认校园网会话状态。",
      statusCode: 0,
      url: config.portalUrl,
      raw: ""
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveStatusPhase(status, runtime, previousRuntime, now) {
  if (status === "online") return "online";
  if (runtime.blocked) return "action_required";
  if (runtime.nextRetryAt > now) return "waiting";
  if (status === "offline") return "captive";
  const previousPhase = stringValue(previousRuntime && previousRuntime.phase).trim();
  return previousPhase && previousPhase !== "checking" ? previousPhase : "idle";
}

async function keepAliveTick() {
  const state = await getState();
  if (!state.config.automation.keepAlive || !state.selectedAccountId) {
    return;
  }

  const runtime = await getConnectionState();
  if (!canAttemptAutomaticLogin(runtime)) return;

  const status = await checkStatus();
  if (status.state === "offline") {
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
