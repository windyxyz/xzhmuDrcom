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
  assert.equal(shouldTakeOver({ enabled: true, online: false, hasPasswordField: true, hasCaptcha: true }), false);
  assert.equal(shouldTakeOver({ enabled: false, online: false, hasPasswordField: true }), false);
  assert.equal(shouldTakeOver({ enabled: true, online: false, hasPasswordField: false }), false);
});

test("经典在线模式显示时间与总流量并把完整脱敏字段放入折叠详情", () => {
  const { renderPortalMarkup } = require(portalUiPath);
  const markup = renderPortalMarkup({
    online: true,
    onlineDetailMode: "classic",
    checkedAt: Date.UTC(2026, 8, 2, 1, 2),
    session: {
      account: "de***42",
      usedMinutes: 125,
      totalKilobytes: 1234567,
      uploadKilobytes: 500000,
      downloadKilobytes: 734567,
      balanceYuan: 12.34,
      loginAt: Date.UTC(2026, 8, 2, 0, 0),
      externalIp: "198.***.***.202",
      network: {
        ipv4: "192.***.***.3",
        ipv6: "2001:***::***:1",
        mac: "02:00:00:**:**:**",
        vlan: "123",
        acIp: "10.***.***.2",
        acName: "campus-ac"
      }
    }
  });

  assert.match(markup, /id="drcom-used-time"[^>]*>125 分钟</);
  assert.match(markup, /id="drcom-total-flow"[^>]*>1\.18 GB</);
  assert.match(markup, /<details id="drcom-session-details">/);
  assert.doesNotMatch(markup, /<details id="drcom-session-details" open>/);
  for (const value of ["de***42", "488.28 MB", "717.35 MB", "¥12.34", "198.***.***.202", "02:00:00:**:**:**", "campus-ac"]) {
    assert.match(markup, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(markup, /demo-student-42|192\.0\.2\.3|02-00-00-00-00-03/);
});

test("完整、简化和隐藏模式按约定控制在线详情", () => {
  const { renderPortalMarkup } = require(portalUiPath);
  const session = { usedMinutes: 5, totalKilobytes: 2048, account: "20***18" };
  const full = renderPortalMarkup({ online: true, onlineDetailMode: "full", session });
  const minimal = renderPortalMarkup({ online: true, onlineDetailMode: "minimal", session });
  const hidden = renderPortalMarkup({ online: true, onlineDetailMode: "hidden", session });

  assert.match(full, /<details id="drcom-session-details" open>/);
  assert.match(full, /20\*\*\*18/);
  assert.doesNotMatch(minimal, /drcom-session-details|drcom-used-time|drcom-total-flow/);
  assert.match(minimal, /drcom-refresh-status|自助服务|drcom-logout/);
  assert.doesNotMatch(hidden, /drcom-session-details|drcom-used-time|drcom-total-flow|drcom-refresh-status|自助服务/);
  assert.match(hidden, /drcom-logout/);
});

test("登录页按学校顺序提供运营商、重置和四个官方辅助入口", () => {
  const { renderPortalMarkup } = require(portalUiPath);
  const markup = renderPortalMarkup({ online: false });
  const campus = markup.indexOf('<option value="">校园网</option>');
  const unicom = markup.indexOf('<option value="@unicom">');
  const telecom = markup.indexOf('<option value="@telecom">');
  const mobile = markup.indexOf('<option value="@cmcc">');

  assert.ok(campus < unicom && unicom < telecom && telecom < mobile);
  assert.match(markup, /id="drcom-reset"/);
  for (const [label, href] of [
    ["自助服务", "http://self.xzhmu.edu.cn"],
    ["账号激活", "https://authserver.xzhmu.edu.cn/retrieve-password/accountActivation/index.html#/?service=http%3A%2F%2F10.10.10.2"],
    ["使用说明", "http://self.xzhmu.edu.cn/guide.htm"],
    ["找回密码", "https://authserver.xzhmu.edu.cn/retrieve-password/retrievePassword/index.html"]
  ]) {
    assert.match(markup, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>${label}`));
  }
  assert.match(markup, /扫码或验证码登录请使用学校原始页面/);
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

test("在线模板在最终 HTML sink 转义标题", () => {
  const { renderPortalMarkup } = require(portalUiPath);
  const markup = renderPortalMarkup({ title: '<svg onload="alert(1)">', online: true });
  assert.doesNotMatch(markup, /<svg/);
  assert.match(markup, /&lt;svg/);
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
