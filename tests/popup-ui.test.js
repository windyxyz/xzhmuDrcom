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
  assert.equal(fixture.elements.get("status-message").textContent, "当前需要登录");
  assert.equal(fixture.elements.get("password").value, "secret");
  assert.equal(fixture.sent.filter((item) => /login$/.test(item.action)).length, 0);
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
