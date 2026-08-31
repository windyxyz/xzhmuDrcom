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

test("扩展操作弹窗保持稳定的 420 像素任务宽度", () => {
  const css = read("popup.css");

  assert.match(css, /html\s*\{[^}]*width:\s*420px;/s);
  assert.doesNotMatch(css, /html\s*\{[^}]*max-width:\s*100vw;/s);
  assert.match(css, /body\s*\{[^}]*width:\s*100%;/s);
});
