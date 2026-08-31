"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const utils = require(join(__dirname, "..", "CRX", "portal-diagnostics-utils.js"));
const diagnosticsPath = join(__dirname, "..", "CRX", "portal-diagnostics.js");

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.id = attributes.id || "";
    this.attributes = new Map(Object.entries(attributes));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

function createHarness(options = {}) {
  const listeners = new Map();
  const mutationObservers = [];
  const performanceObservers = [];
  const sent = [];
  const timers = new Map();
  const controls = options.controls || [
    new FakeElement("form", { id: "login-form" }),
    new FakeElement("input", { id: "student-account", name: "user_account", type: "text" }),
    new FakeElement("input", { id: "password", name: "user_password", type: "password" }),
    new FakeElement("button", { id: "login-button", type: "submit", "aria-label": "登录" })
  ];
  const passwordInput = controls.find((element) => element.getAttribute("type") === "password");
  for (const control of controls) {
    Object.defineProperty(control, "value", {
      get() { throw new Error("诊断脚本不得读取任何 control.value"); }
    });
  }
  let now = 0;
  let timerId = 0;
  const resourceEntries = options.resourceEntries || [];
  const responses = {
    "diagnostics:status": { ok: true, enabled: options.enabled === true },
    "diagnostics:start": { ok: true, enabled: true, sessionId: "session-1" },
    "diagnostics:append": { ok: true, stored: true },
    "diagnostics:end": { ok: true, ended: true },
    ...(options.responses || {})
  };
  const messageFailures = [...(options.messageFailures || [])];
  const document = {
    title: options.title || "校园网登录",
    documentElement: { nodeType: 1, tagName: "HTML" },
    addEventListener(type, listener, capture) {
      const current = listeners.get(type) || [];
      current.push({ listener, capture });
      listeners.set(type, current);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "form, input, select, button, a");
      return controls;
    }
  };
  const context = vm.createContext({
    URL,
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          sent.push(JSON.parse(JSON.stringify(message)));
          const failure = message.action === "diagnostics:append" ? messageFailures.shift() : null;
          if (failure) {
            context.chrome.runtime.lastError = { message: failure };
            callback(undefined);
            context.chrome.runtime.lastError = null;
            return;
          }
          const response = typeof responses[message.action] === "function"
            ? responses[message.action](message)
            : responses[message.action];
          callback(response || { ok: true });
        }
      }
    },
    console,
    document,
    globalThis: null,
    location: { origin: options.origin || "http://10.10.10.2", href: options.url || "http://10.10.10.2/eportal/?uid=202600000001" },
    performance: { getEntriesByType(type) { return type === "resource" ? resourceEntries : []; } },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; mutationObservers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; }
    },
    PerformanceObserver: class {
      constructor(callback) { this.callback = callback; performanceObservers.push(this); }
      observe(options) { this.options = options; }
      disconnect() { this.disconnected = true; }
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, due: now + Number(delay || 0) });
      return id;
    }
  });
  context.globalThis = context;
  context.DrcomPortalDiagnosticsUtils = utils;

  return {
    context, controls, document, mutationObservers, passwordInput, performanceObservers, sent,
    async advance(milliseconds) {
      now += milliseconds;
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= now);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      await flush();
    },
    async emit(type, target) {
      for (const { listener } of listeners.get(type) || []) listener({ target });
      await flush();
    },
    async emitMutations() {
      for (const observer of mutationObservers) observer.callback([{ type: "childList" }]);
      await flush();
    },
    async emitResources(entries) {
      for (const observer of performanceObservers) observer.callback({ getEntries: () => entries });
      await flush();
    }
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadDiagnostics(harness) {
  const source = readFileSync(diagnosticsPath, "utf8");
  new vm.Script(source, { filename: "portal-diagnostics.js" }).runInContext(harness.context);
  await flush();
}

function records(harness, type) {
  return harness.sent
    .filter((message) => message.action === "diagnostics:append")
    .map((message) => message.record)
    .filter((record) => !type || record.type === type);
}

test("诊断关闭时不创建观察器也不记录事件", async () => {
  const harness = createHarness({ enabled: false });
  await loadDiagnostics(harness);
  await harness.emit("click", harness.passwordInput);

  assert.deepEqual(harness.sent.map((item) => item.action), ["diagnostics:status"]);
  assert.equal(harness.mutationObservers.length, 0);
  assert.equal(harness.performanceObservers.length, 0);
});

test("诊断只记录密码框结构且从不读取值", async () => {
  const harness = createHarness({ enabled: true });
  await loadDiagnostics(harness);
  await harness.emit("focus", harness.passwordInput);

  const focus = records(harness, "focus").at(-1);
  assert.equal(focus.target.type, "password");
  assert.equal("value" in focus.target, false);
});

test("启用的会话记录结构事件并以安全页面数据启动", async () => {
  const harness = createHarness({ enabled: true });
  await loadDiagnostics(harness);
  const [form, account, , button] = harness.controls;
  await harness.emit("click", button);
  await harness.emit("submit", form);
  await harness.emit("change", account);
  await harness.emit("focus", account);

  assert.deepEqual(harness.sent.slice(0, 2).map((message) => message.action), ["diagnostics:status", "diagnostics:start"]);
  assert.deepEqual(records(harness).map((record) => record.type), ["dom", "click", "submit", "change", "focus"]);
  assert.equal(harness.sent[1].page.url, "http://10.10.10.2/eportal/?uid=%5Bredacted%5D");
  assert.equal(harness.mutationObservers[0].target, harness.document.documentElement);
  assert.equal(harness.mutationObservers[0].options.childList, true);
  assert.equal(harness.mutationObservers[0].options.subtree, true);
});

test("DOM 变动会在 250 ms 后合并为一条新摘要", async () => {
  const harness = createHarness({ enabled: true });
  await loadDiagnostics(harness);
  await harness.emitMutations();
  await harness.emitMutations();
  await harness.advance(249);
  assert.equal(records(harness, "mutation").length, 0);

  await harness.advance(1);
  assert.equal(records(harness, "mutation").length, 1);
  assert.ok(records(harness, "mutation")[0].summary.length <= 64 * 1024);
});

test("资源记录保留经过净化的 URL 与数值元数据", async () => {
  const harness = createHarness({
    enabled: true,
    resourceEntries: [{ name: "http://192.0.2.15/private/202600000001?token=secret", initiatorType: "script", responseStatus: 204, duration: 12.5 }]
  });
  await loadDiagnostics(harness);
  await harness.emitResources([{ name: "http://10.10.10.2/assets/app.js?token=secret", initiatorType: "link", responseStatus: 200, duration: 3 }]);

  const resource = records(harness, "resource");
  assert.equal(resource.length, 2);
  assert.equal(resource[0].type, "resource");
  assert.equal(resource[0].url, "http://[redacted-ip]/private/[redacted-id]?token=%5Bredacted%5D");
  assert.equal(resource[0].initiatorType, "script");
  assert.equal(resource[0].status, 204);
  assert.equal(resource[0].duration, 12.5);
  assert.equal(resource[1].url, "http://10.10.10.2/assets/app.js?token=%5Bredacted%5D");
  assert.equal(resource[1].initiatorType, "link");
  assert.equal(resource[1].status, 200);
  assert.equal(resource[1].duration, 3);
});

test("资源加载错误只记录元素描述", async () => {
  const harness = createHarness({ enabled: true });
  await loadDiagnostics(harness);
  const image = new FakeElement("img", { id: "logo", src: "http://10.10.10.2/assets/logo.png?token=secret" });
  await harness.emit("error", image);

  assert.deepEqual(records(harness, "resource-error").at(-1).target, {
    tag: "img", id: "logo", name: "", type: "", role: "", ariaLabel: ""
  });
});

test("pagehide 会记录结束事件且只结束一次", async () => {
  const harness = createHarness({ enabled: true });
  await loadDiagnostics(harness);
  await harness.emit("pagehide", harness.document.documentElement);
  await harness.emit("pagehide", harness.document.documentElement);

  assert.equal(records(harness, "pagehide").length, 1);
  assert.equal(harness.sent.filter((message) => message.action === "diagnostics:end").length, 1);
  assert.equal(harness.mutationObservers[0].disconnected, true);
  assert.equal(harness.performanceObservers[0].disconnected, true);
});

test("离线消息失败时保留至多 20 条记录并按队列顺序恢复", async () => {
  const harness = createHarness({ enabled: true, messageFailures: Array(23).fill("offline") });
  await loadDiagnostics(harness);
  const [, account, , button] = harness.controls;
  for (let index = 0; index < 22; index += 1) await harness.emit("click", index % 2 ? account : button);
  await harness.emit("focus", account);

  const appended = harness.sent.filter((message) => message.action === "diagnostics:append");
  assert.ok(appended.length >= 43);
  assert.deepEqual(records(harness).slice(-20).map((record) => record.type), Array(19).fill("click").concat(["focus"]));
});

test("对抗性页面文字、属性、标题和 URL 永远不会进入发送消息", async () => {
  const secret = "202600000001 192.0.2.15 00:11:22:33:44:55 password=very-secret-value student@example.com Ab9xY7zQ2mN8pL4rT6vK";
  const harness = createHarness({
    enabled: true,
    title: secret,
    url: `http://10.10.10.2/eportal/${secret}?token=${secret}`,
    controls: [
      new FakeElement("input", { id: secret, name: secret, type: "password", "aria-label": secret }),
      new FakeElement("button", { id: "safe" })
    ]
  });
  Object.defineProperty(harness.document, "body", { get() { throw new Error("诊断脚本不得读取页面文本"); } });
  await loadDiagnostics(harness);
  await harness.emit("focus", harness.passwordInput);

  const serialized = JSON.stringify(harness.sent);
  for (const value of ["202600000001", "192.0.2.15", "00:11:22:33:44:55", "very-secret-value", "student@example.com", "Ab9xY7zQ2mN8pL4rT6vK"]) {
    assert.doesNotMatch(serialized, new RegExp(value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});
