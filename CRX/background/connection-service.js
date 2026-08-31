"use strict";

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
    return recordLogoutOutcome(legacyResult);
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

  return recordLogoutOutcome(result);
}

async function recordLogoutOutcome(result) {
  if (!result || !result.success) return result;
  await chrome.alarms.clear(RETRY_ALARM);
  const { session } = await mutateSession((draft) => {
    draft.activeIdentity = null;
    draft.connection = {
      ...DEFAULT_CONNECTION_STATE,
      phase: "offline",
      message: result.message || "已下线。",
      updatedAt: Date.now()
    };
  });
  await updateActionBadge(session.connection);
  return { ...result, online: false, phase: "offline" };
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

