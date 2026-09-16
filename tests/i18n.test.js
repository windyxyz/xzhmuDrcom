"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const i18n = require("../CRX/i18n.js");

function makeElement(dataset) {
  const attributes = new Map();
  let innerHTMLWrites = 0;

  return {
    dataset,
    attributes,
    textContent: "",
    get innerHTMLWrites() {
      return innerHTMLWrites;
    },
    set innerHTML(value) {
      innerHTMLWrites += 1;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };
}

function makeRoot(nodes) {
  return {
    querySelectorAll() {
      return nodes;
    }
  };
}

test("auto 对中文浏览器使用中文，其余语言使用英文", () => {
  assert.equal(i18n.resolveLanguage("auto", ["zh-HK", "en-US"]), "zh-CN");
  assert.equal(i18n.resolveLanguage("auto", ["en-US"]), "en");
  assert.equal(i18n.resolveLanguage("broken", ["en-US"]), "en");
});

test("翻译缺失时回退中文且参数按文本替换", () => {
  i18n.setLanguage("en");
  assert.equal(i18n.t("gateway_open", ["10.10.10.2"]), "Open 10.10.10.2 and sign in");
  assert.equal(i18n.t("zh_only_test"), "仅中文回退");
});

test("应用翻译只写 textContent 和受支持属性", () => {
  const node = makeElement({ i18n: "unsafe_test", i18nAriaLabel: "language_switch" });
  i18n.apply(makeRoot([node]), "en");
  assert.equal(node.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(node.innerHTMLWrites, 0);
  assert.equal(node.attributes.get("aria-label"), "Language / 语言");
});

test("中文运行时品牌和门户更新提示使用正式产品名顺序", () => {
  const brand = makeElement({ i18n: "brand_name" });
  const title = makeElement({ i18n: "brand_settings_title" });
  i18n.apply(makeRoot([brand, title]), "zh-CN");
  assert.equal(brand.textContent, "徐医校园网xzhmu");
  assert.equal(title.textContent, "徐医校园网xzhmu 设置");
  assert.equal(i18n.t("portal_context_lost", undefined, "zh-CN"), "徐医校园网xzhmu 已更新，请刷新页面以恢复登录界面。");
});

test("只翻译扩展自有的已知网关状态，未知文本保持原样", () => {
  assert.equal(i18n.localizeKnownMessage("需要登录", "en"), "Sign-in required");
  assert.equal(i18n.localizeKnownMessage("登录成功。", "en"), "Signed in successfully.");
  assert.equal(i18n.localizeKnownMessage("正在检查校园网连接状态。", "en"), "Checking the campus network connection.");
  assert.equal(i18n.localizeKnownMessage("未知网关错误 <734>", "en"), "未知网关错误 <734>");
});
