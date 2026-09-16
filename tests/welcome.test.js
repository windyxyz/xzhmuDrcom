"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("欢迎页未运行脚本时也显示正式中文产品名", () => {
  const html = readFileSync(join(__dirname, "..", "CRX", "welcome.html"), "utf8");
  assert.match(html, /<title[^>]*>开始使用徐医校园网xzhmu<\/title>/);
  assert.match(html, /<strong data-i18n="brand_name">徐医校园网xzhmu<\/strong>/);
});

test("欢迎页主操作进入网关，次操作打开设置", () => {
  const documentListeners = {};
  const elementListeners = {};
  const updatedTabs = [];
  let optionsOpened = 0;
  const elements = new Map(
    ["open-portal", "open-options"].map((id) => [
      id,
      {
        addEventListener(type, listener) {
          elementListeners[`${id}:${type}`] = listener;
        }
      }
    ])
  );
  const context = vm.createContext({
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          const response = message.action === "language:get" ? { ok: true, preference: "zh-CN" } : { ok: true };
          if (callback) callback(response);
          else return Promise.resolve(response);
        },
        openOptionsPage() {
          optionsOpened += 1;
        }
      },
      tabs: {
        update(options) {
          updatedTabs.push(options);
        }
      }
    },
    document: {
      documentElement: {},
      querySelectorAll() { return []; },
      addEventListener(type, listener) {
        documentListeners[type] = listener;
      },
      getElementById(id) {
        return elements.get(id) || null;
      }
    }
  });
  for (const file of ["i18n-messages.js", "i18n.js", "welcome.js"]) {
    new vm.Script(readFileSync(join(__dirname, "..", "CRX", file), "utf8"), { filename: file }).runInContext(context);
  }
  return documentListeners.DOMContentLoaded().then(() => {
  elementListeners["open-portal:click"]();
  elementListeners["open-options:click"]();

  assert.deepEqual(JSON.parse(JSON.stringify(updatedTabs)), [{ url: "http://10.10.10.2/" }]);
  assert.equal(optionsOpened, 1);
  });
});

test("欢迎页跟随英文浏览器并能切回中文且切换不打开页面", async () => {
  const listeners = new Map();
  const runtimeListeners = [];
  const messages = [];
  const opened = [];
  const elements = new Map(["open-portal", "open-options", "language-toggle", "portal-title"].map((id) => [id, {
    textContent: "",
    dataset: {},
    addEventListener(type, listener) { listeners.set(`${id}:${type}`, listener); },
    setAttribute() {}
  }]));
  const document = {
    documentElement: { lang: "zh-CN", dir: "ltr" },
    addEventListener(type, listener) { listeners.set(type, listener); },
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; }
  };
  const chrome = {
    i18n: { getUILanguage() { return "en-US"; } },
    runtime: {
      id: "test-extension-id",
      lastError: null,
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        const response = message.action === "language:get" ? { ok: true, preference: "auto" }
          : message.action === "language:set" ? { ok: true, preference: message.preference }
            : { ok: true, state: { config: { ui: {}, portalUrl: "http://10.10.10.2/" } } };
        if (callback) callback(response);
        else return Promise.resolve(response);
        if (message.action === "language:set") {
          for (const listener of runtimeListeners) listener({ action: "language:changed", preference: message.preference }, { id: "test-extension-id" });
        }
      },
      openOptionsPage() { opened.push("options"); }
    },
    tabs: { update() { opened.push("portal"); } }
  };
  const context = vm.createContext({ URL, chrome, document, navigator: { languages: ["en-US"] }, DrcomAppearance: { applyToRoot() {} } });
  for (const file of ["i18n-messages.js", "i18n.js", "welcome.js"]) {
    new vm.Script(readFileSync(join(__dirname, "..", "CRX", file), "utf8"), { filename: file }).runInContext(context);
  }
  await listeners.get("DOMContentLoaded")();
  assert.equal(elements.get("open-portal").textContent, "Open 10.10.10.2 and sign in");
  await listeners.get("language-toggle:click")();
  assert.equal(elements.get("open-portal").textContent, "打开 10.10.10.2 并登录");
  assert.equal(document.documentElement.lang, "zh-CN");
  assert.deepEqual(opened, []);
  assert.deepEqual(messages.map((message) => message.action), ["language:get", "state:get", "language:set"]);
});

test("欢迎页语言保存失败时临时应用并显示安全的未保存提示", async () => {
  const listeners = new Map();
  const elements = new Map(["open-portal", "open-options", "language-toggle", "portal-title", "language-save-status"].map((id) => [id, {
    hidden: true, textContent: "", dataset: {}, addEventListener(type, listener) { listeners.set(`${id}:${type}`, listener); }, setAttribute() {}
  }]));
  const chrome = {
    i18n: { getUILanguage() { return "zh-CN"; } },
    runtime: { id: "test", lastError: null, onMessage: { addListener() {} }, sendMessage(message, callback) {
      if (message.action === "language:set") {
        this.lastError = { message: "QUOTA_BYTES quota exceeded" }; callback(); this.lastError = null; return;
      }
      const response = message.action === "language:get" ? { ok: true, preference: "zh-CN" } : { ok: true, state: { config: { ui: {}, portalUrl: "http://10.10.10.2/" } } };
      if (callback) callback(response); else return Promise.resolve(response);
    }, openOptionsPage() {} }, tabs: { update() {} }
  };
  const document = { documentElement: {}, addEventListener(type, listener) { listeners.set(type, listener); }, getElementById(id) { return elements.get(id) || null; }, querySelectorAll() { return []; } };
  const context = vm.createContext({ URL, chrome, document, navigator: { languages: ["zh-CN"] }, DrcomAppearance: { applyToRoot() {} }, clearTimeout, setTimeout });
  for (const file of ["i18n-messages.js", "i18n.js", "welcome.js"]) new vm.Script(readFileSync(join(__dirname, "..", "CRX", file), "utf8"), { filename: file }).runInContext(context);
  await listeners.get("DOMContentLoaded")();

  await listeners.get("language-toggle:click")();

  assert.equal(elements.get("language-toggle").textContent, "中文");
  assert.match(elements.get("language-save-status").textContent, /not saved/i);
  assert.doesNotMatch(elements.get("language-save-status").textContent, /quota/i);
});
