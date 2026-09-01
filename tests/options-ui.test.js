"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadOptions(context) {
  for (const file of ["account-utils.js", "options.js"]) {
    const source = readFileSync(join(__dirname, "..", "CRX", file), "utf8");
    new vm.Script(source, { filename: file }).runInContext(context);
  }
}

function createOptionsHarness(options = {}) {
  const messages = [];
  const confirmations = [];
  const elements = new Map(Object.entries({
    "portal-diagnostics-enabled": { checked: false, disabled: false },
    "portal-diagnostics-status": { textContent: "" },
    "portal-diagnostics-storage": { textContent: "" },
    "portal-diagnostics-sessions": { textContent: "" },
    "portal-diagnostics-dropped": { textContent: "" },
    "export-portal-diagnostics": { disabled: false },
    "clear-portal-diagnostics": { disabled: false },
    toast: { hidden: true, textContent: "" }
  }));
  const diagnostics = options.diagnostics || {
    ok: true,
    enabled: false,
    bytes: 0,
    sessionCount: 0,
    limits: { bytes: 1024 * 1024, sessions: 10 },
    sessions: []
  };
  const context = vm.createContext({
    Blob,
    URL: options.URL || URL,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(structuredClone(message));
          if (options.sendMessage) {
            Promise.resolve().then(() => options.sendMessage(message)).then(callback, (error) => {
              context.chrome.runtime.lastError = { message: error.message };
              callback();
              context.chrome.runtime.lastError = null;
            });
            return;
          }
          if (message.action === "diagnostics:get") callback(diagnostics);
          else if (message.action === "diagnostics:export") callback({ ok: true, export: options.export || diagnostics });
          else if (message.action === "diagnostics:clear") callback({ ok: true });
          else if (message.action === "diagnostics:set") callback({ ok: true, enabled: message.enabled, limits: diagnostics.limits });
          else callback({ ok: true });
        }
      }
    },
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) { return elements.get(id) || null; },
      createElement() {
        return { click() {} };
      }
    },
    DrcomConfirmDialog: {
      async ask(input) {
        confirmations.push(structuredClone(input));
        return options.confirmResult !== false;
      }
    },
    setTimeout
  });
  loadOptions(context);
  return { confirmations, context, elements, messages };
}

test("门户诊断加载会显示精确开关、占用和会话状态", async () => {
  const harness = createOptionsHarness({ diagnostics: {
    ok: true,
    enabled: true,
    bytes: 1536,
    sessionCount: 2,
    droppedRecords: 3,
    paused: false,
    limits: { bytes: 1024 * 1024, sessions: 10 },
    sessions: []
  } });
  await harness.context.loadPortalDiagnostics();
  assert.equal(harness.elements.get("portal-diagnostics-enabled").checked, true);
  assert.equal(harness.elements.get("portal-diagnostics-status").textContent, "诊断模式已开启");
  assert.equal(harness.elements.get("portal-diagnostics-storage").textContent, "1.5 KB / 1 MiB");
  assert.equal(harness.elements.get("portal-diagnostics-sessions").textContent, "2 / 10");
  assert.equal(harness.elements.get("portal-diagnostics-dropped").textContent, "3 条");
});

test("门户诊断暂停和淘汰状态会明确显示", async () => {
  const harness = createOptionsHarness({ diagnostics: {
    ok: true,
    enabled: true,
    bytes: 4096,
    sessionCount: 1,
    droppedRecords: 7,
    paused: true,
    limits: { bytes: 1024 * 1024, sessions: 10 },
    sessions: []
  } });
  await harness.context.loadPortalDiagnostics();

  assert.equal(harness.elements.get("portal-diagnostics-status").textContent, "诊断记录已暂停");
  assert.equal(harness.elements.get("portal-diagnostics-dropped").textContent, "7 条");
});

test("门户诊断开关请求失败时不乐观改变显示状态并可恢复", async () => {
  let fail = true;
  let enabled = false;
  const harness = createOptionsHarness({ sendMessage(message) {
    if (message.action === "diagnostics:get") return { ok: true, enabled, bytes: 0, sessionCount: 0, limits: { bytes: 1024 * 1024, sessions: 10 } };
    if (message.action === "diagnostics:set" && fail) { fail = false; throw new Error("后台不可用"); }
    if (message.action === "diagnostics:set") enabled = message.enabled;
    return { ok: true, enabled: message.enabled, limits: { bytes: 1024 * 1024, sessions: 10 } };
  } });
  const toggle = harness.elements.get("portal-diagnostics-enabled");
  await harness.context.setPortalDiagnosticsEnabled(true);
  assert.equal(toggle.checked, false);
  assert.match(harness.elements.get("toast").textContent, /后台不可用/);
  await harness.context.setPortalDiagnosticsEnabled(true);
  assert.equal(toggle.checked, true);
  await harness.context.setPortalDiagnosticsEnabled(false);
  assert.equal(toggle.checked, false);
});

test("导出门户诊断会生成脱敏 JSON 文件并释放对象 URL", async () => {
  const calls = { create: [], revoke: [], click: 0 };
  const harness = createOptionsHarness({
    export: { generatedAt: "2026-09-01T00:00:00.000Z", sessions: [{ event: "click" }] },
    URL: {
      createObjectURL(blob) { calls.create.push(blob); return "blob:diagnostics"; },
      revokeObjectURL(url) { calls.revoke.push(url); }
    }
  });
  harness.context.document.createElement = () => ({
    href: "",
    download: "",
    click() { calls.click += 1; }
  });
  await harness.context.exportPortalDiagnostics();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].type, "application/json");
  assert.match(await calls.create[0].text(), /"generatedAt": "2026-09-01T00:00:00.000Z"/);
  assert.equal(calls.click, 1);
  assert.deepEqual(calls.revoke, ["blob:diagnostics"]);
  assert.equal(
    harness.context.portalDiagnosticsExportFilename(new Date("2026-09-01T12:34:56.789Z")),
    "drcom-portal-diagnostics-2026-09-01T12-34-56-789Z.json"
  );
});

test("清空诊断记录需要统一确认且取消时不发送删除消息", async () => {
  const harness = createOptionsHarness({ confirmResult: false });
  await harness.context.clearPortalDiagnostics();
  assert.equal(harness.messages.some((item) => item.action === "diagnostics:clear"), false);
  assert.equal(harness.confirmations[0].danger, true);
});

test("确认清空诊断记录后刷新诊断状态", async () => {
  let gets = 0;
  let cleared = false;
  let resolveClear;
  const harness = createOptionsHarness({ sendMessage(message) {
    if (message.action === "diagnostics:get") {
      gets += 1;
      return {
        ok: true,
        enabled: true,
        bytes: cleared ? 0 : 4096,
        sessionCount: cleared ? 0 : 2,
        limits: { bytes: 1024 * 1024, sessions: 10 }
      };
    }
    if (message.action === "diagnostics:clear") {
      return new Promise((resolve) => {
        resolveClear = () => {
          cleared = true;
          resolve({ ok: true });
        };
      });
    }
    return { ok: true };
  } });
  await harness.context.loadPortalDiagnostics();
  assert.equal(harness.elements.get("portal-diagnostics-storage").textContent, "4 KB / 1 MiB");
  assert.equal(harness.elements.get("portal-diagnostics-sessions").textContent, "2 / 10");
  assert.equal(harness.elements.get("portal-diagnostics-status").textContent, "诊断模式已开启");
  const clearing = harness.context.clearPortalDiagnostics();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.elements.get("clear-portal-diagnostics").disabled, true);
  resolveClear();
  await clearing;
  assert.equal(harness.messages.filter((item) => item.action === "diagnostics:clear").length, 1);
  assert.equal(gets, 2);
  assert.equal(harness.elements.get("portal-diagnostics-storage").textContent, "0 B / 1 MiB");
  assert.equal(harness.elements.get("portal-diagnostics-sessions").textContent, "0 / 10");
  assert.equal(harness.elements.get("portal-diagnostics-status").textContent, "诊断模式已开启");
  assert.equal(harness.elements.get("clear-portal-diagnostics").disabled, false);
});

test("保活关闭时禁用间隔输入，开启后恢复", () => {
  const keepAlive = { checked: false };
  const minutes = { disabled: false };
  const seconds = { disabled: false };
  const elements = new Map([
    ["keep-alive", keepAlive],
    ["interval-minutes", minutes],
    ["interval-seconds", seconds]
  ]);
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    setTimeout
  });
  loadOptions(context);

  context.syncDependentControls();
  assert.equal(minutes.disabled, true);
  assert.equal(seconds.disabled, true);

  keepAlive.checked = true;
  context.syncDependentControls();
  assert.equal(minutes.disabled, false);
  assert.equal(seconds.disabled, false);
});

test("保活间隔支持分钟和秒并遵守 Chrome 的三十秒下限", () => {
  const elements = new Map([
    ["interval-minutes", { value: "2" }],
    ["interval-seconds", { value: "30" }]
  ]);
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) { return elements.get(id) || null; }
    },
    setTimeout
  });
  loadOptions(context);

  assert.equal(context.readKeepAliveInterval(), 2.5);
  assert.deepEqual(JSON.parse(JSON.stringify(context.splitKeepAliveInterval(0))), { minutes: 0, seconds: 30 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.splitKeepAliveInterval(30.75))), { minutes: 30, seconds: 0 });
});

test("设置页连接概览会把在线、待登录和错误状态转换为明确文案", () => {
  const context = vm.createContext({
    clearTimeout,
    console,
    document: { addEventListener() {}, getElementById() { return null; } },
    setTimeout
  });
  loadOptions(context);

  assert.equal(context.connectionSummary({ online: true }).label, "已连接");
  assert.equal(context.connectionSummary({ phase: "captive" }).label, "需要登录");
  assert.equal(context.connectionSummary({ phase: "waiting" }).tone, "waiting");
  assert.equal(context.connectionSummary(null).label, "无法检查");
});

test("外观表单会保存主题、自定义背景和可读性参数", () => {
  const elements = new Map([
    ["online-detail-mode", { value: "full" }],
    ["appearance-theme", { value: "dark" }],
    ["appearance-accent", { value: "#2563eb" }],
    ["appearance-background", { value: "custom" }],
    ["background-image-data", { value: "data:image/webp;base64,AAAA" }],
    ["background-blur", { value: "18" }],
    ["background-dim", { value: "0.46" }],
    ["background-scale", { value: "1.06" }]
  ]);
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    setTimeout
  });
  loadOptions(context);

  const result = JSON.parse(JSON.stringify(context.readAppearanceConfig()));
  assert.deepEqual(result, {
    onlineDetailMode: "full",
    theme: "dark",
    accent: "#2563eb",
    background: "custom",
    backgroundImage: "data:image/webp;base64,AAAA",
    backgroundBlur: 18,
    backgroundDim: 0.46,
    backgroundScale: 1.06
  });
});

test("外观图片选择后会立即持久化，不依赖页面底部的总保存按钮", async () => {
  const messages = [];
  const elements = new Map([
    ["online-detail-mode", { value: "minimal" }],
    ["appearance-theme", { value: "dark" }],
    ["appearance-accent", { value: "#2563eb" }],
    ["appearance-background", { value: "custom" }],
    ["background-image-data", { value: "data:image/webp;base64,AAAA" }],
    ["background-blur", { value: "18" }],
    ["background-dim", { value: "0.46" }],
    ["background-scale", { value: "1.06" }]
  ]);
  const context = vm.createContext({
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(structuredClone(message));
          callback({ ok: true });
        }
      }
    },
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) { return elements.get(id) || null; }
    },
    setTimeout
  });
  loadOptions(context);

  await context.persistAppearance();

  assert.deepEqual(messages, [{
    action: "config:save",
    config: {
      ui: {
        onlineDetailMode: "minimal",
        theme: "dark",
        accent: "#2563eb",
        background: "custom",
        backgroundImage: "data:image/webp;base64,AAAA",
        backgroundBlur: 18,
        backgroundDim: 0.46,
        backgroundScale: 1.06
      }
    }
  }]);
});

test("背景图片预算会拒绝超过三兆字节的数据", () => {
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById() { return null; }
    },
    setTimeout
  });
  loadOptions(context);

  assert.throws(
    () => context.assertBackgroundImageBudget("A".repeat(3 * 1024 * 1024 + 1)),
    /处理后仍然过大/
  );
  assert.equal(context.formatStorageSize(1536), "1.5 KB");
});

test("设置页会显示当前背景图片占用与预算上限", () => {
  const note = { textContent: "" };
  const elements = new Map([
    ["appearance-background", { value: "custom" }],
    ["background-image-data", { value: "A".repeat(2048) }],
    ["background-controls", { hidden: true }],
    ["clear-background", { disabled: true }],
    ["background-blur", { value: "14" }],
    ["background-dim", { value: "0.42" }],
    ["background-scale", { value: "1.04" }],
    ["background-blur-value", { value: "" }],
    ["background-dim-value", { value: "" }],
    ["background-scale-value", { value: "" }],
    ["background-storage-note", note]
  ]);
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    setTimeout
  });
  loadOptions(context);

  context.syncAppearanceControls();

  assert.equal(note.textContent, "当前约 2 KB，保存上限 3 MB");
  assert.equal(elements.get("background-controls").hidden, false);
});

test("超过保存预算的高分辨率背景会自动多轮压缩到三兆以内", async () => {
  const encodeCalls = [];
  let bitmapClosed = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return { drawImage() {} };
    },
    toBlob(resolve, type, quality) {
      encodeCalls.push({ width: this.width, height: this.height, type, quality });
      const encodedLength = encodeCalls.length === 1
        ? 3 * 1024 * 1024 + 256
        : 2 * 1024 * 1024;
      resolve({ encodedLength, size: Math.floor(encodedLength * 0.75), type });
    }
  };

  class FakeFileReader {
    constructor() {
      this.listeners = {};
      this.result = "";
    }

    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }

    readAsDataURL(blob) {
      const encodedLength = blob.encodedLength || Math.ceil((blob.size || 0) * 4 / 3);
      this.result = `data:${blob.type};base64,${"A".repeat(encodedLength)}`;
      this.listeners.load();
    }
  }

  const context = vm.createContext({
    clearTimeout,
    console,
    createImageBitmap: async () => ({
      width: 4000,
      height: 3000,
      close() { bitmapClosed = true; }
    }),
    document: {
      addEventListener() {},
      createElement(name) {
        assert.equal(name, "canvas");
        return canvas;
      },
      getElementById() { return null; }
    },
    FileReader: FakeFileReader,
    setTimeout
  });
  loadOptions(context);

  const result = await context.optimizeBackgroundImage({
    type: "image/jpeg",
    size: 18 * 1024 * 1024
  });

  assert.ok(result.length <= 3 * 1024 * 1024, `压缩结果仍超限：${result.length}`);
  assert.ok(encodeCalls.length >= 2, "首次编码超限后应继续压缩");
  assert.ok(encodeCalls[0].quality >= 0.9, "第一次编码应优先保留高画质");
  assert.ok(encodeCalls[1].quality < encodeCalls[0].quality, "后续编码应逐步调整质量");
  assert.equal(bitmapClosed, true);
});

test("背景图片处理失败后会清空文件输入以便重试同一文件", async () => {
  const fileInput = {
    disabled: false,
    files: [{ type: "text/plain", size: 10 }],
    value: "C:\\fakepath\\background.txt"
  };
  const toastElement = { hidden: true, textContent: "" };
  const elements = new Map([["toast", toastElement]]);
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) { return elements.get(id) || null; }
    },
    setTimeout
  });
  loadOptions(context);

  await assert.rejects(() => context.handleBackgroundFile({ target: fileInput }), /请选择 PNG/);
  assert.equal(fileInput.value, "");
  assert.equal(fileInput.disabled, false);
});

test("设置页账号删除按钮包含具体账号的无障碍名称", () => {
  const list = { innerHTML: "" };
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) { return id === "account-list" ? list : null; }
    },
    setTimeout
  });
  loadOptions(context);
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

  context.renderAccounts();

  assert.match(list.innerHTML, /aria-label="删除账号：主账号 &amp; 备用"/);
});

test("自定义网关只请求对应来源并在现代界面启用时请求脚本权限", async () => {
  const requests = [];
  const context = vm.createContext({
    chrome: {
      permissions: {
        async request(request) {
          requests.push(structuredClone(request));
          return true;
        }
      }
    },
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById() { return null; }
    },
    setTimeout,
    URL
  });
  loadOptions(context);

  await context.requestGatewayAccess({
    portalUrl: "https://gateway.example/login",
    apiUrl: "http://gateway.example:801/eportal/",
    ui: { modernizePortal: true }
  });

  assert.deepEqual(requests, [{
    origins: ["https://gateway.example/*", "http://gateway.example/*"],
    permissions: ["scripting"]
  }]);
});

test("设置状态尚未加载时打开认证页不会崩溃或误跳默认地址", () => {
  const opened = [];
  const toastElement = { hidden: true, textContent: "" };
  const context = vm.createContext({
    chrome: { tabs: { create(options) { opened.push(structuredClone(options)); } } },
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) { return id === "toast" ? toastElement : null; }
    },
    setTimeout
  });
  loadOptions(context);

  assert.equal(context.openConfiguredPortal(), false);
  assert.deepEqual(opened, []);
  assert.equal(toastElement.textContent, "设置仍在加载，请稍后再试");

  new vm.Script('state = { config: { portalUrl: "https://gateway.example/login" } }').runInContext(context);
  assert.equal(context.openConfiguredPortal(), true);
  assert.deepEqual(opened, [{ url: "https://gateway.example/login" }]);
});
