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
    Object.defineProperty(this, "value", {
      get() { throw new Error("诊断脚本不得读取任何 control.value"); }
    });
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

function createHarness(options = {}) {
  const listeners = new Map();
  const sent = [];
  const delivered = [];
  const callbacks = [];
  const mutationObservers = [];
  const performanceObservers = [];
  const deferredActions = new Set(options.deferredActions || []);
  const failures = [...(options.appendFailures || [])];
  const controls = options.controls || [
    new FakeElement("input", { id: "account", name: "user_account", type: "text" }),
    new FakeElement("input", { id: "password", name: "user_password", type: "password" }),
    new FakeElement("button", { id: "login" })
  ];
  const responses = {
    "diagnostics:status": { ok: true, enabled: options.enabled !== false },
    "diagnostics:start": { ok: true, sessionId: "session-1" },
    "diagnostics:append": { ok: true },
    "diagnostics:end": { ok: true },
    ...(options.responses || {})
  };
  const document = {
    title: options.title || "safe title",
    documentElement: { nodeType: 1, tagName: "HTML" },
    addEventListener(type, listener, capture) {
      const entries = listeners.get(type) || [];
      entries.push({ listener, capture });
      listeners.set(type, entries);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "form, input, select, button, a");
      return controls;
    }
  };
  const context = vm.createContext({
    URL,
    chrome: { runtime: {
      lastError: null,
      sendMessage(message, callback) {
        const copy = JSON.parse(JSON.stringify(message));
        sent.push(copy);
        if (deferredActions.has(message.action)) {
          callbacks.push({ message: copy, callback });
          return;
        }
        if (message.action === "diagnostics:append" && failures.shift()) {
          context.chrome.runtime.lastError = { message: "offline" };
          callback(undefined);
          context.chrome.runtime.lastError = null;
          return;
        }
        delivered.push(copy);
        callback(responses[message.action] || { ok: true });
      }
    } },
    clearTimeout() {},
    document,
    globalThis: null,
    location: { origin: "http://10.10.10.2", href: options.url || "http://10.10.10.2/eportal/?token=secret" },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; mutationObservers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    PerformanceObserver: class {
      constructor(callback) { this.callback = callback; performanceObservers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    performance: { getEntriesByType() { return options.resourceEntries || []; } },
    setTimeout() { return 1; }
  });
  context.globalThis = context;
  context.DrcomPortalDiagnosticsUtils = utils;

  return {
    callbacks, controls, delivered, document, mutationObservers, performanceObservers, sent,
    async emit(type, target = document.documentElement) {
      for (const { listener } of listeners.get(type) || []) listener({ target });
      await settle();
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    async resolveNext(action, response) {
      const index = callbacks.findIndex((item) => item.message.action === action);
      assert.notEqual(index, -1, `missing deferred ${action}`);
      const { message, callback } = callbacks.splice(index, 1)[0];
      delivered.push(message);
      callback(response || responses[action] || { ok: true });
      await settle();
    },
    context
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadDiagnostics(harness) {
  new vm.Script(readFileSync(diagnosticsPath, "utf8"), { filename: "portal-diagnostics.js" }).runInContext(harness.context);
  await settle();
}

test("pagehide 在 status 等待期间阻止后续 start、append 和 end", async () => {
  const harness = createHarness({ deferredActions: ["diagnostics:status"] });
  await loadDiagnostics(harness);
  assert.equal(harness.listenerCount("pagehide"), 1);
  await harness.emit("pagehide");
  await harness.resolveNext("diagnostics:status", { ok: true, enabled: true });

  assert.deepEqual(harness.sent.map((message) => message.action), ["diagnostics:status"]);
  assert.equal(harness.mutationObservers.length, 0);
  assert.equal(harness.performanceObservers.length, 0);
});

test("pagehide 在 start 等待期间只结束已创建会话且不安装记录器", async () => {
  const harness = createHarness({ deferredActions: ["diagnostics:start"] });
  await loadDiagnostics(harness);
  assert.equal(harness.listenerCount("pagehide"), 1);
  await harness.emit("pagehide");
  await harness.resolveNext("diagnostics:start", { ok: true, sessionId: "late-session" });
  await harness.emit("pagehide");

  assert.deepEqual(harness.sent.map((message) => message.action), ["diagnostics:status", "diagnostics:start", "diagnostics:end"]);
  assert.equal(harness.sent.at(-1).sessionId, "late-session");
  assert.equal(harness.mutationObservers.length, 0);
  assert.equal(harness.performanceObservers.length, 0);
});

test("pagehide 等待活动 FIFO 刷新完成后才结束会话", async () => {
  const harness = createHarness({ deferredActions: ["diagnostics:append"] });
  await loadDiagnostics(harness);
  assert.equal(harness.sent.at(-1).action, "diagnostics:append");
  await harness.emit("pagehide");
  assert.equal(harness.sent.some((message) => message.action === "diagnostics:end"), false);

  await harness.resolveNext("diagnostics:append");
  await harness.resolveNext("diagnostics:append");
  assert.deepEqual(harness.sent.map((message) => message.action), ["diagnostics:status", "diagnostics:start", "diagnostics:append", "diagnostics:append", "diagnostics:end"]);
});

test("失败队列精确保留最近 20 条不同控件记录并按 FIFO 恢复", async () => {
  const controls = Array.from({ length: 23 }, (_, index) => new FakeElement("button", { id: `control-${String(index + 1).padStart(2, "0")}` }));
  const harness = createHarness({ controls, appendFailures: Array(22).fill(true) });
  await loadDiagnostics(harness);
  for (const control of controls.slice(0, 22)) await harness.emit("click", control);
  await harness.emit("focus", controls[22]);

  const delivered = harness.delivered.filter((message) => message.action === "diagnostics:append");
  assert.equal(delivered.length, 21);
  assert.deepEqual(delivered.slice(1).map((message) => message.record.target.id), [
    "control-04", "control-05", "control-06", "control-07", "control-08", "control-09", "control-10", "control-11", "control-12", "control-13",
    "control-14", "control-15", "control-16", "control-17", "control-18", "control-19", "control-20", "control-21", "control-22", "control-23"
  ]);
});

test("资源记录使用 initiatorType，并且所有控件值和页面机密都不会泄露", async () => {
  const secret = "202600000001 192.0.2.15 00:11:22:33:44:55 password=private student@example.com Ab9xY7zQ2mN8pL4rT6vK";
  const harness = createHarness({
    title: secret,
    url: `http://10.10.10.2/eportal/${secret}?token=${secret}`,
    controls: [new FakeElement("input", { id: secret, name: secret, type: "password", "aria-label": secret })],
    resourceEntries: [{ name: "http://10.10.10.2/static/app.js?token=secret", initiatorType: "script", responseStatus: 0, duration: 2.5 }]
  });
  Object.defineProperty(harness.document, "body", { get() { throw new Error("不得读取页面文本"); } });
  await loadDiagnostics(harness);
  await harness.emit("focus", harness.controls[0]);

  const focus = harness.sent.find((message) => message.action === "diagnostics:append" && message.record.type === "focus");
  assert.equal("value" in focus.record.target, false);
  const resource = harness.sent.find((message) => message.action === "diagnostics:append" && message.record.type === "resource").record;
  assert.equal(resource.initiatorType, "script");
  assert.equal(resource.status, 0);
  assert.equal(resource.duration, 2.5);
  assert.equal("method" in resource, false);
  const serialized = JSON.stringify(harness.sent);
  for (const raw of ["202600000001", "192.0.2.15", "00:11:22:33:44:55", "private", "student@example.com", "Ab9xY7zQ2mN8pL4rT6vK"]) assert.doesNotMatch(serialized, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("资源记录以 initiatorType 传递安全数值字段", async () => {
  const record = utils.sanitizeRecord({ type: "resource", initiatorType: "script", status: 0, duration: 2.5 });
  assert.equal(record.initiatorType, "script");
  assert.equal(record.status, 0);
  assert.equal(record.duration, 2.5);
  assert.equal("method" in record, false);
});
