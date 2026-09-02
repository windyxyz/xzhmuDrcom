"use strict";

(function attachPortalUi(root, factory) {
  const accountUtils = typeof module === "object" && module.exports
    ? require("./account-utils.js")
    : root.DrcomAccountUtils;
  const portalSession = typeof module === "object" && module.exports
    ? require("./portal-session.js")
    : root.DrcomPortalSession;
  const api = factory(accountUtils, portalSession);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DrcomPortalUI = api;
  }
})(typeof globalThis === "object" ? globalThis : this, (accountUtils, portalSession) => {
  const OFFICIAL_LINKS = [
    ["自助服务", "http://self.xzhmu.edu.cn"],
    ["账号激活", "https://authserver.xzhmu.edu.cn/retrieve-password/accountActivation/index.html#/?service=http%3A%2F%2F10.10.10.2"],
    ["使用说明", "http://self.xzhmu.edu.cn/guide.htm"],
    ["找回密码", "https://authserver.xzhmu.edu.cn/retrieve-password/retrievePassword/index.html"]
  ];

  function buildAccount(form = {}, network = {}) {
    const parsed = accountUtils.parse(form.username, form.suffix);
    return {
      label: accountUtils.label(parsed.username, parsed.suffix),
      username: parsed.username,
      suffix: parsed.suffix,
      password: String(form.password || ""),
      network: {
        wlanUserIp: String(network.wlanUserIp || "").trim(),
        wlanUserMac: accountUtils.normalizeMac(network.wlanUserMac),
        wlanUserIpv6: String(network.wlanUserIpv6 || "").trim(),
        wlanAcIp: String(network.wlanAcIp || "").trim(),
        wlanAcName: String(network.wlanAcName || "").trim()
      }
    };
  }

  function shouldTakeOver(input = {}) {
    return input.enabled === true
      && input.hasCaptcha !== true
      && (input.online === true || input.hasPasswordField === true);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderOfficialLinks(className = "drcom-support-links") {
    return `<nav class="${className}" aria-label="校园网辅助服务">${OFFICIAL_LINKS
      .map(([label, href]) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .join("")}</nav>`;
  }

  function renderCharacters(mood = "idle", mini = false) {
    const kinds = ["purple", "black", "orange", "yellow"];
    return `<div class="drcom-characters${mini ? " drcom-characters--mini" : ""}" data-mood="${escapeHtml(mood)}" aria-hidden="true">${kinds
      .map((kind) => `
        <div class="drcom-char char-${kind}">
          <span class="char-eyes"><span class="char-eye"><span class="char-pupil"></span></span><span class="char-eye"><span class="char-pupil"></span></span></span>
          <span class="char-mouth"></span>
        </div>`)
      .join("")}</div>`;
  }

  function renderBrandPanel(safeTitle, safeHost) {
    return `
      <section class="drcom-brand-panel" aria-hidden="true">
        <span class="drcom-blob drcom-blob-a"></span>
        <span class="drcom-blob drcom-blob-b"></span>
        <div class="drcom-brand-stage">
          ${renderCharacters("idle")}
          <div class="drcom-brand-copy">
            <strong>${safeTitle}</strong>
            <span>校园网认证 · ${safeHost}</span>
          </div>
        </div>
      </section>
    `;
  }

  function renderSessionRows(session = {}) {
    const network = session.network && typeof session.network === "object" ? session.network : {};
    const rows = [
      ["账号", session.account],
      ["已用时间", portalSession.formatMinutes(session.usedMinutes)],
      ["总流量", portalSession.formatKilobytes(session.totalKilobytes)],
      ["上行流量", portalSession.formatKilobytes(session.uploadKilobytes)],
      ["下行流量", portalSession.formatKilobytes(session.downloadKilobytes)],
      ["余额", Number.isFinite(Number(session.balanceYuan)) ? `¥${Number(session.balanceYuan).toFixed(2)}` : ""],
      ["登录时间", portalSession.formatTimestamp(session.loginAt)],
      ["外网映射地址", session.externalIp],
      ["IPv4", network.ipv4],
      ["IPv6", network.ipv6],
      ["MAC", network.mac],
      ["VLAN", network.vlan],
      ["AC IP", network.acIp],
      ["AC 名称", network.acName]
    ].filter(([, value]) => String(value || "").trim());
    if (!rows.length) return "";
    return `<dl class="drcom-session-list">${rows
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join("")}</dl>`;
  }

  function renderOnlineContent({ title, session = null, onlineDetailMode = "classic", statusMessage = "", checkedAt = 0 }) {
    const mode = ["classic", "full", "minimal", "hidden"].includes(onlineDetailMode)
      ? onlineDetailMode
      : "classic";
    const usedTime = session ? portalSession.formatMinutes(session.usedMinutes) : "";
    const totalFlow = session ? portalSession.formatKilobytes(session.totalKilobytes) : "";
    const rows = session ? renderSessionRows(session) : "";
    const showSummary = mode === "classic" || mode === "full";
    const showTools = mode !== "hidden";
    const checkedText = checkedAt ? portalSession.formatTimestamp(checkedAt) : "";
    const summary = showSummary && (usedTime || totalFlow)
      ? `<div class="drcom-session-summary">
          ${usedTime ? `<div><span>已用时间</span><strong id="drcom-used-time">${escapeHtml(usedTime)}</strong></div>` : ""}
          ${totalFlow ? `<div><span>总流量</span><strong id="drcom-total-flow">${escapeHtml(totalFlow)}</strong></div>` : ""}
        </div>`
      : "";
    const details = showSummary && rows
      ? `<details id="drcom-session-details"${mode === "full" ? " open" : ""}>
          <summary>查看完整在线详情</summary>
          ${rows}
        </details>`
      : "";

    return `
      <section class="drcom-state-view" aria-labelledby="drcom-state-title">
        ${renderCharacters("happy", true)}
        <span class="drcom-status-mark" aria-hidden="true"></span>
        <h1 id="drcom-state-title">已经连接校园网</h1>
        <p>当前设备已通过 ${title} 认证，可以正常访问网络。</p>
        ${summary}
        ${details}
        ${showTools ? `<div class="drcom-online-tools">
          <button id="drcom-refresh-status" type="button">刷新在线状态</button>
          <a id="drcom-self-service" href="${OFFICIAL_LINKS[0][1]}" target="_blank" rel="noopener noreferrer">自助服务</a>
        </div>` : ""}
        ${checkedText && showTools ? `<p class="drcom-checked-at">最近检查：${escapeHtml(checkedText)}</p>` : ""}
        <button id="drcom-logout" class="drcom-secondary-button" type="button">注销并解绑 MAC</button>
        <p id="drcom-form-status" class="drcom-form-status" aria-live="polite">${escapeHtml(statusMessage)}</p>
      </section>
    `;
  }

  function renderPortalMarkup({
    title = "徐医校园网",
    online = false,
    host = "10.10.10.2",
    session = null,
    onlineDetailMode = "classic",
    statusMessage = "",
    checkedAt = 0
  } = {}) {
    const safeTitle = escapeHtml(title);
    const safeHost = escapeHtml(host || "认证网关");
    const content = online
      ? renderOnlineContent({
        title: safeTitle,
        session,
        onlineDetailMode,
        statusMessage,
        checkedAt
      })
      : `
        <section aria-labelledby="drcom-login-title">
          <div class="drcom-intro">
            <h1 id="drcom-login-title">${safeTitle}</h1>
            <p class="drcom-host">${safeHost}</p>
            <p>输入校园网账号并登录，认证请求会直接发送到学校接口。</p>
          </div>
          <form id="drcom-login-form" class="drcom-login-form">
            <label>
              <span>学号或 DrCOM 账号</span>
              <input id="drcom-username" name="username" autocomplete="username" required>
            </label>
            <label>
              <span>运营商</span>
              <select id="drcom-suffix" name="suffix">
                <option value="">校园网</option>
                <option value="@unicom">联通 @unicom</option>
                <option value="@telecom">电信 @telecom</option>
                <option value="@cmcc">移动 @cmcc</option>
              </select>
            </label>
            <label>
              <span>密码</span>
              <input id="drcom-password" name="password" type="password" autocomplete="current-password" required>
            </label>
            <label class="drcom-remember">
              <input id="drcom-remember" type="checkbox" checked>
              <span>保存密码到本机，方便下次快速登录</span>
            </label>
            <p id="drcom-form-status" class="drcom-form-status" aria-live="polite"></p>
            <div class="drcom-login-actions">
              <button id="drcom-submit" class="drcom-primary-button" type="submit">登录校园网</button>
              <button id="drcom-reset" class="drcom-secondary-button" type="reset">重置</button>
            </div>
            ${renderOfficialLinks()}
            <p class="drcom-original-capabilities">扫码或验证码登录请使用学校原始页面。</p>
          </form>
        </section>
      `;

    return `
      <div class="drcom-page">
        <header class="drcom-header glass-chrome">
          <span class="drcom-brand-mark" aria-hidden="true"></span>
          <strong>校园网助手</strong>
          <div class="drcom-header-actions">
            <button id="drcom-open-options" type="button" aria-label="个性化" title="个性化">
              <span class="win-glyph" aria-hidden="true">&#xE713;</span>
            </button>
            <button id="drcom-restore-original" type="button">使用原始登录页</button>
          </div>
        </header>
        <main class="drcom-stage">
          ${renderBrandPanel(safeTitle, safeHost)}
          <div class="drcom-surface">${content}</div>
        </main>
        <footer>账号数据只保存在这台设备的浏览器中。</footer>
      </div>
    `;
  }

  return {
    buildAccount,
    normalizeSuffix: accountUtils.normalizeSuffix,
    parseAccount: accountUtils.parse,
    renderPortalMarkup,
    shouldTakeOver,
    suffixLabel: accountUtils.suffixLabel
  };
});
