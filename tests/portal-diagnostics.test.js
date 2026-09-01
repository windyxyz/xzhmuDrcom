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
  const delivered = [];
  const callbacks = [];
  const timers = new Map();
  const deferredActions = new Set(options.deferredActions || []);
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
  const messageFailures = [...(options.messageFailures || options.appendFailures || [])];
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
          const copy = JSON.parse(JSON.stringify(message));
          sent.push(copy);
          if (deferredActions.has(message.action)) {
            callbacks.push({ message: copy, callback });
            return;
          }
          const failure = message.action === "diagnostics:append" ? messageFailures.shift() : null;
          if (failure) {
            context.chrome.runtime.lastError = { message: String(failure) };
            callback(undefined);
            context.chrome.runtime.lastError = null;
            return;
          }
          const response = typeof responses[message.action] === "function"
            ? responses[message.action](message)
            : responses[message.action];
          delivered.push(copy);
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
    callbacks, context, controls, delivered, document, mutationObservers, passwordInput, performanceObservers, sent,
    async advance(milliseconds) {
      now += milliseconds;
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= now);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      await flush();
    },
    async emit(type, target = document.documentElement) {
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
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    async resolveNext(action, response) {
      const index = callbacks.findIndex((item) => item.message.action === action);
      assert.notEqual(index, -1, `missing deferred ${action}`);
      const { message, callback } = callbacks.splice(index, 1)[0];
      delivered.push(message);
      callback(response || responses[action] || { ok: true });
      await flush();
    },
    async rejectNext(action) {
      const index = callbacks.findIndex((item) => item.message.action === action);
      assert.notEqual(index, -1, `missing deferred ${action}`);
      const { callback } = callbacks.splice(index, 1)[0];
      context.chrome.runtime.lastError = { message: "offline" };
      callback(undefined);
      context.chrome.runtime.lastError = null;
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

test("初始注销结构在不读取文案或控件值时识别为在线页", async () => {
  const logout = new FakeElement("button", { name: "logout", type: "button" });
  const harness = createHarness({ enabled: true, controls: [logout] });
  Object.defineProperty(harness.document, "body", {
    get() { throw new Error("诊断页型识别不得读取页面文案"); }
  });
  await loadDiagnostics(harness);

  const start = harness.sent.find((message) => message.action === "diagnostics:start");
  assert.equal(start.page.pageKind, "online");
  assert.equal(records(harness, "dom")[0].pageKind, "online");
});

test("延迟出现的注销本地化标记会把变更记录识别为在线页", async () => {
  const harness = createHarness({ enabled: true, controls: [] });
  Object.defineProperty(harness.document, "body", {
    get() { throw new Error("诊断页型识别不得读取页面文案"); }
  });
  await loadDiagnostics(harness);
  harness.controls.push(new FakeElement("button", { "data-localize": "portal.logout.action" }));
  await harness.emitMutations();
  await harness.advance(250);

  const mutation = records(harness, "mutation")[0];
  assert.equal(mutation.pageKind, "online");
  assert.match(mutation.summary, /"pageKind":"online"/);
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

test("记录器发送前隐藏 URL 键、主机标签和两类不透明令牌", async () => {
  const harness = createHarness({
    enabled: true,
    url: "http://10.10.10.2/?202600000001=value",
    resourceEntries: [{
      name: "https://202600000001.example.test/assets/abcdef0123456789abcdef0123456789.js?202600000001=value",
      initiatorType: "script",
      responseStatus: 200,
      duration: 1
    }]
  });
  await loadDiagnostics(harness);

  const start = harness.sent.find((message) => message.action === "diagnostics:start");
  const resource = records(harness, "resource")[0];
  assert.equal(start.page.url, "http://10.10.10.2/?redacted-id=%5Bredacted%5D");
  assert.equal(
    resource.url,
    "https://redacted-id.example.test/assets/[redacted-secret].js?redacted-id=%5Bredacted%5D"
  );
  assert.doesNotMatch(JSON.stringify(harness.sent), /202600000001|abcdef0123456789abcdef0123456789/);
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
  const harness = createHarness({ enabled: true, deferredActions: ["diagnostics:start"] });
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
  const harness = createHarness({ enabled: true, deferredActions: ["diagnostics:append"] });
  await loadDiagnostics(harness);
  assert.equal(harness.sent.at(-1).action, "diagnostics:append");
  await harness.emit("pagehide");
  assert.equal(harness.sent.some((message) => message.action === "diagnostics:end"), false);

  await harness.resolveNext("diagnostics:append");
  await harness.resolveNext("diagnostics:append");
  assert.deepEqual(harness.sent.map((message) => message.action), ["diagnostics:status", "diagnostics:start", "diagnostics:append", "diagnostics:append", "diagnostics:end"]);
});

test("pagehide 在活动 append 首次失败后有界重试 FIFO 队列再结束", async () => {
  const harness = createHarness({ enabled: true, deferredActions: ["diagnostics:append"] });
  await loadDiagnostics(harness);
  await harness.emit("pagehide");
  await harness.rejectNext("diagnostics:append");
  assert.equal(harness.sent.some((message) => message.action === "diagnostics:end"), false);

  await harness.resolveNext("diagnostics:append");
  await harness.resolveNext("diagnostics:append");
  assert.deepEqual(harness.sent.map((message) => message.action), ["diagnostics:status", "diagnostics:start", "diagnostics:append", "diagnostics:append", "diagnostics:append", "diagnostics:end"]);
  assert.deepEqual(harness.delivered.filter((message) => message.action === "diagnostics:append").map((message) => message.record.type), ["dom", "pagehide"]);
});

test("失败队列精确保留最近 20 条不同控件记录并按 FIFO 恢复", async () => {
  const controls = Array.from({ length: 23 }, (_, index) =>
    new FakeElement("button", { id: `control-${String(index + 1).padStart(2, "0")}` })
  );
  const harness = createHarness({ enabled: true, controls, appendFailures: Array(22).fill("offline") });
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

test("后台明确拒绝或未存储 append 时记录器进入暂停且不继续发送", async () => {
  for (const response of [
    { ok: false, stored: false, paused: true, error: "quota" },
    { ok: true, stored: false }
  ]) {
    let appendCalls = 0;
    const harness = createHarness({
      enabled: true,
      responses: {
        "diagnostics:append": () => {
          appendCalls += 1;
          return response;
        }
      }
    });
    await loadDiagnostics(harness);
    await harness.emit("click", harness.controls.at(-1));
    await harness.emit("focus", harness.controls.at(-1));

    assert.equal(appendCalls, 1);
  }
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
