"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function loadConnectionRuntime(options = {}) {
  const localStore = {};
  const sessionStore = options.sessionStore || {};
  const alarms = options.alarms || {};
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    atob,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: options.fetch || fetch,
    setTimeout,
    structuredClone,
    chrome: {
      action: {
        async setBadgeBackgroundColor() {},
        async setBadgeText() {},
        async setTitle() {}
      },
      alarms: {
        async clear(name) {
          const existed = Boolean(alarms[name]);
          delete alarms[name];
          return existed;
        },
        create(name, info) { alarms[name] = { name, ...info }; },
        async get(name) { return alarms[name] || null; }
      },
      runtime: { id: "test-extension-id", lastError: null },
      storage: {
        local: {
          async get(keys) {
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => key in localStore).map((key) => [key, structuredClone(localStore[key])]));
          },
          async set(patch) { Object.assign(localStore, structuredClone(patch)); },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete localStore[key];
          },
          async getBytesInUse() { return 0; }
        },
        session: {
          async get(keys) {
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => key in sessionStore).map((key) => [key, structuredClone(sessionStore[key])]));
          },
          async set(patch) { Object.assign(sessionStore, structuredClone(patch)); }
        }
      }
    },
    __alarms: alarms,
    __sessionStore: sessionStore
  });

  for (const path of [
    "account-utils.js",
    "portal-url.js",
    "portal-diagnostics-utils.js",
    "background/state-store.js",
    "background/response-reader.js",
    "background/portal-context.js",
    "background/drcom-protocol.js",
    "background/drcom-client.js",
    "background/account-service.js",
    "background/connection-service.js",
    "background/portal-service.js"
  ]) {
    const source = readFileSync(join(__dirname, "..", "CRX", path), "utf8");
    new vm.Script(source, { filename: path }).runInContext(context);
  }
  return context;
}

function account(overrides = {}) {
  return {
    id: "account-1",
    label: "测试账号",
    username: "student",
    suffix: "@telecom",
    password: "test-secret",
    network: {
      wlanUserIp: "192.0.2.99",
      wlanUserIpv6: "",
      wlanUserMac: "000000000000",
      wlanAcIp: "",
      wlanAcName: ""
    },
    updatedAt: "2026-01-02T03:04:05.000Z",
    ...overrides
  };
}

function stateWithAccount(item, overrides = {}) {
  return {
    selectedAccountId: item.id,
    accounts: [item],
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
      automation: { keepAlive: true, intervalMinutes: 3 },
      ...(overrides.config || {})
    }
  };
}

function response(body, url) {
  return {
    ok: true,
    status: 200,
    url,
    async text() { return body; }
  };
}

function activeSession(wlanUserMac = "AABBCCDDEEFF") {
  return {
    drcomAssistantSession: {
      guards: {},
      connection: {
        phase: "online",
        attempt: 0,
        nextRetryAt: 0,
        blocked: false,
        message: "已连接",
        updatedAt: 100
      },
      activeIdentity: {
        accountId: "account-1",
        username: "student",
        suffix: "@telecom",
        network: {
          wlanUserIp: "192.0.2.46",
          wlanUserIpv6: "",
          wlanUserMac,
          wlanAcIp: "",
          wlanAcName: ""
        },
        source: "saved",
        authenticatedAt: 100
      },
      pendingAccountCapture: null,
      captureOptionsOpenedAt: 0
    }
  };
}

function setStatusFakes(background) {
  background.getState = async () => structuredClone(stateWithAccount(account()));
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;
  /* saveConfig 依赖 portal-service 的内容脚本同步；本 harness 未加载该模块。 */
  background.syncPortalContentScript = async () => undefined;
}

function loginFakes(requests, { gateAction, initialStatus = "offline" } = {}) {
  let releaseGate;
  const gate = gateAction ? new Promise((resolve) => { releaseGate = resolve; }) : null;
  let unbindCompleted = false;
  let statusQueries = 0;
  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const action = url.searchParams.get("a");
    if (url.pathname === "/drcom/chkstatus") {
      statusQueries += 1;
      const online = statusQueries > 1 || initialStatus === "online";
      return response(online && !unbindCompleted
        ? 'dr1001({"result":1,"uid":"student@telecom","v46ip":"192.0.2.46","ss4":"AABBCCDDEEFF"})'
        : 'dr1001({"result":0})', url.toString());
    }
    if (url.port !== "801") {
      return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
    }
    if (action === "login") {
      if (gateAction === "login") await gate;
      return response('dr1002({"result":1,"msg":"login success"})', url.toString());
    }
    if (action === "unbind_mac") {
      if (gateAction === "unbind_mac") await gate;
      unbindCompleted = true;
      return response('dr1002({"result":1,"msg":"unbind success"})', url.toString());
    }
    return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
  };
  return { fetch, releaseGate };
}

function offlineLoginFakes(requests) {
  let loginCount = 0;
  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const action = url.searchParams.get("a");
    if (url.pathname === "/drcom/chkstatus") {
      return response(loginCount > 0
        ? 'dr1001({"result":1,"uid":"student@telecom","v46ip":"192.0.2.46"})'
        : 'dr1001({"result":0})', url.toString());
    }
    if (url.port !== "801") {
      return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
    }
    if (action === "login") {
      loginCount += 1;
      return response('dr1002({"result":1,"msg":"login success"})', url.toString());
    }
    return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
  };
  return { fetch, getLoginCount: () => loginCount };
}

test("并发登录合并为同一任务，认证请求只发送一次", async () => {
  const requests = [];
  const { fetch, releaseGate } = loginFakes(requests, { gateAction: "login" });
  const background = loadConnectionRuntime({ fetch });
  setStatusFakes(background);
  const saved = account();

  const first = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  const second = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseGate();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.success, true);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(requests.filter((url) => url.searchParams.get("a") === "login").length, 1);
});

test("登录进行中收到注销时等待登录结束后再执行，最终状态为离线", async () => {
  const requests = [];
  const { fetch, releaseGate } = loginFakes(requests, { gateAction: "login" });
  const background = loadConnectionRuntime({ fetch, sessionStore: activeSession() });
  setStatusFakes(background);
  const saved = account();

  const login = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  await new Promise((resolve) => setImmediate(resolve));
  const logout = background.logout();
  await new Promise((resolve) => setImmediate(resolve));

  /* 登录被闸门挂起时，注销不得提前向网关发送任何请求。 */
  const requestsBeforeRelease = requests.length;
  assert.equal(
    requests.some((url) => url.searchParams.get("a") === "unbind_mac" || url.searchParams.get("a") === "logout"),
    false
  );

  releaseGate();
  const loginResult = await login;
  const logoutResult = await logout;

  assert.equal(loginResult.success, true);
  assert.equal(logoutResult.success, true);
  assert.equal(requests.length > requestsBeforeRelease, true);
  assert.equal(background.__sessionStore.drcomAssistantSession.connection.phase, "offline");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity, null);
});

test("注销进行中时自动登录被直接拒绝，注销完成后也不自动重连", async () => {
  const requests = [];
  const { fetch, releaseGate } = loginFakes(requests, { gateAction: "unbind_mac", initialStatus: "online" });
  const background = loadConnectionRuntime({ fetch, sessionStore: activeSession() });
  setStatusFakes(background);
  const saved = account();

  const logout = background.logout();
  await new Promise((resolve) => setImmediate(resolve));

  const autoLogin = await background.loginAccount(saved.id, null, { automatic: true });
  assert.equal(autoLogin.skipped, true, "logout 进行中自动登录应被跳过");

  releaseGate();
  const logoutResult = await logout;
  assert.equal(logoutResult.success, true);

  /* 注销完成后自动通道也不得重新登录。 */
  const autoRetry = await background.loginAccount(saved.id, null, { automatic: true });
  assert.equal(autoRetry.skipped, true);
  assert.equal(
    requests.some((url) => url.searchParams.get("a") === "login"),
    false,
    "整个注销流程不得出现任何登录请求"
  );
});

test("用户主动注销成功后抑制自动重连，直到再次主动登录", async () => {
  const requests = [];
  const { fetch } = offlineLoginFakes(requests);
  const background = loadConnectionRuntime({ fetch });
  setStatusFakes(background);
  const saved = account();

  const logoutResult = await background.logout();
  assert.equal(logoutResult.success, true);
  assert.equal(background.__sessionStore.drcomAssistantSession.manualLogout, true);

  const requestsAfterLogout = requests.length;
  await background.keepAliveTick();
  assert.equal(requests.length, requestsAfterLogout, "主动注销后 keepalive 不得访问网关");

  const autoLogin = await background.loginAccount(saved.id, null, { automatic: true });
  assert.equal(autoLogin.skipped, true, "主动注销后自动登录应被跳过");

  /* 用户再次主动登录后解除抑制。 */
  const manualLogin = await background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  assert.equal(manualLogin.success, true);
  assert.equal(background.__sessionStore.drcomAssistantSession.manualLogout, false);

  await background.keepAliveTick();
  assert.equal(requests.length > requestsAfterLogout, true, "恢复后 keepalive 应重新检查状态");
});

test("重新启用自动连接（打开 keepAlive 开关）同样解除主动注销抑制", async () => {
  const requests = [];
  const { fetch } = offlineLoginFakes(requests);
  const background = loadConnectionRuntime({ fetch });
  setStatusFakes(background);

  const logoutResult = await background.logout();
  assert.equal(logoutResult.success, true);
  assert.equal(background.__sessionStore.drcomAssistantSession.manualLogout, true);

  /* config:save 把 keepAlive 从关闭切换为打开视为用户明确重新启用。 */
  background.getState = async () => structuredClone({
    ...stateWithAccount(account()),
    config: {
      ...stateWithAccount(account()).config,
      automation: { keepAlive: false, intervalMinutes: 3 }
    }
  });
  await background.saveConfig({ automation: { keepAlive: true } });
  assert.equal(background.__sessionStore.drcomAssistantSession.manualLogout, false);
});

test("过期的 operationId 不得覆盖最新连接状态", async () => {
  const sessionStore = activeSession();
  const background = loadConnectionRuntime({ sessionStore });
  setStatusFakes(background);

  const stale = await background.recordLoginOutcome(
    { success: true, online: true, message: "过期登录完成" },
    { operationId: 999999 }
  );
  assert.equal(stale.stale, true);
  assert.equal(sessionStore.drcomAssistantSession.connection.phase, "online");
  assert.equal(sessionStore.drcomAssistantSession.connection.message, "已连接");

  const staleLogout = await background.recordLogoutOutcome(
    { success: true },
    { state: "offline" },
    888888
  );
  assert.equal(staleLogout.stale, true);
  assert.equal(sessionStore.drcomAssistantSession.connection.phase, "online");
  assert.equal(sessionStore.drcomAssistantSession.connection.message, "已连接");
});

test("主动注销后网关离线时状态显示为离线而不是待认证", async () => {
  const requests = [];
  const background = loadConnectionRuntime({
    sessionStore: { drcomAssistantSession: { ...activeSession().drcomAssistantSession, manualLogout: true } },
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return response('dr1001({"result":0})', url.toString());
    }
  });
  setStatusFakes(background);

  const result = await background.checkStatus();

  assert.equal(result.state, "offline");
  assert.equal(result.phase, "offline");
});

test("login + logout + logout：注销只执行一次，最终离线", async () => {
  const requests = [];
  const { fetch, releaseGate } = loginFakes(requests, { gateAction: "login" });
  const background = loadConnectionRuntime({ fetch, sessionStore: activeSession() });
  setStatusFakes(background);
  const saved = account();

  const login = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  await new Promise((resolve) => setImmediate(resolve));
  const logoutA = background.logout();
  const logoutB = background.logout();
  await new Promise((resolve) => setImmediate(resolve));

  releaseGate();
  await login;
  const [aResult, bResult] = await Promise.all([logoutA, logoutB]);

  assert.equal(aResult.success, true);
  assert.deepEqual(bResult, aResult, "排队中的重复注销应与第一次合并");
  assert.equal(requests.filter((url) => url.searchParams.get("a") === "unbind_mac").length, 1);
  assert.equal(requests.filter((url) => url.searchParams.get("a") === "logout").length, 0);
  assert.equal(background.__sessionStore.drcomAssistantSession.connection.phase, "offline");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity, null);
});

test("login + logout + login：用户最后的登录意图必须生效，最终在线", async () => {
  const requests = [];
  const { fetch, releaseGate } = loginFakes(requests, { gateAction: "login" });
  const background = loadConnectionRuntime({ fetch, sessionStore: activeSession() });
  setStatusFakes(background);
  const saved = account();

  const login1 = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  await new Promise((resolve) => setImmediate(resolve));
  const logout = background.logout();
  const login2 = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  await new Promise((resolve) => setImmediate(resolve));

  releaseGate();
  await Promise.all([login1, logout, login2]);

  assert.equal(background.__sessionStore.drcomAssistantSession.connection.phase, "online");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity.username, "student");
  assert.equal(requests.filter((url) => url.searchParams.get("a") === "unbind_mac").length, 1);
  assert.equal(requests.filter((url) => url.searchParams.get("a") === "login").length, 2,
    "登录和重新登录各发送一次认证请求");
});

test("logout + login + logout：用户最后的注销意图必须生效，最终离线", async () => {
  const requests = [];
  const { fetch, releaseGate } = loginFakes(requests, { gateAction: "unbind_mac", initialStatus: "online" });
  const background = loadConnectionRuntime({ fetch, sessionStore: activeSession() });
  setStatusFakes(background);
  const saved = account();

  const logoutA = background.logout();
  await new Promise((resolve) => setImmediate(resolve));
  const login = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });
  const logoutB = background.logout();
  await new Promise((resolve) => setImmediate(resolve));

  releaseGate();
  await Promise.all([logoutA, login, logoutB]);

  assert.equal(background.__sessionStore.drcomAssistantSession.connection.phase, "offline");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity, null);
  /* 两次注销都是独立操作，各自完整走一遍解绑；重新登录只发一次认证请求。 */
  assert.equal(requests.filter((url) => url.searchParams.get("a") === "unbind_mac").length, 2);
  assert.equal(requests.filter((url) => url.searchParams.get("a") === "login").length, 1);
});

test("注销结果未知时同样抑制自动重连", async () => {
  const requests = [];
  const sessionStore = activeSession();
  const background = loadConnectionRuntime({
    sessionStore,
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const action = url.searchParams.get("a");
      if (url.pathname === "/drcom/chkstatus") {
        return response('dr1001({"result":1,"uid":"student@telecom","v46ip":"192.0.2.46","ss4":"AABBCCDDEEFF"})', url.toString());
      }
      if (url.port !== "801") {
        return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      }
      return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
    }
  });
  setStatusFakes(background);
  const saved = account();

  /* 网关一直报告在线：注销请求已发送但无法确认离线。 */
  const logoutResult = await background.logout();
  assert.equal(logoutResult.success, false);
  assert.equal(background.__sessionStore.drcomAssistantSession.manualLogout, true,
    "用户发起注销的那一刻就应抑制自动重连，即使结果未知");

  const requestsBefore = requests.length;
  await background.keepAliveTick();
  assert.equal(requests.length, requestsBefore, "结果未知的注销之后 keepalive 不得访问网关");

  const autoLogin = await background.loginAccount(saved.id, null, { automatic: true });
  assert.equal(autoLogin.skipped, true);
});

test("logout 进行中排队的不同账号登录必须逐个执行，最终身份是最后请求的账号", async () => {
  const requests = [];
  let unbindDone = false;
  let loginCount = 0;
  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const action = url.searchParams.get("a");
    if (url.pathname === "/drcom/chkstatus") {
      if (unbindDone) {
        /* 第二次登录（student2）后才复核在线：A 登录复核离线以区分两次执行。 */
        return response(loginCount >= 2
          ? 'dr1001({"result":1,"uid":"student2@telecom","v46ip":"192.0.2.46"})'
          : 'dr1001({"result":0})', url.toString());
      }
      return response('dr1001({"result":1,"uid":"student@telecom","v46ip":"192.0.2.46","ss4":"AABBCCDDEEFF"})', url.toString());
    }
    if (url.port !== "801") {
      return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
    }
    if (action === "login") {
      loginCount += 1;
      return response('dr1002({"result":1,"msg":"login success"})', url.toString());
    }
    if (action === "unbind_mac") {
      unbindDone = true;
      return response('dr1002({"result":1,"msg":"unbind success"})', url.toString());
    }
    return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
  };
  const background = loadConnectionRuntime({ fetch, sessionStore: activeSession() });
  const accountB = account({ id: "account-2", username: "student2" });
  background.getState = async () => {
    const state = stateWithAccount(account());
    state.accounts = [account(), accountB];
    return structuredClone(state);
  };
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;
  background.syncPortalContentScript = async () => undefined;

  const logout = background.logout();
  await new Promise((resolve) => setImmediate(resolve));
  const loginA = background.loginAccount("account-1", null, { portalPageUrl: "http://10.10.10.2/" });
  const loginB = background.loginAccount("account-2", null, { portalPageUrl: "http://10.10.10.2/" });

  assert.notEqual(loginA, loginB, "不同账号的排队登录不得被误合并为同一任务");

  await logout;
  const [resultA, resultB] = await Promise.all([loginA, loginB]);

  assert.equal(resultA.success, true);
  assert.equal(resultB.success, true);
  const loginRequests = requests.filter((url) => url.searchParams.get("a") === "login");
  assert.equal(loginRequests.length, 2, "两个账号应各自发送认证请求");
  assert.match(loginRequests[0].searchParams.get("user_account"), /student@telecom/,
    "先排队登录的账号 A 必须先执行");
  assert.match(loginRequests[1].searchParams.get("user_account"), /student2@telecom/,
    "后排队登录的账号 B 必须在其后独立执行");
  assert.equal(background.__sessionStore.drcomAssistantSession.connection.phase, "online");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity.username, "student2",
    "用户最后请求的账号必须拥有最终语义");
});

test("同一账号的自动与手动登录是不同语义，排队时不得互相合并", async () => {
  const requests = [];
  const { fetch } = offlineLoginFakes(requests);
  const background = loadConnectionRuntime({ fetch });
  setStatusFakes(background);
  const saved = account();

  const autoLogin = background.loginAccount(saved.id, null, { automatic: true });
  const manualLogin = background.loginAccount(saved.id, null, { portalPageUrl: "http://10.10.10.2/" });

  assert.notEqual(autoLogin, manualLogin, "自动与手动登录不得合并为同一任务");

  const autoResult = await autoLogin;
  const manualResult = await manualLogin;
  assert.equal(autoResult.success, true);
  assert.equal(manualResult.success, true);
  assert.equal(background.__sessionStore.drcomAssistantSession.connection.phase, "online");
});

test("临时账号登录不参与合并，各自独立执行", async () => {
  const requests = [];
  let loginCount = 0;
  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const action = url.searchParams.get("a");
    if (url.pathname === "/drcom/chkstatus") {
      /* 只有第二次登录后才复核在线，保证两个临时账号都真实走完认证请求。 */
      return response(loginCount >= 2
        ? 'dr1001({"result":1,"uid":"temporary-b@unicom","v46ip":"192.0.2.46"})'
        : 'dr1001({"result":0})', url.toString());
    }
    if (url.port !== "801") {
      return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
    }
    if (action === "login") {
      loginCount += 1;
      return response('dr1002({"result":1,"msg":"login success"})', url.toString());
    }
    return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
  };
  const background = loadConnectionRuntime({ fetch });
  setStatusFakes(background);

  const transientA = account({
    id: "",
    username: "temporary-a",
    suffix: "@unicom",
    password: "secret-a",
    network: { wlanUserIp: "10.0.0.99", wlanUserMac: "AABBCCDDEEFF" }
  });
  const transientB = account({
    id: "",
    username: "temporary-b",
    suffix: "@unicom",
    password: "secret-b",
    network: { wlanUserIp: "10.0.0.98", wlanUserMac: "AABBCCDDEEFF" }
  });

  const first = background.loginAccount("", transientA);
  const second = background.loginAccount("", transientB);

  assert.notEqual(first, second, "临时账号登录不得互相合并");

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, true);
  const loginRequests = requests.filter((url) => url.searchParams.get("a") === "login");
  assert.equal(loginRequests.length, 2, "两个临时账号应各自发送认证请求");
  assert.match(loginRequests[0].searchParams.get("user_account"), /temporary-a@unicom/,
    "先排队的临时账号必须先执行");
  assert.match(loginRequests[1].searchParams.get("user_account"), /temporary-b@unicom/,
    "后排队的临时账号必须在其后独立执行");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity.username, "temporary-b");
});
