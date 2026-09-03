"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");
const read = (path) => readFileSync(join(projectRoot, path), "utf8");

test("开发指南覆盖最终架构、生命周期、接口、测试、打包和安全边界", () => {
  const guide = read("docs/development-guide.md");
  for (const term of [
    "background/state-store.js",
    "background/portal-context.js",
    "background/drcom-client.js",
    "DrcomAccountUtils",
    "schemaVersion: 12",
    "activeIdentity",
    "portal:appearance:get",
    "closed Shadow DOM",
    "npm run test:unit",
    "npm run test:browser",
    "npm run verify:package",
    "npm run package",
    "drcom-xuzhou-medical-1.0.2.zip",
    "SHA-256",
    "设备失陷",
    "删除文件前"
  ]) {
    assert.equal(guide.includes(term), true, term);
  }
  assert.doesNotMatch(guide, /81 passed|81 项|建议实现可重复的打包脚本|当前最先应处理/);
});

test("README 只链接仍在维护的正式文档并说明自动化发布命令", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, /review-and-recommendations/);
  assert.match(readme, /npm run package/);
  assert.match(readme, /npm run verify:release/);
  assert.match(readme, /background\/state-store\.js/);
});

test("完成整改后删除过期审阅副本和无版本视觉截图，保留测试预览入口", () => {
  assert.equal(existsSync(join(projectRoot, "docs", "review-and-recommendations.md")), false);
  assert.equal(existsSync(join(projectRoot, "artifacts", "ui-review", "popup-fixed.png")), false);
  assert.equal(existsSync(join(projectRoot, "artifacts", "ui-review", "options-mobile.png")), false);
  assert.equal(existsSync(join(projectRoot, "CRX", "portal-preview.html")), true);
  assert.equal(existsSync(join(projectRoot, "CRX", "portal-preview.js")), true);
});
