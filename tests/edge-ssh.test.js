"use strict";

const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const test = require("node:test");
const {
  createHarness,
  requestUrls,
  sshEnvironmentReady
} = require("./fixtures/ssh-harness");

const testSsh = (name, fn) => test(name, async (t) => {
  if (!(await sshEnvironmentReady(t))) return;
  return fn(t);
});

function replaceConfig(path, changes) {
  let text = readFileSync(path, "utf8");
  for (const [key, value] of Object.entries(changes)) {
    const line = `${key}='${String(value).replaceAll("'", "")}'`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, text, "utf8");
}

testSsh("SSH HTTPS 门户未指定 API_URL 时沿用 HTTPS origin 而不强加 801", () => {
  const harness = createHarness({
    portal: "https://gateway.example:9443/login",
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"configured-user","v46ip":"172.28.180.144"})'
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const login = requestUrls(harness.paths.requestLog).map((value) => new URL(value))
      .find((url) => url.searchParams.get("a") === "login");
    assert.ok(login);
    assert.equal(login.origin, "https://gateway.example:9443");
    assert.equal(login.pathname, "/eportal/");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH IPv6 HTTP 门户移除自定义端口后正确切换到 801", () => {
  const harness = createHarness({
    portal: "http://[2001:db8::1]:8080/login",
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"configured-user","v46ip":"172.28.180.144"})'
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const login = requestUrls(harness.paths.requestLog).map((value) => new URL(value))
      .find((url) => url.searchParams.get("a") === "login");
    assert.ok(login);
    assert.equal(login.hostname, "[2001:db8::1]");
    assert.equal(login.port, "801");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH API_URL 会去掉 query/hash 并规范到单个 eportal 路径", () => {
  const harness = createHarness({
    apiUrl: "https://api.example:9443/eportal/?token=secret#fragment",
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"configured-user","v46ip":"172.28.180.144"})'
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const login = requestUrls(harness.paths.requestLog).map((value) => new URL(value))
      .find((url) => url.searchParams.get("a") === "login");
    assert.ok(login);
    assert.equal(login.origin, "https://api.example:9443");
    assert.equal(login.pathname, "/eportal/");
    assert.equal(login.searchParams.has("token"), false);
    assert.equal(login.hash, "");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 特殊字符账号和密码只以 URL 编码形式进入认证请求", () => {
  const harness = createHarness({
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    statusAfter: 'dr1001({"result":1,"uid":"user name+tag@telecom","v46ip":"172.28.180.144"})'
  });
  try {
    replaceConfig(harness.paths.config, {
      USERNAME: "user name+tag",
      PASSWORD: "p&ss=word ?#",
      SUFFIX: "@telecom"
    });
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const raw = requestUrls(harness.paths.requestLog).find((value) => value.includes("a=login"));
    assert.ok(raw);
    assert.doesNotMatch(raw, /p&ss=word \?#/);
    const login = new URL(raw);
    assert.equal(login.searchParams.get("user_account"), ",0,user name+tag@telecom");
    assert.equal(login.searchParams.get("user_password"), "p&ss=word ?#");
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 登录失败的 stdout/stderr 不回显配置密码", () => {
  const harness = createHarness({
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    loginResponse: 'dr1002({"result":0,"msg":"gateway rejected"})'
  });
  try {
    replaceConfig(harness.paths.config, { PASSWORD: "UltraSecret-123!" });
    const result = harness.run("login");
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /UltraSecret-123!/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 普通 script error 不应误分类成 network_parameters", () => {
  const harness = createHarness({
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    loginResponse: 'dr1002({"result":0,"msg":"script error"})'
  });
  try {
    const result = harness.run("login");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /code=gateway_rejected/);
    assert.doesNotMatch(result.stderr, /code=network_parameters/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH password service unavailable 不应误分类成 bad_credentials", () => {
  const harness = createHarness({
    statusOnline: 'dr1001({"result":0,"msg":"offline"})',
    loginResponse: 'dr1002({"result":0,"msg":"password service unavailable"})'
  });
  try {
    const result = harness.run("login");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /code=gateway_rejected/);
    assert.doesNotMatch(result.stderr, /code=bad_credentials/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH status 对 true/ok 等登录成功 token 不猜测在线，只接受 chkstatus 0/1", () => {
  const harness = createHarness({ statusOnline: 'dr1001({"result":"true","msg":"ok"})' });
  try {
    const result = harness.run("status");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /state=unknown/);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 缺失 USERNAME 时在发送登录密码前失败", () => {
  const harness = createHarness({ statusOnline: 'dr1001({"result":0,"msg":"offline"})' });
  try {
    replaceConfig(harness.paths.config, { USERNAME: "" });
    const result = harness.run("login");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /USERNAME is required/);
    assert.equal(requestUrls(harness.paths.requestLog).some((url) => url.includes("a=login")), false);
  } finally {
    harness.cleanup();
  }
});

testSsh("SSH 缺失 PASSWORD 时在发送认证请求前失败", () => {
  const harness = createHarness({ statusOnline: 'dr1001({"result":0,"msg":"offline"})' });
  try {
    replaceConfig(harness.paths.config, { PASSWORD: "" });
    const result = harness.run("login");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PASSWORD is required/);
    assert.equal(requestUrls(harness.paths.requestLog).some((url) => url.includes("a=login")), false);
  } finally {
    harness.cleanup();
  }
});
