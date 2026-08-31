"use strict";

const assert = require("node:assert/strict");
const { join } = require("node:path");
const test = require("node:test");

const utilsPath = join(__dirname, "..", "CRX", "portal-diagnostics-utils.js");
const utils = require(utilsPath);

test("诊断 URL 只保留来源和路径", () => {
  assert.equal(
    utils.sanitizeUrl("http://10.10.10.2/drcom/chkstatus?uid=202600000001&token=fake#result"),
    "http://10.10.10.2/drcom/chkstatus"
  );
});

test("诊断文本删除账号、IP、MAC 和凭据", () => {
  const result = utils.sanitizeText(
    "uid=202600000001 ip=192.0.2.15 mac=00:11:22:33:44:55 password=fake-secret"
  );
  assert.doesNotMatch(result, /202600000001|192\.0\.2\.15|00:11:22:33:44:55|fake-secret/);
});

test("控件描述保留结构但忽略 value", () => {
  assert.deepEqual(utils.sanitizeTarget({
    tag: "INPUT",
    id: "username",
    name: "user_account",
    type: "text",
    role: "textbox",
    ariaLabel: "校园网账号",
    value: "202600000001"
  }), {
    tag: "input",
    id: "username",
    name: "user_account",
    type: "text",
    role: "textbox",
    ariaLabel: "校园网账号"
  });
});

test("诊断 URL 对 malformed input 返回空字符串", () => {
  assert.equal(utils.sanitizeUrl("not a URL"), "");
  assert.equal(utils.sanitizeUrl(null), "");
});

test("诊断文本删除 query string 中的凭据并压缩空白", () => {
  const result = utils.sanitizeText("path?token=top-secret&uid=202600000001\n  status=ok");
  assert.equal(result, "path?token=[redacted]&uid=[redacted] status=ok");
});

test("UTF-8 截断按字节边界保留完整字符", () => {
  assert.equal(utils.utf8Bytes("a你"), 4);
  assert.equal(utils.truncateUtf8("a你b", 4), "a你");
  assert.equal(utils.truncateUtf8("a你b", 3), "a");
  assert.equal(utils.truncateUtf8("abc", 3), "abc");
});

test("诊断记录只保留允许类型和已知字段", () => {
  assert.deepEqual(utils.sanitizeRecord({
    type: "not-allowed",
    at: -5,
    pageKind: "invalid",
    url: "https://example.test/path?token=secret",
    method: " post ",
    status: "204",
    summary: "done",
    message: "ok",
    value: "must be ignored",
    extra: "must be ignored"
  }), {
    type: "navigation",
    at: 0,
    pageKind: "unknown",
    url: "https://example.test/path",
    method: "POST",
    status: 204,
    summary: "done",
    message: "ok"
  });
});

test("诊断记录保留允许类型、页面类型和安全控件描述", () => {
  assert.deepEqual(utils.sanitizeRecord({
    type: "click",
    at: 123,
    pageKind: "login",
    target: { tag: "BUTTON", value: "202600000001", ariaLabel: "登录" }
  }), {
    type: "click",
    at: 123,
    pageKind: "login",
    target: { tag: "button", id: "", name: "", type: "", role: "", ariaLabel: "登录" }
  });
});

test("大于默认字节上限的文本会被 UTF-8 安全截断", () => {
  const result = utils.sanitizeText("你".repeat(3000));
  assert.ok(utils.utf8Bytes(result) <= 4096);
  assert.ok(result.length < 3000);
  assert.equal(result, "你".repeat(1365));
});
