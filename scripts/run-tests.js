"use strict";

const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { runStaticCheck } = require("./static-check.js");
const { buildAllTestSteps, runAllSteps } = require("./test-all-runner.js");

const projectRoot = join(__dirname, "..");
const testRoot = join(projectRoot, "tests");
const mode = process.argv[2] || "all";
const allTests = readdirSync(testRoot)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testRoot, name));
const browserTest = join(testRoot, "welcome-layout.test.js");
const packageTest = join(testRoot, "package-extension.test.js");
const edgeTests = allTests.filter((path) => path.includes(`${join(testRoot, "edge-")}`));
const groups = {
  // Keep the historical meaning of test:unit: it includes edge tests. test:all
  // therefore does not execute test:edge separately and avoids duplicate work.
  unit: allTests.filter((path) => path !== browserTest && path !== packageTest),
  browser: [browserTest],
  package: [packageTest],
  edge: edgeTests
};

if (![...Object.keys(groups), "all"].includes(mode)) {
  throw new Error(`未知测试分组：${mode}`);
}

function runNodeTestGroup(testFiles, { capture = false } = {}) {
  return spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: projectRoot,
    stdio: capture ? "pipe" : "inherit",
    encoding: capture ? "utf8" : undefined
  });
}

function runBrowserGroup({ capture = false } = {}) {
  return runNodeTestGroup(groups.browser, { capture });
}

function printCaptured(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function isTransientBrowserFailure(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return /Execution context was destroyed|Target closed|target .* closed|DevTools.*disconnect|WebSocket.*closed|无法连接浏览器调试目标/i.test(output);
}

function executeBrowserGroup() {
  const first = runBrowserGroup({ capture: true });
  if (first.error) throw first.error;
  printCaptured(first);
  if (first.status === 0) return 0;

  /* 真实浏览器（headless Chrome/Edge）偶发 "Execution context was destroyed" 之类
     的 CDP 环境竞态。只对这些已知瞬时错误重跑一次；断言失败、启动参数错误等
     确定性失败直接返回，避免用重跑掩盖真实回归。 */
  if (isTransientBrowserFailure(first)) {
    console.log("\n浏览器测试首轮失败（疑似 headless 环境偶发），正在重跑一次以排除抖动…");
    const retry = runBrowserGroup();
    if (retry.error) throw retry.error;
    return retry.status ?? 1;
  }
  return first.status ?? 1;
}

function executeNodeGroup(groupName) {
  const result = runNodeTestGroup(groups[groupName]);
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function executeStaticCheck() {
  // Do not recursively spawn npm here. On Windows, spawning npm.cmd directly
  // through spawnSync can fail with EINVAL on otherwise healthy Node/npm setups.
  // Reuse the same cross-platform checker that backs `npm run check` instead.
  return runStaticCheck();
}

if (mode === "browser") {
  process.exitCode = executeBrowserGroup();
} else if (mode === "all") {
  const summary = runAllSteps(buildAllTestSteps({
    check: executeStaticCheck,
    unit: () => executeNodeGroup("unit"),
    browser: executeBrowserGroup,
    packageVerify: () => executeNodeGroup("package")
  }));
  process.exitCode = summary.status;
} else {
  process.exitCode = executeNodeGroup(mode);
}
