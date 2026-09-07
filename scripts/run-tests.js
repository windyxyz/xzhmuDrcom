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

function runBrowserGroup() {
  return spawnSync(process.execPath, ["--test", ...groups.browser], {
    cwd: projectRoot,
    stdio: "inherit"
  });
}

/* 真实浏览器（headless Chrome/Edge）偶发 "Execution context was destroyed" 之类
   的 CDP 环境竞态，已多次导致发布流水线误报失败（v1.0.3、v1.1.0）。确定性失败
   重跑后依然失败并如实返回非零状态，因此仅在浏览器组对失败结果整体重跑一次。 */
if (mode === "browser") {
  let first = runBrowserGroup();
  if (first.error) throw first.error;
  if (first.status === 0) {
    process.exitCode = 0;
  } else {
    console.log("\n浏览器测试首轮失败（疑似 headless 环境偶发），正在重跑一次以排除抖动…");
    const retry = runBrowserGroup();
    if (retry.error) throw retry.error;
    process.exitCode = retry.status ?? 1;
  }
} else {
  const result = spawnSync(process.execPath, ["--test", ...groups[mode]], {
    cwd: projectRoot,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
