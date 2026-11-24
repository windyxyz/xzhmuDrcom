(function (root, factory) {
  "use strict";
  const messages = typeof module === "object" && module.exports
    ? require("./i18n-messages.js")
    : root.DrcomI18nMessages;
  const api = factory(root, messages);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DrcomI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, messages) {
  "use strict";

  const VALID_PREFERENCES = new Set(["auto", "zh-CN", "en"]);
  const FALLBACK_LANGUAGE = "zh-CN";
  const KNOWN_MESSAGE_KEYS = Object.freeze({
    "需要登录": "status_sign_in_required",
    "当前需要登录": "status_sign_in_required",
    "当前需要登录。": "status_sign_in_required",
    "当前需要登录校园网。": "status_sign_in_required",
    "登录成功": "backend_login_success",
    "登录成功。": "backend_login_success",
    "下线成功。": "backend_logout_success",
    "账号已经在线，无需重复登录。": "backend_already_online",
    "正在登录校园网。": "backend_signing_in",
    "正在自动恢复连接。": "backend_auto_reconnecting",
    "连接守护正在恢复校园网。": "backend_keepalive_reconnecting",
    "正在检查校园网连接状态。": "backend_checking_connection",
    "校园网状态检查超时。": "backend_status_check_timeout",
    "校园网会话状态不明确。": "backend_status_unclear",
    "已访问认证页，但状态不明确。": "backend_status_unclear",
    "无法确认校园网会话状态。": "backend_status_unclear",
    "网关提示账号已经在线，正在复核实际状态。": "backend_verifying_online",
    "已确认校园网会话离线。": "backend_session_offline",
    "当前校园网会话在线。": "portal_session_online",
    "当前页面显示已在线。": "portal_session_online",
    "当前在线的是另一账号，请先注销再登录。": "backend_other_account_online",
    "校园网已有会话在线，但无法确认账号。": "backend_online_account_unverified",
    "未取得当前校园网 IP，认证密码尚未发送。": "backend_missing_ip",
    "无法访问校园网门户，尚未发送认证密码。": "backend_portal_unreachable",
    "访问校园网门户超时，尚未发送认证密码。": "backend_portal_timeout",
    "DrCOM 接口超时，请确认校园网网关可访问。": "backend_drcom_timeout",
    "DrCOM 接口发生异常重定向，请确认校园网网关地址配置正确。": "backend_drcom_redirect",
    "注销未完成，校园网会话仍然在线。": "backend_logout_still_online",
    "注销请求已发送，但无法确认已经离线。": "backend_logout_unconfirmed",
    "自动登录已暂停，请检查账号配置。": "backend_auto_login_paused",
    "仍在等待下一次自动重试。": "backend_waiting_retry",
    "注销正在进行，已跳过本次自动登录。": "backend_auto_login_skipped_logout"
  });
  const SUPPORTED_ATTRIBUTES = [
    ["i18nTitle", "title"],
    ["i18nAriaLabel", "aria-label"],
    ["i18nPlaceholder", "placeholder"]
  ];
  let currentLanguage = resolveLanguage("auto", getBrowserLanguages());

  function normalizePreference(value) {
    return VALID_PREFERENCES.has(value) ? value : "auto";
  }

  function resolveLanguage(preference, browserLanguages = []) {
    const normalized = normalizePreference(preference);
    if (normalized !== "auto") return normalized;
    return Array.from(browserLanguages || []).some((value) => /^zh(?:-|$)/i.test(String(value))) ? "zh-CN" : "en";
  }

  function getBrowserLanguages() {
    try {
      const chromeI18n = root.chrome && root.chrome.i18n;
      if (chromeI18n && typeof chromeI18n.getUILanguage === "function") {
        const language = chromeI18n.getUILanguage();
        if (language) return [language];
      }
    } catch (error) {
      // Browser APIs are unavailable in Node and can be unavailable during startup.
    }

    const navigatorObject = root.navigator;
    if (!navigatorObject) return [];
    if (navigatorObject.languages && navigatorObject.languages.length) return Array.from(navigatorObject.languages);
    return navigatorObject.language ? [navigatorObject.language] : [];
  }

  function format(message, substitutions) {
    if (Array.isArray(substitutions)) {
      return message.replace(/\$(\d+)\$?/g, (match, position) => {
        const value = substitutions[Number(position) - 1];
        return value === undefined ? match : String(value);
      });
    }
    if (substitutions && typeof substitutions === "object") {
      return message.replace(/\$([a-zA-Z][a-zA-Z0-9_]*)\$/g, (match, name) => {
        return Object.hasOwn(substitutions, name) ? String(substitutions[name]) : match;
      });
    }
    return message;
  }

  function t(key, substitutions, language) {
    const resolvedLanguage = language === undefined
      ? currentLanguage
      : resolveLanguage(language, getBrowserLanguages());
    const messageKey = String(key);
    const dictionary = messages && messages[resolvedLanguage];
    const fallbackDictionary = messages && messages[FALLBACK_LANGUAGE];
    const message = (dictionary && dictionary[messageKey]) || (fallbackDictionary && fallbackDictionary[messageKey]);
    return message === undefined ? messageKey : format(message, substitutions);
  }

  function localizeKnownMessage(value, language) {
    const message = String(value || "");
    const key = KNOWN_MESSAGE_KEYS[message];
    return key ? t(key, undefined, language) : message;
  }

  function dataValue(node, name) {
    if (node.dataset && Object.hasOwn(node.dataset, name)) return node.dataset[name];
    if (typeof node.getAttribute === "function") return node.getAttribute(`data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    return null;
  }

  function apply(rootElement, language) {
    const targetRoot = rootElement || root.document;
    if (!targetRoot || typeof targetRoot.querySelectorAll !== "function") return;

    const nodes = targetRoot.querySelectorAll("[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]");
    for (const node of nodes) {
      const textKey = dataValue(node, "i18n");
      if (textKey) node.textContent = t(textKey, undefined, language);
      for (const [dataName, attributeName] of SUPPORTED_ATTRIBUTES) {
        const key = dataValue(node, dataName);
        if (key) node.setAttribute(attributeName, t(key, undefined, language));
      }
    }
  }

  function setLanguage(language) {
    currentLanguage = resolveLanguage(language, getBrowserLanguages());
  }

  function getLanguage() {
    return currentLanguage;
  }

  return { apply, getLanguage, localizeKnownMessage, normalizePreference, resolveLanguage, setLanguage, t };
});
