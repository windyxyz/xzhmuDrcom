"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const portalUiPath = join(__dirname, "..", "CRX", "portal-ui.js");

test("门户账号解析优先采用账号字符串中的运营商后缀", () => {
  const { parseAccount } = require(portalUiPath);
  const cases = [
    {
      input: "%2C0%2C202513010318%40telecom",
      fallback: "",
      expected: { username: "202513010318", suffix: "@telecom" }
    },
    {
      input: "202513010318",
      fallback: "@cmcc",
      expected: { username: "202513010318", suffix: "@cmcc" }
    },
    {
      input: ",0,202513010318@unicom",
      fallback: "@telecom",
      expected: { username: "202513010318", suffix: "@unicom" }
    }
  ];

  for (const item of cases) {
    assert.deepEqual(parseAccount(item.input, item.fallback), item.expected);
  }
});

test("门户登录表单会生成后台需要的账号和网络结构", () => {
  const { buildAccount } = require(portalUiPath);
  const result = buildAccount(
    {
      username: ",0,202513010318@unicom",
      suffix: "@telecom",
      password: "secret"
    },
    {
      wlanUserIp: "10.0.0.8",
      wlanUserMac: "00-11-22-33-44-55",
      wlanAcIp: "10.0.0.1"
    }
  );

  assert.deepEqual(result, {
    label: "202513010318 联通",
    username: "202513010318",
    suffix: "@unicom",
    password: "secret",
    network: {
      wlanUserIp: "10.0.0.8",
      wlanUserMac: "001122334455",
      wlanUserIpv6: "",
      wlanAcIp: "10.0.0.1",
      wlanAcName: ""
    }
  });
});

test("只在功能启用且页面可识别为登录或在线状态时接管", () => {
  const { shouldTakeOver } = require(portalUiPath);
  assert.equal(shouldTakeOver({ enabled: true, online: false, hasPasswordField: true }), true);
  assert.equal(shouldTakeOver({ enabled: true, online: true, hasPasswordField: false }), true);
  assert.equal(shouldTakeOver({ enabled: false, online: false, hasPasswordField: true }), false);
  assert.equal(shouldTakeOver({ enabled: true, online: false, hasPasswordField: false }), false);
});

test("门户界面转义可配置标题并始终提供恢复原页面操作", () => {
  const { renderPortalMarkup } = require(portalUiPath);
  const markup = renderPortalMarkup({
    title: '<img src=x onerror="alert(1)">',
    online: false
  });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /id="drcom-restore-original"/);
  assert.match(markup, /id="drcom-login-form"/);
  assert.match(markup, /aria-live="polite"/);
});

test("门户界面显示当前自定义网关而不是写死默认地址", () => {
  const { renderPortalMarkup } = require(portalUiPath);
  const markup = renderPortalMarkup({ host: "gateway.example:8443" });
  assert.match(markup, /gateway\.example:8443/);
  assert.doesNotMatch(markup, />10\.10\.10\.2</);
});

test("门户个性化入口包含提示、无障碍名称和 44 像素点击区域", () => {
  const { renderPortalMarkup } = require(portalUiPath);
  const markup = renderPortalMarkup();
  const css = readFileSync(join(__dirname, "..", "CRX", "portal.css"), "utf8");

  assert.match(markup, /id="drcom-open-options"/);
  assert.match(markup, /aria-label="个性化"/);
  assert.match(markup, /title="个性化"/);
  assert.match(css, /#drcom-open-options[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
});
