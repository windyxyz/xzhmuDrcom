"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAllTestSteps, normalizeStatus, runAllSteps } = require("../scripts/test-all-runner.js");

function bufferWriter() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read() { return value; }
  };
}

test("统一测试计划按 check -> unit -> browser -> package 执行且 edge 不重复运行", () => {
  const noop = () => 0;
  const steps = buildAllTestSteps({
    check: noop,
    unit: noop,
    browser: noop,
    packageVerify: noop
  });

  assert.deepEqual(steps.map((step) => step.id), ["check", "unit", "browser", "package"]);
  assert.equal(steps.some((step) => step.id === "edge"), false);
  assert.deepEqual(steps.find((step) => step.id === "unit").covers, ["edge"]);
});

test("统一测试计划即使中间阶段失败也继续执行并最终返回非零", () => {
  const calls = [];
  const stdout = bufferWriter();
  const stderr = bufferWriter();
  const steps = buildAllTestSteps({
    check: () => { calls.push("check"); return 0; },
    unit: () => { calls.push("unit"); return 1; },
    browser: () => { calls.push("browser"); return 0; },
    packageVerify: () => { calls.push("package"); return 0; }
  });

  const summary = runAllSteps(steps, { stdout: stdout.stream, stderr: stderr.stream });
  assert.deepEqual(calls, ["check", "unit", "browser", "package"]);
  assert.equal(summary.status, 1);
  assert.equal(summary.results.find((item) => item.id === "unit").status, 1);
  assert.match(stdout.read(), /全部测试汇总/);
  assert.match(stdout.read(), /同时覆盖 edge/);
  assert.match(stderr.read(), /单元与运行测试/);
});

test("统一测试计划全部成功时返回 0 并输出最终成功汇总", () => {
  const stdout = bufferWriter();
  const stderr = bufferWriter();
  const steps = buildAllTestSteps({
    check: () => ({ status: 0 }),
    unit: () => 0,
    browser: () => ({ status: 0 }),
    packageVerify: () => 0
  });

  const summary = runAllSteps(steps, { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(summary.status, 0);
  assert.equal(summary.results.length, 4);
  assert.match(stdout.read(), /全部测试通过/);
  assert.equal(stderr.read(), "");
});

test("统一测试计划捕获阶段异常并继续后续阶段", () => {
  const calls = [];
  const stdout = bufferWriter();
  const stderr = bufferWriter();
  const steps = buildAllTestSteps({
    check: () => { calls.push("check"); throw new Error("synthetic check failure"); },
    unit: () => { calls.push("unit"); return 0; },
    browser: () => { calls.push("browser"); return 0; },
    packageVerify: () => { calls.push("package"); return 0; }
  });

  const summary = runAllSteps(steps, { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(summary.status, 1);
  assert.deepEqual(calls, ["check", "unit", "browser", "package"]);
  assert.match(stderr.read(), /synthetic check failure/);
});

test("normalizeStatus 对非法结果保持失败默认值", () => {
  assert.equal(normalizeStatus(0), 0);
  assert.equal(normalizeStatus({ status: 0 }), 0);
  assert.equal(normalizeStatus({ status: 2 }), 2);
  assert.equal(normalizeStatus(undefined), 1);
  assert.equal(normalizeStatus({}), 1);
});
