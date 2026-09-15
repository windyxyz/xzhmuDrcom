"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const extensionRoot = join(__dirname, "..", "CRX");

function read(path) {
  return readFileSync(join(extensionRoot, path), "utf8");
}

test("欢迎页三个步骤使用稳定的显式编号而不是失效的 CSS 列表计数", () => {
  const html = read("welcome.html");
  const numbers = Array.from(
    html.matchAll(/<span class="step-number"[^>]*>([123])<\/span>/g),
    (match) => match[1]
  );

  assert.deepEqual(numbers, ["1", "2", "3"]);
});

test("所有扩展界面支持动态视口、安全区和粗指针触摸目标", () => {
  const styles = [
    "welcome.css",
    "options.css",
    "popup.css",
    "portal.css"
  ];
  const missing = [];

  for (const path of styles) {
    const css = read(path);
    if (!/\b100dvh\b/.test(css)) missing.push(`${path}: dynamic viewport`);
    if (!/env\(safe-area-inset-(top|bottom)/.test(css)) missing.push(`${path}: safe area`);
    if (!/@media\s*\(max-width:\s*\d+px\)/.test(css)) missing.push(`${path}: narrow breakpoint`);
    if (!/@media\s*\(pointer:\s*coarse\)/.test(css)) missing.push(`${path}: coarse pointer`);
  }

  assert.deepEqual(missing, []);
});

test("扩展操作弹窗限制最大宽度但允许 320px 视口收缩", () => {
  const css = read("popup.css");

  assert.match(css, /html\s*\{[^}]*width:\s*min\(420px,\s*100vw\);/s);
  assert.match(css, /html\s*\{[^}]*max-width:\s*100%;/s);
  assert.match(css, /body\s*\{[^}]*width:\s*100%;/s);
});

test("四个界面的根容器均可在窄屏收缩", () => {
  const contracts = [
    ["popup.css", /\.shell\s*\{[^}]*max-width:\s*100%;/s],
    ["welcome.css", /\.welcome-shell\s*\{[^}]*max-width:\s*100%;/s],
    ["options.css", /\.settings-layout\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s],
    ["portal.css", /#drcom-modern-root\s*\{[^}]*max-width:\s*100%;/s]
  ];

  for (const [path, contract] of contracts) {
    assert.match(read(path), contract, `${path} 应允许其根容器收缩至窄视口`);
  }
});

test("门户滚动容器为软键盘后的提交操作预留底部空间", () => {
  const css = read("portal.css");

  assert.match(css, /#drcom-modern-root\s*\{[^}]*scroll-padding-bottom:\s*max\(24px,\s*env\(safe-area-inset-bottom,\s*0px\)\);/s);
});
