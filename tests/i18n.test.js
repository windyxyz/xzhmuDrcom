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
