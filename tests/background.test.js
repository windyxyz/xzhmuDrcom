"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function loadBackground(options = {}) {
  const listeners = {
    installed: [],
    message: [],
    startup: [],
    alarm: [],
    tabUpdated: []
  };
  const event = (name) => ({
    addListener(listener) {
      listeners[name].push(listener);
    }
  });
  const createdTabs = [];
  const updatedTabs = [];
  const localStore = options.localStore || {};
  const sessionStore = options.sessionStore || {};
  const alarms = options.alarms || {};
  const createdAlarms = [];
  const badgeUpdates = [];
  const storageAccessLevels = [];
  const registeredContentScripts = [];
  const grantedOrigins = new Set(options.grantedOrigins || []);
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
    chrome: {
      action: {
        async setBadgeBackgroundColor(options) {
          badgeUpdates.push({ type: "color", options });
        },
        async setBadgeText(options) {
          badgeUpdates.push({ type: "text", options });
        },
        async setTitle(options) {
          badgeUpdates.push({ type: "title", options });
        }
      },
      alarms: {
        clear: async (name) => {
          const existed = Boolean(alarms[name]);
          delete alarms[name];
          return existed;
        },
        create(name, info) {
          alarms[name] = { name, ...info };
          createdAlarms.push({ name, ...info });
        },
        get: async (name) => alarms[name] || null,
        onAlarm: event("alarm")
      },
      runtime: {
        getURL: (path) => `chrome-extension://test/${path}`,
        lastError: null,
        onInstalled: event("installed"),
        onMessage: event("message"),
        onStartup: event("startup")
      },
      permissions: {
        async contains(request) {
          return (request.origins || []).every((origin) => grantedOrigins.has(origin));
        }
      },
      scripting: {
        async getRegisteredContentScripts(filter = {}) {
          const ids = filter.ids || [];
          return structuredClone(ids.length
            ? registeredContentScripts.filter((script) => ids.includes(script.id))
            : registeredContentScripts);
        },
        async registerContentScripts(scripts) {
          registeredContentScripts.push(...structuredClone(scripts));
        },
        async unregisterContentScripts(filter = {}) {
          const ids = new Set(filter.ids || []);
          for (let index = registeredContentScripts.length - 1; index >= 0; index -= 1) {
            if (!ids.size || ids.has(registeredContentScripts[index].id)) {
              registeredContentScripts.splice(index, 1);
            }
          }
        }
      },
      storage: {
        local: {
          get: async (keys) => {
            if (!keys) return structuredClone(localStore);
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => key in localStore).map((key) => [key, structuredClone(localStore[key])]));
          },
          set: async (patch) => {
            Object.assign(localStore, structuredClone(patch));
          },
          setAccessLevel: async (options) => {
            storageAccessLevels.push(structuredClone(options));
          },
          getBytesInUse: async () => 0
        },
        session: {
          get: async (keys) => {
            if (!keys) return structuredClone(sessionStore);
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => key in sessionStore).map((key) => [key, structuredClone(sessionStore[key])]));
          },
          set: async (patch) => {
            Object.assign(sessionStore, structuredClone(patch));
          }
        }
      },
      tabs: {
        create(options) {
          createdTabs.push(options);
        },
        onUpdated: event("tabUpdated"),
        update(tabId, options, callback) {
          updatedTabs.push({ tabId, options });
          if (callback) callback();
        }
      }
    },
    __alarms: alarms,
    __badgeUpdates: badgeUpdates,
    __createdAlarms: createdAlarms,
    __createdTabs: createdTabs,
    __listeners: listeners,
    __localStore: localStore,
    __registeredContentScripts: registeredContentScripts,
    __sessionStore: sessionStore,
    __storageAccessLevels: storageAccessLevels,
    __updatedTabs: updatedTabs
  });

  const source = readFileSync(join(__dirname, "..", "CRX", "background.js"), "utf8");
  new vm.Script(source, { filename: "background.js" }).runInContext(context);
  return context;
}

test("首次安装会打开欢迎页，扩展更新不会重复打开", async () => {
  const background = loadBackground();
  const [onInstalled] = background.__listeners.installed;

  await onInstalled({ reason: "install" });
  assert.deepEqual(JSON.parse(JSON.stringify(background.__createdTabs)), [
    { url: "chrome-extension://test/welcome.html" }
  ]);

  background.__createdTabs.length = 0;
  await onInstalled({ reason: "update" });
  assert.deepEqual(JSON.parse(JSON.stringify(background.__createdTabs)), []);
});

test("门户内容脚本只能读取非敏感界面配置", async () => {
  const background = loadBackground();
  background.getState = async () => ({
    accounts: [account()],
    config: {
      apiUrl: "http://10.10.10.2:801/eportal/",
      network: { wlanUserIp: "10.0.0.8" },
      ui: {
        modernizePortal: true,
        title: "徐医校园网",
        accent: "#0f766e",
        theme: "light",
        background: "custom",
        backgroundImage: "data:image/webp;base64,AAAA",
        backgroundBlur: 18,
        backgroundDim: 0.46,
        backgroundScale: 1.06
      }
    }
  });

  const result = await background.handleMessage(
    { action: "portal:config:get" },
    { url: "http://10.10.10.2/" }
  );
  const plain = JSON.parse(JSON.stringify(result));

  assert.deepEqual(plain, {
    ok: true,
    portal: {
      enabled: true,
      title: "徐医校园网",
      appearance: {
        theme: "light",
        accent: "#0f766e",
        background: "custom",
        backgroundImage: "data:image/webp;base64,AAAA",
        backgroundBlur: 18,
        backgroundDim: 0.46,
        backgroundScale: 1.06
      }
    }
  });
  assert.doesNotMatch(JSON.stringify(plain), /accounts|password|apiUrl|wlanUserIp/);
});

test("旧版本配置升级后默认启用可恢复的门户接管", () => {
  const background = loadBackground();
  const normalized = background.normalizeState({
    schemaVersion: 9,
    config: {
      ui: {
        modernizePortal: false,
        hideOriginalPortal: false,
        accent: "#14b8a6"
      }
    }
  });

  assert.equal(normalized.schemaVersion, 11);
  assert.equal(normalized.config.ui.modernizePortal, true);
  assert.equal(normalized.config.ui.hideOriginalPortal, true);
  assert.equal(normalized.config.ui.accent, "#007aff");
  assert.equal(normalized.config.ui.theme, "system");
  assert.equal(normalized.config.ui.backgroundBlur, 14);
  assert.equal(normalized.config.ui.backgroundDim, 0.42);
  assert.equal(normalized.config.ui.backgroundScale, 1.04);
});

function account(overrides = {}) {
  return {
    id: "account-1",
    label: "测试账号",
    username: "202513010318",
    suffix: "@telecom",
    password: "secret",
    network: {
      wlanUserIp: "10.0.0.8",
      wlanUserIpv6: "",
      wlanUserMac: "001122334455",
      wlanAcIp: "",
      wlanAcName: ""
    },
    note: "",
    updatedAt: "2026-01-02T03:04:05.000Z",
    ...overrides
  };
}

test("账号规范化不会在读取时改写更新时间", () => {
  const background = loadBackground();
  const normalized = background.sanitizeAccount(account());
  assert.equal(normalized.updatedAt, "2026-01-02T03:04:05.000Z");
});

test("陌生抓包账号不会污染当前选中账号的网络参数", async () => {
  const background = loadBackground();
  const state = {
    selectedAccountId: "account-1",
    accounts: [account()]
  };
  let persisted = null;
  background.getState = async () => structuredClone(state);
  background.setState = async (nextState) => {
    persisted = structuredClone(nextState);
    return nextState;
  };

  const result = await background.updateAccountNetwork("other@telecom", {
    wlanUserIp: "10.0.0.99"
  });

  assert.equal(result.ok, false);
  assert.equal(result.state.accounts[0].network.wlanUserIp, "10.0.0.8");
  assert.equal(persisted, null);
});

test("匹配账号仍可更新抓包网络参数", async () => {
  const background = loadBackground();
  const state = {
    selectedAccountId: "account-1",
    accounts: [account()]
  };
  let persisted = null;
  background.getState = async () => structuredClone(state);
  background.setState = async (nextState) => {
    persisted = structuredClone(nextState);
    return nextState;
  };

  const result = await background.updateAccountNetwork("202513010318@telecom", {
    wlanUserIp: "10.0.0.9"
  });

  assert.equal(result.ok, true);
  assert.equal(persisted.accounts[0].network.wlanUserIp, "10.0.0.9");
});

test("网页内容脚本不能读取完整扩展状态", async () => {
  const background = loadBackground();
  background.getState = async () => ({ accounts: [account()] });

  await assert.rejects(
    background.handleMessage(
      { action: "state:get" },
      { url: "http://10.10.10.2/" }
    ),
    /不能读取完整扩展状态/
  );
});

test("网页内容脚本不能执行设置页专属的破坏性操作", async () => {
  const background = loadBackground();
  const sender = { url: "http://10.10.10.2/" };

  for (const action of ["account:delete", "account:select", "requestLog:clear", "config:save", "config:reset"]) {
    await assert.rejects(
      background.handleMessage({ action, accountId: "account-1", config: {} }, sender),
      /无权执行此操作/
    );
  }
});

test("请求记录会脱敏 URL、消息和原始返回文本", () => {
  const background = loadBackground();
  const record = background.sanitizeRequestRecord({
    kind: "login",
    message: "user_account=,0,202513010318@telecom user_password=secret",
    raw: '{"user_account":",0,202513010318@telecom","user_password":"secret"}',
    url: "http://10.10.10.2:801/eportal/?user_account=%2C0%2C202513010318%40telecom&user_password=secret"
  });
  const serialized = JSON.stringify(record);

  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /202513010318/);
  assert.match(serialized, /\*\*\*\*/);
});

test("同一账号的并发登录只执行一次真实任务", async () => {
  const background = loadBackground();
  let attempts = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const task = async () => {
    attempts += 1;
    await waiting;
    return { success: true };
  };

  const first = background.runLoginSingleFlight("account-1", task);
  const second = background.runLoginSingleFlight("account-1", task);
  release();

  assert.deepEqual(await first, { success: true });
  assert.deepEqual(await second, { success: true });
  assert.equal(attempts, 1);
});

test("自动重试会指数退避并限制最大等待时间", () => {
  const background = loadBackground();
  assert.equal(background.calculateRetryDelay(1, 0), 30000);
  assert.equal(background.calculateRetryDelay(2, 0), 60000);
  assert.equal(background.calculateRetryDelay(20, 0), 300000);
  assert.equal(background.calculateRetryDelay(1, 1), 36000);
});

test("密码错误被识别为需要人工处理而不是自动重试", () => {
  const background = loadBackground();
  const classified = JSON.parse(JSON.stringify(background.classifyLoginFailure({
    success: false,
    message: "密码错误或密钥失效"
  })));

  assert.deepEqual(classified, {
    category: "credentials",
    retryable: false,
    action: "请检查账号、运营商后缀和认证密码。"
  });
});

test("后台重启后仍能从 session 恢复短时间跳转保护", async () => {
  const sessionStore = {};
  const firstWorker = loadBackground({ sessionStore });
  firstWorker.getState = async () => ({
    config: {
      portalUrl: "http://10.10.10.2/",
      redirect: { returnToPortal: true, guardSeconds: 4 }
    }
  });
  await firstWorker.markSenderTab({ tab: { id: 7 } });

  const restartedWorker = loadBackground({ sessionStore });
  restartedWorker.getState = firstWorker.getState;
  await restartedWorker.handleTabRedirect(7, "https://example.com/");

  assert.deepEqual(JSON.parse(JSON.stringify(restartedWorker.__updatedTabs)), [
    { tabId: 7, options: { url: "http://10.10.10.2/?drcom_kept=1" } }
  ]);
});

test("保活任务已经匹配配置时不会清除并重复创建", async () => {
  const alarms = {
    "drcomAssistant.keepAlive": {
      name: "drcomAssistant.keepAlive",
      periodInMinutes: 3
    }
  };
  const background = loadBackground({ alarms });

  await background.setupAutomation({
    config: { automation: { keepAlive: true, intervalMinutes: 3 } }
  });

  assert.equal(background.__createdAlarms.length, 0);
  assert.equal(background.__alarms["drcomAssistant.keepAlive"].periodInMinutes, 3);
});

test("扩展状态接近 storage.local 上限时会在写入前拒绝", () => {
  const background = loadBackground();
  assert.throws(
    () => background.assertStateStorageBudget({ image: "A".repeat(9 * 1024 * 1024) }),
    /存储空间不足/
  );
});

test("临时网络失败会写入等待状态并安排一次性重试", async () => {
  const background = loadBackground();
  const result = await background.recordLoginOutcome(
    { success: false, online: false, message: "请求失败：网络不可达" },
    { now: 1000, randomValue: 0 }
  );

  assert.equal(result.phase, "waiting");
  assert.equal(result.retryable, true);
  assert.equal(result.retryAt, 31000);
  assert.equal(background.__alarms["drcomAssistant.retry"].when, 31000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.__sessionStore.drcomAssistantSession.connection)),
    {
      phase: "waiting",
      attempt: 1,
      nextRetryAt: 31000,
      blocked: false,
      message: "请求失败：网络不可达",
      updatedAt: 1000
    }
  );
});

test("凭据错误会进入人工处理状态且不安排重试", async () => {
  const background = loadBackground();
  const result = await background.recordLoginOutcome(
    { success: false, online: false, message: "密码错误或密钥失效" },
    { now: 2000, randomValue: 0 }
  );

  assert.equal(result.phase, "action_required");
  assert.equal(result.retryable, false);
  assert.equal(result.retryAt, 0);
  assert.equal(background.__alarms["drcomAssistant.retry"], undefined);
  assert.equal(background.__sessionStore.drcomAssistantSession.connection.blocked, true);
});

test("自动登录在退避时间到达前会跳过，到达后恢复", () => {
  const background = loadBackground();
  const runtime = {
    phase: "waiting",
    blocked: false,
    nextRetryAt: 5000
  };

  assert.equal(background.canAttemptAutomaticLogin(runtime, 4999), false);
  assert.equal(background.canAttemptAutomaticLogin(runtime, 5000), true);
  assert.equal(background.canAttemptAutomaticLogin({ ...runtime, blocked: true }, 9999), false);
});

test("浏览器启动登录使用自动模式并遵守退避状态", async () => {
  const background = loadBackground();
  let invocation = null;
  background.getState = async () => ({
    selectedAccountId: "account-1",
    config: {
      automation: {
        keepAlive: true,
        intervalMinutes: 3,
        loginOnStartup: true
      }
    }
  });
  background.loginSelectedAccount = async (reason, options) => {
    invocation = { reason, options };
    return { success: true };
  };

  await background.__listeners.startup[0]();

  assert.deepEqual(JSON.parse(JSON.stringify(invocation)), {
    reason: "浏览器启动自动登录",
    options: { automatic: true }
  });
});

test("状态检测确认在线后会清除退避并恢复在线状态", async () => {
  const sessionStore = {
    drcomAssistantSession: {
      guards: {},
      connection: {
        phase: "waiting",
        attempt: 3,
        nextRetryAt: 999999,
        blocked: false,
        message: "等待重试",
        updatedAt: 100
      }
    }
  };
  const background = loadBackground({
    sessionStore,
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        return '<button name="logout">下线</button>';
      }
    })
  });
  background.getState = async () => ({
    recentRequests: [],
    config: { portalUrl: "http://10.10.10.2/" }
  });
  background.addRequestRecord = async () => undefined;

  const result = await background.checkStatus();

  assert.equal(result.online, true);
  assert.equal(result.phase, "online");
  assert.equal(sessionStore.drcomAssistantSession.connection.attempt, 0);
  assert.equal(sessionStore.drcomAssistantSession.connection.nextRetryAt, 0);
});

test("不同入口同时触发登录时也只发送一个 DrCOM 请求", async () => {
  let requests = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const background = loadBackground({
    fetch: async () => {
      requests += 1;
      await waiting;
      return {
        ok: true,
        status: 200,
        async text() {
          return '{"result":"1","msg":"success"}';
        }
      };
    }
  });
  background.getState = async () => ({
    selectedAccountId: "account-1",
    accounts: [
      account(),
      account({ id: "account-2", username: "202513010319" })
    ],
    recentRequests: [],
    config: {
      apiUrl: "http://10.10.10.2:801/eportal/",
      login: {
        accountPrefix: ",0,",
        callbackPrefix: "dr",
        loginMethod: "1",
        jsVersion: "3.3.2",
        findMacBeforeLogin: false
      },
      network: {
        wlanUserIp: "",
        wlanUserIpv6: "",
        wlanUserMac: "000000000000",
        wlanAcIp: "",
        wlanAcName: ""
      }
    }
  });
  background.addRequestRecord = async () => undefined;

  const first = background.loginAccount("account-1", null);
  const second = background.loginAccount("account-2", null);
  await Promise.resolve();
  await Promise.resolve();
  release();
  await Promise.all([first, second]);

  assert.equal(requests, 1);
});

test("明确失败的登录与下线响应不会因为出现 success 或 logout 字样被误判", () => {
  const background = loadBackground();
  const login = background.normalizeDrcomResult(
    "login",
    200,
    { success: false, message: "password error" },
    '{"success":false,"message":"password error"}'
  );
  const logout = background.normalizeDrcomResult(
    "logout",
    200,
    { result: "0", message: "logout failed" },
    '{"result":"0","message":"logout failed"}'
  );

  assert.equal(login.success, false);
  assert.equal(logout.success, false);
});

test("普通英文错误文本不会被误当作 Base64 解码", () => {
  const background = loadBackground();
  assert.equal(background.decodeMessage("fail"), "fail");
  assert.equal(background.decodeMessage("test"), "test");
});

test("账号保存与请求记录并发写入时不会互相覆盖", async () => {
  const localStore = {
    drcomAssistantState: {
      schemaVersion: 11,
      selectedAccountId: "account-1",
      accounts: [account()],
      recentRequests: []
    }
  };
  const background = loadBackground({ localStore });

  await Promise.all([
    background.saveAccount(account({ id: "account-2", username: "202513010319" })),
    background.addRequestRecord({ kind: "status", online: false, message: "需要登录" })
  ]);

  const saved = localStore.drcomAssistantState;
  assert.equal(saved.accounts.some((item) => item.id === "account-2"), true);
  assert.equal(saved.recentRequests.length, 1);
});

test("标签页保护与连接状态并发写入时都会保留", async () => {
  const sessionStore = {};
  const background = loadBackground({ sessionStore });

  await Promise.all([
    background.setTabGuard(7, { until: 12345 }),
    background.setConnectionState({ phase: "waiting", attempt: 2 })
  ]);

  const saved = sessionStore.drcomAssistantSession;
  assert.deepEqual(JSON.parse(JSON.stringify(saved.guards)), { "7": { until: 12345 } });
  assert.equal(saved.connection.phase, "waiting");
  assert.equal(saved.connection.attempt, 2);
});

test("自定义网关地址会保留并清除 URL 中的凭据与片段", () => {
  const background = loadBackground();
  const normalized = background.normalizeState({
    schemaVersion: 11,
    config: {
      portalUrl: "https://admin:secret@gateway.example/login#panel",
      apiUrl: "http://gateway.example:801/eportal/#debug"
    }
  });

  assert.equal(normalized.config.portalUrl, "https://gateway.example/login");
  assert.equal(normalized.config.apiUrl, "http://gateway.example:801/eportal/");
  assert.equal(background.normalizeUrl("file:///tmp/login", "http://10.10.10.2/"), "http://10.10.10.2/");
});

test("保存自定义门户后会为已授权来源注册现代认证内容脚本", async () => {
  const background = loadBackground({
    grantedOrigins: ["http://192.168.8.1/*"]
  });

  await background.saveConfig({
    portalUrl: "http://192.168.8.1/login",
    apiUrl: "http://192.168.8.1:801/eportal/",
    ui: { modernizePortal: true }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(background.__registeredContentScripts)), [{
    id: "drcom-custom-portal",
    matches: ["http://192.168.8.1/*"],
    css: ["design-tokens.css", "portal.css"],
    js: ["appearance.js", "portal-ui.js", "portal-modernizer.js"],
    runAt: "document_start",
    persistAcrossSessions: true
  }]);
});

test("后台启动时把包含密码的本地存储限制为可信扩展上下文", async () => {
  const background = loadBackground();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(background.__storageAccessLevels)), [
    { accessLevel: "TRUSTED_CONTEXTS" }
  ]);
});

test("带标点的引号密码会被完整脱敏", () => {
  const background = loadBackground();
  const redacted = background.redactSensitiveText(
    '{"password":"abc,def;ghi","user_account":",0,202513010318@telecom"}'
  );

  assert.doesNotMatch(redacted, /abc|def|ghi|202513010318/);
  assert.match(redacted, /\*\*\*\*\*\*/);
});

test("流量或余额异常会暂停自动重试并提示人工处理", () => {
  const background = loadBackground();
  const failure = JSON.parse(JSON.stringify(background.classifyLoginFailure({
    message: "流量已用尽或账号余额不足"
  })));

  assert.equal(failure.retryable, false);
  assert.equal(failure.category, "account");
});
