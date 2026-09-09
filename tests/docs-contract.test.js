"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");
const read = (path) => readFileSync(join(projectRoot, path), "utf8");

test("开发指南覆盖最终架构、生命周期、接口、测试、打包和安全边界", () => {
  const guide = read("docs/development-guide.md");
  const version = JSON.parse(read("CRX/manifest.json")).version;
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
    "drcom-xuzhou-medical-chrome-" + version + ".zip",
    "drcom-xuzhou-medical-firefox-" + version + ".zip",
    "API_RESPONSE_LIMIT",
    "chkstatus",
    "ss4",
    "5 秒",
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
  assert.match(readme, /xuyi-helper-this-version-300-transparent\.png/);
  assert.match(readme, /addons\.mozilla\.org/);
  assert.match(readme, /microsoftedge\.microsoft\.com/);
  assert.doesNotMatch(readme, /1\.1\.0 依据生产抓包恢复/);
});

test("完成整改后删除过期审阅副本和无版本视觉截图，保留测试预览入口", () => {
  assert.equal(existsSync(join(projectRoot, "docs", "review-and-recommendations.md")), false);
  assert.equal(existsSync(join(projectRoot, "artifacts", "ui-review", "popup-fixed.png")), false);
  assert.equal(existsSync(join(projectRoot, "artifacts", "ui-review", "options-mobile.png")), false);
  assert.equal(existsSync(join(projectRoot, "CRX", "portal-preview.html")), true);
  assert.equal(existsSync(join(projectRoot, "CRX", "portal-preview.js")), true);
});
test("过期审计文档删除后仍由安全策略和变更日志保存有效结论", () => {
  assert.equal(existsSync(join(projectRoot, "docs", "security-audit-2026-09.md")), false);
  assert.equal(existsSync(join(projectRoot, "docs", "security-remediation-2026-09.md")), false);
  const security = read("SECURITY.md");
  const changelog = read("CHANGELOG.md");
  assert.match(security, /宿主脚本可能观察输入或真实用户事件/);
  assert.match(security, /storage\.local/);
  assert.match(security, /HTTP GET/);
  assert.match(changelog, /账号投毒/);
});

test("产品设计明确现代页保存选择与原始页候选确认是两条不同路径", () => {
  const product = read("docs/product-design.md");
  assert.match(product, /现代登录页.*保存账号/);
  assert.match(product, /未勾选.*不会保存/);
  assert.match(product, /原始登录页.*暂存.*设置页.*确认/);
});
