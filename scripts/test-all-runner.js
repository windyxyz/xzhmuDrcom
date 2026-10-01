"use strict";

function normalizeStatus(outcome) {
  if (typeof outcome === "number") return outcome;
  if (outcome && Number.isInteger(outcome.status)) return outcome.status;
  return 1;
}


function buildAllTestSteps({ check, unit, browser, packageVerify }) {
  return [
    { id: "check", label: "静态检查", run: check },
    { id: "unit", label: "单元与运行测试", run: unit, covers: ["edge"] },
    { id: "browser", label: "真实浏览器测试", run: browser },
    { id: "package", label: "扩展打包验证", run: packageVerify }
  ];
}

function runAllSteps(steps, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const results = [];

  for (const step of steps) {
    stdout.write(`\n=== ${step.label} ===\n`);
    const startedAt = Date.now();
    let status = 1;
    let error = null;
    try {
      status = normalizeStatus(step.run());
    } catch (caught) {
      error = caught;
      status = 1;
      stderr.write(`${caught?.stack || caught}\n`);
    }
    results.push({
      id: step.id,
      label: step.label,
      status,
      error,
      durationMs: Date.now() - startedAt,
      covers: step.covers || []
    });
  }

  stdout.write("\n=== 全部测试汇总 ===\n");
  for (const result of results) {
    const mark = result.status === 0 ? "PASS" : "FAIL";
    const coverage = result.covers.length ? `；同时覆盖 ${result.covers.join(", ")}` : "";
    stdout.write(`${mark.padEnd(4)}  ${result.label} (${result.durationMs}ms${coverage})\n`);
  }

  const failed = results.filter((result) => result.status !== 0);
  if (failed.length === 0) {
    stdout.write("\n全部测试通过。\n");
  } else {
    stderr.write(`\n${failed.length} 个测试阶段失败：${failed.map((item) => item.label).join("、")}\n`);
  }

  return {
    status: failed.length === 0 ? 0 : 1,
    results
  };
}

module.exports = {
  buildAllTestSteps,
  normalizeStatus,
  runAllSteps
};
