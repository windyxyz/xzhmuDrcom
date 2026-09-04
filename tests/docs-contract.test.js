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
    "schemaVersion: 13",
    "activeIdentity",
    "portal:appearance:get",
    "closed Shadow DOM",
    "npm run test:unit",
    "npm run test:browser",
    "npm run verify:package",
    "npm run package",
    "drcom-xuzhou-medical-1.0.3.zip",
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
  assert.match(readme, /暂存并确认/);
});

test("完成整改后删除过期审阅副本和无版本视觉截图，保留测试预览入口", () => {
  assert.equal(existsSync(join(projectRoot, "docs", "review-and-recommendations.md")), false);
  assert.equal(existsSync(join(projectRoot, "artifacts", "ui-review", "popup-fixed.png")), false);
  assert.equal(existsSync(join(projectRoot, "artifacts", "ui-review", "options-mobile.png")), false);
  assert.equal(existsSync(join(projectRoot, "CRX", "portal-preview.html")), true);
  assert.equal(existsSync(join(projectRoot, "CRX", "portal-preview.js")), true);
});
test("安全整改登记覆盖二十一项发现并区分延期风险", () => {
  const remediation = read("docs/security-remediation-2026-09.md");
  const itemIds = [...remediation.matchAll(/\|\s*(F[12]-\d+|N\d+)\s*\|/g)].map((match) => match[1]);
  assert.equal(new Set(itemIds).size, 21);
  for (const status of ["已修复", "部分缓解", "接受风险", "延期"]) {
    assert.match(remediation, new RegExp(status));
  }
  assert.match(remediation, /宿主页面.*观察.*密码/);
  assert.match(remediation, /账号投毒/);
});
