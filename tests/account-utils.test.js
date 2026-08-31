"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const utilsPath = join(__dirname, "..", "CRX", "account-utils.js");

test("共享账号工具统一解析、自然键、标签和脱敏显示", () => {
  const utils = require(utilsPath);

  assert.deepEqual(utils.parse("%2C0%2CStudent%40TELECOM"), {
    username: "Student",
    suffix: "@telecom"
  });
  assert.equal(utils.naturalKey({ username: " Student ", suffix: "电信" }), "Student\u0000@telecom");
  assert.equal(utils.naturalKey({ username: "student", suffix: "@telecom" }), "student\u0000@telecom");
  assert.equal(utils.label("Student", "@unicom"), "Student 联通");
  assert.equal(utils.mask("202513010318"), "20***18");
  assert.equal(utils.mask("1234"), "****");
});

test("后台、弹窗、设置和门户都复用 DrcomAccountUtils 而不保留重复实现", () => {
  const files = [
    "background/account-service.js",
    "background/drcom-client.js",
    "options.js",
    "popup.js",
    "portal-ui.js"
  ];
  const duplicateDefinition = /function\s+(?:decodeMaybe|normalizeAccountValue|splitAccountValue|splitAccount|parseAccount|normalizeSuffix|suffixLabel|makeAccountLabel|maskUsername|normalizeMac)\s*\(/;

  for (const file of files) {
    const source = readFileSync(join(__dirname, "..", "CRX", file), "utf8");
    assert.match(source, /DrcomAccountUtils/);
    assert.doesNotMatch(source, duplicateDefinition);
  }
});
