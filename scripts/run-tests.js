"use strict";

const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = join(__dirname, "..");
const testRoot = join(projectRoot, "tests");
const mode = process.argv[2] || "all";
const allTests = readdirSync(testRoot)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testRoot, name));
const browserTest = join(testRoot, "welcome-layout.test.js");
const packageTest = join(testRoot, "package-extension.test.js");
const groups = {
  unit: allTests.filter((path) => path !== browserTest && path !== packageTest),
  browser: [browserTest],
  package: [packageTest],
  all: allTests
};

if (!groups[mode]) {
  throw new Error(`未知测试分组：${mode}`);
}

const result = spawnSync(process.execPath, ["--test", ...groups[mode]], {
  cwd: projectRoot,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
