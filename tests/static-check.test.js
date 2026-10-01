"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { join } = require("node:path");
const { collectJavaScriptFiles, runStaticCheck } = require("../scripts/static-check.js");

const projectRoot = join(__dirname, "..");

test("静态检查自动覆盖 CRX 与 scripts 中新增的 JavaScript 文件", () => {
  const files = collectJavaScriptFiles();
  assert.ok(files.includes(join(projectRoot, "CRX", "background.js")));
  assert.ok(files.includes(join(projectRoot, "scripts", "run-tests.js")));
  assert.ok(files.includes(join(projectRoot, "scripts", "static-check.js")));
  assert.equal(files.some((file) => file.includes(`${join(projectRoot, "tests")}\\`) || file.includes(`${join(projectRoot, "tests")}/`)), false);
  assert.deepEqual(files, [...files].sort((a, b) => a.localeCompare(b)));
});

test("统一静态检查直接调用 node --check，不再依赖 npm.cmd", () => {
  const calls = [];
  const output = [];
  const status = runStaticCheck({
    files: [join(projectRoot, "CRX", "background.js"), join(projectRoot, "scripts", "run-tests.js")],
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    stdout: { write: (text) => output.push(text) },
    stderr: { write: (text) => output.push(text) }
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.args[0], "--check");
    assert.equal(call.command.toLowerCase().includes("npm.cmd"), false);
  }
  assert.match(output.join(""), /静态检查通过：2 个 JavaScript 文件/);
});

test("静态检查会汇总单文件错误并返回非零，而不是中止后续文件", () => {
  const files = [
    join(projectRoot, "CRX", "background.js"),
    join(projectRoot, "scripts", "run-tests.js"),
    join(projectRoot, "scripts", "test-all-runner.js")
  ];
  let index = 0;
  const errors = [];
  const status = runStaticCheck({
    files,
    spawnSyncImpl() {
      index += 1;
      return { status: index === 2 ? 1 : 0 };
    },
    stdout: { write() {} },
    stderr: { write: (text) => errors.push(text) }
  });

  assert.equal(index, 3);
  assert.equal(status, 1);
  assert.match(errors.join(""), /静态检查失败：1\/3/);
});

test("静态检查把子进程启动错误计入失败并继续检查其他文件", () => {
  const files = [
    join(projectRoot, "CRX", "background.js"),
    join(projectRoot, "scripts", "run-tests.js")
  ];
  let index = 0;
  const errors = [];
  const status = runStaticCheck({
    files,
    spawnSyncImpl() {
      index += 1;
      return index === 1 ? { error: new Error("synthetic spawn failure") } : { status: 0 };
    },
    stdout: { write() {} },
    stderr: { write: (text) => errors.push(text) }
  });

  assert.equal(index, 2);
  assert.equal(status, 1);
  assert.match(errors.join(""), /synthetic spawn failure/);
});
