"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");
const read = (path) => readFileSync(join(projectRoot, path), "utf8");

test("项目包含 GPL-3.0 许可证、贡献指南、安全策略和 1.0.1 变更日志", () => {
  const license = read("LICENSE");
  const packageMetadata = JSON.parse(read("package.json"));
  const readme = read("README.md");
  const contributing = read("CONTRIBUTING.md");
  const changelog = read("CHANGELOG.md");

  assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 29 June 2007/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.equal(packageMetadata.license, "GPL-3.0-only");
  assert.equal(packageMetadata.version, "1.0.1");
  assert.match(readme, /LICENSE/);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(contributing, /npm run verify/);
  assert.match(contributing, /不得.*真实账号|不要.*真实账号/);
  assert.match(changelog, /## \[1\.0\.1\]/);
  assert.match(changelog, /## \[1\.0\.0\]/);
  assert.match(changelog, /## \[2\.5\.3\]/);
  assert.match(changelog, /账号自然键|账号去重/);
  assert.match(changelog, /确定性|可复现/);
});

test("CI 分别执行静态、单元、浏览器和打包验证", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /push:/);
  assert.match(workflow, /pull_request:/);
  for (const command of ["npm run check", "npm run test:unit", "npm run test:browser", "npm run verify:package", "npm run package"]) {
    assert.equal(workflow.includes(command), true, command);
  }
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test("标签工作流先验证版本，再发布 ZIP、校验值和变更说明", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /tags:/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /npm run verify:release/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /dist\/drcom-xuzhou-medical-2\.5\.3\.zip|dist\/\*\.zip/);
  assert.match(workflow, /dist\/drcom-xuzhou-medical-2\.5\.3\.sha256|dist\/\*\.sha256/);
  assert.match(workflow, /release-notes\.md/);
  assert.match(workflow, /contents:\s*write/);
});
