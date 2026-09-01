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
    "portal-diagnostics-utils.js",
    "background/state-store.js",
    "background/portal-context.js",
    "background/drcom-client.js",
    "background/account-service.js",
    "background/connection-service.js"
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

test("空网络账号首次登录使用门户实时 IP 和 find_mac 返回 MAC", async () => {
  const requests = [];
  const saved = account();
  const background = loadConnectionRuntime({
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/drcom/chkstatus") {
        return response('dr1001({"result":0})', url.toString());
      }
      if (url.port !== "801") {
        return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      }
      if (url.searchParams.get("a") === "find_mac") {
        return response('dr1004({"result":1,"wlan_user_mac":"AA-BB-CC-DD-EE-FF"})', url.toString());
      }
      return response('dr1002({"result":1,"msg":"login success"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;

  const result = await background.loginAccount(saved.id, null, {
    portalPageUrl: "http://10.10.10.2/"
  });
  const findMac = requests.find((url) => url.searchParams.get("a") === "find_mac");
  const login = requests.find((url) => url.searchParams.get("a") === "login");

  assert.equal(result.success, true);
  assert.equal(findMac.searchParams.get("wlan_user_ip"), "192.0.2.46");
  assert.equal(login.searchParams.get("wlan_user_ip"), "192.0.2.46");
  assert.equal(login.searchParams.get("wlan_user_mac"), "AABBCCDDEEFF");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity.network.wlanUserIp, "192.0.2.46");
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity.network.wlanUserMac, "AABBCCDDEEFF");
});

test("登录前确认已经在线时不获取上下文也不发送密码", async () => {
  const requests = [];
  const saved = account();
  const background = loadConnectionRuntime({
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return response('dr1001({"result":1,"user_name":"student"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;

  const result = await background.loginAccount(saved.id, null, {
    portalPageUrl: "http://10.10.10.2/"
  });

  assert.equal(result.success, true);
  assert.equal(result.online, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, "/drcom/chkstatus");
  assert.equal(requests.some((url) => url.searchParams.has("user_password")), false);
});

test("缺少实时或全局 IP 时历史账号 IP 不会触发密码请求", async () => {
  const requests = [];
  const saved = account();
  const background = loadConnectionRuntime({
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/drcom/chkstatus") {
        return response('dr1001({"result":0})', url.toString());
      }
      return response('<html><body><div id="edit_body"></div></body></html>', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;

  const result = await background.loginAccount(saved.id, null, {
    portalPageUrl: "http://10.10.10.2/"
  });

  assert.equal(result.success, false);
  assert.equal(result.failureCode, "portal_context_missing");
  assert.equal(requests.some((url) => url.searchParams.get("a") === "login"), false);
  assert.equal(requests.some((url) => url.searchParams.has("user_password")), false);
});

test("ret_code=2 的已在线提示只有复核在线后才完成登录", async () => {
  let statusChecks = 0;
  const saved = account();
  const currentState = stateWithAccount(saved);
  currentState.config.login.findMacBeforeLogin = false;
  const background = loadConnectionRuntime({
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/drcom/chkstatus") {
        statusChecks += 1;
        return response(statusChecks === 1
          ? 'dr1001({"result":0})'
          : 'dr1001({"result":1})', url.toString());
      }
      if (url.port !== "801") {
        return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      }
      return response('dr1002({"result":0,"ret_code":2,"msg":"已经在线"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(currentState);
  background.addRequestRecord = async () => undefined;

  const result = await background.loginAccount(saved.id, null, {
    portalPageUrl: "http://10.10.10.2/"
  });

  assert.equal(result.success, true);
  assert.equal(result.online, true);
  assert.equal(statusChecks, 2);
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity.username, "student");
});

test("ret_code=2 的已在线提示在复核离线时保持失败且不保存活动身份", async () => {
  let statusChecks = 0;
  const saved = account();
  const currentState = stateWithAccount(saved);
  currentState.config.login.findMacBeforeLogin = false;
  const background = loadConnectionRuntime({
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/drcom/chkstatus") {
        statusChecks += 1;
        return response('dr1001({"result":0})', url.toString());
      }
      if (url.port !== "801") {
        return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      }
      return response('dr1002({"result":0,"ret_code":2,"msg":"已经在线"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(currentState);
  background.addRequestRecord = async () => undefined;

  const result = await background.loginAccount(saved.id, null, {
    portalPageUrl: "http://10.10.10.2/"
  });

  assert.equal(result.success, false);
  assert.equal(result.online, false);
  assert.equal(statusChecks, 2);
  assert.match(result.message, /复核未确认在线/);
  assert.equal(background.__sessionStore.drcomAssistantSession.activeIdentity, null);
});

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
        source: "saved",
        authenticatedAt: 100,
        network: {
          wlanUserIp: "192.0.2.46",
          wlanUserIpv6: "",
          wlanUserMac,
          wlanAcIp: "",
          wlanAcName: ""
        }
      }
    }
  };
}

test("没有活动身份时注销不回退到传入或界面选中的账号", async () => {
  const requests = [];
  const sessionStore = activeSession();
  sessionStore.drcomAssistantSession.activeIdentity = null;
  const selected = account({
    network: {
      wlanUserIp: "192.0.2.99",
      wlanUserIpv6: "",
      wlanUserMac: "AABBCCDDEEFF",
      wlanAcIp: "",
      wlanAcName: ""
    }
  });
  const background = loadConnectionRuntime({
    sessionStore,
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/drcom/chkstatus") return response('dr1001({"result":0})', url.toString());
      if (url.port !== "801") return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(selected));
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;

  const result = await background.logout(selected.id, selected);
  const actions = requests.map((url) => url.searchParams.get("a")).filter(Boolean);

  assert.equal(result.success, true);
  assert.equal(actions.includes("unbind_mac"), false);
  assert.equal(actions.includes("logout"), true);
});

test("没有有效 MAC 时直接完整 Portal/logout 并在确认离线后清理会话", async () => {
  const requests = [];
  const sessionStore = activeSession("000000000000");
  const alarms = {
    "drcomAssistant.retry": { name: "drcomAssistant.retry" },
    "drcomAssistant.keepAlive": { name: "drcomAssistant.keepAlive" }
  };
  const saved = account();
  const background = loadConnectionRuntime({
    sessionStore,
    alarms,
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/drcom/chkstatus") return response('dr1001({"result":0})', url.toString());
      if (url.port !== "801") return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      if (url.searchParams.get("a") === "find_mac") return response('dr1004({"result":0})', url.toString());
      return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;

  const result = await background.logout();
  const actions = requests.map((url) => url.searchParams.get("a")).filter(Boolean);
  const fullLogout = requests.find((url) => url.searchParams.get("a") === "logout");

  assert.equal(result.success, true);
  assert.equal(actions.includes("unbind_mac"), false);
  assert.equal(actions.includes("logout"), true);
  assert.equal(fullLogout.searchParams.get("user_account"), "drcom");
  assert.equal(fullLogout.searchParams.get("user_password"), "123");
  assert.equal(fullLogout.searchParams.get("wlan_user_ip"), "192.0.2.46");
  assert.equal(sessionStore.drcomAssistantSession.activeIdentity, null);
  assert.equal(sessionStore.drcomAssistantSession.connection.phase, "offline");
  assert.equal(alarms["drcomAssistant.retry"], undefined);
  assert.equal(alarms["drcomAssistant.keepAlive"], undefined);
});

test("unbind_mac 失败后回退完整 Portal/logout", async () => {
  const requests = [];
  const sessionStore = activeSession();
  const saved = account();
  const background = loadConnectionRuntime({
    sessionStore,
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const action = url.searchParams.get("a");
      if (url.pathname === "/drcom/chkstatus") return response('dr1001({"result":0})', url.toString());
      if (url.port !== "801") return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      if (action === "unbind_mac") return response('dr1002({"result":0,"msg":"unbind failed"})', url.toString());
      return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;

  const result = await background.logout();
  const actions = requests.map((url) => url.searchParams.get("a")).filter(Boolean);

  assert.equal(result.success, true);
  assert.deepEqual(actions.filter((action) => action === "unbind_mac" || action === "logout"), ["unbind_mac", "logout"]);
  assert.equal(sessionStore.drcomAssistantSession.activeIdentity, null);
});

test("注销请求成功但状态始终未知时保留活动身份和在线状态", async () => {
  const sessionStore = activeSession("000000000000");
  const saved = account();
  const background = loadConnectionRuntime({
    sessionStore,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/drcom/chkstatus") return response('dr1001({"message":"unknown"})', url.toString());
      if (url.port !== "801") return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      return response('dr1002({"result":1,"msg":"logout success"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;

  const result = await background.logout();

  assert.equal(result.success, false);
  assert.match(result.message, /无法确认|尚未确认/);
  assert.equal(sessionStore.drcomAssistantSession.activeIdentity.username, "student");
  assert.equal(sessionStore.drcomAssistantSession.connection.phase, "online");
});

test("解绑和完整注销都失败时保持真实在线状态", async () => {
  const requests = [];
  const sessionStore = activeSession();
  const saved = account();
  const background = loadConnectionRuntime({
    sessionStore,
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/drcom/chkstatus") return response('dr1001({"result":1})', url.toString());
      if (url.port !== "801") return response('<script>var v4ip="192.0.2.46";</script>', url.toString());
      return response('dr1002({"result":0,"msg":"logout failed"})', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;

  const result = await background.logout();
  const actions = requests.map((url) => url.searchParams.get("a")).filter(Boolean);

  assert.equal(result.success, false);
  assert.deepEqual(actions.filter((action) => action === "unbind_mac" || action === "logout"), ["unbind_mac", "logout"]);
  assert.equal(sessionStore.drcomAssistantSession.activeIdentity.username, "student");
  assert.equal(sessionStore.drcomAssistantSession.connection.phase, "online");
});

test("异步门户空壳在直接状态未知时保持 unknown 而不是误判离线", async () => {
  const saved = account();
  const background = loadConnectionRuntime({
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/drcom/chkstatus") {
        return response('dr1001({"message":"loading"})', url.toString());
      }
      return response('<html><body><div id="edit_body"></div></body></html>', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;

  const result = await background.checkStatus();

  assert.equal(result.state, "unknown");
  assert.equal(result.online, false);
  assert.equal(result.phase, "idle");
  assert.match(result.message, /不明确|无法确认/);
});

test("连接状态未知时保活不会尝试登录或发送凭据", async () => {
  const requests = [];
  const saved = account();
  const background = loadConnectionRuntime({
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/drcom/chkstatus") {
        return response('dr1001({"message":"loading"})', url.toString());
      }
      return response('<html><body><div id="edit_body"></div></body></html>', url.toString());
    }
  });
  background.getState = async () => structuredClone(stateWithAccount(saved));
  background.addRequestRecord = async () => undefined;
  let loginCalls = 0;
  background.loginAccount = async () => {
    loginCalls += 1;
    return { success: false };
  };

  await background.keepAliveTick();

  assert.equal(loginCalls, 0);
  assert.equal(requests.some((url) => url.searchParams.has("user_password")), false);
});
