"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPage(script, options = {}) {
  const messages = [];
  const confirmations = [];
  const elements = options.elements || new Map();
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(structuredClone(message));
          callback({ ok: true, state: { accounts: [], recentRequests: [], config: {} }, account: {} });
        }
      }
    },
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById(id) { return elements.get(id) || null; }
    },
    DrcomConfirmDialog: {
      async ask(options) {
        confirmations.push(structuredClone(options));
        return false;
      }
    },
    setTimeout
  });
  const files = script === "options.js"
    ? ["account-utils.js", "options-appearance-images.js", "options-refresh-controller.js", "options-account-capture-controller.js", script]
    : ["account-utils.js", script];
  for (const file of files) {
    new vm.Script(readFileSync(join(__dirname, "..", "CRX", file), "utf8"), { filename: file }).runInContext(context);
  }
  return { confirmations, context, messages };
}

function setAccountState(context) {
  new vm.Script(`state = {
    selectedAccountId: "account-1",
    recentRequests: [{ kind: "login" }],
    accounts: [{
      id: "account-1",
      label: "主账号",
      username: "20250001",
      suffix: "@cmcc",
      password: "secret",
      network: {}
    }],
    config: { ui: { backgroundImage: "data:image/png;base64,AAAA" } }
  }`).runInContext(context);
}

test("设置页取消删除时不发送消息，并显示具体账号", async () => {
  const { confirmations, context, messages } = loadPage("options.js");
  setAccountState(context);

  await context.deleteAccount("account-1");

  assert.deepEqual(messages, []);
  assert.match(confirmations[0].message, /主账号/);
  assert.match(confirmations[0].message, /无法撤销/);
});

test("抓包导入覆盖现有自然键账号前必须确认", async () => {
  const elements = new Map([
    ["parsed-label", { value: "导入账号" }],
    ["parsed-username", { value: "20250001" }],
    ["parsed-suffix", { value: "@CMCC" }],
    ["parsed-password", { value: "new-secret" }],
    ["parsed-ip", { value: "10.0.0.2" }],
    ["parsed-mac", { value: "001122334455" }]
  ]);
  const { confirmations, context, messages } = loadPage("options.js", { elements });
  setAccountState(context);

  await context.saveParsedAccount();

  assert.deepEqual(messages, []);
  assert.match(confirmations[0].title, /覆盖导入/);
  assert.match(confirmations[0].message, /主账号/);
  assert.match(confirmations[0].message, /密码和网络参数/);
});

test("恢复默认设置前显示影响范围，取消时不发送消息", async () => {
  const { confirmations, context, messages } = loadPage("options.js");
  setAccountState(context);

  await context.resetConfig();

  assert.deepEqual(messages, []);
  assert.match(confirmations[0].message, /网关/);
  assert.match(confirmations[0].message, /1 个已保存账号不会删除/);
});

test("弹窗删除账号同样使用统一确认且取消不发送消息", async () => {
  const { confirmations, context, messages } = loadPage("popup.js");
  setAccountState(context);

  await context.deleteAccount("account-1");

  assert.deepEqual(messages, []);
  assert.match(confirmations[0].message, /主账号/);
});
