"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  createHarness,
  requestUrls,
  shellPath,
  shellQuote,
  sshEnvironmentReady,
  writeFixture
} = require("./fixtures/ssh-harness");

/* 有条件执行：WSL/POSIX 环境缺失时跳过，避免在 Windows 上报假失败。 */
const testSsh = (name, fn) => test(name, async (t) => {
  if (!(await sshEnvironmentReady(t))) return;
  return fn(t);
});

testSsh("SSH 无本地会话时使用 chkstatus 的在线身份和 ss4 解绑", () => {
  const harness = createHarness();
  try {
    const result = harness.run("logout");
    const rawRequests = requestUrls(harness.paths.requestLog);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${rawRequests.join("\n")}`);
    const requests = rawRequests.map((value) => new URL(value));
    const unbind = requests.find((url) => url.searchParams.get("a") === "unbind_mac");
    assert.equal(requests.filter((url) => url.hostname === "127.0.0.1").length, 1, "wget -i 能力只探测一次");
    assert.ok(unbind, "应发送 unbind_mac");
    assert.equal(unbind.searchParams.get("user_account"), "student@telecom");
    assert.equal(unbind.searchParams.get("wlan_user_ip"), "172.28.180.144");
    assert.equal(unbind.searchParams.get("wlan_user_mac"), "580205DC58C2");
    assert.equal(requests.some((url) => url.searchParams.get("a") === "logout"), false);
    assert.equal(readFileSync(harness.paths.sleepLog, "utf8").trim().split(/\r?\n/)[0], "5");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 的 ss4 无效时只采用 find_mac 中当前 IP 对应的 MAC", () => {
  const harness = createHarness({
    statusOnline: "dr1001({\"result\":1,\"uid\":\"student\",\"v46ip\":\"172.28.180.144\",\"ss4\":\"111111111111\"})",
    findMac: "dr1004({\"result\":1,\"list\":[{\"online_ip\":\"172.28.180.99\",\"online_mac\":\"11:22:33:44:55:66\"},{\"online_ip\":\"172.28.180.144\",\"online_mac\":\"58:02:05:DC:58:C2\"}]})"
  });
  try {
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    const findMac = requests.filter((url) => url.searchParams.get("a") === "find_mac");
    const unbind = requests.find((url) => url.searchParams.get("a") === "unbind_mac");
    assert.equal(findMac.length, 1);
    assert.equal(findMac[0].searchParams.get("user_account"), "student");
    assert.ok(unbind, `${result.stderr}\n${requestUrls(harness.paths.requestLog).join("\n")}`);
    assert.equal(unbind.searchParams.get("wlan_user_mac"), "580205DC58C2");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 会话文件按数据解析，不执行其中的 shell 内容", () => {
  const harness = createHarness();
  const marker = join(harness.paths.root, "executed");
  try {
    writeFixture(harness.paths.session, [
      "SESSION_IP=172.28.180.144",
      "SESSION_MAC=580205DC58C2",
      `touch ${shellQuote(shellPath(marker))}`,
      ""
    ].join("\n"));
    harness.run("logout");
    assert.equal(existsSync(marker), false);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 拒绝超过 64 KiB 的状态响应", () => {
  const largeStatus = `dr1001({"result":1,"msg":"${"a".repeat(70 * 1024)}"})`;
  const harness = createHarness({ statusOnline: largeStatus, statusAfter: largeStatus });
  try {
    const result = harness.run("status");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /state=unknown/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 状态响应通过有界管道读取，不让 wget 先写完整临时文件", () => {
  const largeStatus = `dr1001({"result":1,"msg":"${"a".repeat(70 * 1024)}"})`;
  const harness = createHarness({ statusOnline: largeStatus, statusAfter: largeStatus });
  try {
    const result = harness.run("status");
    const outputs = readFileSync(harness.paths.wgetOutputLog, "utf8").trim().split(/\r?\n/);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /state=unknown/);
    assert.equal(outputs[1], "-", "chkstatus 应经 stdout 管道进入大小限制读取器");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 登录沿用生产请求：不查询 find_mac 且网络身份字段保持空值", () => {
  const harness = createHarness({
    statusOnline: "dr1001({\"result\":0,\"msg\":\"offline\"})",
    statusAfter: "dr1001({\"result\":1,\"uid\":\"configured-user\",\"v46ip\":\"172.28.180.144\"})"
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    assert.equal(requests.some((url) => url.searchParams.get("a") === "find_mac"), false);
    const login = requests.find((url) => url.searchParams.get("a") === "login");
    assert.ok(login, "应发送 Portal/login");
    assert.equal(login.searchParams.get("wlan_user_mac"), "000000000000");
    assert.equal(login.searchParams.get("wlan_user_ipv6"), "");
    assert.equal(login.searchParams.get("wlan_ac_ip"), "");
    assert.equal(login.searchParams.get("wlan_ac_name"), "");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 完整注销兜底携带学校页面要求的 VLAN 标记", () => {
  const harness = createHarness({
    statusOnline: "dr1001({\"result\":1,\"v46ip\":\"172.28.180.144\",\"ss4\":\"111111111111\"})"
  });
  try {
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    const logout = requests.find((url) => url.searchParams.get("a") === "logout");
    assert.ok(logout, "应发送完整 Portal/logout");
    assert.equal(logout.searchParams.get("wlan_vlan_id"), "1");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 状态解析不会把 notresult 误识别成 result", () => {
  const harness = createHarness({
    statusOnline: 'dr1001({"notresult":1,"msg":"synthetic"})'
  });
  try {
    const result = harness.run("status");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /state=unknown/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 保留带空格的 already online 消息并正确复核在线", () => {
  const harness = createHarness({
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"configured-user","v46ip":"172.28.180.144"})',
    loginResponse: 'dr1002({"result":0,"ret_code":2,"msg":"already online"})'
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /already online confirmed/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 自定义 HTTP 门户带端口时不会生成双端口 API URL", () => {
  const harness = createHarness({
    portal: "http://gateway.example:8080/login",
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"configured-user","v46ip":"172.28.180.144"})'
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    const login = requests.find((url) => url.searchParams.get("a") === "login");
    assert.ok(login, "应发送 Portal/login");
    assert.equal(login.hostname, "gateway.example");
    assert.equal(login.port, "801");
    assert.doesNotMatch(login.toString(), /:8080:801/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH API_URL 可显式覆盖自定义门户的 API 来源", () => {
  const harness = createHarness({
    portal: "http://gateway.example:8080/login",
    apiUrl: "https://api.example:9443/eportal/",
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"configured-user","v46ip":"172.28.180.144"})'
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    const login = requests.find((url) => url.searchParams.get("a") === "login");
    assert.ok(login, "应发送 Portal/login");
    assert.equal(login.origin, "https://api.example:9443");
    assert.equal(login.pathname, "/eportal/");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 门户正文实时 IP 优先于 PORTAL 中的旧查询参数", () => {
  const harness = createHarness({
    portal: "http://10.10.10.2/?station_ip=192.0.2.7",
    ip: "192.0.2.46",
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"configured-user","v46ip":"192.0.2.46"})'
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    const login = requests.find((url) => url.searchParams.get("a") === "login");
    assert.ok(login, "应发送 Portal/login");
    assert.equal(login.searchParams.get("wlan_user_ip"), "192.0.2.46");
    assert.match(result.stdout, /source=v46ip/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 登录失败输出与扩展一致的结构化凭据错误代码", () => {
  const harness = createHarness({
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    loginResponse: 'dr1002({"result":0,"msg":"password invalid"})'
  });
  try {
    const result = harness.run("login");
    assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /code=bad_credentials/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 登录失败区分账号不存在和网络参数错误", () => {
  const cases = [
    ['dr1002({"result":0,"msg":"userid error1"})', "user_not_found"],
    ['dr1002({"result":0,"msg":"ip mismatch"})', "network_parameters"]
  ];

  for (const [loginResponse, expectedCode] of cases) {
    const harness = createHarness({
      statusOnline: 'dr1001({"result":0,"msg":"offline"})',
      loginResponse
    });
    try {
      const result = harness.run("login");
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, new RegExp(`code=${expectedCode}`));
    } finally {
      harness.cleanup();
    }
  }
});
