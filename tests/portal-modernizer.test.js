"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const portalUi = require(join(__dirname, "..", "CRX", "portal-ui.js"));

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
    if (selector.startsWith("#")) return this.childrenById.get(selector.slice(1)) || null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector !== "button, input, select") return [];
    return Array.from(this.childrenById.values()).filter((element) =>
      ["BUTTON", "INPUT", "SELECT"].includes(element.tagName)
    );
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
  const originalUsername = { value: "" };
  const originalPassword = { value: "" };
  const documentElement = {
    classList: new FakeClassList(),
    innerText: "",
    style: { setProperty() {} }
  };
  const document = {
    readyState: "complete",
    documentElement,
    body: {
      innerText: options.online ? "当前已连接，可以下线" : "",
      append(element) {
        roots.set(element.id, element);
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
      if (selector === 'input[type="password"]') return options.online ? null : originalPassword;
      if (options.online && /logout/i.test(selector)) return { value: "" };
      if (/DDDDD|user_account|username/i.test(selector)) return originalUsername;
      if (/upass|user_password|password|0MKKey/i.test(selector)) return originalPassword;
      return null;
    },
    removeRoot(root) {
      roots.delete(root.id);
    }
  };
  const responses = {
    "portal:config:get": {
      ok: true,
      portal: { enabled: true, title: "徐医校园网", accent: "#0f766e" }
    },
    "account:save": { ok: true, accountId: "saved-account" },
    "drcom:login": { ok: true, success: true, online: true, message: "登录成功" },
    "drcom:logout": { ok: true, success: true, online: false, message: "已下线" },
    "redirect:markPortalTab": { ok: true },
    ...(options.responses || {})
  };
  const context = vm.createContext({
    AbortController,
    URL,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(message);
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
    MutationObserver: class {
      observe() {}
    },
    setTimeout
  });
  context.globalThis = context;
  context.DrcomPortalUI = portalUi;
  return { context, document, messages, responses };
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
    ["portal:config:get", "account:save", "drcom:login"]
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
