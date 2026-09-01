"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const portalUi = require(join(__dirname, "..", "CRX", "portal-ui.js"));
const appearance = require(join(__dirname, "..", "CRX", "appearance.js"));

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

  attachShadow(options = {}) {
    const shadow = { mode: options.mode, innerHTML: "" };
    this.document.closedShadowRoots.set(this, shadow);
    if (options.mode !== "closed") this.shadowRoot = shadow;
    return shadow;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.childrenById.clear();
    const tags = this._innerHTML.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi);
    for (const match of tags) {
      const id = match[2].match(/\bid="([^"]+)"/i)?.[1];
      if (!id) continue;
      const element = new FakeElement(this.document, match[1], id);
      element.checked = /\bchecked\b/i.test(match[2]);
      for (const attribute of match[2].matchAll(/\b([a-z][a-z0-9-]*)="([^"]*)"/gi)) {
        element.setAttribute(attribute[1], attribute[2]);
      }
      this.childrenById.set(id, element);
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
  const roots = new Map();
  const observers = [];
  const deferredActions = new Set(options.deferredActions || []);
  const pendingCallbacks = new Map();
  const microtaskErrors = [];
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
    documentElement,
    body: {
      innerText: "",
      append(element) {
        roots.set(element.id, element);
        if (element.id === "drcom-modern-root") modernRootMountCount += 1;
        notifyMutation([{ addedNodes: [element], removedNodes: [] }]);
      }
    },
    addEventListener() {},
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
      if (selector === 'input[type="password"]') return pageState === "login" ? originalPassword : null;
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
    "portal:config:get": {
      ok: true,
      portal: { enabled: true, title: "徐医校园网", appearance: { theme: "light", accent: "#0f766e" } }
    },
    "portal:appearance:get": {
      ok: true,
      appearance: { theme: "light", accent: "#0f766e", background: "fresh", backgroundImage: "" }
    },
    "account:save": { ok: true, accountId: "saved-account" },
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
        lastError: null,
        sendMessage(message, callback) {
          messages.push(message);
          if (deferredActions.has(message.action)) {
            const callbacks = pendingCallbacks.get(message.action) || [];
            callbacks.push(callback);
            pendingCallbacks.set(message.action, callbacks);
            return;
          }
          callback(responses[message.action] || { ok: true });
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
  context.DrcomPortalUI = {
    ...portalUi,
    shouldTakeOver(input) {
      shouldTakeOverCalls += 1;
      return portalUi.shouldTakeOver(input);
    }
  };
  context.DrcomAppearance = appearance;
  return {
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
  const source = readFileSync(join(__dirname, "..", "CRX", "portal-modernizer.js"), "utf8");
  new vm.Script(source, { filename: "portal-modernizer.js" }).runInContext(harness.context);
  await new Promise((resolve) => setImmediate(resolve));
}

test("现代登录界面挂载后可以立即恢复原始页面", async () => {
  const harness = createHarness();
  await loadModernizer(harness);

  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), true);
  assert.ok(harness.document.getElementById("drcom-modern-root"));

  const restore = harness.document.getElementById("drcom-restore-original");
  await restore.emit("click");

  assert.equal(harness.document.documentElement.classList.contains("drcom-modern-active"), false);
  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
});

test("现代登录表单保存账号后发起认证并切换到在线状态", async () => {
  const harness = createHarness();
  await loadModernizer(harness);

  harness.document.getElementById("drcom-username").value = "202513010318";
  harness.document.getElementById("drcom-suffix").value = "@telecom";
  harness.document.getElementById("drcom-password").value = "secret";
  harness.document.getElementById("drcom-remember").checked = true;
  const form = harness.document.getElementById("drcom-login-form");
  await form.emit("submit", { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    harness.messages.map((message) => message.action),
    ["portal:config:get", "portal:appearance:get", "account:save", "drcom:login"]
  );
  assert.match(harness.document.getElementById("drcom-modern-root").innerHTML, /已经连接校园网/);
});

test("下线认证失败时门户界面保持在线并显示错误", async () => {
  const harness = createHarness({
    online: true,
    responses: {
      "drcom:logout": { ok: true, success: false, online: true, message: "下线失败" }
    }
  });
  await loadModernizer(harness);

  const logout = harness.document.getElementById("drcom-logout");
  await logout.emit("click");
  await new Promise((resolve) => setImmediate(resolve));

  const root = harness.document.getElementById("drcom-modern-root");
  assert.match(root.innerHTML, /已经连接校园网/);
  assert.equal(harness.document.getElementById("drcom-form-status").textContent, "下线失败");
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
  await personalize.emit("click");
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
  await harness.document.getElementById("drcom-login-form").emit("submit", { preventDefault() {} });
  await harness.flush();
  await harness.document.getElementById("drcom-restore-original").emit("click");
  harness.resolveDeferred("drcom:login");
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
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

  harness.triggerMutation([{
    addedNodes: [{
      tagName: "SCRIPT",
      src: "http://10.10.10.2/?a=login&user_account=sample%40telecom&user_password=masked"
    }]
  }]);
  await harness.flush();

  assert.ok(harness.messages.some((message) => message.action === "account:save"));
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

  await harness.document.getElementById("drcom-restore-original").emit("click");
  harness.setPageState("online");
  harness.triggerMutation();
  await harness.flush();

  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  assert.equal(harness.modernRootMountCount(), 1);
  assert.equal(harness.connectedObserverCount(), 1);
});
