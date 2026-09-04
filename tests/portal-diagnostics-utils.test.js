"use strict";

const assert = require("node:assert/strict");
const { join } = require("node:path");
const test = require("node:test");

const utilsPath = join(__dirname, "..", "CRX", "portal-diagnostics-utils.js");
const utils = require(utilsPath);

test("诊断 URL 只保留来源和路径", () => {
  assert.equal(
    utils.sanitizeUrl("http://10.10.10.2/drcom/chkstatus?uid=202600000001&token=fake#result"),
    "http://10.10.10.2/drcom/chkstatus?uid=%5Bredacted%5D&token=%5Bredacted%5D"
  );
});

test("诊断文本删除账号、IP、MAC 和凭据", () => {
  const result = utils.sanitizeText(
    "uid=202600000001 ip=192.0.2.15 mac=00:11:22:33:44:55 password=fake-secret"
  );
  assert.doesNotMatch(result, /202600000001|192\.0\.2\.15|00:11:22:33:44:55|fake-secret/);
});

test("诊断文本删除中文密码、口令、账号、学号和凭据字段", () => {
  const result = utils.sanitizeText(
    "密码=秘密值 口令: another-secret 账号=202513010318 学号:202513010319 凭据=BearerValue"
  );
  assert.doesNotMatch(result, /秘密值|another-secret|202513010318|202513010319|BearerValue/);
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
    url: "https://example.test/path?token=%5Bredacted%5D",
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
test("诊断 URL 仅接受 HTTP(S)，隐藏非固定 IP 主机并清理路径", () => {
  assert.equal(utils.sanitizeUrl("data:text/html,secret"), "");
  assert.equal(utils.sanitizeUrl("ftp://example.test/file"), "");
  assert.equal(utils.sanitizeUrl("http://192.0.2.15/private/202600000001"), "http://[redacted-ip]/private/[redacted-id]");
  assert.equal(utils.sanitizeUrl("https://[2001:db8::1]/private"), "https://[redacted-ip]/private");
  assert.equal(utils.sanitizeUrl("http://portal.example.test/private"), "http://portal.example.test/private");
});

test("诊断 URL 只保留白名单协议 action 值并为其他参数保留键名", () => {
  assert.equal(
    utils.sanitizeUrl("http://10.10.10.2/eportal/?a=login&action=logout&user_account=student&token=secret&c=Portal"),
    "http://10.10.10.2/eportal/?a=login&action=logout&user_account=%5Bredacted%5D&token=%5Bredacted%5D&c=%5Bredacted%5D"
  );
  assert.equal(utils.sanitizeUrl("http://10.10.10.2/?a=student&action=not-safe"), "http://10.10.10.2/?a=%5Bredacted%5D&action=%5Bredacted%5D");
});

test("诊断 URL 会隐藏敏感键和主机标签并限制结构名称长度", () => {
  assert.equal(
    utils.sanitizeUrl("https://202600000001.example.test/path?202600000001=value&safe_name=value"),
    "https://redacted-id.example.test/path?redacted-id=%5Bredacted%5D&safe_name=%5Bredacted%5D"
  );
  assert.equal(
    utils.sanitizeUrl("https://abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz.example.test/?abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz=value"),
    "https://abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijk.example.test/?abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijkl=%5Bredacted%5D"
  );
  assert.equal(
    utils.sanitizeText("abcdef0123456789abcdef0123456789"),
    "[redacted-secret]"
  );
});

test("诊断文本完整删除带空格的凭据、授权头和多段 Cookie", () => {
  const result = utils.sanitizeText("Authorization: Bearer secret-value Cookie: sid=one; token=two password = \"fake secret value\"");
  assert.doesNotMatch(result, /Bearer|secret-value|sid=one|token=two|fake secret value/);
  assert.match(result, /Authorization=\[redacted\]/i);
});

test("诊断文本删除手机号、邮件、账号后缀和高熵字符串", () => {
  const result = utils.sanitizeText("phone=13812345678 email=student@example.com account=202513010318@telecom key=Ab9xY7zQ2mN8pL4rT6vK");
  assert.doesNotMatch(result, /13812345678|student@example.com|@telecom|Ab9xY7zQ2mN8pL4rT6vK/);
});

test("诊断文本删除各种 IPv6 和 MAC 表示", () => {
  const result = utils.sanitizeText([
    "IPv6=2001:db8::1",
    "full=2001:0db8:0000:0000:0000:ff00:0042:8329",
    "bracket=[2001:db8::2]",
    "mac-colon=00:11:22:33:44:55",
    "mac-hyphen=00-11-22-33-44-66",
    "mac-plain=001122334477"
  ].join(" "));
  assert.doesNotMatch(result, /2001:db8::1|2001:0db8:0000:0000:0000:ff00:0042:8329|2001:db8::2|00:11:22:33:44:55|00-11-22-33-44-66|001122334477/);
  assert.match(result, /redacted/);
});

test("畸形诊断输入会归一化为空对象而不抛异常", () => {
  assert.doesNotThrow(() => utils.sanitizeTarget(null));
  assert.doesNotThrow(() => utils.sanitizeRecord(null));
  assert.deepEqual(utils.sanitizeTarget(null), { tag: "", id: "", name: "", type: "", role: "", ariaLabel: "" });
  assert.equal(utils.sanitizeRecord(null).pageKind, "unknown");
});

test("诊断摘要在 64 KiB 边界下分别保留和截断", () => {
  const below = "x".repeat(64 * 1024 - 1);
  const above = "x".repeat(64 * 1024 + 1);
  assert.equal(utils.sanitizeRecord({ summary: below }).summary.length, 64 * 1024 - 1);
  assert.equal(utils.sanitizeRecord({ summary: above }).summary.length, 64 * 1024);
});

test("资源字段仅保留白名单 initiator 和有限非负数", () => {
  const record = utils.sanitizeRecord({ type: "resource", initiatorType: "SCRIPT", status: 0, duration: 2.5 });
  assert.equal(record.initiatorType, "script");
  assert.equal(record.status, 0);
  assert.equal(record.duration, 2.5);
  const rejected = utils.sanitizeRecord({ type: "resource", initiatorType: "custom", status: Infinity, duration: -1 });
  assert.equal("initiatorType" in rejected, false);
  assert.equal("status" in rejected, false);
  assert.equal("duration" in rejected, false);
});
