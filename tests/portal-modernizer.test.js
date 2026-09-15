"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const portalUi = require(join(__dirname, "..", "CRX", "portal-ui.js"));
const appearance = require(join(__dirname, "..", "CRX", "appearance.js"));
const i18n = require(join(__dirname, "..", "CRX", "i18n.js"));
const portalSession = require(join(__dirname, "..", "CRX", "portal-session.js"));

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(document, tagName = "div", id = "") {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Map();
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, String(value))
    };
    this.shadowRoot = null;
    this.listeners = new Map();
    this.childrenById = new Map();
    this.localizableNodes = [];
    this.textContent = "";
    this._innerHTML = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  async emit(type, event = {}) {
    return this.listeners.get(type)?.(event);
  }

  querySelector(selector) {
    if (this.id === "drcom-modern-root" && this.document.failPortalEventBinding) {
      throw new Error("injected portal event binding failure");
    }
    if (selector.startsWith("#")) return this.childrenById.get(selector.slice(1)) || null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector.includes("data-i18n")) return this.localizableNodes;
    if (selector !== "button, input, select") return [];
    return Array.from(this.childrenById.values()).filter((element) =>
      ["BUTTON", "INPUT", "SELECT"].includes(element.tagName)
    );
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    this.document.activeElement = this;
  }

  attachShadow(options = {}) {
    const shadow = { mode: options.mode, innerHTML: "" };
    this.document.closedShadowRoots.set(this, shadow);
    if (options.mode !== "closed") this.shadowRoot = shadow;
    return shadow;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.childrenById.clear();
    this.localizableNodes = [];
    const tags = this._innerHTML.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi);
    for (const match of tags) {
      const id = match[2].match(/\bid="([^"]+)"/i)?.[1];
      if (!id && !/data-i18n/.test(match[2])) continue;
      const element = new FakeElement(this.document, match[1], id);
      element.checked = /\bchecked\b/i.test(match[2]);
      for (const attribute of match[2].matchAll(/\b([a-z][a-z0-9-]*)="([^"]*)"/gi)) {
        element.setAttribute(attribute[1], attribute[2]);
        if (attribute[1] === "data-i18n") element.dataset.i18n = attribute[2];
        if (attribute[1] === "data-i18n-aria-label") element.dataset.i18nAriaLabel = attribute[2];
        if (attribute[1] === "data-i18n-title") element.dataset.i18nTitle = attribute[2];
      }
      const closing = this._innerHTML.indexOf(`</${match[1]}>`, match.index + match[0].length);
      if (closing >= 0) element.textContent = this._innerHTML.slice(match.index + match[0].length, closing).replace(/<[^>]*>/g, "");
      if (id) this.childrenById.set(id, element);
      if (/data-i18n/.test(match[2])) this.localizableNodes.push(element);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  remove() {
    this.document.removeRoot(this);
  }
}

function createHarness(options = {}) {
  const messages = [];
  const confirmations = [];
  const roots = new Map();
  const observers = [];
  const deferredActions = new Set(options.deferredActions || []);
  const pendingCallbacks = new Map();
  const microtaskErrors = [];
  const documentListeners = new Map();
  const runtimeMessageListeners = [];
  const scheduleMicrotask = queueMicrotask;
  let pageState = options.pageState || (options.online ? "online" : "login");
  let shouldTakeOverCalls = 0;
  let modernRootMountCount = 0;
  const originalUsername = { value: "" };
  const originalPassword = { value: "" };
  const documentElement = {
    classList: new FakeClassList(),
    innerText: "",
    style: { setProperty() {} }
  };
  const document = {
    readyState: "complete",
    failPortalEventBinding: options.failPortalEventBinding === true,
    closedShadowRoots: new Map(),
    activeElement: null,
    documentElement,
    body: {
      innerText: "",
      append(element) {
        roots.set(element.id, element);
        if (element.id === "drcom-modern-root") modernRootMountCount += 1;
        notifyMutation([{ addedNodes: [element], removedNodes: [] }]);
      }
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    createElement(tagName) {
      return new FakeElement(document, tagName);
    },
    getElementById(id) {
      if (roots.has(id)) return roots.get(id);
      for (const root of roots.values()) {
        if (root.childrenById.has(id)) return root.childrenById.get(id);
      }
      return null;
    },
    querySelector(selector) {
      if (selector === 'input[name="captcha"]') return pageState === "captcha" ? { value: "" } : null;
      if (selector === 'input[type="password"]') return pageState === "login" || pageState === "captcha" ? originalPassword : null;
      if (pageState === "online" && /logout/i.test(selector)) return { value: "" };
      if (pageState === "pending") return null;
      if (/DDDDD|user_account|username/i.test(selector)) return originalUsername;
      if (/upass|user_password|password|0MKKey/i.test(selector)) return originalPassword;
      return null;
    },
    removeRoot(root) {
      if (!roots.delete(root.id)) return;
      notifyMutation([{ addedNodes: [], removedNodes: [root] }]);
    }
  };
  function notifyMutation(records) {
    observers.forEach((observer) => observer.trigger(records));
  }
  function updatePageText() {
    document.body.innerText = pageState === "online" ? "当前已连接，可以下线" : "";
  }
  updatePageText();
  const responses = {
    "language:get": { ok: true, preference: options.languagePreference || "zh-CN" },
    "language:set": { ok: true, preference: "en" },
    "portal:config:get": {
      ok: true,
      portal: {
        enabled: true,
        title: "徐医校园网",
        onlineDetailMode: "classic",
        appearance: { theme: "light", accent: "#0f766e" }
      }
    },
    "portal:appearance:get": {
      ok: true,
      appearance: { theme: "light", accent: "#0f766e", background: "fresh", backgroundImage: "" }
    },
    "account:save:interactive": { ok: true, accountId: "saved-account" },
    "account:capture:stage": { ok: true, staged: true, expiresAt: Date.now() + 300000 },
    "portal:status:get": {
      state: "online",
      phase: "online",
      message: "当前校园网会话在线。",
      checkedAt: Date.UTC(2026, 8, 2, 1, 2),
      session: {
        account: "20***18",
        usedMinutes: 125,
        totalKilobytes: 1234567,
        uploadKilobytes: 500000,
        downloadKilobytes: 734567
      }
    },
    "drcom:login": { ok: true, success: true, online: true, message: "登录成功" },
    "drcom:logout": { ok: true, success: true, online: false, message: "已下线" },
    "redirect:markPortalTab": { ok: true },
    "options:open": { ok: true },
    ...(options.responses || {})
  };
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }

    observe() {
      this.connected = true;
    }

    disconnect() {
      this.connected = false;
    }

    trigger(records = [{ addedNodes: [] }]) {
      if (this.connected) this.callback(records);
    }
  }
  const context = vm.createContext({
    AbortController,
    URL,
    chrome: {
      runtime: {
        id: "test-extension-id",
        onMessage: { addListener(listener) { runtimeMessageListeners.push(listener); } },
        lastError: null,
        sendMessage(message, callback) {
          if ((options.throwingActions || []).includes(message.action)) {
            /* 模拟扩展重载后已开页面孤儿化：chrome.runtime 调用同步抛错 */
            throw new Error("Extension context invalidated.");
          }
          messages.push(message);
          if (deferredActions.has(message.action)) {
            const callbacks = pendingCallbacks.get(message.action) || [];
            callbacks.push(callback);
            pendingCallbacks.set(message.action, callbacks);
            return;
          }
          callback(responses[message.action] || { ok: true });
          if (message.action === "language:set") {
            for (const listener of runtimeMessageListeners) listener({ action: "language:changed", preference: message.preference }, { id: "test-extension-id" });
          }
        }
      }
    },
    clearTimeout,
    console,
    document,
    FormData,
    globalThis: null,
    location: { href: "http://10.10.10.2/" },
    MutationObserver: FakeMutationObserver,
    queueMicrotask(callback) {
      scheduleMicrotask(() => {
        try {
          callback();
        } catch (error) {
          microtaskErrors.push(error);
        }
      });
    },
    setTimeout
  });
  context.globalThis = context;
  context.DrcomI18n = i18n;
  context.DrcomPortalSession = portalSession;
  context.DrcomPortalUI = {
    ...portalUi,
    shouldTakeOver(input) {
      shouldTakeOverCalls += 1;
      return portalUi.shouldTakeOver(input);
    }
  };
  context.DrcomAppearance = appearance;
  context.DrcomConfirmDialog = {
    async ask(input) {
      confirmations.push(structuredClone(input));
      return options.confirmResult !== false;
    }
  };
  return {
    confirmations,
    context,
    document,
    messages,
    microtaskErrors,
    responses,
    setPageState(nextState) {
      pageState = nextState;
      updatePageText();
    },
    triggerMutation(records) {
      notifyMutation(records || [{ addedNodes: [], removedNodes: [] }]);
    },
    async emitDocument(type, event = {}) {
      for (const listener of documentListeners.get(type) || []) await listener(event);
    },
    resolveDeferred(action, response = responses[action] || { ok: true }) {
      deferredActions.delete(action);
      const callbacks = pendingCallbacks.get(action) || [];
      pendingCallbacks.delete(action);
      callbacks.forEach((callback) => callback(response));
    },
    connectedObserverCount() {
      return observers.filter((observer) => observer.connected).length;
    },
    shouldTakeOverCalls() {
      return shouldTakeOverCalls;
    },
    modernRootMountCount() {
      return modernRootMountCount;
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

async function loadModernizer(harness) {
  const captureSource = readFileSync(join(__dirname, "..", "CRX", "portal-capture.js"), "utf8");
  new vm.Script(captureSource, { filename: "portal-capture.js" }).runInContext(harness.context);
  const source = readFileSync(join(__dirname, "..", "CRX", "portal-modernizer.js"), "utf8");
  new vm.Script(source, { filename: "portal-modernizer.js" }).runInContext(harness.context);  await new Promise((resolve) => setImmediate(resolve));
}

test("现代登录界面挂载后可以立即恢复原始页面", async () => {
  const harness = createHarness();
  await loadModernizer(harness);

  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), true);
  assert.ok(harness.document.getElementById("drcom-modern-root"));

  const restore = harness.document.getElementById("drcom-restore-original");
  await restore.emit("click", { isTrusted: true });

  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), false);
  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
});

test("现代登录表单只在可信提交时交互保存账号并发起认证", async () => {
  const harness = createHarness();
  await loadModernizer(harness);

  harness.document.getElementById("drcom-username").value = "202513010318";
  harness.document.getElementById("drcom-suffix").value = "@telecom";
  harness.document.getElementById("drcom-password").value = "secret";
  harness.document.getElementById("drcom-remember").checked = true;
  const form = harness.document.getElementById("drcom-login-form");
  await form.emit("submit", { isTrusted: true, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    harness.messages.map((message) => message.action),
    ["portal:config:get", "portal:appearance:get", "language:get", "account:save:interactive", "drcom:login", "portal:status:get"]
  );
  assert.match(harness.document.getElementById("drcom-modern-root").innerHTML, /已经连接校园网/);
});

test("后台报告其他账号在线时现代登录页不会误显示登录成功", async () => {
  const harness = createHarness({
    responses: {
      "drcom:login": {
        ok: true,
        success: false,
        online: true,
        accountMismatch: true,
        message: "当前在线的是另一账号，请先注销再登录。"
      }
    }
  });
  await loadModernizer(harness);

  harness.document.getElementById("drcom-username").value = "202513010318";
  harness.document.getElementById("drcom-password").value = "masked";
  await harness.document.getElementById("drcom-login-form").emit("submit", {
    isTrusted: true,
    preventDefault() {}
  });
  await harness.flush();

  assert.match(harness.document.getElementById("drcom-modern-root").innerHTML, /登录校园网/);
  assert.equal(
    harness.document.getElementById("drcom-form-status").textContent,
    "当前在线的是另一账号，请先注销再登录。"
  );
});

test("现代登录表单拒绝合成提交事件", async () => {
  const harness = createHarness();
  await loadModernizer(harness);
  harness.document.getElementById("drcom-username").value = "202513010318";
  harness.document.getElementById("drcom-password").value = "secret";
  await harness.document.getElementById("drcom-login-form").emit("submit", {
    isTrusted: false,
    preventDefault() {}
  });
  await harness.flush();
  assert.equal(harness.messages.some((message) => message.action === "account:save:interactive"), false);
  assert.equal(harness.messages.some((message) => message.action === "drcom:login"), false);
});

test("门户注销、恢复原页和打开设置拒绝合成点击", async () => {
  const harness = createHarness({ online: true });
  await loadModernizer(harness);
  await harness.flush();
  const logout = harness.document.getElementById("drcom-logout");
  const restore = harness.document.getElementById("drcom-restore-original");
  const optionsButton = harness.document.getElementById("drcom-open-options");
  await logout.emit("click", { isTrusted: false });
  await restore.emit("click", { isTrusted: false });
  await optionsButton.emit("click", { isTrusted: false });
  await harness.flush();
  assert.equal(harness.confirmations.length, 0);
  assert.ok(harness.document.getElementById("drcom-modern-root"));
  assert.equal(harness.messages.some((message) => message.action === "options:open"), false);
});

test("在线页面读取脱敏会话并支持手动刷新详情", async () => {
  const harness = createHarness({ online: true });
  await loadModernizer(harness);
  await harness.flush();

  let root = harness.document.getElementById("drcom-modern-root");
  assert.match(root.innerHTML, /125 分钟/);
  assert.match(root.innerHTML, /1\.18 GB/);
  assert.equal(harness.messages.filter((message) => message.action === "portal:status:get").length, 1);

  harness.responses["portal:status:get"] = {
    state: "online",
    phase: "online",
    message: "状态已刷新。",
    checkedAt: Date.UTC(2026, 8, 2, 1, 3),
    session: { usedMinutes: 126, totalKilobytes: 2048 }
  };
  await harness.document.getElementById("drcom-refresh-status").emit("click", { isTrusted: true });
  await harness.flush();

  root = harness.document.getElementById("drcom-modern-root");
  assert.match(root.innerHTML, /126 分钟/);
  assert.match(root.innerHTML, /2\.00 MB/);
  assert.equal(harness.messages.filter((message) => message.action === "portal:status:get").length, 2);
});

test("取消注销确认不会调用后台下线", async () => {
  const harness = createHarness({ online: true, confirmResult: false });
  await loadModernizer(harness);
  await harness.flush();

  await harness.document.getElementById("drcom-logout").emit("click", { isTrusted: true });
  await harness.flush();

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0].message, /注销并解绑 MAC/);
  assert.equal(harness.messages.some((message) => message.action === "drcom:logout"), false);
});

test("扩展重载孤儿化后摘除现代界面并显示刷新引导", async () => {
  const harness = createHarness({ online: true, throwingActions: ["drcom:logout"] });
  await loadModernizer(harness);
  await harness.flush();
  assert.ok(harness.document.getElementById("drcom-modern-root"));

  await harness.document.getElementById("drcom-logout").emit("click", { isTrusted: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.confirmations.length, 1);
  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  assert.ok(harness.document.getElementById("drcom-context-lost-hint"));
  assert.match(harness.document.getElementById("drcom-context-lost-hint").innerHTML, /xzhmu徐医校园网 已更新/);
  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), false);
});

test("后台返回 ok=false 时门户界面显示真实注销错误而不是伪报无响应", async () => {
  const harness = createHarness({
    online: true,
    responses: {
      "drcom:logout": {
        ok: false,
        success: false,
        online: true,
        message: "注销未完成，校园网会话仍然在线。"
      }
    }
  });
  await loadModernizer(harness);

  const logout = harness.document.getElementById("drcom-logout");
  await logout.emit("click", { isTrusted: true });
  await new Promise((resolve) => setImmediate(resolve));

  const root = harness.document.getElementById("drcom-modern-root");
  assert.match(root.innerHTML, /已经连接校园网/);
  assert.equal(
    harness.document.getElementById("drcom-form-status").textContent,
    "注销未完成，校园网会话仍然在线。"
  );
});

test("门户注销进行中禁用操作且失败后恢复", async () => {
  const harness = createHarness({
    online: true,
    deferredActions: ["drcom:logout"]
  });
  await loadModernizer(harness);
  await harness.flush();

  const logout = harness.document.getElementById("drcom-logout");
  const pending = logout.emit("click", { isTrusted: true });
  await harness.flush();

  assert.equal(logout.disabled, true);
  harness.resolveDeferred("drcom:logout", {
    ok: false,
    success: false,
    message: "注销未完成，校园网会话仍然在线。"
  });
  await pending;

  assert.equal(logout.disabled, false);
  assert.equal(
    harness.document.getElementById("drcom-form-status").textContent,
    "注销未完成，校园网会话仍然在线。"
  );
});

test("重置按钮清空现代登录表单并恢复保存选项", async () => {
  const harness = createHarness();
  await loadModernizer(harness);
  const username = harness.document.getElementById("drcom-username");
  const suffix = harness.document.getElementById("drcom-suffix");
  const password = harness.document.getElementById("drcom-password");
  const remember = harness.document.getElementById("drcom-remember");
  username.value = "sample";
  suffix.value = "@cmcc";
  password.value = "masked";
  remember.checked = false;

  await harness.document.getElementById("drcom-reset").emit("click", { isTrusted: true, preventDefault() {} });

  assert.equal(username.value, "");
  assert.equal(suffix.value, "");
  assert.equal(password.value, "");
  assert.equal(remember.checked, true);
});

test("验证码页面保留学校原始控件且只显示非阻断提示", async () => {
  const harness = createHarness({ pageState: "captcha" });
  await loadModernizer(harness);
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  assert.ok(harness.document.getElementById("drcom-captcha-hint"));
  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), false);
  assert.ok(harness.document.querySelector('input[type="password"]'));
  assert.equal(harness.messages.some((message) => message.action === "portal:status:get"), false);
});

test("自定义背景只写入 closed Shadow DOM 且个性化按钮打开设置", async () => {
  const image = "data:image/webp;base64,AAAA";
  const harness = createHarness({
    responses: {
      "portal:appearance:get": {
        ok: true,
        appearance: {
          theme: "dark",
          accent: "#0f766e",
          background: "custom",
          backgroundImage: image,
          backgroundBlur: 18,
          backgroundDim: 0.46,
          backgroundScale: 1.06
        }
      }
    }
  });

  await loadModernizer(harness);

  const root = harness.document.getElementById("drcom-modern-root");
  const host = harness.document.getElementById("drcom-private-appearance");
  assert.ok(host);
  assert.equal(host.shadowRoot, null);
  assert.doesNotMatch(root.innerHTML, /data:image/);
  assert.doesNotMatch(JSON.stringify([...root.style.values]), /data:image/);
  assert.doesNotMatch(JSON.stringify([...host.attributes]), /data:image/);
  assert.match(harness.document.closedShadowRoots.get(host).innerHTML, /data:image\/webp;base64,AAAA/);

  const personalize = harness.document.getElementById("drcom-open-options");
  assert.equal(personalize.getAttribute("aria-label"), "个性化");
  assert.equal(personalize.getAttribute("title"), "个性化");
  await personalize.emit("click", { isTrusted: true });
  assert.equal(harness.messages.at(-1).action, "options:open");
});

test("学校脚本异步渲染登录表单后会接管页面", async () => {
  const harness = createHarness({ pageState: "pending" });
  await loadModernizer(harness);

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  harness.setPageState("login");
  harness.triggerMutation();
  await harness.flush();

  assert.ok(harness.document.getElementById("drcom-modern-root"));
});

test("学校脚本异步渲染在线模板后会接管页面", async () => {
  const harness = createHarness({ pageState: "pending" });
  await loadModernizer(harness);

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  harness.setPageState("online");
  harness.triggerMutation();
  await harness.flush();

  assert.match(harness.document.getElementById("drcom-modern-root").innerHTML, /已经连接校园网/);
});

test("用户恢复原始页后延迟登录成功也不会再次接管", async () => {
  const harness = createHarness({
    pageState: "login",
    deferredActions: ["drcom:login"]
  });
  await loadModernizer(harness);

  harness.document.getElementById("drcom-username").value = "202513010318";
  harness.document.getElementById("drcom-password").value = "masked";
  await harness.document.getElementById("drcom-login-form").emit("submit", { isTrusted: true, preventDefault() {} });
  await harness.flush();
  await harness.document.getElementById("drcom-restore-original").emit("click", { isTrusted: true });
  harness.resolveDeferred("drcom:login");
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
});

test("用户恢复原始页后延迟注销成功也不会再次挂载现代登录页", async () => {
  const harness = createHarness({
    pageState: "online",
    deferredActions: ["drcom:logout"]
  });
  await loadModernizer(harness);
  await harness.flush();
  const initialMountCount = harness.modernRootMountCount();

  const pending = harness.document.getElementById("drcom-logout").emit("click", { isTrusted: true });
  await harness.flush();
  await harness.document.getElementById("drcom-restore-original").emit("click", { isTrusted: true });
  harness.resolveDeferred("drcom:logout", {
    ok: true,
    success: true,
    online: false,
    message: "已下线"
  });
  await pending;
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), false);
  assert.equal(harness.modernRootMountCount(), initialMountCount);
});

test("模板早于配置响应渲染时仍只读取一次配置并接管", async () => {
  const harness = createHarness({
    pageState: "pending",
    deferredActions: ["portal:config:get"]
  });
  await loadModernizer(harness);

  harness.setPageState("login");
  harness.triggerMutation();
  harness.resolveDeferred("portal:config:get");
  await harness.flush();

  assert.ok(harness.document.getElementById("drcom-modern-root"));
  assert.equal(harness.messages.filter((message) => message.action === "portal:config:get").length, 1);
  assert.equal(harness.messages.filter((message) => message.action === "portal:appearance:get").length, 1);
});

test("就绪观察器合并重复变更，并在接管后保留原始请求捕获", async () => {
  const harness = createHarness({ pageState: "pending" });
  await loadModernizer(harness);

  const callsBeforeMutations = harness.shouldTakeOverCalls();
  harness.triggerMutation();
  harness.triggerMutation();
  harness.triggerMutation();
  await harness.flush();

  assert.equal(harness.shouldTakeOverCalls(), callsBeforeMutations + 1);

  harness.setPageState("login");
  harness.triggerMutation();
  await harness.flush();

  assert.ok(harness.document.getElementById("drcom-modern-root"));
  assert.equal(harness.connectedObserverCount(), 1);

  await harness.emitDocument("click", {
    isTrusted: true,
    target: { closest(selector) { return selector === "#drcom-modern-root" ? null : this; } }
  });
  harness.triggerMutation([{
    addedNodes: [{
      tagName: "SCRIPT",
      src: "http://10.10.10.2/?a=login&user_account=sample%40telecom&user_password=masked"
    }]
  }]);
  await harness.flush();

  assert.ok(harness.messages.some((message) => message.action === "account:capture:stage"));
});

test("页面加载脚本和合成点击不能触发原门户账号捕获", async () => {
  const harness = createHarness({ pageState: "pending" });
  await loadModernizer(harness);
  const mutation = [{
    addedNodes: [{
      tagName: "SCRIPT",
      src: "http://10.10.10.2/?a=login&user_account=sample%40telecom&user_password=poisoned"
    }]
  }];
  harness.triggerMutation(mutation);
  await harness.emitDocument("click", { isTrusted: false, target: { closest() { return this; } } });
  harness.triggerMutation(mutation);
  await harness.flush();
  assert.equal(harness.messages.some((message) => message.action === "account:capture:stage"), false);
  assert.equal(harness.messages.some((message) => message.action === "account:save"), false);
});

test("禁用现代门户时只保留原始登录捕获观察器", async () => {
  const harness = createHarness({
    pageState: "pending",
    responses: {
      "portal:config:get": {
        ok: true,
        portal: { enabled: false, title: "徐医校园网", appearance: {} }
      }
    }
  });
  await loadModernizer(harness);

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  assert.equal(harness.connectedObserverCount(), 1);
});

test("接管会在注入现代根节点前断开就绪观察器", async () => {
  const harness = createHarness({ pageState: "login" });
  await loadModernizer(harness);

  assert.equal(harness.modernRootMountCount(), 1);
  assert.equal(harness.shouldTakeOverCalls(), 1);
  assert.equal(harness.connectedObserverCount(), 1);
});

test("异步接管在根节点插入后失败会完整回滚并保留学校页面", async () => {
  const harness = createHarness({ pageState: "login", failPortalEventBinding: true });
  await loadModernizer(harness);
  await harness.flush();

  assert.equal(harness.modernRootMountCount(), 1);
  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), false);
  assert.equal(harness.connectedObserverCount(), 1);
  assert.equal(harness.microtaskErrors.length, 0);
  assert.ok(harness.document.querySelector('input[type="password"]'));
});

test("用户恢复原始页后页面状态变化不会重新挂载或重连就绪观察器", async () => {
  const harness = createHarness({ pageState: "login" });
  await loadModernizer(harness);

  await harness.document.getElementById("drcom-restore-original").emit("click", { isTrusted: true });
  harness.setPageState("online");
  harness.triggerMutation();
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  assert.equal(harness.modernRootMountCount(), 1);
  assert.equal(harness.connectedObserverCount(), 1);
});

test("门户语言切换原位更新文案并保留表单节点、值、焦点和监听器", async () => {
  const harness = createHarness();
  await loadModernizer(harness);
  const root = harness.document.getElementById("drcom-modern-root");
  const username = harness.document.getElementById("drcom-username");
  const suffix = harness.document.getElementById("drcom-suffix");
  const password = harness.document.getElementById("drcom-password");
  const remember = harness.document.getElementById("drcom-remember");
  username.value = "student-18";
  suffix.value = "@telecom";
  password.value = "secret";
  remember.checked = false;
  password.focus();
  const messagesBefore = harness.messages.length;
  const mountsBefore = harness.modernRootMountCount();
  await harness.document.getElementById("drcom-language-toggle").emit("click", { isTrusted: true });
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), root);
  assert.equal(harness.modernRootMountCount(), mountsBefore);
  assert.equal(harness.document.getElementById("drcom-username"), username);
  assert.equal(harness.document.getElementById("drcom-password"), password);
  assert.equal(username.value, "student-18");
  assert.equal(suffix.value, "@telecom");
  assert.equal(password.value, "secret");
  assert.equal(remember.checked, false);
  assert.equal(harness.document.activeElement, password);
  assert.equal(harness.document.documentElement.lang, "en");
  assert.equal(harness.document.getElementById("drcom-restore-original").textContent, "Use original sign-in page");
  assert.deepEqual(harness.messages.slice(messagesBefore).map((message) => message.action), ["language:set"]);
  assert.equal(harness.document.getElementById("drcom-login-form").listeners.has("submit"), true);
});

test("在线门户语言切换复用状态并保留未知网关消息", async () => {
  const harness = createHarness({ online: true, responses: {
    "portal:status:get": { state: "online", message: "未知错误 <734>", checkedAt: 1788339720000, session: { account: "20***18" } }
  } });
  await loadModernizer(harness);
  await harness.flush();
  const root = harness.document.getElementById("drcom-modern-root");
  const status = harness.document.getElementById("drcom-form-status");
  const refreshes = harness.messages.filter((message) => message.action === "portal:status:get").length;
  const mounts = harness.modernRootMountCount();
  await harness.document.getElementById("drcom-language-toggle").emit("click", { isTrusted: true });
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), root);
  assert.equal(harness.modernRootMountCount(), mounts);
  assert.equal(harness.messages.filter((message) => message.action === "portal:status:get").length, refreshes);
  assert.equal(harness.document.getElementById("drcom-state-title").textContent, "Connected to the campus network");
  assert.equal(harness.document.getElementById("drcom-form-status"), status);
  assert.equal(status.textContent, "未知错误 &lt;734&gt;");
  assert.equal(harness.messages.some((message) => ["account:save:interactive", "drcom:login", "drcom:logout", "account:capture:stage"].includes(message.action)), false);
});

test("已知在线状态提示随语言更新而未知消息保持原文", async () => {
  const harness = createHarness({ online: true });
  await loadModernizer(harness);
  await harness.flush();
  const status = harness.document.getElementById("drcom-form-status");
  assert.equal(status.textContent, "当前校园网会话在线。");
  await harness.document.getElementById("drcom-language-toggle").emit("click", { isTrusted: true });
  assert.equal(status.textContent, "Current campus network session is online.");
});

test("在线门户语言切换只更新时长展示节点不替换会话区", async () => {
  const harness = createHarness({ online: true });
  await loadModernizer(harness);
  await harness.flush();
  const root = harness.document.getElementById("drcom-modern-root");
  const details = harness.document.getElementById("drcom-session-details");
  await harness.document.getElementById("drcom-language-toggle").emit("click", { isTrusted: true });
  assert.equal(harness.document.getElementById("drcom-modern-root"), root);
  assert.equal(harness.document.getElementById("drcom-session-details"), details);
  assert.equal(harness.document.getElementById("drcom-used-time").textContent, "125 minutes");
  assert.equal(harness.document.getElementById("drcom-used-minutes-detail").textContent, "125 minutes");
});

test("门户切换只更新已知默认标题而不替换登录表单", async () => {
  const harness = createHarness();
  await loadModernizer(harness);
  const form = harness.document.getElementById("drcom-login-form");
  await harness.document.getElementById("drcom-language-toggle").emit("click", { isTrusted: true });
  assert.equal(harness.document.getElementById("drcom-login-form"), form);
  assert.equal(harness.document.getElementById("drcom-login-title").textContent, "XZHMU Campus Network");
  assert.equal(harness.document.getElementById("drcom-brand-title").textContent, "XZHMU Campus Network");
});

test("门户自身校验提示随语言切换而更新但不提交账号", async () => {
  const harness = createHarness();
  await loadModernizer(harness);
  await harness.document.getElementById("drcom-login-form").emit("submit", { isTrusted: true, preventDefault() {} });
  const status = harness.document.getElementById("drcom-form-status");
  assert.equal(status.textContent, "请输入学号或 DrCOM 账号");
  await harness.document.getElementById("drcom-language-toggle").emit("click", { isTrusted: true });
  assert.equal(status.textContent, "Enter your student ID or DrCOM account");
  assert.equal(harness.messages.some((message) => ["account:save:interactive", "drcom:login"].includes(message.action)), false);
});

test("英文门户注销确认使用英文且取消不发送下线", async () => {
  const harness = createHarness({ online: true, languagePreference: "en", confirmResult: false });
  await loadModernizer(harness);
  await harness.flush();
  await harness.document.getElementById("drcom-logout").emit("click", { isTrusted: true });
  assert.equal(harness.confirmations[0].title, "Sign out of the current campus connection?");
  assert.equal(harness.confirmations[0].confirmLabel, "Sign out and unbind MAC");
  assert.equal(harness.messages.some((message) => message.action === "drcom:logout"), false);
});

test("Chrome 与 Firefox 在门户代码前加载共享语言资源", () => {
  for (const file of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "CRX", file), "utf8"));
    const scripts = manifest.content_scripts[0].js;
    assert.ok(scripts.indexOf("i18n-messages.js") >= 0, `${file} 缺少共享词典`);
    assert.ok(scripts.indexOf("i18n.js") > scripts.indexOf("i18n-messages.js"), `${file} 语言 API 加载顺序错误`);
    assert.ok(scripts.indexOf("i18n.js") < scripts.indexOf("account-utils.js"), `${file} 语言 API 必须先于门户代码`);
  }
});
