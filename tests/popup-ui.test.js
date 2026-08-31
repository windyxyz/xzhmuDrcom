"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPopup(options = {}) {
  const createdElements = [];
  const elements = new Map([
    ["status-dot", { dataset: {} }],
    ["status-label", { textContent: "" }],
    ["status-message", { textContent: "" }],
    ["request-url", { textContent: "" }],
    ["toast", { hidden: true, textContent: "" }],
    ["account-list", {
      innerHTML: "",
      append(element) { createdElements.push(element); }
    }]
  ]);
  const context = vm.createContext({
    URL,
    chrome: options.chrome,
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      createElement() {
        const element = { className: "", innerHTML: "" };
        createdElements.push(element);
        return element;
      },
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    setTimeout
  });
  for (const file of ["account-utils.js", "popup.js"]) {
    const source = readFileSync(join(__dirname, "..", "CRX", file), "utf8");
    new vm.Script(source, { filename: file }).runInContext(context);
  }
  return { context, createdElements, elements };
}

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
  for (const file of ["account-utils.js", "popup.js"]) {
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
