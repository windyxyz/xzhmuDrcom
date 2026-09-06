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

test("发布标签必须与 Manifest 和 package.json 的当前版本一致", () => {
  const projectRoot = join(__dirname, "..");
  const version = JSON.parse(readFileSync(join(projectRoot, "CRX", "manifest.json"), "utf8")).version;
  const outputDirectory = mkdtempSync(join(tmpdir(), "drcom-release-"));
  try {
    const result = verifyRelease({ projectRoot, outputDirectory, tag: "v" + version });
    assert.equal(result.version, version);
    assert.ok(readFileSync(result.notesPath, "utf8").startsWith("## [" + version + "]"));
    assert.throws(
      () => verifyRelease({ projectRoot, outputDirectory, tag: "v0.0.0" }),
      (error) => error.message.includes("标签") && error.message.includes("Manifest")
    );
    assert.throws(
      () => verifyRelease({ projectRoot, outputDirectory, tag: version }),
      (error) => error.message.includes("v" + version)
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
  ].join(String.fromCharCode(10));

  const section = extractChangelogSection(changelog, "2.5.3");
  assert.ok(section.includes("当前版本"));
  assert.equal(section.includes("旧版本"), false);
});
