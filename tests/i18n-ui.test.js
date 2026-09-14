"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const CRX = join(__dirname, "..", "CRX");

test("弹窗和设置页先加载国际化运行时并提供语言控件", () => {
  const popup = readFileSync(join(CRX, "popup.html"), "utf8");
  const options = readFileSync(join(CRX, "options.html"), "utf8");

  assert.match(popup, /id="language-toggle"[^>]*data-i18n-aria-label="language_switch_bilingual"/);
  assert.ok(popup.indexOf('src="i18n-messages.js"') < popup.indexOf('src="popup.js"'));
  assert.ok(popup.indexOf('src="i18n.js"') < popup.indexOf('src="popup.js"'));

  assert.match(options, /id="ui-language"/);
  assert.match(options, /value="auto"[^>]*data-i18n="language_auto"/);
  assert.match(options, /value="zh-CN"/);
  assert.match(options, /value="en"/);
  assert.ok(options.indexOf('src="i18n-messages.js"') < options.indexOf('src="options.js"'));
  assert.ok(options.indexOf('src="i18n.js"') < options.indexOf('src="options.js"'));
});

test("界面消息目录提供稳定状态和设置页品牌翻译", () => {
  const messages = require("../CRX/i18n-messages.js");
  assert.equal(messages["zh-CN"].status_sign_in_required, "需要登录");
  assert.equal(messages.en.status_sign_in_required, "Sign-in required");
  assert.equal(messages["zh-CN"].language_auto, "跟随浏览器");
  assert.equal(messages.en.language_auto, "Follow browser");
  assert.equal(messages.en.brand_name, "XZHMU Campus Network");
});

test("紧凑语言控件不会换行且满足触控高度", () => {
  const popupCss = readFileSync(join(CRX, "popup.css"), "utf8");
  const optionsCss = readFileSync(join(CRX, "options.css"), "utf8");
  assert.match(popupCss, /#language-toggle\s*\{[^}]*white-space:\s*nowrap[^}]*min-height:\s*44px/s);
  assert.match(optionsCss, /#ui-language\s*\{[^}]*min-height:\s*44px/s);
});

test("弹窗和设置页声明的翻译键在两种语言中都存在", () => {
  const messages = require("../CRX/i18n-messages.js");
  for (const file of ["popup.html", "options.html"]) {
    const source = readFileSync(join(CRX, file), "utf8");
    const keys = Array.from(source.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder))?="([^"]+)"/g), (match) => match[1]);
    for (const key of keys) {
      assert.equal(typeof messages["zh-CN"][key], "string", `${file} 缺少中文键 ${key}`);
      assert.equal(typeof messages.en[key], "string", `${file} 缺少英文键 ${key}`);
    }
  }
});
