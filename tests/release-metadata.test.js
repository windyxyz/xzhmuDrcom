"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  extractChangelogSection,
  verifyRelease
} = require("../scripts/verify-release.js");

test("发布标签必须与 Manifest 和 package.json 的 1.0.1 版本一致", () => {
  const projectRoot = join(__dirname, "..");
  const outputDirectory = mkdtempSync(join(tmpdir(), "drcom-release-"));
  try {
    const result = verifyRelease({ projectRoot, outputDirectory, tag: "v1.0.1" });
    assert.equal(result.version, "1.0.1");
    assert.match(readFileSync(result.notesPath, "utf8"), /^## \[1.0.1\]/);
    assert.throws(
      () => verifyRelease({ projectRoot, outputDirectory, tag: "v1.0.2" }),
      /标签.*Manifest.*不一致/
    );
    assert.throws(
      () => verifyRelease({ projectRoot, outputDirectory, tag: "1.0.1" }),
      /v1\.0.1/
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("变更说明只提取目标版本，不混入其他版本", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [2.5.3] - 2026-08-31",
    "",
    "- 当前版本",
    "",
    "## [2.5.2] - 2026-08-01",
    "",
    "- 旧版本"
  ].join("\n");

  const section = extractChangelogSection(changelog, "2.5.3");
  assert.match(section, /当前版本/);
  assert.doesNotMatch(section, /旧版本/);
});
