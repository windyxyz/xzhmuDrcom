"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require("../CRX/background/drcom-protocol.js");

const parseCases = [
  ["BOM + JSON", "\uFEFF  {\"result\":1,\"msg\":\"ok\"}  ", { result: 1, msg: "ok" }],
  ["JSONP dotted callback", "dr.portal.cb({\"result\":1});", { result: 1 }],
  ["query plus decoding", "result=0&msg=already+online", { result: "0", msg: "already online" }],
  ["query percent decoding", "result=0&msg=a%26b%3Dc", { result: "0", msg: "a&b=c" }],
  ["pseudo object quoted comma", "{result:'0',msg:'a,b'}", { result: "0", msg: "a,b" }],
  ["pseudo object quoted colon", "{result:'0',msg:'a:b'}", { result: "0", msg: "a:b" }]
];

for (const [name, input, expected] of parseCases) {
  test(`DrCOM 解析边界：${name}`, () => {
    assert.deepEqual(protocol.parseText(input), expected);
  });
}

const rejectedContainers = [
  ["JSON array", '[{"result":1}]'],
  ["JSON string", '"result=1"'],
  ["JSON number", "1"],
  ["JSON boolean", "true"],
  ["JSONP array", "cb([{\"result\":1}])"],
  ["JSONP primitive", "cb(1)"],
  ["invalid callback", "alert(1);cb({\"result\":1})"],
  ["unclosed quoted pair", "result=1&msg='unterminated"],
  ["bad percent encoding", "result=1&msg=%E0%A4%A"],
  ["free-form body", "noise result=1 more noise"]
];

for (const [name, input] of rejectedContainers) {
  test(`DrCOM 拒绝非结构化响应：${name}`, () => {
    assert.deepEqual(protocol.parseText(input), {});
  });
}

test("DrCOM 明确 HTTP 失败优先于正文成功标记", () => {
  const result = protocol.normalizeResult("login", 503, { result: 1, msg: "login success" });
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "http_error");
  assert.equal(result.httpOk, false);
});

test("DrCOM 登录 result=0 + ret_code=2 + already online 必须进入状态复核", () => {
  const result = protocol.normalizeResult("login", 200, {
    result: 0,
    ret_code: 2,
    msg: "already online"
  });
  assert.equal(result.success, false);
  assert.equal(result.requiresStatusConfirmation, true);
  assert.equal(result.failureCode, "");
});

test("DrCOM 未知协议码保持失败而不是凭正文猜成功", () => {
  const result = protocol.normalizeResult("login", 200, {
    result: "mystery",
    msg: "login success"
  });
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "protocol_unknown");
});

test("DrCOM 布尔 success 字段可作为明确成功协议值", () => {
  const result = protocol.normalizeResult("login", 200, { success: true, msg: "ok" });
  assert.equal(result.success, true);
  assert.equal(result.online, true);
});

test("DrCOM 下线无 result 时只接受明确下线语义", () => {
  assert.equal(protocol.normalizeResult("logout", 200, { msg: "logout success" }).success, true);
  assert.equal(protocol.normalizeResult("logout", 200, { msg: "request accepted" }).success, false);
});

test("DrCOM 下线失败语义优先于同一消息中的 success 单词", () => {
  const result = protocol.normalizeResult("logout", 200, { msg: "logout error after previous success" });
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "gateway_rejected");
});

const failureCases = [
  ["userid error1", "user_not_found"],
  ["账号不存在", "user_not_found"],
  ["password invalid", "bad_credentials"],
  ["密码不正确", "bad_credentials"],
  ["AC999 device limit", "device_limit"],
  ["终端数量超限", "device_limit"],
  ["balance insufficient", "account_restricted"],
  ["流量已用完", "account_restricted"],
  ["ip mismatch", "network_parameters"],
  ["MAC invalid", "network_parameters"],
  ["bind error", "network_parameters"]
];

for (const [message, expected] of failureCases) {
  test(`DrCOM 错误分类：${message} -> ${expected}`, () => {
    assert.equal(protocol.classifyFailureCode(message, {}, "login"), expected);
  });
}

test("普通含 ip 字母的英文单词不会被误写成 IP/MAC 参数错误", () => {
  const message = protocol.humanizeError("script error", {}, "login");
  assert.equal(message, "登录失败：script error");
});

test("普通 password 服务错误不会被误判为密码错误", () => {
  assert.equal(
    protocol.classifyFailureCode("password service unavailable", {}, "login", "gateway_rejected"),
    "gateway_rejected"
  );
});

test("Base64 中文错误信息可解码后参与分类", () => {
  const encoded = Buffer.from("密码错误", "utf8").toString("base64");
  assert.equal(protocol.decodeMessage(encoded), "密码错误");
  assert.equal(protocol.classifyFailureCode(encoded, {}, "login"), "bad_credentials");
});

test("非 UTF-8 Base64 候选保持原文而不是抛错", () => {
  const original = "/+7d";
  assert.equal(typeof protocol.decodeMessage(original), "string");
});
