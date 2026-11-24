"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPopup(options = {}) {
  const createdElements = [];
  const runtimeMessageListeners = [];
  const sent = [];
  const makeInteractiveElement = (initial = {}) => ({
    disabled: false,
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    ...initial
  });
  const elements = new Map([
    ["status-dot", { dataset: {} }],
    ["status-label", { textContent: "" }],
    ["status-message", { textContent: "" }],
    ["request-url", { textContent: "" }],
    ["toast", { hidden: true, textContent: "" }],
    ["account-list", {
      innerHTML: "",
      listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      append(element) { createdElements.push(element); }
    }],
    ["language-toggle", makeInteractiveElement({ textContent: "EN" })],
    ["password", makeInteractiveElement({ value: options.password || "" })],
    ...(options.elements || [])
  ]);
  const chrome = options.chrome || {};
  chrome.i18n ||= { getUILanguage: () => (options.browserLanguages || ["zh-CN"])[0] };
  chrome.runtime ||= {};
  chrome.runtime.lastError ??= null;
  chrome.runtime.onMessage ||= {
    addListener(listener) { runtimeMessageListeners.push(listener); }
  };
  chrome.runtime.sendMessage ||= ((message, callback) => {
    sent.push(structuredClone(message));
    if (message.action === "language:get") callback({ ok: true, preference: options.languagePreference || "zh-CN" });
    else if (message.action === "language:set") {
      callback({ ok: true, preference: message.preference });
      for (const listener of runtimeMessageListeners) {
        listener({ action: "language:changed", preference: message.preference }, { id: "test-extension-id" });
      }
    } else callback({ ok: true });
  });
  chrome.runtime.id ||= "test-extension-id";
  const context = vm.createContext({
    URL,
    chrome,
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      body: { dataset: {} },
      createElement() {
        const element = { className: "", innerHTML: "" };
        createdElements.push(element);
        return element;
      },
      getElementById(id) {
        return elements.get(id) || null;
      },
      documentElement: {},
      querySelectorAll() { return []; }
    },
    navigator: { languages: options.browserLanguages || ["zh-CN"] },
    setTimeout
  });
  for (const file of ["i18n-messages.js", "i18n.js", "account-utils.js", "popup.js"]) {
    const source = readFileSync(join(__dirname, "..", "CRX", file), "utf8");
    new vm.Script(source, { filename: file }).runInContext(context);
  }
  return {
    context,
    createdElements,
    elements,
    runtimeMessageListeners,
    sent,
    async click(id) {
      const element = elements.get(id);
      assert.equal(typeof element?.listeners?.click, "function", `${id} 缺少 click 监听器`);
      await element.listeners.click({ currentTarget: element, target: element });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

test("弹窗切换英文会更新动态状态但不登录或清空密码", async () => {
  const fixture = loadPopup({ languagePreference: "zh-CN", password: "secret" });
  fixture.context.bindLanguageControls();
  fixture.context.renderResult({ phase: "captive", message: "当前需要登录" });

  await fixture.click("language-toggle");

  assert.equal(fixture.elements.get("status-label").textContent, "Sign-in required");
  assert.equal(fixture.elements.get("status-message").textContent, "Sign-in required");
  assert.equal(fixture.elements.get("password").value, "secret");
  assert.equal(fixture.sent.filter((item) => /login$/.test(item.action)).length, 0);
});

test("弹窗语言保存失败时临时应用选择并隐藏底层存储错误", async () => {
  const fixture = loadPopup({
    languagePreference: "zh-CN",
    chrome: { runtime: { lastError: null, sendMessage(message, callback) {
      if (message.action === "language:set") {
        this.lastError = { message: "QUOTA_BYTES quota exceeded" };
        callback();
        this.lastError = null;
        return;
      }
      callback({ ok: true, preference: "zh-CN" });
    } } }
  });
  fixture.context.bindLanguageControls();

  await fixture.click("language-toggle");

  assert.equal(fixture.elements.get("language-toggle").textContent, "中文");
  assert.match(fixture.elements.get("toast").textContent, /not saved/i);
  assert.doesNotMatch(fixture.elements.get("toast").textContent, /quota/i);
});

test("弹窗明确区分等待重试、需要处理和需要登录", () => {
  const { context, elements } = loadPopup();

  context.renderResult({ phase: "waiting", message: "稍后自动重试" });
  assert.equal(elements.get("status-dot").dataset.state, "waiting");
  assert.equal(elements.get("status-label").textContent, "等待重试");

  context.renderResult({ phase: "action_required", message: "请检查密码" });
  assert.equal(elements.get("status-dot").dataset.state, "action_required");
  assert.equal(elements.get("status-label").textContent, "需要处理");

  context.renderResult({ phase: "captive", message: "当前需要登录" });
  assert.equal(elements.get("status-dot").dataset.state, "captive");
  assert.equal(elements.get("status-label").textContent, "需要登录");
});

test("忙碌态结束后不会启用本来就不可用的账号选择框", () => {
  const accountSelect = { disabled: true };
  const loginButton = { disabled: false };
  const context = vm.createContext({
    URL,
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      body: { dataset: {} },
      getElementById(id) { return id === "account-select" ? accountSelect : null; },
      querySelectorAll() { return [accountSelect, loginButton]; }
    },
    setTimeout
  });
  for (const file of ["i18n-messages.js", "i18n.js", "account-utils.js", "popup.js"]) {
    const source = readFileSync(join(__dirname, "..", "CRX", file), "utf8");
    new vm.Script(source, { filename: file }).runInContext(context);
  }

  context.setBusy(true);
  context.setBusy(false);

  assert.equal(accountSelect.disabled, true);
  assert.equal(loginButton.disabled, false);
});

test("刷新连接状态失败时弹窗会显示可恢复的错误信息", async () => {
  const chrome = {
    runtime: {
      lastError: { message: "后台服务已暂停" },
      sendMessage(message, callback) { callback(undefined); }
    }
  };
  const { context, elements } = loadPopup({ chrome });

  await assert.doesNotReject(() => context.refreshStatus(false));
  assert.equal(elements.get("status-label").textContent, "未连接");
  assert.match(elements.get("status-message").textContent, /后台服务已暂停/);
});

test("弹窗首次读取状态失败时不会无提示中止", async () => {
  const chrome = {
    runtime: {
      lastError: { message: "无法连接后台服务" },
      sendMessage(message, callback) { callback(undefined); }
    }
  };
  const { context, elements } = loadPopup({ chrome });
  context.bindEvents = () => {};

  await assert.doesNotReject(() => context.init());
  assert.equal(elements.get("status-label").textContent, "未连接");
  assert.match(elements.get("status-message").textContent, /无法连接后台服务/);
});

test("弹窗账号删除按钮包含具体账号的无障碍名称", () => {
  const { context, createdElements } = loadPopup();
  new vm.Script(`state = {
    selectedAccountId: "account-1",
    accounts: [{
      id: "account-1",
      label: "主账号 & 备用",
      username: "20250001",
      suffix: "@cmcc",
      network: {}
    }]
  }`).runInContext(context);

  context.renderAccountList();

  assert.match(createdElements[0].innerHTML, /aria-label="删除账号：主账号 &amp; 备用"/);
});

test("弹窗异步操作失败时会显示错误提示而不是产生未处理拒绝", async () => {
  const { context, elements } = loadPopup();
  const handler = context.runAsync(async () => {
    throw new Error("保存账号失败");
  });

  await assert.doesNotReject(async () => {
    handler();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(elements.get("toast").hidden, false);
  assert.equal(elements.get("toast").textContent, "保存账号失败");
});

test("弹窗状态尚未加载时打开认证页不会崩溃或误跳默认地址", () => {
  const opened = [];
  const { context, elements } = loadPopup({
    chrome: { tabs: { create(options) { opened.push(structuredClone(options)); } } }
  });

  assert.equal(context.openConfiguredPortal(), false);
  assert.deepEqual(opened, []);
  assert.equal(elements.get("toast").textContent, "设置仍在加载，请稍后再试");

  new vm.Script('state = { config: { portalUrl: "https://gateway.example/login" } }').runInContext(context);
  assert.equal(context.openConfiguredPortal(), true);
  assert.deepEqual(opened, [{ url: "https://gateway.example/login" }]);
});

test("每日壁纸回调遇到 runtime.lastError 时不应用无效结果", () => {
  let appearanceCalls = 0;
  const chrome = {
    runtime: {
      lastError: { message: "扩展上下文已失效" },
      sendMessage(message, callback) {
        callback({ wallpaper: { ok: true, dataUrl: "data:image/png;base64,AAAA" } });
      }
    }
  };
  const { context } = loadPopup({ chrome });
  context.DrcomAppearance = {
    applyToRoot() {
      appearanceCalls += 1;
      return {};
    }
  };

  context.applyAppearance({ background: "daily" });

  assert.equal(appearanceCalls, 1);
});

test("登录前统一校验账号和密码且不会保存不完整账号", async () => {
  const messages = [];
  const fields = new Map([
    ["account-select", { disabled: false }],
    ["label", { value: "" }],
    ["username", { value: "" }],
    ["suffix", { value: "" }],
    ["password", { value: "secret" }],
    ["wlan-user-ip", { value: "" }],
    ["wlan-user-mac", { value: "" }],
    ["remember", { checked: true }]
  ]);
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        callback({ ok: true });
      }
    }
  };
  const { context, elements } = loadPopup({ chrome, elements: fields });
  new vm.Script("state = { selectedAccountId: '', accounts: [], config: {} }").runInContext(context);

  await context.login();
  assert.equal(messages.length, 0);
  assert.match(elements.get("status-message").textContent, /账号/);

  fields.get("username").value = "student";
  fields.get("password").value = "";
  await context.login();
  assert.equal(messages.length, 0);
  assert.match(elements.get("status-message").textContent, /密码/);
});

test("点击新建账号按钮会清空表单并在保存时生成新账号而不覆盖当前选中账号", async () => {
  const messages = [];
  let focusedUsername = false;
  const makeField = (value = "") => ({
    value,
    disabled: false,
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; }
  });
  const fields = new Map([
    ["account-select", {
      value: "acc-1",
      selectedIndex: 0,
      disabled: false,
      innerHTML: "",
      options: [],
      listeners: {},
      append(opt) { this.options.push(opt); },
      addEventListener(type, listener) { this.listeners[type] = listener; }
    }],
    ["new-account", {
      disabled: false,
      listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute() {}
    }],
    ["label", makeField("主账号")],
    ["username", { ...makeField("20250001"), focus() { focusedUsername = true; } }],
    ["suffix", makeField("@cmcc")],
    ["password", makeField("old-pass")],
    ["wlan-user-ip", makeField("10.0.0.1")],
    ["wlan-user-mac", makeField("001122334455")],
    ["portal-host", { textContent: "" }],
    ["refresh-status", makeField()],
    ["save-account", makeField()],
    ["login", makeField()],
    ["logout", makeField()],
    ["open-options", makeField()],
    ["open-portal", makeField()],
    ["reveal-password", makeField()]
  ]);
  const nextState = {
    selectedAccountId: "acc-2",
    config: { portalUrl: "http://10.10.10.2/", ui: {} },
    accounts: [
      { id: "acc-1", label: "主账号", username: "20250001", suffix: "@cmcc", password: "old-pass", network: { wlanUserIp: "", wlanUserMac: "" } },
      { id: "acc-2", label: "备用账号", username: "20250002", suffix: "@telecom", password: "new-pass", network: { wlanUserIp: "", wlanUserMac: "" } }
    ]
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        if (message.action === "account:save") callback({ ok: true, account: nextState.accounts[1], state: nextState });
        else callback({ ok: true });
      }
    }
  };
  const fixture = loadPopup({ chrome, elements: fields });
  fixture.context.Option = function Option(text, value) { return { text, value, selected: false }; };
  fixture.context.DrcomAppearance = { applyToRoot() { return {}; } };
  new vm.Script(`state = {
    selectedAccountId: "acc-1",
    config: { portalUrl: "http://10.10.10.2/", ui: {} },
    accounts: [{ id: "acc-1", label: "主账号", username: "20250001", suffix: "@cmcc", password: "old-pass", network: { wlanUserIp: "", wlanUserMac: "" } }]
  }`).runInContext(fixture.context);

  fixture.context.bindEvents();
  await fixture.click("new-account");

  assert.equal(focusedUsername, true);
  assert.equal(fields.get("label").value, "");
  assert.equal(fields.get("username").value, "");
  assert.equal(fields.get("password").value, "");

  fields.get("label").value = "备用账号";
  fields.get("username").value = "20250002";
  fields.get("suffix").value = "@telecom";
  fields.get("password").value = "new-pass";
  await fixture.context.saveCurrentAccount();

  const saveCalls = messages.filter((m) => m.action === "account:save");
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].account.id, "");
  assert.equal(saveCalls[0].account.username, "20250002");
  // Uses response.state directly without a redundant state:get IPC call
  assert.equal(messages.filter((m) => m.action === "state:get").length, 0);
});

test("表单输入框按 Enter 会触发登录提交", async () => {
  const messages = [];
  const makeField = (value = "") => ({
    value,
    disabled: false,
    checked: false,
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; }
  });
  const fields = new Map([
    ["account-select", makeField()],
    ["new-account", makeField()],
    ["label", makeField("测试")],
    ["username", makeField("20250001")],
    ["suffix", makeField("")],
    ["password", makeField("secret")],
    ["wlan-user-ip", makeField("")],
    ["wlan-user-mac", makeField("")],
    ["remember", makeField()],
    ["refresh-status", makeField()],
    ["save-account", makeField()],
    ["login", makeField()],
    ["logout", makeField()],
    ["open-options", makeField()],
    ["open-portal", makeField()],
    ["reveal-password", makeField()]
  ]);
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        callback({ ok: true, online: true, phase: "online", message: "已在线" });
      }
    }
  };
  const fixture = loadPopup({ chrome, elements: fields });
  fixture.context.bindEvents();

  let prevented = false;
  fields.get("password").listeners.keydown({ key: "Enter", isComposing: false, preventDefault() { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(prevented, true);
  assert.equal(messages.filter((m) => m.action === "drcom:login").length, 1);
});

test("state 为空或 portalUrl 非法时弹窗操作不会崩溃，且保存前校验必填字段", async () => {
  const fields = new Map([
    ["label", { value: "" }],
    ["username", { value: "" }],
    ["suffix", { value: "" }],
    ["password", { value: "" }],
    ["wlan-user-ip", { value: "" }],
    ["wlan-user-mac", { value: "" }],
    ["portal-host", { textContent: "" }],
    ["account-select", { innerHTML: "", disabled: false, append() {} }]
  ]);
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.action === "state:get") {
          callback({ ok: true, state: { selectedAccountId: "", accounts: [], config: { portalUrl: "not a valid url", ui: {} } } });
          return;
        }
        callback({ ok: true });
      }
    }
  };
  const fixture = loadPopup({ chrome, elements: fields });
  fixture.context.Option = function Option(text, value) { return { text, value, selected: false }; };
  fixture.context.DrcomAppearance = { applyToRoot() { return {}; } };

  // state is null initially
  assert.equal(fixture.context.readAccountForm().id, "");
  await assert.doesNotReject(() => fixture.context.deleteAccount("missing"));
  await assert.rejects(() => fixture.context.saveCurrentAccount(), /账号/);

  // invalid portalUrl does not throw
  await assert.doesNotReject(() => fixture.context.loadState());
  assert.equal(fields.get("portal-host").textContent, "not a valid url");
});

test("刷新状态独立旋转刷新图标并防止并发重入，且更新状态面板 data-state", async () => {
  const glyphClasses = new Set();
  const refreshButton = {
    disabled: false,
    querySelector(selector) {
      if (selector === ".win-glyph") {
        return {
          classList: {
            add(c) { glyphClasses.add(c); },
            remove(c) { glyphClasses.delete(c); },
            toggle(c, force) { if (force) glyphClasses.add(c); else glyphClasses.delete(c); }
          }
        };
      }
      return null;
    }
  };
  const statusPanel = { dataset: {} };
  let statusCalls = 0;
  let resolveStatus;
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.action === "drcom:status") {
          statusCalls += 1;
          resolveStatus = () => callback({ ok: true, online: true, phase: "online", message: "已在线" });
          return;
        }
        callback({ ok: true });
      }
    }
  };
  const fixture = loadPopup({
    chrome,
    elements: [
      ["refresh-status", refreshButton],
      ["status-panel", statusPanel]
    ]
  });

  // setBusy must NOT spin refresh glyph
  fixture.context.setBusy(true);
  assert.equal(glyphClasses.has("spinning"), false);
  fixture.context.setBusy(false);

  // refreshStatus spins glyph and guards against concurrent calls
  const p1 = fixture.context.refreshStatus(false);
  const p2 = fixture.context.refreshStatus(false);
  assert.equal(statusCalls, 1);
  assert.equal(glyphClasses.has("spinning"), true);
  assert.equal(refreshButton.disabled, true);

  resolveStatus();
  await Promise.all([p1, p2]);
  assert.equal(glyphClasses.has("spinning"), false);
  assert.equal(refreshButton.disabled, false);
  assert.equal(statusPanel.dataset.state, "online");
});

test("每日壁纸在弹窗会话内缓存 Data URL 避免重复 IPC 传输", () => {
  let wallpaperCalls = 0;
  const applied = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.action === "wallpaper:get") {
          wallpaperCalls += 1;
          callback({ wallpaper: { ok: true, dataUrl: "data:image/png;base64,CACHED" } });
        }
      }
    }
  };
  const fixture = loadPopup({ chrome });
  fixture.context.DrcomAppearance = {
    applyToRoot(_root, ui) {
      applied.push(structuredClone(ui));
      return ui;
    }
  };

  fixture.context.applyAppearance({ background: "daily" });
  fixture.context.applyAppearance({ background: "daily" });

  assert.equal(wallpaperCalls, 1);
  assert.equal(applied.at(-1).backgroundImage, "data:image/png;base64,CACHED");
});
