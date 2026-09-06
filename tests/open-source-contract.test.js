"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");
const read = (path) => readFileSync(join(projectRoot, path), "utf8");

test("项目包含 GPL-3.0 许可证、贡献指南、安全策略和当前版本变更日志", () => {
  const license = read("LICENSE");
  const packageMetadata = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("CRX/manifest.json"));
  const readme = read("README.md");
  const contributing = read("CONTRIBUTING.md");
  const changelog = read("CHANGELOG.md");

  assert.ok(license.includes("GNU GENERAL PUBLIC LICENSE"));
  assert.ok(license.includes("Version 3, 29 June 2007"));
  assert.ok(license.includes("END OF TERMS AND CONDITIONS"));
  assert.equal(packageMetadata.license, "GPL-3.0-only");
  assert.equal(packageMetadata.version, manifest.version);
  assert.ok(readme.includes("LICENSE"));
  assert.ok(readme.includes("CONTRIBUTING.md"));
  assert.ok(contributing.includes("npm run verify"));
  assert.ok(contributing.includes("真实账号"));
  assert.ok(changelog.includes("## [" + manifest.version + "]"));
  for (const historicalVersion of ["1.1.0", "1.0.3", "1.0.1", "1.0.0", "2.5.3"]) {
    assert.ok(changelog.includes("## [" + historicalVersion + "]"), historicalVersion);
  }
  assert.ok(changelog.includes("账号自然键") || changelog.includes("账号去重"));
  assert.ok(changelog.includes("确定性") || changelog.includes("可复现"));
  assert.equal(packageMetadata.engines.node, ">=22");
  assert.ok(packageMetadata.scripts["check:stable"].includes("CRX/portal-capture.js"));
});

test("CI 分别执行静态、单元、浏览器和双浏览器打包验证", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.ok(workflow.includes("push:"));
  assert.ok(workflow.includes("branches: [main]"));
  assert.ok(workflow.includes("pull_request:"));
  for (const command of [
    "npm run check",
    "npm run test:unit",
    "npm run test:browser",
    "npm run verify:package",
    "npm run package",
    "npm run package:firefox"
  ]) {
    assert.ok(workflow.includes(command), command);
  }
  assert.ok(workflow.includes("actions/upload-artifact@v4"));
});

test("标签工作流限制并发并先验证版本，再发布 ZIP、校验值和变更说明", () => {
  const workflow = read(".github/workflows/release.yml");
  for (const term of [
    "tags:",
    "concurrency:",
    "cancel-in-progress: false",
    "npm run verify",
    "npm run verify:release",
    "gh release create",
    "dist/*.zip",
    "dist/*.sha256",
    "release-notes.md",
    "contents: write"
  ]) {
    assert.ok(workflow.includes(term), term);
  }
});
