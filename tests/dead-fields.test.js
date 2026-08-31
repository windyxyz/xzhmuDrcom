"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");

test("运行时代码和开发数据模型不再定义已废弃字段", () => {
  const targets = [
    "CRX/background/account-service.js",
    "CRX/options.js"
  ];
  const combined = targets
    .map((path) => readFileSync(join(projectRoot, path), "utf8"))
    .join("\n");

  for (const field of ["hideOriginalPortal", "subtitle", "density"]) {
    assert.doesNotMatch(combined, new RegExp(`\\b${field}\\b`));
  }
  const stateStore = readFileSync(join(projectRoot, "CRX", "background", "state-store.js"), "utf8");
  for (const field of ["hideOriginalPortal", "subtitle", "density"]) {
    assert.doesNotMatch(stateStore, new RegExp(`${field}\\s*:`));
    assert.doesNotMatch(stateStore, new RegExp(`\\.${field}\\b`));
  }
  assert.doesNotMatch(
    readFileSync(join(projectRoot, "CRX", "background", "account-service.js"), "utf8"),
    /\bnote\s*:/
  );
});
