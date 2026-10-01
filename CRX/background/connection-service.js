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
  const automatic = options.automatic === true;
  // 自动登录在单通道外先检查冷却、暂停与主动注销抑制：被拦截时直接返回，不并入
  // 进行中的登录，避免并发的手动登录入口拿到“自动跳过”结果。
  if (automatic) {
    const precheck = await getConnectionState();
    if (!canAttemptAutomaticLogin(precheck) || await isManualLogoutActive()) {
      return automaticLoginSkipped(precheck);
    }
  }

  /* 所有登录入口共享统一的连接操作通道：与进行中的 logout 互斥，
     logout 进行中时自动登录直接放弃、手动登录等待其完成后再执行。
     合并按语义键进行：同一保存账号的同模式并发登录去重为一次执行；
     自动与手动是不同意图不互相合并；临时账号每次都是独立任务。
     语义键必须同步构造（不得 await）：并发入口只有在同一微任务阶段
     比较键才能命中合并窗口。空 accountId 以 "selected" 占位，表示
     "跟随当前选中账号"的入口。 */
  const dedupeKey = transientAccount
    ? null
    : `login:saved:${accountId || "selected"}:${automatic ? "auto" : "manual"}`;
  return runConnectionOperation("login", async (operation) => {
    const runtime = await getConnectionState();
    if (automatic && (!canAttemptAutomaticLogin(runtime) || await isManualLogoutActive())) {
      return automaticLoginSkipped(runtime);
    }

    if (!automatic) {
      /* 用户主动登录解除主动注销抑制，恢复自动连接资格。 */
      await setManualLogout(false);
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
    return recordLoginOutcome(result, { operationId: operation.id });
  }, { automatic, dedupeKey });
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

  const currentSnapshot = await queryPortalSessionSnapshot(state.config);
  const currentStatus = currentSnapshot.status;
  if (currentStatus.state === "online") {
    return evaluateOnlineAccount(
      currentStatus,
      currentSnapshot.identity,
      account,
      isTransient
    );
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

  const network = createRuntimeLoginNetwork(portalContext.network);

  const request = buildLoginRequest(account, state.config, network);
  let result = await fetchDrcom(request, "login");
  if (result.requiresStatusConfirmation) {
    const confirmed = await queryPortalSessionSnapshot(state.config);
    result = confirmed.status.state === "online"
      ? evaluateOnlineAccount(
        { ...result, ok: true, state: "online", online: true },
        confirmed.identity,
        account,
        isTransient,
        network
      )
      : { ...result, success: false, online: false, message: "网关提示账号可能在线，但状态复核未确认在线。" };
  }

  const authenticatedIdentity = result.success
    ? result.authenticatedIdentity || createAuthenticatedIdentity(account, isTransient, network)
    : null;
  return { ...result, authenticatedIdentity };
}

function evaluateOnlineAccount(baseResult, identity, account, isTransient, fallbackNetwork = {}) {
  const onlineAccount = accountUtils.parse(stringValue(identity && identity.uid).trim());
  const result = {
    ...baseResult,
    ok: true,
    online: true,
    state: "online"
  };

  if (!onlineAccount.username) {
    return {
      ...result,
      success: false,
      identityVerified: false,
      session: null,
      message: "校园网已有会话在线，但无法确认账号。"
    };
  }

  if (accountUtils.naturalKey(onlineAccount) !== accountUtils.naturalKey(account)) {
    return {
      ...result,
      success: false,
      identityVerified: true,
      accountMismatch: true,
      session: null,
      message: "当前在线的是另一账号，请先注销再登录。"
    };
  }

  return {
    ...result,
    success: true,
    identityVerified: true,
    message: "账号已经在线，无需重复登录。",
    authenticatedIdentity: createAuthenticatedIdentity(
      account,
      isTransient,
      mergeVerifiedNetwork(fallbackNetwork, identity)
    )
  };
}

function mergeVerifiedNetwork(fallbackNetwork, identity) {
  const fallback = fallbackNetwork || {};
  return {
    wlanUserIp: stringValue(identity && identity.ip).trim() || stringValue(fallback.wlanUserIp).trim(),
    wlanUserIpv6: stringValue(fallback.wlanUserIpv6).trim(),
    wlanUserMac: stringValue(identity && identity.mac).trim() || stringValue(fallback.wlanUserMac).trim(),
    wlanAcIp: stringValue(fallback.wlanAcIp).trim(),
    wlanAcName: stringValue(fallback.wlanAcName).trim()
  };
}

function createAuthenticatedIdentity(account, isTransient, network) {
  return sanitizeActiveIdentity({
    accountId: isTransient ? "" : account.id,
    username: account.username,
    suffix: account.suffix,
    network,
    source: isTransient ? "transient" : "saved",
    authenticatedAt: Date.now()
  });
}

function createRuntimeLoginNetwork(runtimeNetwork) {
  const fresh = runtimeNetwork || {};
  /* 生产门户登录只提交本次页面解析到的 IPv4；设备和 AC 字段保持学校原请求的空值。
     findMacBeforeLogin 继续保留在存储结构中以兼容旧配置，但不再参与认证。 */
  return {
    wlanUserIp: stringValue(fresh.wlanUserIp).trim(),
    wlanUserIpv6: "",
    wlanUserMac: "000000000000",
    wlanAcIp: "",
    wlanAcName: ""
  };
}
function automaticLoginSkipped(runtime) {
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

/* 兼容入口：登录单通道已并入统一连接操作协调器（见 state-store.js）。
   key 参数仅为保留旧签名，现在全局只有一条登录通道。 */
function runLoginSingleFlight(key, task) {
  return runConnectionOperation("login", () => task());
}

function calculateRetryDelay(attempt, randomValue = Math.random()) {
  const count = Math.max(1, Math.floor(Number(attempt) || 1));
  const jitter = Math.min(1, Math.max(0, Number(randomValue) || 0));
  const exponential = RETRY_BASE_MS * (2 ** (count - 1));
  return Math.min(RETRY_MAX_MS, Math.round(exponential * (1 + jitter * 0.2)));
}

function classifyLoginFailure(result) {
  const message = stringValue(result && result.message);
  const failureCode = stringValue(result && result.failureCode).trim();
  if (["bad_credentials", "user_not_found"].includes(failureCode)
      || /密码(?:错误|不正确|失效)|password\s*(?:fail|error|incorrect|invalid|wrong)|账号不存在|用户不存在|userid error/i.test(message)) {
    return {
      category: "credentials",
      retryable: false,
      action: "请检查账号、运营商后缀和认证密码。"
    };
  }
  if (failureCode === "device_limit" || /设备数量|MAC 冲突|AC999|绑定/i.test(message)) {
    return {
      category: "device",
      retryable: false,
      action: "请先下线其他设备，或重新采集当前设备的网络参数。"
    };
  }
  if (failureCode === "account_restricted" || /流量|余额|欠费|停机|flux out|balance/i.test(message)) {
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
  /* operationId 防覆盖保险：操作互斥之外的第二层保护。若调用时已有更新的连接
     操作启动（或调用方直接传入已过期的 operationId），本次不得写入运行时状态。 */
  if (!isLatestConnectionOperation(options.operationId)) {
    const publicResult = { ...(result || {}) };
    delete publicResult.authenticatedIdentity;
    return { ...publicResult, stale: true };
  }
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
    await setupAutomation(await getState());
    return { ...publicResult, phase: "online", retryable: false, retryAt: 0 };
  }

  if (result && result.online && (result.accountMismatch || result.identityVerified === false)) {
    await chrome.alarms.clear(RETRY_ALARM);
    await setActiveIdentity(null);
    await setConnectionState({
      phase: "online",
      attempt: 0,
      nextRetryAt: 0,
      blocked: false,
      message: result.message,
      updatedAt: now
    });
    await setupAutomation(await getState());
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

function logout() {
  /* 用户点击注销的那一刻就抑制自动重连：即使注销结果未知或失败，
     也不得在稍后由 keepalive / retry 把用户重新拉上线。 */
  void setManualLogout(true);
  /* 注销与登录共用统一连接操作队列：login 进行中时注销排队等其完成再执行；
     后到的注销操作会拿到新的 operationId，慢登录收尾时不得覆盖注销结果。 */
  return runConnectionOperation("logout", (operation) => performLogout(operation.id));
}

async function performLogout(operationId) {
  const state = await getState();
  const session = await getSessionState();
  let account = session.activeIdentity;
  let network = await resolveCurrentLogoutNetwork(account, state.config);

  /* 会话可能不是扩展建立的（例如在学校原始页登录、扩展重装或换机后），activeIdentity
     可能为空或已过期。此时向网关现场解析当前在线身份（chkstatus uid）与绑定 MAC
     （find_mac），走与学校原始页一致的 unbind_mac 通道，而不是依赖 a=logout 兜底。 */
  const live = await resolveLiveLogoutIdentity(state.config, network);
  if (live.username) {
    account = { username: live.username, suffix: live.suffix, network: {} };
  }
  if (isUsableMac(live.wlanUserMac)) {
    network = { ...network, wlanUserMac: live.wlanUserMac };
  }
  if (!stringValue(network.wlanUserIp).trim() && stringValue(live.wlanUserIp).trim()) {
    network = { ...network, wlanUserIp: live.wlanUserIp };
  }

  let unbindResult = null;
  let confirmation = null;

  if (account && isUsableMac(network.wlanUserMac)) {
    unbindResult = await fetchDrcom(buildUnbindRequest(account, state.config, network), "logout");
    if (unbindResult.success) {
      confirmation = await confirmPortalOffline(state.config);
      if (confirmation.state === "offline") {
        return recordLogoutOutcome(unbindResult, confirmation, operationId);
      }
    }
  }

  const portalResult = await fetchDrcom(buildPortalLogoutRequest(state.config, network), "logout");
  confirmation = await confirmPortalOffline(state.config);
  if (confirmation.state === "offline") {
    return recordLogoutOutcome(portalResult, confirmation, operationId);
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

async function recordLogoutOutcome(result, confirmation, operationId) {
  if (!confirmation || confirmation.state !== "offline") {
    return {
      ...(result || {}),
      ok: false,
      success: false,
      message: "注销请求已发送，但尚未确认已经离线。"
    };
  }
  /* 慢操作收尾保护：已经不是最新连接操作时不得覆盖运行时状态。 */
  if (!isLatestConnectionOperation(operationId)) {
    return {
      ...(result || {}),
      ok: true,
      success: true,
      online: false,
      phase: "offline",
      message: "已确认校园网会话离线。",
      confirmationState: "offline",
      stale: true
    };
  }
  await chrome.alarms.clear(RETRY_ALARM);
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  /* 用户主动注销成功后抑制自动重连，直到用户再次主动登录或重新启用自动连接。 */
  await setManualLogout(true);
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

async function resolveLiveLogoutIdentity(config, network) {
  const empty = { username: "", suffix: "", wlanUserMac: "", wlanUserIp: "" };
  try {
    const identity = await queryPortalSessionIdentity(config);
    if (identity.state !== "online") return empty;
    const parsed = accountUtils.parse(stringValue(identity.uid).trim());
    if (!parsed.username) return empty;
    const live = {
      username: parsed.username,
      suffix: parsed.suffix,
      /* chkstatus 的 ss4 就是学校页面 term.mac 的来源（a41.js），优先于 find_mac 猜测 */
      wlanUserMac: stringValue(identity.mac).trim(),
      wlanUserIp: stringValue(identity.ip).trim()
    };
    if (!isUsableMac(live.wlanUserMac)) {
      const probeNetwork = {
        ...network,
        wlanUserIp: stringValue(network.wlanUserIp).trim() || live.wlanUserIp
      };
      try {
        const probe = await fetchDrcom(buildFindMacRequest({
          username: live.username,
          suffix: live.suffix,
          network: {}
        }, config, { networkOverride: probeNetwork, includeSuffix: true }), "find_mac");
        const mac = extractMacFromResponse(probe.data, probe.raw, probeNetwork.wlanUserIp);
        if (isUsableMac(mac)) live.wlanUserMac = mac;
      } catch (error) {}
    }
    return live;
  } catch (error) {
    return empty;
  }
}

async function resolveCurrentLogoutNetwork(account, config) {  const stored = account && account.network || {};
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
  /* 学校页面在 unbind_mac 成功后固定等待 5 秒才刷新；提前复核会把生效中的解绑误判为失败。 */
  for (const delay of [5000, 1500]) {
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
  let phase = resolveStatusPhase(result.state, runtime, previousRuntime, now);
  /* 用户主动注销后，offline 不再显示为“门户待认证”，就是普通的离线。 */
  if (phase === "captive" && await isManualLogoutActive()) phase = "offline";
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
    const html = await readLimitedResponse(response, PORTAL_HTML_LIMIT_BYTES, controller);
    return parsePortalStatus(response.status, html, config.portalUrl);
  } catch (error) {
    return {
      ok: false,
      success: false,
      online: false,
      state: "unknown",
      message: error && error.name === "ResponseSizeLimitError"
        ? "校园网门户响应超过 1 MiB 安全上限，无法确认校园网状态。"
        : error && error.name === "AbortError"
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
  /* 主动注销抑制期间，keepalive 不做状态检查，更不自动重连。 */
  if (!canAttemptAutomaticLogin(runtime) || await isManualLogoutActive()) return;

  const status = await checkStatus();
  if (status.state === "offline") {
    await loginAccount(state.selectedAccountId, null, {
      automatic: true,
      reason: "连接守护正在恢复校园网。"
    });
  }
}

async function setupAutomation(state) {
  const automation = (state.config && state.config.automation) || DEFAULT_STATE.config.automation;
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
