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
    "登录成功": "backend_login_success",
    "登录成功。": "backend_login_success",
    "账号已经在线，无需重复登录。": "backend_already_online",
    "正在检查校园网连接状态。": "backend_checking_connection",
    "网关提示账号已经在线，正在复核实际状态。": "backend_verifying_online",
    "已确认校园网会话离线。": "backend_session_offline",
    "当前校园网会话在线。": "portal_session_online"
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
