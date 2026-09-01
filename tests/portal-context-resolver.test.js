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

test("门户上下文请求首页并让实时 IP 覆盖全局兼容值", async () => {
  const calls = [];
  const html = readFileSync(join(__dirname, "fixtures", "portal-runtime.html"), "utf8");
  const background = loadPortalContext({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        url: "http://10.10.10.2/",
        async text() { return html; }
      };
    }
  });

  const result = await background.resolvePortalRuntimeContext({
    portalUrl: "http://10.10.10.2/",
    network: { wlanUserIp: "192.0.2.200" }
  }, "http://10.10.10.2/");

  assert.equal(result.ok, true);
  assert.equal(result.network.wlanUserIp, "192.0.2.46");
  assert.equal(result.ipSource, "v46ip");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://10.10.10.2/");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.cache, "no-store");
});

test("门户没有实时 IP 时仅接受有效的全局兼容值且不返回正文", async () => {
  const background = loadPortalContext({
    fetch: async () => ({
      ok: true,
      status: 200,
      url: "http://10.10.10.2/",
      async text() { return '<script>var v4ip="0.0.0.0";</script>'; }
    })
  });

  const fallback = await background.resolvePortalRuntimeContext({
    portalUrl: "http://10.10.10.2/",
    network: { wlanUserIp: "192.0.2.88" }
  }, "");
  const missing = await background.resolvePortalRuntimeContext({
    portalUrl: "http://10.10.10.2/",
    network: { wlanUserIp: "000.000.000.000" }
  }, "");

  assert.equal(fallback.network.wlanUserIp, "192.0.2.88");
  assert.equal(fallback.ipSource, "config");
  assert.equal(missing.ok, false);
  assert.equal(missing.failureCode, "portal_context_missing");
  assert.doesNotMatch(JSON.stringify(missing), /<script>|v4ip/);
});
