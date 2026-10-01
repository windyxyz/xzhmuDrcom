"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CRX = join(__dirname, "..", "CRX");

function loadGlobals(files, extras = {}) {
  const context = vm.createContext({
    URL,
    TextDecoder,
    Uint8Array,
    atob,
    console,
    ...extras
  });
  for (const file of files) {
    new vm.Script(readFileSync(join(CRX, file), "utf8"), { filename: file }).runInContext(context);
  }
  return context;
}

test("共享门户 URL 模块严格区分 origin 端口，同时生成浏览器合法匹配模式", () => {
  const { DrcomPortalUrl: url } = loadGlobals(["portal-url.js"]);
  assert.equal(url.sameOrigin("http://gateway.example:8080/a", "http://gateway.example:8080/b"), true);
  assert.equal(url.sameOrigin("http://gateway.example:8080/", "http://gateway.example:9090/"), false);
  assert.equal(url.matchPattern("http://gateway.example:8080/login"), "http://gateway.example/*");
  assert.equal(url.origin("javascript:alert(1)"), "");
});

test("共享门户 URL 模块只把非默认 HTTP 网关标为明文自定义来源", () => {
  const { DrcomPortalUrl: url } = loadGlobals(["portal-url.js"]);
  assert.equal(url.isInsecureCustom("http://10.10.10.2/"), false);
  assert.equal(url.isInsecureCustom("https://gateway.example/"), false);
  assert.equal(url.isInsecureCustom("http://gateway.example/"), true);
});

test("DrCOM 协议模块独立解析 JSONP、query 且拒绝正文模糊抽取", () => {
  const protocol = require("../CRX/background/drcom-protocol.js");
  assert.deepEqual(protocol.parseText('dr1001({"result":1,"msg":"ok"})'), { result: 1, msg: "ok" });
  assert.deepEqual(protocol.parseText("result=0&msg=already+online"), { result: "0", msg: "already online" });
  assert.deepEqual(protocol.parseText("noise result=1 more noise"), {});
});

test("DrCOM 协议模块统一结构化错误分类和人类可读错误", () => {
  const protocol = require("../CRX/background/drcom-protocol.js");
  assert.equal(protocol.classifyFailureCode("password invalid", {}, "login"), "bad_credentials");
  assert.equal(protocol.classifyFailureCode("AC999 device limit", {}, "login"), "device_limit");
  const result = protocol.normalizeResult("login", 200, { result: 0, msg: "password invalid" });
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "bad_credentials");
  assert.match(result.message, /密码错误/);
});

test("设置页网关模块统一计算自定义权限并去重", () => {
  const context = loadGlobals(["portal-url.js", "options-gateway-controller.js"]);
  const gateway = context.DrcomOptionsGateway;
  assert.deepEqual(Array.from(gateway.customOrigins({
    portalUrl: "http://gateway.example:8080/login",
    apiUrl: "http://gateway.example:9090/eportal/"
  })), ["http://gateway.example/*"]);
  assert.deepEqual(Array.from(gateway.customOrigins({
    portalUrl: "http://10.10.10.2/",
    apiUrl: "http://10.10.10.2:801/eportal/"
  })), []);
});

test("设置页网关模块只撤销不再使用的旧来源权限", async () => {
  const removed = [];
  const context = loadGlobals(["portal-url.js", "options-gateway-controller.js"]);
  const gateway = context.DrcomOptionsGateway;
  const changed = await gateway.revokeUnusedAccess(
    { portalUrl: "https://old.example/", apiUrl: "https://old.example/eportal/" },
    { portalUrl: "https://new.example/", apiUrl: "https://new.example/eportal/" },
    { chromeApi: { permissions: { async remove(request) { removed.push(request); return true; } } } }
  );
  assert.equal(changed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(removed)), [{ origins: ["https://old.example/*"] }]);
});

test("颜色工具抽离后保持旧设置页的十六进制和 HSV 行为", () => {
  const colors = require("../CRX/options-color-utils.js");
  assert.equal(colors.normalizeHex("#007AFF"), "#007aff");
  assert.equal(colors.normalizeHex("#07f"), "");
  const rgb = colors.hsvToRgb(212, 1, 0.5);
  assert.deepEqual(rgb, { r: 0, g: 60, b: 128 });
  assert.equal(colors.rgbToHex(rgb.r, rgb.g, rgb.b), "#003c80");
  assert.deepEqual(colors.hexToRgb("#003c80"), rgb);
});

test("诊断模块纯函数保留容量显示、上限兼容和导出命名", () => {
  const diagnostics = require("../CRX/options-diagnostics-controller.js");
  assert.equal(diagnostics.limitBytes({ limits: { bytes: 2048 } }), 2048);
  assert.equal(diagnostics.limitSessions({ limits: { maxSessions: 12 } }), 12);
  assert.equal(diagnostics.formatSize(1536), "1.5 KB");
  assert.equal(
    diagnostics.exportFilename(new Date("2026-10-01T01:02:03.004Z")),
    "drcom-portal-diagnostics-2026-10-01T01-02-03-004Z.json"
  );
});

test("设置页新拆分模块全部在 options.js 之前加载", () => {
  const html = readFileSync(join(CRX, "options.html"), "utf8");
  const optionsIndex = html.indexOf('src="options.js"');
  for (const file of [
    "portal-url.js",
    "options-color-utils.js",
    "options-gateway-controller.js",
    "options-diagnostics-controller.js",
    "options-account-controller.js"
  ]) {
    const index = html.indexOf(`src="${file}"`);
    assert.ok(index >= 0 && index < optionsIndex, `${file} 应先于 options.js 加载`);
  }
});
