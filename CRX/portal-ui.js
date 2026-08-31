"use strict";

(function attachPortalUi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DrcomPortalUI = api;
  }
})(typeof globalThis === "object" ? globalThis : this, () => {
  function decodeMaybe(value) {
    let text = String(value || "");
    for (let index = 0; index < 2; index += 1) {
      if (!/%[0-9a-f]{2}/i.test(text)) break;
      try {
        const decoded = decodeURIComponent(text);
        if (decoded === text) break;
        text = decoded;
      } catch (error) {
        break;
      }
    }
    return text;
  }

  function normalizeSuffix(value) {
    const raw = decodeMaybe(String(value || "").trim()).toLowerCase();
    if (!raw || raw === "校园网" || raw === "campus" || raw === "none") return "";
    const aliases = {
      telecom: "@telecom",
      "@telecom": "@telecom",
      "电信": "@telecom",
      unicom: "@unicom",
      "@unicom": "@unicom",
      "联通": "@unicom",
      cmcc: "@cmcc",
      "@cmcc": "@cmcc",
      mobile: "@cmcc",
      "移动": "@cmcc"
    };
    if (aliases[raw]) return aliases[raw];
    return /^@[a-z0-9._-]+$/i.test(raw) ? raw : "";
  }

  function parseAccount(value, fallbackSuffix = "") {
    let raw = decodeMaybe(String(value || "").trim());
    raw = raw.replace(/^\s*0+\s*$/, "");
    if (raw.startsWith(",0,")) raw = raw.slice(3);
    const suffixMatch = raw.match(/@(telecom|unicom|cmcc)$/i);
    const suffixFromRaw = suffixMatch ? `@${suffixMatch[1].toLowerCase()}` : "";
    const suffix = suffixFromRaw || normalizeSuffix(fallbackSuffix);
    const username = suffixFromRaw ? raw.slice(0, -suffixFromRaw.length) : raw;
    return { username: username.trim(), suffix };
  }

  function suffixLabel(suffix) {
    return {
      "": "校园网",
      "@telecom": "电信",
      "@unicom": "联通",
      "@cmcc": "移动"
    }[normalizeSuffix(suffix)] || normalizeSuffix(suffix) || "校园网";
  }

  function normalizeMac(value) {
    return String(value || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  }

  function buildAccount(form = {}, network = {}) {
    const parsed = parseAccount(form.username, form.suffix);
    return {
      label: `${parsed.username || "未命名账号"} ${suffixLabel(parsed.suffix)}`,
      username: parsed.username,
      suffix: parsed.suffix,
      password: String(form.password || ""),
      network: {
        wlanUserIp: String(network.wlanUserIp || "").trim(),
        wlanUserMac: normalizeMac(network.wlanUserMac),
        wlanUserIpv6: String(network.wlanUserIpv6 || "").trim(),
        wlanAcIp: String(network.wlanAcIp || "").trim(),
        wlanAcName: String(network.wlanAcName || "").trim()
      }
    };
  }

  function shouldTakeOver(input = {}) {
    return input.enabled === true && (input.online === true || input.hasPasswordField === true);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderPortalMarkup({ title = "徐医校园网", online = false, host = "10.10.10.2" } = {}) {
    const safeTitle = escapeHtml(title);
    const safeHost = escapeHtml(host || "认证网关");
    const content = online
      ? `
        <section class="drcom-state-view" aria-labelledby="drcom-state-title">
          <span class="drcom-status-mark" aria-hidden="true"></span>
          <h1 id="drcom-state-title">已经连接校园网</h1>
          <p>当前设备已通过 ${safeTitle} 认证，可以正常访问网络。</p>
          <button id="drcom-logout" class="drcom-secondary-button" type="button">下线当前连接</button>
          <p id="drcom-form-status" class="drcom-form-status" aria-live="polite"></p>
        </section>
      `
      : `
        <section aria-labelledby="drcom-login-title">
          <div class="drcom-intro">
            <p class="drcom-host">${safeHost}</p>
            <h1 id="drcom-login-title">${safeTitle}</h1>
            <p>输入校园网账号并登录。登录请求会直接发送到学校认证接口。</p>
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
                <option value="@telecom">电信 @telecom</option>
                <option value="@unicom">联通 @unicom</option>
                <option value="@cmcc">移动 @cmcc</option>
              </select>
            </label>
            <label>
              <span>密码</span>
              <input id="drcom-password" name="password" type="password" autocomplete="current-password" required>
            </label>
            <label class="drcom-remember">
              <input id="drcom-remember" type="checkbox" checked>
              <span>保存账号，方便下次快速登录</span>
            </label>
            <p id="drcom-form-status" class="drcom-form-status" aria-live="polite"></p>
            <button id="drcom-submit" class="drcom-primary-button" type="submit">登录校园网</button>
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
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4a7.8 7.8 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a8 8 0 0 0-1.7-1L15.5 3h-4L11 5.9a8 8 0 0 0-1.7 1L7 6 5 9.5 7.1 11a7.8 7.8 0 0 0 0 2L5 14.5 7 18l2.4-1a8 8 0 0 0 1.7 1l.5 3h4l.5-3a8 8 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7.8 7.8 0 0 0 .1-1Z"/></svg>
            </button>
            <button id="drcom-restore-original" type="button">使用原始登录页</button>
          </div>
        </header>
        <main class="drcom-surface">${content}</main>
        <footer>账号数据只保存在这台设备的浏览器中。</footer>
      </div>
    `;
  }

  return {
    buildAccount,
    normalizeSuffix,
    parseAccount,
    renderPortalMarkup,
    shouldTakeOver,
    suffixLabel
  };
});
