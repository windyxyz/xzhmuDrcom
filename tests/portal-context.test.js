"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPortalContext(overrides = {}) {
  const context = vm.createContext({
    AbortController,
    URL,
    clearTimeout,
    fetch: overrides.fetch || fetch,
    setTimeout
  });
  const source = readFileSync(join(__dirname, "..", "CRX", "background", "portal-context.js"), "utf8");
  new vm.Script(source, { filename: "background/portal-context.js" }).runInContext(context);
  return context;
}

test("当前门户 URL 的标准 IP 参数优先于页面脚本变量", () => {
  const background = loadPortalContext();
  const html = readFileSync(join(__dirname, "fixtures", "portal-runtime.html"), "utf8");

  const result = background.parsePortalRuntimeContext(
    html,
    "http://10.10.10.2/?station_ip=192.0.2.7"
  );

  assert.equal(result.ok, true);
  assert.equal(result.network.wlanUserIp, "192.0.2.7");
  assert.equal(result.ipSource, "url:station_ip");
});

test("门户上下文严格按 v46ip、ss5、v4ip、ss3 顺序选择 IP", () => {
  const background = loadPortalContext();
  const cases = [
    {
      html: 'var v46ip="192.0.2.46"; var ss5="192.0.2.55"; var v4ip="192.0.2.44"; var ss3="C0000203";',
      wantIp: "192.0.2.46",
      wantSource: "v46ip"
    },
    {
      html: 'var v46ip="0.0.0.0"; var ss5="192.0.2.55"; var v4ip="192.0.2.44"; var ss3="C0000203";',
      wantIp: "192.0.2.55",
      wantSource: "ss5"
    },
    {
      html: 'var v46ip="invalid"; var ss5=""; var v4ip="192.0.2.44"; var ss3="C0000203";',
      wantIp: "192.0.2.44",
      wantSource: "v4ip"
    },
    {
      html: 'var v46ip=""; var ss5=""; var v4ip=""; var ss3="C0000203";',
      wantIp: "192.0.2.3",
      wantSource: "ss3"
    }
  ];

  for (const fixture of cases) {
    const result = background.parsePortalRuntimeContext(fixture.html, "http://10.10.10.2/");
    assert.equal(result.network.wlanUserIp, fixture.wantIp);
    assert.equal(result.ipSource, fixture.wantSource);
  }
});

test("门户上下文拒绝非法地址和可执行表达式", () => {
  const background = loadPortalContext();
  const result = background.parsePortalRuntimeContext(
    'var v46ip=(globalThis.__portalCodeExecuted=true,"192.0.2.9"); var ss3="not-hex";',
    "http://10.10.10.2/?ip=000.000.000.000"
  );

  assert.equal(result.ok, false);
  assert.equal(result.network.wlanUserIp, "");
  assert.equal(background.__portalCodeExecuted, undefined);
});
