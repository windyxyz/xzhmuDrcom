"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const portalUrl = require("../CRX/portal-url.js");
const account = require("../CRX/account-utils.js");

for (const value of [
  "javascript:alert(1)",
  "data:text/html,hello",
  "file:///tmp/portal.html",
  "ftp://gateway.example/",
  "ws://gateway.example/",
  "not a url",
  ""
]) {
  test(`门户 URL 拒绝非 HTTP(S)：${value || "empty"}`, () => {
    assert.equal(portalUrl.parse(value), null);
    assert.equal(portalUrl.origin(value), "");
    assert.equal(portalUrl.matchPattern(value), "");
  });
}

test("门户 URL 规范化协议、主机大小写和默认端口", () => {
  assert.equal(portalUrl.origin(" HTTP://EXAMPLE.COM:80/login "), "http://example.com");
  assert.equal(portalUrl.origin("https://EXAMPLE.COM:443/login"), "https://example.com");
});

test("门户 sameOrigin 把默认端口视为同源并严格区分非默认端口", () => {
  assert.equal(portalUrl.sameOrigin("http://example.com:80/a", "http://example.com/b"), true);
  assert.equal(portalUrl.sameOrigin("https://example.com:443/a", "https://example.com/b"), true);
  assert.equal(portalUrl.sameOrigin("https://example.com:444/a", "https://example.com/b"), false);
});

test("门户匹配模式不会泄露 URL 用户名密码、路径、查询或端口", () => {
  assert.equal(
    portalUrl.matchPattern("https://student:secret@gateway.example:9443/login?token=x#frag"),
    "https://gateway.example/*"
  );
});

test("门户 URL 支持 IPv6 host 且 origin 仍保留端口身份", () => {
  assert.equal(portalUrl.origin("http://[2001:db8::1]:8080/a"), "http://[2001:db8::1]:8080");
  assert.equal(portalUrl.matchPattern("http://[2001:db8::1]:8080/a"), "http://[2001:db8::1]/*");
});

test("默认网关判断只比较 hostname，不因 801 端口改变", () => {
  assert.equal(portalUrl.isDefaultGateway("http://10.10.10.2/"), true);
  assert.equal(portalUrl.isDefaultGateway("http://10.10.10.2:801/eportal/"), true);
  assert.equal(portalUrl.isDefaultGateway("http://10.10.10.20/"), false);
});

test("仅非默认明文 HTTP 自定义门户触发安全警告", () => {
  assert.equal(portalUrl.isInsecureCustom("http://gateway.example/"), true);
  assert.equal(portalUrl.isInsecureCustom("https://gateway.example/"), false);
  assert.equal(portalUrl.isInsecureCustom("http://10.10.10.2:801/"), false);
});

test("账号工具支持双重 URL 编码运营商后缀", () => {
  assert.equal(account.normalizeSuffix("%2540telecom"), "@telecom");
  assert.deepEqual(account.parse("student%2540telecom"), { username: "student", suffix: "@telecom" });
});

test("账号工具兼容学校 ,0, 前缀并优先使用账号自身后缀", () => {
  assert.deepEqual(account.parse(",0,student@unicom", "@telecom"), {
    username: "student",
    suffix: "@unicom"
  });
});

test("账号工具把纯 0 占位账号归一化为空", () => {
  assert.deepEqual(account.parse("0000", "@telecom"), { username: "", suffix: "@telecom" });
});

test("账号工具拒绝未知或带危险字符的 suffix", () => {
  assert.equal(account.normalizeSuffix("@telecom/../../x"), "");
  assert.equal(account.normalizeSuffix("javascript:alert(1)"), "");
  assert.equal(account.normalizeSuffix("@custom-ok_1"), "@custom-ok_1");
});

test("账号自然键区分大小写但规范化 suffix 大小写", () => {
  assert.notEqual(account.naturalKey({ username: "Student", suffix: "@telecom" }), account.naturalKey({ username: "student", suffix: "@telecom" }));
  assert.equal(account.naturalKey({ username: "Student", suffix: "@TELECOM" }), account.naturalKey({ username: "Student", suffix: "@telecom" }));
});

test("账号脱敏在短账号和长账号上都不会回显完整内容", () => {
  assert.equal(account.mask("1234"), "****");
  assert.equal(account.mask("123456789"), "12***89");
  assert.doesNotMatch(account.mask("student-account"), /student-account/);
});

test("MAC 规范化只保留十六进制并统一大写", () => {
  assert.equal(account.normalizeMac("58:02-05.dc 58:c2"), "580205DC58C2");
  assert.equal(account.normalizeMac("not-a-mac"), "AAC");
});
