"use strict";

(function attachPortalUi(root, factory) {
  const accountUtils = typeof module === "object" && module.exports
    ? require("./account-utils.js")
    : root.DrcomAccountUtils;
  const portalSession = typeof module === "object" && module.exports
    ? require("./portal-session.js")
    : root.DrcomPortalSession;
  const i18n = typeof module === "object" && module.exports
    ? require("./i18n.js")
    : root.DrcomI18n;
  const api = factory(accountUtils, portalSession, i18n);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DrcomPortalUI = api;
  }
})(typeof globalThis === "object" ? globalThis : this, (accountUtils, portalSession, i18n) => {
  let language = "zh-CN";
  const t = (key, substitutions) => i18n.t(key, substitutions, language);
  const OFFICIAL_LINKS = [
    ["portal_self_service", "http://self.xzhmu.edu.cn"],
    ["portal_account_activation", "https://authserver.xzhmu.edu.cn/retrieve-password/accountActivation/index.html#/?service=http%3A%2F%2F10.10.10.2"],
    ["portal_guide", "http://self.xzhmu.edu.cn/guide.htm"],
    ["portal_recover_password", "https://authserver.xzhmu.edu.cn/retrieve-password/retrievePassword/index.html"]
  ];

  function setLanguage(preference) {
    language = i18n.resolveLanguage(preference, i18n.getBrowserLanguages?.() || []);
  }

  function localizeTitle(value) {
    const title = String(value || "");
    const knownChinese = i18n.t("campus_network_short", undefined, "zh-CN");
    const knownEnglish = i18n.t("campus_network_short", undefined, "en");
    return title === knownChinese || title === knownEnglish ? t("campus_network_short") : title;
  }

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
    return `<nav class="${className}" aria-label="${escapeHtml(t("portal_support_services"))}" data-i18n-aria-label="portal_support_services">${OFFICIAL_LINKS
      .map(([key, href]) => `<a href="${href}" target="_blank" rel="noopener noreferrer" data-i18n="${key}">${escapeHtml(t(key))}</a>`)
      .join("")}</nav>`;
  }

  function renderBrandPanel(safeTitle, host) {
    return `
      <section class="drcom-brand-panel" aria-hidden="true">
        <span class="drcom-blob drcom-blob-a"></span>
        <span class="drcom-blob drcom-blob-b"></span>
        <div class="drcom-brand-stage">
          <div class="dchar-frame" data-characters></div>
          <div class="drcom-brand-copy">
            <strong id="drcom-brand-title">${safeTitle}</strong>
            <span id="drcom-brand-context">${escapeHtml(t("portal_brand_context", [host]))}</span>
          </div>
        </div>
      </section>
    `;
  }

  function formatUsedMinutes(value) {
    const formatted = portalSession.formatMinutes(value);
    const match = /^(\d+) 分钟$/.exec(formatted);
    return match ? t("portal_minutes", [match[1]]) : formatted;
  }

  function renderSessionRows(session = {}) {
    const network = session.network && typeof session.network === "object" ? session.network : {};
    const rows = [
      ["account_short", session.account],
      ["portal_used_time", formatUsedMinutes(session.usedMinutes)],
      ["portal_total_traffic", portalSession.formatKilobytes(session.totalKilobytes)],
      ["portal_upload_traffic", portalSession.formatKilobytes(session.uploadKilobytes)],
      ["portal_download_traffic", portalSession.formatKilobytes(session.downloadKilobytes)],
      ["portal_balance", Number.isFinite(Number(session.balanceYuan)) ? `¥${Number(session.balanceYuan).toFixed(2)}` : ""],
      ["portal_login_time", portalSession.formatTimestamp(session.loginAt)],
      ["portal_external_ip", session.externalIp],
      ["IPv4", network.ipv4],
      ["IPv6", network.ipv6],
      ["MAC", network.mac],
      ["VLAN", network.vlan],
      ["AC IP", network.acIp],
      ["portal_ac_name", network.acName]
    ].filter(([, value]) => String(value || "").trim());
    if (!rows.length) return "";
    return `<dl class="drcom-session-list">${rows
      .map(([key, value]) => `<div><dt data-i18n="${key}">${escapeHtml(t(key))}</dt><dd${key === "portal_used_time" ? ' id="drcom-used-minutes-detail"' : ""}>${escapeHtml(value)}</dd></div>`)
      .join("")}</dl>`;
  }

  function renderOnlineContent({ title, session = null, onlineDetailMode = "classic", statusMessage = "", checkedAt = 0 }) {
    const mode = ["classic", "full", "minimal", "hidden"].includes(onlineDetailMode)
      ? onlineDetailMode
      : "classic";
    const usedTime = session ? formatUsedMinutes(session.usedMinutes) : "";
    const totalFlow = session ? portalSession.formatKilobytes(session.totalKilobytes) : "";
    const rows = session ? renderSessionRows(session) : "";
    const showSummary = mode === "classic" || mode === "full";
    const showTools = mode !== "hidden";
    const checkedText = checkedAt ? portalSession.formatTimestamp(checkedAt) : "";
    const summary = showSummary && (usedTime || totalFlow)
      ? `<div class="drcom-session-summary">
          ${usedTime ? `<div><span data-i18n="portal_used_time">${escapeHtml(t("portal_used_time"))}</span><strong id="drcom-used-time">${escapeHtml(usedTime)}</strong></div>` : ""}
          ${totalFlow ? `<div><span data-i18n="portal_total_traffic">${escapeHtml(t("portal_total_traffic"))}</span><strong id="drcom-total-flow">${escapeHtml(totalFlow)}</strong></div>` : ""}
        </div>`
      : "";
    const details = showSummary && rows
      ? `<details id="drcom-session-details"${mode === "full" ? " open" : ""}>
          <summary data-i18n="portal_online_details">${escapeHtml(t("portal_online_details"))}</summary>
          ${rows}
        </details>`
      : "";

    return `
      <section class="drcom-state-view" aria-labelledby="drcom-state-title">
        <span class="drcom-status-mark" aria-hidden="true"></span>
        <h1 id="drcom-state-title" data-i18n="portal_online_heading">${escapeHtml(t("portal_online_heading"))}</h1>
        <p id="drcom-online-description">${escapeHtml(t("portal_online_description", [title]))}</p>
        ${summary}
        ${details}
        ${showTools ? `<div class="drcom-online-tools">
          <button id="drcom-refresh-status" type="button" data-i18n="portal_refresh_status">${escapeHtml(t("portal_refresh_status"))}</button>
          <a id="drcom-self-service" href="${OFFICIAL_LINKS[0][1]}" target="_blank" rel="noopener noreferrer" data-i18n="portal_self_service">${escapeHtml(t("portal_self_service"))}</a>
        </div>` : ""}
        ${checkedText && showTools ? `<p id="drcom-checked-at" class="drcom-checked-at">${escapeHtml(t("portal_checked_at", [checkedText]))}</p>` : ""}
        <button id="drcom-logout" class="drcom-secondary-button" type="button" data-i18n="portal_logout">${escapeHtml(t("portal_logout"))}</button>
        <p id="drcom-form-status" class="drcom-form-status" aria-live="polite">${escapeHtml(statusMessage)}</p>
      </section>
    `;
  }

  function renderPortalMarkup({
    title = t("brand_name"),
    online = false,
    host = "10.10.10.2",
    session = null,
    onlineDetailMode = "classic",
    statusMessage = "",
    checkedAt = 0
  } = {}) {
    const visibleTitle = localizeTitle(title);
    const safeTitle = escapeHtml(visibleTitle);
    const safeHost = escapeHtml(host || t("authentication_gateway"));
    const content = online
      ? renderOnlineContent({
        title: visibleTitle,
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
            <p data-i18n="portal_login_intro">${escapeHtml(t("portal_login_intro"))}</p>
          </div>
          <form id="drcom-login-form" class="drcom-login-form">
            <label>
              <span data-i18n="username_label">${escapeHtml(t("username_label"))}</span>
              <input id="drcom-username" name="username" autocomplete="username" required>
            </label>
            <label>
              <span data-i18n="carrier">${escapeHtml(t("carrier"))}</span>
              <select id="drcom-suffix" name="suffix">
                <option value="" data-i18n="carrier_campus">${escapeHtml(t("carrier_campus"))}</option>
                <option value="@unicom" data-i18n="carrier_unicom">${escapeHtml(t("carrier_unicom"))}</option>
                <option value="@telecom" data-i18n="carrier_telecom">${escapeHtml(t("carrier_telecom"))}</option>
                <option value="@cmcc" data-i18n="carrier_mobile">${escapeHtml(t("carrier_mobile"))}</option>
              </select>
            </label>
            <label>
              <span data-i18n="password">${escapeHtml(t("password"))}</span>
              <span class="drcom-password-wrapper">
                <input id="drcom-password" name="password" type="password" autocomplete="current-password" required>
                <button id="drcom-password-toggle" class="drcom-password-toggle" type="button" aria-label="${escapeHtml(t("reveal_password"))}" data-i18n-aria-label="reveal_password" aria-pressed="false" title="${escapeHtml(t("portal_password_toggle_title"))}" data-i18n-title="portal_password_toggle_title">
                  <span class="win-glyph" aria-hidden="true">&#xE890;</span>
                </button>
              </span>
            </label>
            <label class="drcom-remember">
              <input id="drcom-remember" type="checkbox" checked>
              <span data-i18n="portal_remember">${escapeHtml(t("portal_remember"))}</span>
            </label>
            <p id="drcom-form-status" class="drcom-form-status" aria-live="polite">${escapeHtml(statusMessage)}</p>
            <div class="drcom-login-actions">
              <button id="drcom-submit" class="drcom-primary-button" type="submit"><span class="win-ring win-ring--inline" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" pathLength="100"/></svg></span><span data-i18n="portal_sign_in">${escapeHtml(t("portal_sign_in"))}</span></button>
              <button id="drcom-reset" class="drcom-secondary-button" type="reset" data-i18n="portal_reset">${escapeHtml(t("portal_reset"))}</button>
            </div>
            ${renderOfficialLinks()}
            <p class="drcom-original-capabilities" data-i18n="portal_original_capabilities">${escapeHtml(t("portal_original_capabilities"))}</p>
          </form>
        </section>
      `;

    return `
      <div class="drcom-page">
        <header class="drcom-header glass-chrome">
          <span class="drcom-brand-mark" aria-hidden="true"></span>
          <strong data-i18n="brand_name">${escapeHtml(t("brand_name"))}</strong>
          <div class="drcom-header-actions">
            <button id="drcom-language-toggle" class="drcom-language-toggle" type="button" data-i18n="language_switch" data-i18n-aria-label="language_switch_bilingual" aria-label="${escapeHtml(t("language_switch_bilingual"))}">${escapeHtml(t("language_switch"))}</button>
            <button id="drcom-open-options" type="button" aria-label="${escapeHtml(t("portal_personalize"))}" data-i18n-aria-label="portal_personalize" title="${escapeHtml(t("portal_personalize"))}" data-i18n-title="portal_personalize">
              <span class="win-glyph" aria-hidden="true">&#xE713;</span>
            </button>
            <button id="drcom-restore-original" type="button" data-i18n="portal_restore_original">${escapeHtml(t("portal_restore_original"))}</button>
          </div>
        </header>
        <main class="drcom-stage">
          ${renderBrandPanel(safeTitle, host || t("authentication_gateway"))}
          <div class="drcom-surface">${content}</div>
        </main>
        <footer data-i18n="welcome_privacy">${escapeHtml(t("welcome_privacy"))}</footer>
      </div>
    `;
  }

  return {
    buildAccount,
    formatUsedMinutes,
    localizeTitle,
    normalizeSuffix: accountUtils.normalizeSuffix,
    parseAccount: accountUtils.parse,
    renderPortalMarkup,
    setLanguage,
    shouldTakeOver,
    suffixLabel: accountUtils.suffixLabel
  };
});
