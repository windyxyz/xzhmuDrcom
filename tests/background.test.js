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
  const openedOptions = [];
  const localStore = options.localStore || {};
  const localWrites = [];
  const sessionStore = options.sessionStore || {};
  const alarms = options.alarms || {};
  const createdAlarms = [];
  const badgeUpdates = [];
  const storageAccessLevels = [];
  const warnings = [];
  const registeredContentScripts = [];
  const removedLocalKeys = [];
  const grantedOrigins = new Set(options.grantedOrigins || []);
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    atob,
    clearTimeout,
    console: { ...console, warn(...args) { warnings.push(args.map(String).join(" ")); } },
    crypto: options.crypto || webcrypto,
    fetch: options.fetch || fetch,
    JSON: options.JSON || JSON,
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
        id: "test-extension-id",
        getURL: (path) => `chrome-extension://test/${path}`,
        lastError: null,
        onInstalled: event("installed"),
        onMessage: event("message"),
        onStartup: event("startup"),
        async openOptionsPage() {
          openedOptions.push(true);
        }
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
            if (options.localSetError) throw options.localSetError;
            localWrites.push(structuredClone(patch));
            Object.assign(localStore, structuredClone(patch));
          },
          remove: async (keys) => {
            const names = Array.isArray(keys) ? keys : [keys];
            for (const key of names) {
              removedLocalKeys.push(key);
              delete localStore[key];
            }
          },
          setAccessLevel: async (accessOptions) => {
            storageAccessLevels.push({ area: "local", ...structuredClone(accessOptions) });
            if (typeof options.localAccessGate === "function") await options.localAccessGate();
          },
          getBytesInUse: async (keys) => {
            if (typeof options.bytesInUse === "function") return options.bytesInUse(keys, localStore);
            if (Number.isFinite(options.bytesInUse)) return options.bytesInUse;
            const selected = keys
              ? Object.fromEntries((Array.isArray(keys) ? keys : [keys])
                .filter((key) => key in localStore)
                .map((key) => [key, localStore[key]]))
              : localStore;
            return new TextEncoder().encode(JSON.stringify(selected)).byteLength;
          }
        },
        session: {
          get: async (keys) => {
            if (!keys) return structuredClone(sessionStore);
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => key in sessionStore).map((key) => [key, structuredClone(sessionStore[key])]));
          },
          set: async (patch) => {
            Object.assign(sessionStore, structuredClone(patch));
          },
          remove: async (keys) => {
            const names = Array.isArray(keys) ? keys : [keys];
            for (const key of names) delete sessionStore[key];
          },
          setAccessLevel: async (accessOptions) => {
            storageAccessLevels.push({ area: "session", ...structuredClone(accessOptions) });
            if (typeof options.sessionAccessGate === "function") await options.sessionAccessGate();
          }
        }
      },
      tabs: {
        async get(tabId) {
          const configured = options.currentTabs && options.currentTabs[tabId];
          return structuredClone(configured || { id: tabId, url: "http://10.10.10.2/" });
        },
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
    __localWrites: localWrites,
    __openedOptions: openedOptions,
    __registeredContentScripts: registeredContentScripts,
    __removedLocalKeys: removedLocalKeys,
    __sessionStore: sessionStore,
    __storageAccessLevels: storageAccessLevels,
    __updatedTabs: updatedTabs,
    __warnings: warnings
  });

  context.importScripts = (...paths) => {
    for (const path of paths) {
      const source = readFileSync(join(__dirname, "..", "CRX", path), "utf8");
      new vm.Script(source, { filename: path }).runInContext(context);
    }
  };

  const source = readFileSync(join(__dirname, "..", "CRX", "background.js"), "utf8");
  new vm.Script(source, { filename: "background.js" }).runInContext(context);
  return context;
}

function portalSender(overrides = {}) {
  return {
    id: "test-extension-id",
    frameId: 0,
    origin: "http://10.10.10.2",
    url: "http://10.10.10.2/",
    ...overrides,
    tab: {
      id: 1,
      url: "http://10.10.10.2/",
      ...(overrides.tab || {})
    }
  };
}

test("后台入口只负责依赖加载和事件注册", () => {
  const source = readFileSync(join(__dirname, "..", "CRX", "background.js"), "utf8");
  const modulePaths = [
    'portal-session.js',
    "portal-diagnostics-utils.js",
    "background/state-store.js",
    "background/response-reader.js",
    "background/diagnostics-service.js",
    "background/portal-context.js",
    "background/drcom-client.js",
    "background/account-service.js",
    "background/connection-service.js",
    "background/wallpaper-service.js",
    "background/portal-service.js",
    "background/message-router.js"
  ];

  assert.match(source, /importScripts\(/);
  assert.ok(source.split(/\r?\n/).length < 100);
  for (const modulePath of modulePaths) {
    assert.match(source, new RegExp(modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotThrow(() => readFileSync(join(__dirname, "..", "CRX", modulePath), "utf8"));
  }
});
test('在线状态结果携带脱敏会话摘要', async () => {
  const payload = JSON.stringify({
    result: '1',
    uid: 'student-account@telecom',
    time: '125',
    flow: '1234567',
    flow_in: '500000',
    flow_out: '734567',
    fee: '123456',
    login_time: '1769990400',
    xip: '192.0.2.202',
    wlan_user_ip: '192.0.2.3',
    wlan_user_ipv6: '2001:db8::1',
    wlan_user_mac: '02-00-00-00-00-03',
    wlan_vlan_id: '123',
    wlan_ac_ip: '192.0.2.2',
    wlan_ac_name: 'campus-ac'
  });
  const background = loadBackground({
    fetch: async () => ({ ok: true, status: 200, async text() { return 'dr1001(' + payload + ')'; } })
  });
  const result = await background.queryPortalSessionStatus({
    portalUrl: 'http://10.10.10.2/',
    login: { callbackPrefix: 'dr' }
  });

  assert.equal(result.state, 'online');
  assert.deepEqual(JSON.parse(JSON.stringify(result.session)), {
    account: 'st***nt',
    usedMinutes: 125,
    totalKilobytes: 1234567,
    uploadKilobytes: 500000,
    downloadKilobytes: 734567,
    balanceYuan: 12.34,
    loginAt: 1769990400000,
    externalIp: '192.***.***.202',
    network: {
      ipv4: '192.***.***.3',
      ipv6: '2001:***::***:1',
      mac: '02:00:00:**:**:**',
      vlan: '123',
      acIp: '192.***.***.2',
      acName: 'campus-ac'
    }
  });
  assert.doesNotMatch(JSON.stringify(result), /student-account|192\.0\.2\.|02-00-00-00-00-03/);
});

test('portal:status:get 只向可信顶层门户返回裁剪后的状态和会话摘要', async () => {
  const payload = JSON.stringify({
    result: '1',
    uid: 'private-student@telecom',
    time: '45',
    flow: '2048',
    xip: '192.0.2.99',
    wlan_user_ip: '192.0.2.3',
    wlan_user_mac: '02-00-00-00-00-03'
  });
  const background = loadBackground({
    fetch: async () => ({ ok: true, status: 200, async text() { return 'dr1001(' + payload + ')'; } })
  });

  const result = JSON.parse(JSON.stringify(await background.handleMessage(
    { action: 'portal:status:get' },
    portalSender()
  )));

  assert.equal(result.state, 'online');
  assert.equal(result.phase, 'online');
  assert.equal(typeof result.checkedAt, 'number');
  assert.deepEqual(result.session, {
    account: 'pr***nt',
    usedMinutes: 45,
    totalKilobytes: 2048,
    externalIp: '192.***.***.99',
    network: {
      ipv4: '192.***.***.3',
      mac: '02:00:00:**:**:**'
    }
  });
  assert.deepEqual(Object.keys(result).sort(), ['checkedAt', 'message', 'phase', 'session', 'state']);
  assert.doesNotMatch(JSON.stringify(result), /private-student|192\.0\.2\.|02-00-00-00-00-03|raw|diagnostic|statusCode|url/);
});

test('portal:status:get 拒绝 iframe、伪造来源和已经离开门户的标签', async () => {
  const invalid = [
    { background: loadBackground(), sender: portalSender({ frameId: 1 }) },
    { background: loadBackground(), sender: portalSender({ origin: 'http://evil.example', url: 'http://evil.example/' }) },
    {
      background: loadBackground({ currentTabs: { 1: { id: 1, url: 'http://example.com/' } } }),
      sender: portalSender()
    }
  ];

  for (const item of invalid) {
    await assert.rejects(
      item.background.handleMessage({ action: 'portal:status:get' }, item.sender),
      /来源|顶层|门户|标签页/
    );
  }
});

test('已配置门户的来源与默认门户共享网页消息信任边界', async () => {
  const background = loadBackground({
    localStore: {
      drcomAssistantState: {
        schemaVersion: 12,
        config: { portalUrl: 'http://portal.example.com/' }
      }
    },
    currentTabs: { 1: { id: 1, url: 'http://portal.example.com/' } }
  });
  const sender = portalSender({
    origin: 'http://portal.example.com',
    url: 'http://portal.example.com/',
    tab: { url: 'http://portal.example.com/' }
  });

  const result = await background.handleMessage({ action: 'portal:config:get' }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.portal.portalUrl, 'http://portal.example.com/');
});

test('未配置门户时其他来源仍被拒绝', async () => {
  const background = loadBackground({
    currentTabs: { 1: { id: 1, url: 'http://portal.example.com/' } }
  });
  await assert.rejects(
    background.handleMessage(
      { action: 'portal:config:get' },
      portalSender({ origin: 'http://portal.example.com', url: 'http://portal.example.com/', tab: { url: 'http://portal.example.com/' } })
    ),
    /门户/
  );
});

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

test("门户安全配置不携带背景数据且专用外观接口单独返回完整配置", async () => {
  const background = loadBackground();
  background.getState = async () => ({
    accounts: [account()],
    config: {
      apiUrl: "http://10.10.10.2:801/eportal/",
      network: { wlanUserIp: "10.0.0.8" },
      ui: {
        modernizePortal: true,
        onlineDetailMode: "full",
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
    portalSender()
  );
  const plain = JSON.parse(JSON.stringify(result));
  const appearanceResult = JSON.parse(JSON.stringify(await background.handleMessage(
    { action: "portal:appearance:get" },
    portalSender()
  )));

  assert.deepEqual(plain, {
    ok: true,
    portal: {
      enabled: true,
      title: "徐医校园网",
      onlineDetailMode: "full",
      appearance: {
        theme: "light",
        accent: "#0f766e"
      }
    }
  });
  assert.deepEqual(appearanceResult, {
    ok: true,
    appearance: {
      theme: "light",
      accent: "#0f766e",
      background: "custom",
      backgroundImage: "data:image/webp;base64,AAAA",
        backgroundBlur: 18,
        backgroundDim: 0.46,
        backgroundScale: 1.06,
        backgroundPosition: "center",
        panelColor: "",
        panelPattern: "grid",
        scrimStrength: 1
    }
  });
  assert.doesNotMatch(JSON.stringify(plain), /accounts|password|apiUrl|wlanUserIp/);
  assert.doesNotMatch(JSON.stringify(plain), /data:image|backgroundImage/);
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

  assert.equal(normalized.schemaVersion, 13);
  assert.equal(normalized.config.ui.modernizePortal, true);
  assert.equal(normalized.config.ui.onlineDetailMode, "classic");
  assert.equal(normalized.config.ui.autoRefreshSettings, true);
  assert.equal("hideOriginalPortal" in normalized.config.ui, false);
  assert.equal("subtitle" in normalized.config.ui, false);
  assert.equal("density" in normalized.config.ui, false);
  assert.equal(normalized.config.ui.accent, "#007aff");
  assert.equal(normalized.config.ui.theme, "system");
  assert.equal(normalized.config.ui.backgroundBlur, 14);
  assert.equal(normalized.config.ui.backgroundDim, 0.42);
  assert.equal(normalized.config.ui.backgroundScale, 1.04);

  const invalidMode = background.normalizeState({
    schemaVersion: 12,
    config: { ui: { onlineDetailMode: "unsupported" } }
  });
  assert.equal(invalidMode.config.ui.onlineDetailMode, "classic");

  const disabledRefresh = background.normalizeState({
    schemaVersion: 12,
    config: { ui: { autoRefreshSettings: false } }
  });
  assert.equal(disabledRefresh.config.ui.autoRefreshSettings, false);
});

test("schema 12 会清理历史无效账号与 UI 字段并幂等写回", async () => {
  const localStore = {
    drcomAssistantState: {
      schemaVersion: 12,
      selectedAccountId: "account-1",
      accounts: [account({ note: "旧备注" })],
      config: {
        ui: {
          modernizePortal: true,
          hideOriginalPortal: false,
          subtitle: "旧副标题",
          density: "compact"
        }
      }
    }
  };
  const background = loadBackground({ localStore });

  const first = await background.getState();
  const persistedAfterFirstRead = JSON.stringify(localStore.drcomAssistantState);
  const second = await background.getState();

  assert.equal("note" in first.accounts[0], false);
  assert.equal("hideOriginalPortal" in first.config.ui, false);
  assert.equal("subtitle" in first.config.ui, false);
  assert.equal("density" in first.config.ui, false);
  assert.equal("note" in localStore.drcomAssistantState.accounts[0], false);
  assert.equal("hideOriginalPortal" in localStore.drcomAssistantState.config.ui, false);
  assert.equal(JSON.stringify(localStore.drcomAssistantState), persistedAfterFirstRead);
  const secondMain = JSON.parse(JSON.stringify(second));
  delete secondMain.recentRequests;
  assert.deepEqual(secondMain, JSON.parse(persistedAfterFirstRead));
  assert.deepEqual(JSON.parse(JSON.stringify(second.recentRequests)), []);
});

test("schema 13 将请求记录迁移到独立键且主状态不再保留旧字段", async () => {
  const localStore = {
    drcomAssistantState: {
      schemaVersion: 12,
      selectedAccountId: "account-1",
      accounts: [account()],
      recentRequests: [
        { kind: "login", message: "first" },
        { kind: "logout", message: "second" }
      ]
    }
  };
  const background = loadBackground({ localStore });

  const first = await background.getState();
  const second = await background.getState();

  assert.equal(first.schemaVersion, 13);
  assert.deepEqual(JSON.parse(JSON.stringify(first.recentRequests.map((record) => record.kind))), ["login", "logout"]);
  assert.deepEqual(JSON.parse(JSON.stringify(second.recentRequests.map((record) => record.kind))), ["login", "logout"]);
  assert.deepEqual(JSON.parse(JSON.stringify(localStore.drcomAssistantRecentRequests.map((record) => record.kind))), ["login", "logout"]);
  assert.equal("recentRequests" in localStore.drcomAssistantState, false);
  assert.equal(localStore.drcomAssistantState.schemaVersion, 13);
  assert.equal(background.__localWrites.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(background.__localWrites[0]))), ["drcomAssistantRecentRequests"]);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(background.__localWrites[1]))), ["drcomAssistantState"]);
});

test("schema 13 请求记录迁移写入失败时不删除主状态旧日志", async () => {
  const localStore = {
    drcomAssistantState: {
      schemaVersion: 12,
      selectedAccountId: "account-1",
      accounts: [account()],
      recentRequests: [{ kind: "login", message: "kept" }]
    }
  };
  const background = loadBackground({ localStore, localSetError: new Error("写入失败") });

  await assert.rejects(background.getState(), /写入失败/);

  assert.equal(localStore.drcomAssistantState.schemaVersion, 12);
  assert.equal(localStore.drcomAssistantState.recentRequests.length, 1);
  assert.equal(localStore.drcomAssistantRecentRequests, undefined);
});

test("新增请求记录只写独立日志键而不重写主状态", async () => {
  const background = loadBackground();
  const state = await background.getState();
  state.config.ui.backgroundImage = `data:image/jpeg;base64,${"a".repeat(1900000)}`;
  await background.setState(state);
  background.__localWrites.length = 0;

  await background.addRequestRecord({ kind: "login", message: "ok" });

  assert.deepEqual(background.__localWrites.map((patch) => Object.keys(patch)), [["drcomAssistantRecentRequests"]]);
  assert.equal(localStorageHasRecentRequests(background.__localStore.drcomAssistantState), false);
  assert.equal(background.__localStore.drcomAssistantRecentRequests.length, 1);
});

test("清空请求记录只写独立日志键且返回兼容状态", async () => {
  const background = loadBackground();
  const state = await background.getState();
  await background.setState({ ...state, recentRequests: [{ kind: "login", message: "old" }] });
  background.__localWrites.length = 0;

  const result = await background.clearRequestLog();

  assert.deepEqual(background.__localWrites.map((patch) => Object.keys(patch)), [["drcomAssistantRecentRequests"]]);
  assert.deepEqual(result.state.recentRequests, []);
  assert.deepEqual(background.__localStore.drcomAssistantRecentRequests, []);
  assert.equal(localStorageHasRecentRequests(background.__localStore.drcomAssistantState), false);
});

function localStorageHasRecentRequests(state) {
  return Boolean(state && Object.prototype.hasOwnProperty.call(state, "recentRequests"));
}
test("schema 12 迁移成功写回后删除旧顶层凭据且重复执行保持幂等", async () => {
  const localStore = { username: " legacy-user ", password: "legacy-secret" };
  const background = loadBackground({ localStore });

  const first = await background.getState();
  const firstAccountId = first.accounts[0].id;
  const second = await background.getState();

  assert.equal(first.schemaVersion, 13);
  assert.equal(first.accounts.length, 1);
  assert.equal(first.accounts[0].username, "legacy-user");
  assert.equal(second.accounts.length, 1);
  assert.equal(second.accounts[0].id, firstAccountId);
  assert.equal("username" in localStore, false);
  assert.equal("password" in localStore, false);
  assert.deepEqual(background.__removedLocalKeys, ["username", "password"]);
});

test("旧凭据迁移写回失败时不会提前删除源字段", async () => {
  const localStore = { username: "legacy-user", password: "legacy-secret" };
  const background = loadBackground({
    localStore,
    localSetError: new Error("模拟 storage.local 写入失败")
  });

  await assert.rejects(background.getState(), /写入失败/);

  assert.equal(localStore.username, "legacy-user");
  assert.equal(localStore.password, "legacy-secret");
  assert.deepEqual(background.__removedLocalKeys, []);
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
    updatedAt: "2026-01-02T03:04:05.000Z",
    ...overrides
  };
}

test("账号规范化不会在读取时改写更新时间", () => {
  const background = loadBackground();
  const normalized = background.sanitizeAccount(account());
  assert.equal(normalized.updatedAt, "2026-01-02T03:04:05.000Z");
});

test("保存相同自然键账号时更新原记录而不是新增重复项", async () => {
  const localStore = {
    drcomAssistantState: {
      schemaVersion: 11,
      selectedAccountId: "account-1",
      accounts: [account({ username: " Student ", suffix: "@TELECOM", password: "old-secret" })]
    }
  };
  const background = loadBackground({ localStore });
  const result = await background.saveAccount(account({
    id: "", label: "新标签", username: "Student@telecom", suffix: "", password: "new-secret"
  }));

  assert.equal(result.state.accounts.length, 1);
  assert.equal(result.account.id, "account-1");
  assert.equal(result.account.username, "Student");
  assert.equal(result.account.suffix, "@telecom");
  assert.equal(result.account.password, "new-secret");
  assert.equal(result.account.label, "新标签");
  assert.equal(result.state.selectedAccountId, "account-1");
});

test("账号自然键保留用户名大小写并区分不同运营商后缀", async () => {
  const localStore = {
    drcomAssistantState: {
      schemaVersion: 11,
      selectedAccountId: "account-1",
      accounts: [account({ username: "Student", suffix: "@telecom" })]
    }
  };
  const background = loadBackground({ localStore });

  await background.saveAccount(account({ id: "", username: "student", suffix: "@telecom" }));
  await background.saveAccount(account({ id: "", username: "Student", suffix: "@unicom" }));

  assert.equal(localStore.drcomAssistantState.accounts.length, 3);
});

test("迁移历史重复账号时优先保留选中 ID 并合并最近的非空字段", () => {
  const background = loadBackground();
  const normalized = background.normalizeState({
    schemaVersion: 11,
    selectedAccountId: "selected-old",
    accounts: [
      account({
        id: "selected-old",
        label: "旧标签",
        username: " 202513010318 ",
        suffix: "@TELECOM",
        password: "old-secret",
        network: { wlanUserIp: "10.0.0.8" },
        updatedAt: "2026-01-01T00:00:00.000Z"
      }),
      account({
        id: "recent-duplicate",
        label: "",
        username: "202513010318@telecom",
        suffix: "",
        password: "new-secret",
        network: { wlanUserIp: "", wlanUserMac: "aabbccddeeff" },
        updatedAt: "2026-02-01T00:00:00.000Z"
      })
    ]
  });

  assert.equal(normalized.accounts.length, 1);
  assert.equal(normalized.accounts[0].id, "selected-old");
  assert.equal(normalized.accounts[0].label, "旧标签");
  assert.equal(normalized.accounts[0].password, "new-secret");
  assert.equal(normalized.accounts[0].network.wlanUserIp, "10.0.0.8");
  assert.equal(normalized.accounts[0].network.wlanUserMac, "AABBCCDDEEFF");
  assert.equal(normalized.accounts[0].updatedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(normalized.selectedAccountId, "selected-old");
});

test("未选中历史重复账号时保留最近更新记录的 ID 并重映射选择", () => {
  const background = loadBackground();
  const normalized = background.normalizeState({
    schemaVersion: 11,
    selectedAccountId: "missing-id",
    accounts: [
      account({ id: "older", updatedAt: "2026-01-01T00:00:00.000Z" }),
      account({ id: "newer", updatedAt: "2026-03-01T00:00:00.000Z" })
    ]
  });

  assert.equal(normalized.accounts.length, 1);
  assert.equal(normalized.accounts[0].id, "newer");
  assert.equal(normalized.selectedAccountId, "newer");
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
      portalSender()
    ),
    /不能读取完整扩展状态/
  );
});

test("网页内容脚本不能执行设置页专属的破坏性操作", async () => {
  const background = loadBackground();
  const sender = portalSender();

  for (const action of ["account:delete", "account:select", "requestLog:clear", "config:save", "config:reset"]) {
    await assert.rejects(
      background.handleMessage({ action, accountId: "account-1", config: {} }, sender),
      /无权执行此操作/
    );
  }
});

test("网页内容脚本不能直接保存或覆盖持久账号", async () => {
  const original = account({ password: "trusted-secret" });
  const localStore = { drcomAssistantState: { schemaVersion: 12, selectedAccountId: original.id, accounts: [original] } };
  const background = loadBackground({ localStore });
  await assert.rejects(background.handleMessage({
    action: "account:save", account: account({ id: "", password: "attacker-secret" })
  }, portalSender()), /无权执行此操作/);
  assert.equal(localStore.drcomAssistantState.accounts[0].password, "trusted-secret");
  assert.equal(localStore.drcomAssistantState.selectedAccountId, original.id);
});

test("门户捕获只暂存五分钟且不覆盖持久账号或当前选择", async () => {
  const original = account({ password: "trusted-secret" });
  const localStore = { drcomAssistantState: { schemaVersion: 12, selectedAccountId: original.id, accounts: [original] } };
  const sessionStore = {};
  const background = loadBackground({ localStore, sessionStore });
  const before = Date.now();
  const result = JSON.parse(JSON.stringify(await background.handleMessage({
    action: "account:capture:stage", account: account({ id: "", password: "captured-secret" }), source: "script"
  }, portalSender())));
  assert.equal(result.ok, true);
  assert.equal(result.staged, true);
  assert.ok(result.expiresAt >= before + (5 * 60 * 1000) - 1000);
  assert.doesNotMatch(JSON.stringify(result), /captured-secret/);
  assert.equal(localStore.drcomAssistantState.accounts[0].password, "trusted-secret");
  assert.equal(localStore.drcomAssistantState.selectedAccountId, original.id);
  assert.match(JSON.stringify(sessionStore), /captured-secret/);
  assert.equal(background.__openedOptions.length, 1);
  const pending = JSON.parse(JSON.stringify(await background.handleMessage({ action: "account:capture:get" }, {
    id: "test-extension-id", url: "chrome-extension://test/options.html"
  })));
  assert.equal(pending.capture.maskedUsername, "20***18");
  assert.equal(pending.capture.sourceOrigin, "http://10.10.10.2");
  assert.equal(pending.capture.replacesExisting, true);
  assert.doesNotMatch(JSON.stringify(pending), /captured-secret/);
});

test("捕获确认只能由扩展页提交，丢弃或过期均不会保存", async () => {
  const localStore = {};
  const sessionStore = {};
  const background = loadBackground({ localStore, sessionStore });
  const staged = await background.handleMessage({
    action: "account:capture:stage", account: account({ id: "", password: "candidate-secret" }), source: "form"
  }, portalSender());
  await assert.rejects(
    background.handleMessage({ action: "account:capture:commit", captureId: staged.captureId }, portalSender()),
    /无权执行此操作/
  );
  assert.deepEqual(localStore.drcomAssistantState.accounts, []);
  assert.equal(localStore.drcomAssistantState.selectedAccountId, "");
  const extensionSender = { id: "test-extension-id", url: "chrome-extension://test/options.html" };
  const discarded = await background.handleMessage({ action: "account:capture:discard", captureId: staged.captureId }, extensionSender);
  assert.equal(discarded.ok, true);
  assert.equal((await background.handleMessage({ action: "account:capture:get" }, extensionSender)).capture, null);
  assert.deepEqual(localStore.drcomAssistantState.accounts, []);
  sessionStore.drcomAssistantSession = {
    guards: {}, connection: {},
    pendingAccountCapture: {
      id: "expired-capture", account: account({ password: "expired-secret" }),
      sourceOrigin: "http://10.10.10.2", createdAt: Date.now() - 400000, expiresAt: Date.now() - 1000
    }
  };
  const expired = await background.handleMessage({ action: "account:capture:get" }, extensionSender);
  assert.equal(expired.capture, null);
  await assert.rejects(
    background.handleMessage({ action: "account:capture:commit", captureId: "expired-capture" }, extensionSender),
    /过期|不存在/
  );
  assert.deepEqual(localStore.drcomAssistantState.accounts, []);
});

test("相同门户候选合并且三十秒内只打开一次设置页，确认后才保存", async () => {
  const localStore = {};
  const sessionStore = {};
  const background = loadBackground({ localStore, sessionStore });
  const sender = portalSender();
  const first = await background.handleMessage({
    action: "account:capture:stage", account: account({ id: "", password: "first-secret" }), source: "script"
  }, sender);
  const second = await background.handleMessage({
    action: "account:capture:stage", account: account({ id: "", password: "second-secret" }), source: "script"
  }, sender);
  assert.equal(second.captureId, first.captureId);
  assert.equal(background.__openedOptions.length, 1);
  const committed = await background.handleMessage({ action: "account:capture:commit", captureId: second.captureId }, {
    id: "test-extension-id", url: "chrome-extension://test/options.html"
  });
  assert.equal(committed.ok, true);
  assert.equal(localStore.drcomAssistantState.accounts.length, 1);
  assert.equal(localStore.drcomAssistantState.accounts[0].password, "second-secret");
});

test("网页消息只接受自身扩展顶层 frame 与当前门户标签", async () => {
  const invalidSenders = [
    portalSender({ id: "forged-extension" }),
    portalSender({ frameId: 1 }),
    portalSender({ origin: "https://10.10.10.2", url: "https://10.10.10.2/" }),
    portalSender({ origin: "http://evil.example", url: "http://evil.example/" }),
    portalSender({ tab: { id: null } })
  ];

  for (const sender of invalidSenders) {
    const background = loadBackground();
    await assert.rejects(
      background.handleMessage({ action: "portal:config:get" }, sender),
      /来源|顶层|门户|标签页|扩展/
    );
  }

  const staleTabBackground = loadBackground({
    currentTabs: { 1: { id: 1, url: "http://example.com/" } }
  });
  await assert.rejects(
    staleTabBackground.handleMessage({ action: "portal:config:get" }, portalSender()),
    /标签页|门户/
  );
});

test("options:open 仅在全部网页来源校验通过后执行", async () => {
  const background = loadBackground();

  const result = await background.handleMessage({ action: "options:open" }, portalSender());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
  assert.equal(background.__openedOptions.length, 1);

  await assert.rejects(
    background.handleMessage({ action: "options:open" }, portalSender({ frameId: 2 })),
    /顶层/
  );
  assert.equal(background.__openedOptions.length, 1);
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
    fetch: async (input) => ({
      ok: true,
      status: 200,
      url: String(input),
      async text() {
        return 'dr1001({"result":1})';
      }
    })
  });
  background.getState = async () => ({
    recentRequests: [],
    config: {
      portalUrl: "http://10.10.10.2/",
      login: { callbackPrefix: "dr" }
    }
  });
  background.addRequestRecord = async () => undefined;

  const result = await background.checkStatus();

  assert.equal(result.online, true);
  assert.equal(result.phase, "online");
  assert.equal(sessionStore.drcomAssistantSession.connection.attempt, 0);
  assert.equal(sessionStore.drcomAssistantSession.connection.nextRetryAt, 0);
});

test("不同入口同时触发登录时也只发送一个 DrCOM 请求", async () => {
  const requests = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const background = loadBackground({
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/drcom/chkstatus") {
        return { ok: true, status: 200, url: url.toString(), async text() { return 'dr1001({"result":0})'; } };
      }
      if (url.port !== "801") {
        return { ok: true, status: 200, url: url.toString(), async text() { return '<script>var v4ip="192.0.2.46";</script>'; } };
      }
      await waiting;
      return {
        ok: true,
        status: 200,
        url: url.toString(),
        async text() { return '{"result":"1","msg":"success"}'; }
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
      portalUrl: "http://10.10.10.2/",
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

  assert.equal(requests.filter((url) => url.searchParams.get("a") === "login").length, 1);
});

test("临时登录身份跨后台重启保留且退出不会误用当前选中账号", async () => {
  const sessionStore = {};
  const requests = [];
  const fetchStub = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/drcom/chkstatus") {
      return { ok: true, status: 200, url: url.toString(), async text() { return 'dr1001({"result":0})'; } };
    }
    if (url.port !== "801") {
      return { ok: true, status: 200, url: url.toString(), async text() { return '<script>var v4ip="10.0.0.99";</script>'; } };
    }
    const action = url.searchParams.get("a");
    return {
      ok: true,
      status: 200,
      url: url.toString(),
      async text() { return action === "unbind_mac" ? '{"result":"1","msg":"logout success"}' : '{"result":"1","msg":"success"}'; }
    };
  };
  const state = {
    selectedAccountId: "account-1",
    accounts: [account({ username: "selected-user", suffix: "@telecom" })],
    recentRequests: [],
    config: {
      portalUrl: "http://10.10.10.2/",
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
  };
  const transient = account({
    id: "",
    username: "temporary-user",
    suffix: "@unicom",
    password: "temporary-secret",
    network: { wlanUserIp: "10.0.0.99", wlanUserMac: "AABBCCDDEEFF" }
  });
  const firstWorker = loadBackground({ sessionStore, fetch: fetchStub });
  firstWorker.getState = async () => structuredClone(state);
  firstWorker.addRequestRecord = async () => undefined;

  const login = await firstWorker.loginAccount("", transient);

  assert.equal(login.success, true);
  const savedIdentity = sessionStore.drcomAssistantSession.activeIdentity;
  assert.equal(savedIdentity.username, "temporary-user");
  assert.equal(savedIdentity.suffix, "@unicom");
  assert.equal(savedIdentity.source, "transient");
  assert.doesNotMatch(JSON.stringify(savedIdentity), /temporary-secret|password/i);

  const restartedWorker = loadBackground({ sessionStore, fetch: fetchStub });
  restartedWorker.getState = firstWorker.getState;
  restartedWorker.addRequestRecord = async () => undefined;
  restartedWorker.__alarms["drcomAssistant.retry"] = {
    name: "drcomAssistant.retry",
    when: Date.now() + 30000
  };
  restartedWorker.waitForLogoutDelay = async () => undefined;
  const logout = await restartedWorker.logout();
  const logoutRequest = requests.find((url) => url.searchParams.get("a") === "unbind_mac");

  assert.equal(logout.success, true);
  assert.equal(logoutRequest.searchParams.get("user_account"), "temporary-user@unicom");
  assert.equal(logoutRequest.searchParams.get("wlan_user_ip"), "10.0.0.99");
  assert.equal(sessionStore.drcomAssistantSession.activeIdentity, null);
  assert.equal(sessionStore.drcomAssistantSession.connection.phase, "offline");
  assert.equal(sessionStore.drcomAssistantSession.connection.attempt, 0);
  assert.equal(sessionStore.drcomAssistantSession.connection.nextRetryAt, 0);
  assert.equal(restartedWorker.__alarms["drcomAssistant.retry"], undefined);
});

test("下线失败时保留真实在线状态和活动身份", async () => {
  const sessionStore = {
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
        accountId: "",
        username: "temporary-user",
        suffix: "@unicom",
        source: "transient",
        authenticatedAt: 100,
        network: { wlanUserIp: "10.0.0.99", wlanUserMac: "AABBCCDDEEFF" }
      }
    }
  };
  const background = loadBackground({
    sessionStore,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/drcom/chkstatus") {
        return { ok: true, status: 200, url: url.toString(), async text() { return 'dr1001({"result":1})'; } };
      }
      if (url.port !== "801") {
        return { ok: true, status: 200, url: url.toString(), async text() { return '<script>var v4ip="10.0.0.99";</script>'; } };
      }
      return {
      ok: true,
      status: 200,
      url: url.toString(),
      async text() { return '{"result":"0","message":"logout failed"}'; }
      };
    }
  });
  background.getState = async () => ({
    selectedAccountId: "account-1",
    accounts: [account({ username: "selected-user" })],
    recentRequests: [],
    config: {
      portalUrl: "http://10.10.10.2/",
      apiUrl: "http://10.10.10.2:801/eportal/",
      login: { callbackPrefix: "dr", jsVersion: "3.3.2" },
      network: { wlanUserIp: "", wlanUserMac: "000000000000" }
    }
  });
  background.addRequestRecord = async () => undefined;
  background.waitForLogoutDelay = async () => undefined;

  const result = await background.logout();

  assert.equal(result.success, false);
  assert.match(result.message, /注销未完成|仍然在线/i);
  assert.equal(sessionStore.drcomAssistantSession.connection.phase, "online");
  assert.equal(sessionStore.drcomAssistantSession.connection.message, "已连接");
  assert.equal(sessionStore.drcomAssistantSession.activeIdentity.username, "temporary-user");
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

test("DrCOM 响应按 HTTP、明确协议、状态提示和安全兜底的顺序解析", () => {
  const background = loadBackground();
  const httpFailure = background.normalizeDrcomResult(
    "login",
    503,
    { result: "1", msg: "success" },
    '{"result":"1","msg":"success"}'
  );
  const explicitSuccess = background.normalizeDrcomResult(
    "login",
    200,
    { result: "1", msg: "ok" },
    '{"result":"1","msg":"ok"}'
  );
  const onlineStatus = background.normalizeDrcomResult(
    "login",
    200,
    { message: "already online" },
    '{"message":"already online"}'
  );
  const unknown = background.normalizeDrcomResult(
    "login",
    200,
    { message: "success" },
    '{"message":"success"}'
  );

  assert.equal(httpFailure.success, false);
  assert.equal(httpFailure.httpOk, false);
  assert.equal(httpFailure.diagnostic.statusCode, 503);
  assert.equal(explicitSuccess.success, true);
  assert.equal(explicitSuccess.diagnostic.protocolCode, "1");
  assert.equal(onlineStatus.success, true);
  assert.equal(unknown.success, false);
  assert.match(unknown.message, /未识别|没有返回明确/);
});

test("DrCOM 解析只接受完整 JSON、锚定 JSONP、query 和对象键值结构", () => {
  const background = loadBackground();
  const cases = [
    ['{"result":1,"ret_code":0,"msg":"ok"}', { result: 1, ret_code: 0, msg: "ok" }],
    ['dr1001({"result":"1","msg":"ok"});', { result: "1", msg: "ok" }],
    ["result=1&ret_code=0&msg=ok", { result: "1", ret_code: "0", msg: "ok" }],
    ["{result:1, ret_code:0, msg:'ok'}", { result: "1", ret_code: "0", msg: "ok" }]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(JSON.parse(JSON.stringify(background.parseDrcomText(input))), expected);
  }
  for (const input of [
    '<!-- result=1 --><html>advertisement</html>',
    '<script>window.x="result=1"</script>',
    'prefix result=1 suffix',
    'dr1001({"result":1}) trailing'
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(background.parseDrcomText(input))), {});
  }
});

test("DrCOM 成功判断不读取任意原始正文中的成功字样", () => {
  const background = loadBackground();
  const result = background.normalizeDrcomResult(
    "login", 200, {}, '<!-- result=1 --><div>login success 已在线</div>'
  );
  assert.equal(result.success, false);
  assert.equal(result.online, false);
});

test("DrCOM API 按 Content-Length 和实际分块字节数限制为 64 KiB", async () => {
  for (const response of [
    {
      ok: true, status: 200,
      headers: { get(name) { return name.toLowerCase() === "content-length" ? String(65 * 1024) : null; } },
      async text() { return '{"result":1}'; }
    },
    {
      ok: true, status: 200,
      headers: { get() { return null; } },
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: new Uint8Array(65 * 1024).fill(65) };
            },
            async cancel() {}
          };
        }
      }
    }
  ]) {
    const background = loadBackground({ fetch: async () => response });
    background.addRequestRecord = async () => undefined;
    const result = await background.fetchDrcom(
      { url: "http://10.10.10.2:801/eportal/", redactedUrl: "http://10.10.10.2:801/eportal/" },
      "login"
    );
    assert.equal(result.success, false);
    assert.match(result.message, /64 KiB|过大|超限/);
    assert.equal(result.raw, "");
  }
});

test("门户 HTML 实际响应超过 1 MiB 时提前拒绝且不返回正文", async () => {
  const background = loadBackground({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return String((1024 * 1024) + 1); } },
      async text() { return 'var v46ip="192.0.2.46";'; }
    })
  });
  const result = await background.resolvePortalRuntimeContext({
    portalUrl: "http://10.10.10.2/",
    network: { wlanUserIp: "" }
  }, "");
  assert.equal(result.ok, false);
  assert.match(result.message, /1 MiB|过大|超限/);
  assert.doesNotMatch(JSON.stringify(result), /v46ip|192\.0\.2\.46/);
});

test("门户在线状态复核同样拒绝超过 1 MiB 的 HTML", async () => {
  const background = loadBackground({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return String((1024 * 1024) + 1); } },
      async text() { return '<input name="logout">'; }
    })
  });
  const result = await background.queryPortalPageStatus({ portalUrl: "http://10.10.10.2/" });
  assert.equal(result.state, "unknown");
  assert.equal(result.raw, "");
  assert.match(result.message, /1 MiB|过大|超限/);
});

test("DrCOM 日志原文保留状态码但清除返回体中的凭据", async () => {
  const background = loadBackground({
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        return '{"result":"0","message":"user_password=secret user_account=202513010318"}';
      }
    })
  });
  background.addRequestRecord = async () => undefined;

  const result = await background.fetchDrcom(
    { url: "http://10.10.10.2:801/eportal/", redactedUrl: "http://10.10.10.2:801/eportal/" },
    "login"
  );

  assert.equal(result.statusCode, 200);
  assert.doesNotMatch(result.raw, /secret|202513010318/);
  assert.match(result.raw, /\*\*\*\*/);
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
  assert.equal(localStore.drcomAssistantRecentRequests.length, 1);
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
    js: [
      "account-utils.js",
      "portal-session.js",
      "appearance.js",
      "portal-ui.js",
      "portal-capture.js",
      "confirm-dialog.js",
      "portal-modernizer.js"
    ],
    runAt: "document_start",
    persistAcrossSessions: true
  }]);
});

test("后台启动时把 local 和 session 存储限制为可信扩展上下文", async () => {
  const background = loadBackground();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(background.__storageAccessLevels)), [
    { area: "local", accessLevel: "TRUSTED_CONTEXTS" },
    { area: "session", accessLevel: "TRUSTED_CONTEXTS" }
  ]);
});

test("后台在 local 和 session 访问级别收紧完成前不处理消息", async () => {
  let releaseLocal;
  let releaseSession;
  const localGate = new Promise((resolve) => { releaseLocal = resolve; });
  const sessionGate = new Promise((resolve) => { releaseSession = resolve; });
  const background = loadBackground({
    localAccessGate: () => localGate,
    sessionAccessGate: () => sessionGate
  });
  let response;
  background.__listeners.message[0]({ action: "connection:get" }, {
    id: "test-extension-id", url: "chrome-extension://test/popup.html"
  }, (value) => { response = value; });
  await Promise.resolve();
  assert.equal(response, undefined);
  releaseLocal();
  await Promise.resolve();
  assert.equal(response, undefined);
  releaseSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.ok, true);
});

test("存储访问级别限制失败只记录无敏感信息警告并继续工作", async () => {
  const background = loadBackground({
    localAccessGate: async () => { throw new Error("password=do-not-log"); },
    sessionAccessGate: async () => { throw new Error("token=do-not-log"); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(background.__warnings.length, 1);
  assert.match(background.__warnings[0], /存储访问级别/);
  assert.doesNotMatch(background.__warnings[0], /do-not-log|password|token/);
});

test("登录成功后按当前配置重建已被注销清除的保活闹钟", async () => {
  const alarms = {};
  const background = loadBackground({ alarms });
  await background.recordLoginOutcome({ success: true, online: true, message: "登录成功" });
  assert.equal(alarms["drcomAssistant.keepAlive"].periodInMinutes, 3);
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

test("门户诊断默认关闭且网页只能读取安全状态", async () => {
  const background = loadBackground();
  const result = await background.handleMessage({ action: "diagnostics:status" }, portalSender());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    enabled: false,
    limits: { maxBytes: 1048576, maxSessions: 10, maxDomBytes: 65536 }
  });
  assert.doesNotMatch(JSON.stringify(result), /sessions|records/);
});

test("后台生成的 UUID 即使包含纯数字段也保持会话可寻址", async () => {
  const background = loadBackground({
    crypto: { randomUUID: () => "12345678-abcd-4abc-8abc-abcdefabcdef" }
  });
  await background.setPortalDiagnosticsEnabled(true);
  const start = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
  const appended = await background.appendPortalDiagnosticRecord(start.sessionId, {
    type: "click",
    at: 1,
    target: { tag: "button", id: "login" }
  });
  const ended = await background.endPortalDiagnosticsSession(start.sessionId);
  const read = await background.readPortalDiagnostics();

  assert.equal(start.sessionId, "12345678-abcd-4abc-8abc-abcdefabcdef");
  assert.equal(appended.stored, true);
  assert.equal(ended.ended, true);
  assert.equal(read.sessions[0].id, "12345678-abcd-4abc-8abc-abcdefabcdef");
  assert.equal(read.sessions[0].records.length, 1);
});

test("门户诊断会在写入和读取时再次清除敏感数据", async () => {
  const background = loadBackground();
  await background.handleMessage({ action: "diagnostics:set", enabled: true }, { id: "test-extension-id" });
  const start = await background.handleMessage({
    action: "diagnostics:start",
    page: { pageKind: "login", title: "password=title-secret 202513010318", url: "http://10.10.10.2/login?user_account=202513010318&password=start-secret" }
  }, portalSender());
  await background.handleMessage({
    action: "diagnostics:append", sessionId: start.sessionId,
    record: { type: "dom", pageKind: "login", url: "http://192.168.8.1/private/202513010318?token=append-secret", summary: "user_account=202513010318 password=record-secret" }
  }, portalSender());
  await background.handleMessage({ action: "diagnostics:end", sessionId: start.sessionId }, portalSender());
  const result = await background.handleMessage({ action: "diagnostics:get" }, { id: "test-extension-id" });
  const serialized = JSON.stringify(result);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.sessions[0].endedAt > 0, true);
  assert.doesNotMatch(serialized, /title-secret|start-secret|record-secret|append-secret|202513010318/);
  assert.match(serialized, /redacted/);
});

test("门户诊断保留最新十个会话并串行化并发写入", async () => {
  const background = loadBackground();
  await background.setPortalDiagnosticsEnabled(true);
  const starts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    background.startPortalDiagnosticsSession({ pageKind: "login", title: `session ${index}` }, portalSender())
  ));
  const result = await background.readPortalDiagnostics();
  assert.equal(result.sessionCount, 10);
  assert.equal(new Set(result.sessions.map((session) => session.id)).size, 10);
  assert.equal(result.sessions.some((session) => session.id === starts[0].sessionId), false);
  assert.equal(result.sessions.some((session) => session.id === starts[1].sessionId), false);
});

test("门户诊断按记录精确累计被会话上限淘汰的数量", async () => {
  const background = loadBackground();
  await background.setPortalDiagnosticsEnabled(true);
  for (let index = 0; index < 12; index += 1) {
    const start = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
    const appended = await background.appendPortalDiagnosticRecord(start.sessionId, {
      type: "click",
      at: index + 1,
      target: { tag: "button", id: `control-${index + 1}` }
    });
    assert.equal(appended.stored, true);
  }

  const result = await background.readPortalDiagnostics();
  assert.equal(result.sessionCount, 10);
  assert.equal(result.droppedRecords, 2);
  assert.equal(result.paused, false);
});

test("门户诊断按时间淘汰乱序旧会话且限制损坏 URL 大小", async () => {
  const localStore = {
    drcomPortalDiagnostics: {
      enabled: true,
      sessions: Array.from({ length: 12 }, (_, index) => ({
        id: `session-${index}`,
        startedAt: index,
        endedAt: index,
        origin: "http://10.10.10.2",
        pageKind: "login",
        title: "title",
        url: `http://10.10.10.2/?${"c=x&".repeat(100000)}`,
        records: []
      })).reverse()
    }
  };
  const background = loadBackground({ localStore });
  const result = await background.readPortalDiagnostics();
  assert.deepEqual(result.sessions.map((session) => session.id), [
    "session-2", "session-3", "session-4", "session-5", "session-6",
    "session-7", "session-8", "session-9", "session-10", "session-11"
  ]);
  assert.ok(result.bytes <= 1048576);
});

test("门户诊断裁剪不会反复序列化完整存储", () => {
  let storeStringifyCount = 0;
  const countingJson = {
    parse: JSON.parse,
    stringify(value, ...args) {
      if (value && Array.isArray(value.sessions) && value.sessions.some((session) => Array.isArray(session.records) && session.records.length)) storeStringifyCount += 1;
      return JSON.stringify(value, ...args);
    }
  };
  const background = loadBackground({ JSON: countingJson });
  const records = Array.from({ length: 40 }, (_, index) => ({
    type: "dom",
    at: index,
    summary: "x".repeat(60 * 1024)
  }));

  const result = background.prunePortalDiagnosticsStore({
    enabled: true,
    updatedAt: 1,
    droppedRecords: 0,
    paused: false,
    sessions: [{
      id: "12345678-abcd-4abc-8abc-abcdefabcdef",
      startedAt: 1,
      endedAt: 0,
      origin: "http://10.10.10.2/",
      pageKind: "login",
      title: "login",
      url: "http://10.10.10.2/",
      records,
      truncated: false
    }]
  });

  assert.ok(storeStringifyCount <= 2, `完整诊断存储序列化次数过多：${storeStringifyCount}`);
  assert.ok(background.portalDiagnosticsSerializedBytes(result) <= 1048576);
  assert.equal(result.truncated || result.sessions[0].truncated, true);
});
test("门户诊断在一 MiB 上限内移除最早记录", async () => {
  const background = loadBackground();
  await background.setPortalDiagnosticsEnabled(true);
  const start = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
  const summary = "x".repeat(64 * 1024);
  for (let index = 0; index < 20; index += 1) {
    await background.appendPortalDiagnosticRecord(start.sessionId, { type: "dom", summary, at: index + 1 });
  }
  const result = await background.readPortalDiagnostics();
  assert.ok(result.bytes <= 1048576);
  assert.ok(result.sessions[0].records.length < 20);
  assert.equal(result.sessions[0].truncated, true);
  assert.ok(result.droppedRecords > 0);
});

test("门户诊断将 DOM 摘要截断为 64 KiB UTF-8", async () => {
  const background = loadBackground();
  await background.setPortalDiagnosticsEnabled(true);
  const start = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
  await background.appendPortalDiagnosticRecord(start.sessionId, { type: "dom", summary: "界".repeat(30000) });
  const result = await background.readPortalDiagnostics();
  assert.ok(new TextEncoder().encode(result.sessions[0].records[0].summary).byteLength <= 65536);
});

test("门户诊断在浏览器存储保留空间时暂停写入但仍可清除", async () => {
  const background = loadBackground({ bytesInUse: (10 * 1024 * 1024) - (512 * 1024) });
  await background.setPortalDiagnosticsEnabled(true);
  const blocked = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
  const cleared = await background.clearPortalDiagnostics();
  assert.deepEqual(JSON.parse(JSON.stringify(blocked)), {
    ok: false,
    paused: true,
    error: "本地存储接近上限，诊断记录已暂停"
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.sessionCount, 0);
  assert.equal(cleared.droppedRecords, 0);
  assert.equal(cleared.paused, false);
});

test("门户诊断接近总配额时拒绝会越过阈值的新负载", async () => {
  const softLimit = (10 * 1024 * 1024) - (512 * 1024);
  const localStore = {};
  const background = loadBackground({
    localStore,
    bytesInUse: (keys) => {
      const diagnosticsBytes = new TextEncoder().encode(
        JSON.stringify(localStore.drcomPortalDiagnostics || {})
      ).byteLength;
      return keys ? diagnosticsBytes : softLimit - 1000 + diagnosticsBytes;
    }
  });
  await background.setPortalDiagnosticsEnabled(true);
  const start = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
  const result = await background.appendPortalDiagnosticRecord(start.sessionId, {
    type: "dom",
    summary: "x".repeat(800)
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    stored: false,
    paused: true,
    error: "本地存储接近上限，诊断记录已暂停"
  });
  const read = await background.readPortalDiagnostics();
  assert.equal(read.droppedRecords, 1);
  assert.equal(read.paused, true);
  assert.equal(read.sessions[0].records.length, 0);
});

test("门户诊断并发写入按队列中的最新占用量拒绝第二个会话", async () => {
  const softLimit = (10 * 1024 * 1024) - (512 * 1024);
  const localStore = {};
  const background = loadBackground({
    localStore,
    bytesInUse: (keys) => {
      const diagnosticsBytes = new TextEncoder().encode(
        JSON.stringify(localStore.drcomPortalDiagnostics || {})
      ).byteLength;
      return keys ? diagnosticsBytes : softLimit - 500 + diagnosticsBytes;
    }
  });
  await background.setPortalDiagnosticsEnabled(true);
  const starts = await Promise.all([
    background.startPortalDiagnosticsSession({ pageKind: "login", title: "first" }, portalSender()),
    background.startPortalDiagnosticsSession({ pageKind: "login", title: "second" }, portalSender())
  ]);
  assert.equal(starts.filter((result) => result.ok).length, 1);
  assert.equal(starts.filter((result) => result.error === "本地存储接近上限，诊断记录已暂停").length, 1);
  assert.equal((await background.readPortalDiagnostics()).sessionCount, 1);
  const cleared = await background.clearPortalDiagnostics();
  assert.equal(cleared.ok, true);
});

test("门户诊断会规范化并脱敏损坏的持久化会话后再读取或导出", async () => {
  const localStore = { drcomPortalDiagnostics: { enabled: true, sessions: [{
    id: "legacy", startedAt: "bad", endedAt: -1, origin: "http://192.168.8.1", pageKind: "unsafe",
    title: "password=stored-secret", url: "http://192.168.8.1/a/202513010318?token=stored-secret",
    records: [{ type: "untrusted", summary: "token=record-secret 202513010318" }]
  }] } };
  const background = loadBackground({ localStore });
  const read = await background.readPortalDiagnostics();
  const exported = await background.exportPortalDiagnostics();
  const serialized = JSON.stringify({ read, exported });
  assert.equal(read.sessions[0].pageKind, "unknown");
  assert.doesNotMatch(serialized, /stored-secret|record-secret|202513010318/);
  assert.match(serialized, /redacted/);
});

test("自定义网关和 iframe 不能写门户诊断", async () => {
  const background = loadBackground();
  await assert.rejects(background.handleMessage(
    { action: "diagnostics:start", page: { pageKind: "login" } },
    portalSender({ origin: "http://gateway.example", url: "http://gateway.example/" })
  ), /默认校园网认证页/);
  await assert.rejects(background.handleMessage(
    { action: "diagnostics:start", page: { pageKind: "login" } }, portalSender({ frameId: 1 })
  ), /顶层页面/);
});

test("网页内容脚本不能管理或导出门户诊断", async () => {
  const background = loadBackground();
  for (const action of ["diagnostics:set", "diagnostics:get", "diagnostics:export", "diagnostics:clear"]) {
    await assert.rejects(background.handleMessage({ action, enabled: true }, portalSender()), /无权执行此操作/);
  }
});

test("门户诊断第二次净化和导出后保留安全资源字段", async () => {
  const background = loadBackground();
  await background.setPortalDiagnosticsEnabled(true);
  const start = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
  await background.appendPortalDiagnosticRecord(start.sessionId, {
    type: "resource", initiatorType: "script", status: 0, duration: 2.5
  });
  const exported = await background.exportPortalDiagnostics();
  const record = exported.export.diagnostics.sessions[0].records[0];
  assert.equal(
    exported.export.redactionNotice,
    "输入值、凭据、Cookie、存储内容、完整账号、IP 和 MAC 已排除或脱敏。"
  );
  assert.equal(
    exported.export.completenessNotice,
    "诊断为尽力记录；关闭、暂停、淘汰、存储受限、页面卸载或后台不可用时可能不完整。"
  );
  assert.equal(exported.export.diagnostics.droppedRecords, 0);
  assert.equal(exported.export.diagnostics.paused, false);
  assert.equal(record.initiatorType, "script");
  assert.equal(record.status, 0);
  assert.equal(record.duration, 2.5);
  assert.equal("method" in record, false);
});

test("门户诊断后台与导出再次隐藏敏感 URL 组件", async () => {
  const background = loadBackground();
  await background.setPortalDiagnosticsEnabled(true);
  const start = await background.startPortalDiagnosticsSession({ pageKind: "login" }, portalSender());
  await background.appendPortalDiagnosticRecord(start.sessionId, {
    type: "resource",
    url: "https://202600000001.example.test/assets/abcdef0123456789abcdef0123456789.js?202600000001=value",
    initiatorType: "script",
    status: 200,
    duration: 1
  });

  const exported = await background.exportPortalDiagnostics();
  const record = exported.export.diagnostics.sessions[0].records[0];
  assert.equal(
    record.url,
    "https://redacted-id.example.test/assets/[redacted-secret].js?redacted-id=%5Bredacted%5D"
  );
  assert.doesNotMatch(JSON.stringify(exported), /202600000001|abcdef0123456789abcdef0123456789/);
});
