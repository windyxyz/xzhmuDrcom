"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadDrcomClient() {
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    URL,
    URLSearchParams,
    Uint8Array,
    atob,
    clearTimeout,
    fetch,
    setTimeout,
    stringValue: (value) => value === undefined || value === null ? "" : String(value),
    createTimestamp: () => "20260901010101000",
    createNonce: () => "123456789",
    tryJson: (value) => {
      try { return JSON.parse(value); } catch (error) { return null; }
    },
    trimRaw: (value) => String(value || "").slice(0, 2000),
    addRequestRecord: async () => undefined
  });
  for (const path of ["account-utils.js", "background/drcom-client.js"]) {
    const source = readFileSync(join(__dirname, "..", "CRX", path), "utf8");
    new vm.Script(source, { filename: path }).runInContext(context);
  }
  return context;
}

test("ret_code=2 只有 result=0 且含已在线语义时进入待复核", () => {
  const background = loadDrcomClient();
  const result = background.normalizeDrcomResult(
    "login",
    200,
    { result: 0, ret_code: 2, msg: "账号已经在线" },
    '{"result":0,"ret_code":2,"msg":"账号已经在线"}'
  );

  assert.equal(result.success, false);
  assert.equal(result.online, false);
  assert.equal(result.requiresStatusConfirmation, true);
  assert.equal(result.diagnostic.resultCode, "0");
  assert.equal(result.diagnostic.retCode, "2");
});

test("ret_code=2 或 3 没有对应语义时不会统一伪报 MAC 冲突", () => {
  const background = loadDrcomClient();
  for (const retCode of [2, 3]) {
    const result = background.normalizeDrcomResult(
      "login",
      200,
      { result: 0, ret_code: retCode, msg: "认证请求被拒绝" },
      `{"result":0,"ret_code":${retCode},"msg":"认证请求被拒绝"}`
    );
    assert.equal(result.success, false);
    assert.equal(result.requiresStatusConfirmation, false);
    assert.doesNotMatch(result.message, /设备数量超限|MAC 冲突/);
  }
});

test("明确 result=1 成功而未知协议仍安全失败", () => {
  const background = loadDrcomClient();
  const success = background.normalizeDrcomResult(
    "login", 200, { result: 1, msg: "ok" }, '{"result":1,"msg":"ok"}'
  );
  const unknown = background.normalizeDrcomResult(
    "login", 200, { result: 7, msg: "maybe" }, '{"result":7,"msg":"maybe"}'
  );

  assert.equal(success.success, true);
  assert.equal(unknown.success, false);
  assert.match(unknown.message, /未识别/);
});

test("DrCOM 日志 URL 和文本不保留具体 IP 或 MAC", () => {
  const background = loadDrcomClient();
  const safeUrl = background.redactSensitiveUrl(
    "http://10.10.10.2:801/eportal/?c=Portal&a=login&user_account=student%40telecom&user_password=secret&wlan_user_ip=192.0.2.46&wlan_user_ipv6=2001%3Adb8%3A%3A1&wlan_user_mac=AABBCCDDEEFF&wlan_ac_ip=192.0.2.1"
  );
  const safeText = background.redactSensitiveText(
    "client=192.0.2.46 ac=192.0.2.1 mac=AA:BB:CC:DD:EE:FF compact=AABBCCDDEEFF ipv6=2001:db8::1"
  );

  for (const sensitive of [
    "secret",
    "192.0.2.46",
    "192.0.2.1",
    "AA:BB:CC:DD:EE:FF",
    "AABBCCDDEEFF",
    "2001:db8::1"
  ]) {
    assert.equal(safeUrl.includes(sensitive), false, sensitive);
    assert.equal(safeText.includes(sensitive), false, sensitive);
  }
  assert.match(safeUrl, /a=login/);
});

test("URL 脱敏覆盖大小写、重复参数、别名、fragment 和双重编码键", () => {
  const background = loadDrcomClient();
  const safe = background.redactSensitiveUrl(
    "http://10.10.10.2/eportal/?USER_PASSWORD=first&user_password=second&passwd=third&%2575ser_password=fourth&User_Account=202513010318%40telecom#password=fifth&账号=202513010318"
  );
  for (const secret of ["first", "second", "third", "fourth", "fifth", "202513010318"]) {
    assert.equal(safe.includes(secret), false, secret);
  }
  assert.match(safe, /\*\*\*|redacted/i);
});

test("find_mac 日志 URL 使用统一敏感 URL 脱敏", () => {
  const background = loadDrcomClient();
  const config = {
    apiUrl: "http://10.10.10.2:801/eportal/",
    login: { loginMethod: "1", jsVersion: "3.3.2" },
    network: { wlanUserIp: "192.0.2.46" }
  };
  const request = background.buildFindMacRequest({ username: "202513010318", suffix: "@telecom", network: {} }, config);
  assert.doesNotMatch(request.redactedUrl, /202513010318|192\.0\.2\.46/);
  assert.match(request.redactedUrl, /\*\*\*|redacted/i);
});
