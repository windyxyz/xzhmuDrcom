"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPortalContext(overrides = {}) {
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    clearTimeout,
    fetch: overrides.fetch || fetch,
    setTimeout
  });
  for (const file of ["response-reader.js", "portal-context.js"]) {
    const source = readFileSync(join(__dirname, "..", "CRX", "background", file), "utf8");
    new vm.Script(source, { filename: `background/${file}` }).runInContext(context);
  }
  return context;
}

const invalidIps = [
  "0.0.0.0",
  "01.2.3.4",
  "256.1.1.1",
  "1.2.3",
  "1.2.3.4.5",
  "1.2.3.-1",
  "1.2.3.4x",
  "::1"
];

for (const ip of invalidIps) {
  test(`门户上下文拒绝非法 IPv4：${ip}`, () => {
    const context = loadPortalContext();
    const result = context.parsePortalRuntimeContext(`var v46ip="${ip}";`, "http://10.10.10.2/");
    assert.equal(result.ok, false);
    assert.equal(result.network.wlanUserIp, "");
  });
}

test("门户上下文可解码静态字符串里的十六进制转义 IPv4", () => {
  const context = loadPortalContext();
  const result = context.parsePortalRuntimeContext(
    String.raw`var v46ip="\x31\x39\x32.\x30.\x32.\x34\x36";`,
    "http://10.10.10.2/"
  );
  assert.equal(result.ok, true);
  assert.equal(result.network.wlanUserIp, "192.0.2.46");
  assert.equal(result.ipSource, "v46ip");
});

test("门户上下文按 URL 参数白名单顺序选择首个合法地址", () => {
  const context = loadPortalContext();
  const result = context.parsePortalRuntimeContext(
    "<html></html>",
    "http://10.10.10.2/?ip=999.1.1.1&wlanuserip=192.0.2.8&station_ip=192.0.2.9"
  );
  assert.equal(result.network.wlanUserIp, "192.0.2.8");
  assert.equal(result.ipSource, "url:wlanuserip");
});

test("门户页面实时 IP 与 URL 一致时不报告冲突", () => {
  const context = loadPortalContext();
  const result = context.parsePortalRuntimeContext(
    'var v46ip="192.0.2.8";',
    "http://10.10.10.2/?station_ip=192.0.2.8"
  );
  assert.equal(result.ipConflict, false);
});

test("门户页面脚本表达式不会被执行或当作静态字符串读取", () => {
  const context = loadPortalContext();
  const result = context.parsePortalRuntimeContext(
    'var v46ip = globalThis.pwned = "192.0.2.8";',
    "http://10.10.10.2/"
  );
  assert.equal(result.ok, false);
  assert.equal(context.pwned, undefined);
});

test("门户抓取失败时优先使用当前页面 URL 的合法 IP", async () => {
  const context = loadPortalContext({ fetch: async () => { throw new Error("offline"); } });
  const result = await context.resolvePortalRuntimeContext(
    { portalUrl: "http://10.10.10.2/", network: { wlanUserIp: "192.0.2.99" } },
    "http://10.10.10.2/?station_ip=192.0.2.7"
  );
  assert.equal(result.ok, true);
  assert.equal(result.network.wlanUserIp, "192.0.2.7");
  assert.equal(result.ipSource, "url:station_ip");
});

test("门户抓取失败且页面无 IP 时回退到已配置 IP", async () => {
  const context = loadPortalContext({ fetch: async () => { throw new Error("offline"); } });
  const result = await context.resolvePortalRuntimeContext(
    { portalUrl: "http://10.10.10.2/", network: { wlanUserIp: "192.0.2.99" } },
    "http://10.10.10.2/"
  );
  assert.equal(result.ok, true);
  assert.equal(result.network.wlanUserIp, "192.0.2.99");
  assert.equal(result.ipSource, "config");
});

test("门户抓取失败且没有任何 IP 时明确标记 unreachable", async () => {
  const context = loadPortalContext({ fetch: async () => { throw new Error("offline"); } });
  const result = await context.resolvePortalRuntimeContext(
    { portalUrl: "http://10.10.10.2/", network: {} },
    "http://10.10.10.2/"
  );
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, "portal_context_unreachable");
  assert.match(result.message, /尚未发送认证密码/);
});

test("门户响应声明超过 1 MiB 时拒绝正文，即使本地有旧 IP 也不继续认证", async () => {
  let aborted = false;
  const context = loadPortalContext({
    fetch: async () => ({
      status: 200,
      headers: { get(name) { return name.toLowerCase() === "content-length" ? String(1024 * 1024 + 1) : null; } },
      async text() { throw new Error("oversized body must not be read"); }
    })
  });
  // response-reader 会调用 controller.abort()；通过结果语义验证安全短路。
  const result = await context.resolvePortalRuntimeContext(
    { portalUrl: "http://10.10.10.2/", network: { wlanUserIp: "192.0.2.99" } },
    "http://10.10.10.2/"
  );
  void aborted;
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, "portal_response_too_large");
});

test("门户成功响应没有实时 IP 时仍可安全回退配置 IP", async () => {
  const context = loadPortalContext({
    fetch: async () => ({
      status: 200,
      url: "http://10.10.10.2/",
      headers: { get() { return null; } },
      body: null,
      async text() { return "<html>no runtime ip</html>"; }
    })
  });
  const result = await context.resolvePortalRuntimeContext(
    { portalUrl: "http://10.10.10.2/", network: { wlanUserIp: "192.0.2.99" } },
    ""
  );
  assert.equal(result.ok, true);
  assert.equal(result.ipSource, "config");
  assert.equal(result.statusCode, 200);
});
