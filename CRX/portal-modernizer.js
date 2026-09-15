"use strict";

(() => {
  const ui = globalThis.DrcomPortalUI;
  const capture = globalThis.DrcomPortalCapture;
  const characters = globalThis.DrcomCharacters;
  const i18n = globalThis.DrcomI18n;
  const t = (key, substitutions) => i18n.t(key, substitutions);
  let activePortalConfig = null;
  let languagePreference = "auto";
  let currentPortalInput = null;
  let portalReadinessObserver = null;
  let recognitionQueued = false;
  let userRestoredOriginal = false;
  let characterController = null;
  let sadRevertTimer = 0;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
  } else {
    void boot();
  }

  async function boot() {
    try {
      if (!ui) throw new Error("门户界面模块未加载");
      if (!capture) throw new Error("门户捕获模块未加载");
      capture.install({ ui, sendMessage: safeSend });
      bindLanguageMessages();
      activePortalConfig = await loadPortalConfig();
      await loadLanguage();
      if (activePortalConfig.enabled !== true) return;
      startPortalReadinessObserver();
      schedulePortalRecognition();
    } catch (error) {
      removeModernPortal();
    }
  }

  function bindLanguageMessages() {
    chrome.runtime.onMessage?.addListener((message, sender) => {
      if (sender?.id && sender.id !== chrome.runtime.id) return;
      if (message?.action !== "language:changed") return;
      applyLanguage(message.preference);
    });
  }

  async function loadLanguage() {
    try {
      const response = await sendMessage({ action: "language:get" });
      applyLanguage(response.preference);
    } catch (error) {
      applyLanguage("auto");
    }
  }

  function applyLanguage(preference) {
    languagePreference = i18n.normalizePreference(preference);
    i18n.setLanguage(languagePreference);
    const language = i18n.getLanguage();
    ui.setLanguage(language);
    document.documentElement.lang = language;
    document.documentElement.dir = "ltr";
    const root = document.getElementById("drcom-modern-root");
    if (root) {
      i18n.apply(root, language);
      const brandContext = root.querySelector("#drcom-brand-context");
      if (brandContext && currentPortalInput) brandContext.textContent = t("portal_brand_context", [currentPortalInput.host]);
      if (currentPortalInput) {
        const localizedTitle = ui.localizeTitle(currentPortalInput.title);
        const brandTitle = root.querySelector("#drcom-brand-title");
        const loginTitle = root.querySelector("#drcom-login-title");
        if (brandTitle) brandTitle.textContent = localizedTitle;
        if (loginTitle) loginTitle.textContent = localizedTitle;
      }
      const description = root.querySelector("#drcom-online-description");
      if (description && currentPortalInput) description.textContent = t("portal_online_description", [ui.localizeTitle(currentPortalInput.title)]);
      const checkedAt = root.querySelector("#drcom-checked-at");
      if (checkedAt && currentPortalInput?.checkedAt) {
        checkedAt.textContent = t("portal_checked_at", [globalThis.DrcomPortalSession.formatTimestamp(currentPortalInput.checkedAt)]);
      }
      if (currentPortalInput?.session) {
        const usedTime = ui.formatUsedMinutes(currentPortalInput.session.usedMinutes);
        const summaryTime = root.querySelector("#drcom-used-time");
        const detailTime = root.querySelector("#drcom-used-minutes-detail");
        if (summaryTime) summaryTime.textContent = usedTime;
        if (detailTime) detailTime.textContent = usedTime;
      }
      const status = root.querySelector("#drcom-form-status");
      if (status?.dataset.i18nKey) status.textContent = t(status.dataset.i18nKey);
      const passwordToggle = root.querySelector("#drcom-password-toggle");
      if (passwordToggle?.getAttribute("aria-pressed") === "true") {
        passwordToggle.setAttribute("aria-label", t("portal_hide_password"));
      }
    }
    const captchaHint = document.getElementById("drcom-captcha-hint");
    if (captchaHint) i18n.apply(captchaHint, language);
  }

  async function loadPortalConfig() {
    const response = await sendMessage({ action: "portal:config:get" });
    const config = response.portal || {};
    const appearanceResponse = await sendMessage({ action: "portal:appearance:get" });
    config.appearance = appearanceResponse.appearance || config.appearance || {};
    return config;
  }

  function startPortalReadinessObserver() {
    if (portalReadinessObserver || userRestoredOriginal) return;
    portalReadinessObserver = new MutationObserver(() => schedulePortalRecognition());
    portalReadinessObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopPortalReadinessObserver() {
    portalReadinessObserver?.disconnect();
    portalReadinessObserver = null;
  }

  function schedulePortalRecognition() {
    if (recognitionQueued || userRestoredOriginal) return;
    recognitionQueued = true;
    queueMicrotask(() => {
      recognitionQueued = false;
      try {
        tryMountRecognizedPortal();
      } catch (error) {
        stopPortalReadinessObserver();
        removeModernPortal();
      }
    });
  }

  function tryMountRecognizedPortal() {
    if (userRestoredOriginal || !activePortalConfig) return false;
    const online = isOnlinePage();
    const hasPasswordField = Boolean(document.querySelector('input[type="password"]'));
    const hasCaptcha = Boolean(document.querySelector('input[name="captcha"]'));
    if (hasCaptcha) {
      stopPortalReadinessObserver();
      showCaptchaFallbackHint();
      return false;
    }
    if (!ui.shouldTakeOver({
      enabled: activePortalConfig.enabled === true,
      online,
      hasPasswordField,
      hasCaptcha
    })) return false;
    stopPortalReadinessObserver();
    mountPortal(activePortalConfig, online);
    return true;
  }

  function mountPortal(config, online, statusResult = null) {
    if (userRestoredOriginal) return;
    try {
      removeModernPortal();
      const root = document.createElement("div");
      root.id = "drcom-modern-root";
      const statusKey = statusResult?.message === i18n.t("portal_session_online", undefined, "zh-CN")
        || statusResult?.message === i18n.t("portal_session_online", undefined, "en")
        ? "portal_session_online" : "";
      currentPortalInput = {
        title: config.title || t("brand_name"),
        online,
        host: portalHost(config.portalUrl),
        onlineDetailMode: config.onlineDetailMode || "classic",
        session: statusResult && statusResult.session,
        statusMessage: statusKey ? t(statusKey) : statusResult && statusResult.message,
        checkedAt: statusResult && statusResult.checkedAt
      };
      root.innerHTML = ui.renderPortalMarkup(currentPortalInput);
      if (statusKey) root.querySelector("#drcom-form-status").dataset.i18nKey = statusKey;
      if (globalThis.DrcomAppearance) {
        const normalized = globalThis.DrcomAppearance.normalizeAppearance(config.appearance || {});
        globalThis.DrcomAppearance.applyToRoot(root, {
          ...normalized,
          background: "fresh",
          backgroundImage: ""
        });
        root.dataset.appearanceBackground = normalized.background;
        installPrivateAppearance(normalized);
      }
      document.body.append(root);
      document.documentElement.classList.add("drcom-modern-active");
      bindPortalEvents(root, online);
      bindCharacters(root, online);
      if (!online) prefillFromOriginalPage(root);
      if (online && !statusResult) void refreshPortalStatus(root);
    } catch (error) {
      removeModernPortal();
      throw error;
    }
  }

  function installPrivateAppearance(input) {
    document.getElementById("drcom-private-appearance")?.remove();
    if (!globalThis.DrcomAppearance) return;
    const appearance = globalThis.DrcomAppearance.normalizeAppearance(input || {});
    if (appearance.background !== "custom" || !appearance.backgroundImage) return;

    const host = document.createElement("div");
    host.id = "drcom-private-appearance";
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    const image = appearance.backgroundImage.replace(/["\\\r\n\f]/g, "");
    const dark = appearance.theme === "dark";
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .layer, .image, .veil { position: absolute; inset: 0; pointer-events: none; }
        .layer { overflow: hidden; background: #f2f3f5; }
        .image { inset: -48px; background: var(--appearance-position, center) / var(--appearance-fit, cover) no-repeat url("${image}"); filter: blur(${appearance.backgroundBlur}px); transform: scale(${appearance.backgroundScale}); }
        .veil { background: rgba(${dark ? "8, 12, 20" : "238, 241, 246"}, ${appearance.backgroundDim}); }
        @media (prefers-color-scheme: dark) { .system .veil { background: rgba(8, 12, 20, ${appearance.backgroundDim}); } }
      </style>
      <div class="layer ${appearance.theme === "system" ? "system" : ""}"><div class="image"></div><div class="veil"></div></div>
    `;
    document.body.append(host);
  }

  function portalHost(value) {
    try { return new URL(value || location.href).host || location.host || t("authentication_gateway"); }
    catch (error) { return location.host || t("authentication_gateway"); }
  }

  function removeModernPortal() {
    if (sadRevertTimer) {
      clearTimeout(sadRevertTimer);
      sadRevertTimer = 0;
    }
    document.documentElement.classList.remove("drcom-modern-active");
    document.getElementById("drcom-modern-root")?.remove();
    currentPortalInput = null;
    document.getElementById("drcom-private-appearance")?.remove();
    document.getElementById("drcom-captcha-hint")?.remove();
    if (characterController) {
      characterController.destroy();
      characterController = null;
    }
  }

  function showCaptchaFallbackHint() {
    removeModernPortal();
    const hint = document.createElement("aside");
    hint.id = "drcom-captcha-hint";
    hint.setAttribute("role", "status");
    hint.innerHTML = `
      <strong data-i18n="portal_captcha_heading">${t("portal_captcha_heading")}</strong>
      <span data-i18n="portal_captcha_description">${t("portal_captcha_description")}</span>
      <button id="drcom-captcha-dismiss" type="button" data-i18n="portal_dismiss" data-i18n-aria-label="portal_dismiss" aria-label="${t("portal_dismiss")}">${t("portal_dismiss")}</button>
    `;
    hint.querySelector("#drcom-captcha-dismiss")?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      hint.remove();
    });
    document.body.append(hint);
  }

  function restoreOriginalPortal() {
    userRestoredOriginal = true;
    stopPortalReadinessObserver();
    removeModernPortal();
  }

  function setCharacterMode(root, next) {
    if (!characterController) return;
    if (sadRevertTimer) {
      clearTimeout(sadRevertTimer);
      sadRevertTimer = 0;
    }
    characterController.setState(next);
  }

  function characterStateFromForm(root, passwordFocused = false) {
    const password = root.querySelector("#drcom-password");
    const visible = root.querySelector("#drcom-password-toggle")?.getAttribute("aria-pressed") === "true";
    if (passwordFocused || (password && password.value)) {
      return visible ? "visible" : "hiding";
    }
    return "idle";
  }

  function bindCharacters(root, online) {
    const frame = root.querySelector("[data-characters]");
    if (!frame || !characters) return;
    characterController = characters.mount(frame, { interactive: true });
    if (online) return;

    const username = root.querySelector("#drcom-username");
    const password = root.querySelector("#drcom-password");
    const toggle = root.querySelector("#drcom-password-toggle");
    let passwordFocused = false;
    const syncFromForm = () => setCharacterMode(root, characterStateFromForm(root, passwordFocused));
    username?.addEventListener("focus", () => setCharacterMode(root, "typing"));
    username?.addEventListener("input", () => setCharacterMode(root, "typing"));
    username?.addEventListener("blur", syncFromForm);
    password?.addEventListener("focus", () => {
      passwordFocused = true;
      /* 聚焦密码框立即回避：即使浏览器自动填充不触发 input 事件 */
      setCharacterMode(root, characterStateFromForm(root, true));
    });
    ["input", "change", "keyup"].forEach((type) => {
      password?.addEventListener(type, syncFromForm);
    });
    password?.addEventListener("blur", () => {
      passwordFocused = false;
      syncFromForm();
    });
    toggle?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (!password) return;
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", show ? "true" : "false");
      toggle.setAttribute("aria-label", show ? t("portal_hide_password") : t("reveal_password"));
      const glyph = toggle.querySelector(".win-glyph");
      if (glyph) glyph.textContent = show ? "\uE7B3" : "\uE890";
      syncFromForm();
    });
    root.querySelector("#drcom-reset")?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (toggle) {
        toggle.setAttribute("aria-pressed", "false");
        toggle.setAttribute("aria-label", t("reveal_password"));
        const glyph = toggle.querySelector(".win-glyph");
        if (glyph) glyph.textContent = "\uE890";
      }
      passwordFocused = false;
      setCharacterMode(root, "idle");
    });
  }

  function bindPortalEvents(root, online) {
    root.querySelector("#drcom-language-toggle")?.addEventListener("click", async (event) => {
      if (!event.isTrusted) return;
      const preference = i18n.getLanguage() === "zh-CN" ? "en" : "zh-CN";
      try {
        const response = await sendMessage({ action: "language:set", preference });
        applyLanguage(response.preference || preference);
      } catch (error) {
        applyLanguage(preference);
      }
    });
    root.querySelector("#drcom-restore-original")?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      restoreOriginalPortal();
    });
    root.querySelector("#drcom-open-options")?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      void sendMessage({ action: "options:open" });
    });
    if (online) {
      root.querySelector("#drcom-logout")?.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        void logoutFromPortal(root);
      });
      root.querySelector("#drcom-refresh-status")?.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        void refreshPortalStatus(root);
      });
      return;
    }
    root.querySelector("#drcom-login-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!event.isTrusted) return;
      void loginFromPortal(root);
    });
    root.querySelector("#drcom-reset")?.addEventListener("click", (event) => {
      event.preventDefault();
      if (!event.isTrusted) return;
      const username = root.querySelector("#drcom-username");
      const suffix = root.querySelector("#drcom-suffix");
      const password = root.querySelector("#drcom-password");
      const remember = root.querySelector("#drcom-remember");
      if (username) username.value = "";
      if (suffix) suffix.value = "";
      if (password) password.value = "";
      if (remember) remember.checked = true;
      setPortalStatus(root, "", "");
    });
  }

  async function refreshPortalStatus(root) {
    setPortalBusy(root, true, "portal_refreshing");
    try {
      const result = await sendMessage({ action: "portal:status:get" });
      if (userRestoredOriginal) return;
      if (result.state === "offline") {
        mountPortal(activePortalConfig || {}, false);
        return;
      }
      mountPortal(activePortalConfig || {}, true, result);
    } catch (error) {
      setPortalBusy(root, false);
      setPortalStatus(root, error.message || String(error), "error");
    }
  }

  function prefillFromOriginalPage(root) {
    const originalUsername = findOriginalValue([
      'input[name="user_account"]',
      'input[name="DDDDD"]',
      'input[name="username"]',
      "#username"
    ]);
    const originalPassword = findOriginalValue([
      'input[name="user_password"]',
      'input[name="upass"]',
      'input[name="password"]',
      'input[name="0MKKey"]',
      'input[type="password"]'
    ]);
    const parsed = ui.parseAccount(originalUsername);
    const username = root.querySelector("#drcom-username");
    const suffix = root.querySelector("#drcom-suffix");
    const password = root.querySelector("#drcom-password");
    if (username) username.value = parsed.username;
    if (suffix) suffix.value = parsed.suffix;
    if (password) password.value = originalPassword;
  }

  async function loginFromPortal(root) {
    const account = ui.buildAccount({
      username: root.querySelector("#drcom-username")?.value,
      suffix: root.querySelector("#drcom-suffix")?.value,
      password: root.querySelector("#drcom-password")?.value
    }, collectNetworkValues());
    const remember = Boolean(root.querySelector("#drcom-remember")?.checked);

    if (!account.username) {
      setLocalPortalStatus(root, "portal_username_required", "error");
      return;
    }
    if (!account.password) {
      setLocalPortalStatus(root, "portal_password_required", "error");
      return;
    }

    setPortalBusy(root, true, "portal_connecting");
    try {
      let result;
      if (remember) {
        const saved = await sendMessage({ action: "account:save:interactive", account });
        result = await sendMessage({ action: "drcom:login", accountId: saved.accountId });
      } else {
        result = await sendMessage({ action: "drcom:login", account });
      }

      if (result.success) {
        mountPortal(activePortalConfig || {}, true);
        setCharacterMode(document.getElementById("drcom-modern-root"), "happy");
        return;
      }
      setCharacterMode(root, "sad");
      sadRevertTimer = setTimeout(() => {
        sadRevertTimer = 0;
        setCharacterMode(root, characterStateFromForm(root));
      }, 3000);
      if (result.message) setPortalStatus(root, result.message, "error");
      else setLocalPortalStatus(root, "portal_auth_failed", "error");
    } catch (error) {
      setPortalStatus(root, error.message || String(error), "error");
    } finally {
      setPortalBusy(root, false);
    }
  }

  async function logoutFromPortal(root) {
    const confirmDialog = globalThis.DrcomConfirmDialog;
    if (!confirmDialog || typeof confirmDialog.ask !== "function") {
      setLocalPortalStatus(root, "portal_confirm_unavailable", "error");
      return;
    }
    const confirmed = await confirmDialog.ask({
      title: t("portal_logout_title"),
      message: t("portal_logout_message"),
      confirmLabel: t("portal_logout")
    });
    if (!confirmed) return;
    setPortalBusy(root, true, "portal_logging_out");
    try {
      const result = await sendMessage({ action: "drcom:logout" });
      if (!result.success) throw new Error(result.error || result.message || t("portal_logout_failed"));
      mountPortal(activePortalConfig || {}, false);
    } catch (error) {
      setPortalStatus(root, error.message || String(error), "error");
    } finally {
      setPortalBusy(root, false);
    }
  }

  function setPortalBusy(root, busy, messageKey = "") {
    root.dataset.busy = busy ? "true" : "false";
    root.querySelectorAll("button, input, select").forEach((element) => {
      if (element.id !== "drcom-restore-original") element.disabled = busy;
    });
    if (messageKey) setLocalPortalStatus(root, messageKey, "progress");
  }

  function setPortalStatus(root, message, state = "") {
    const status = root.querySelector("#drcom-form-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
    delete status.dataset.i18nKey;
  }

  function setLocalPortalStatus(root, key, state = "") {
    setPortalStatus(root, t(key), state);
    const status = root.querySelector("#drcom-form-status");
    if (status) status.dataset.i18nKey = key;
  }

  function collectNetworkValues() {
    return {
      wlanUserIp: findNetworkValue("wlan_user_ip"),
      wlanUserMac: findNetworkValue("wlan_user_mac"),
      wlanUserIpv6: findNetworkValue("wlan_user_ipv6"),
      wlanAcIp: findNetworkValue("wlan_ac_ip"),
      wlanAcName: findNetworkValue("wlan_ac_name")
    };
  }

  function findOriginalValue(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && "value" in element && String(element.value || "").trim()) {
        return String(element.value).trim();
      }
    }
    return "";
  }

  function findNetworkValue(name) {
    const input = document.querySelector(`[name="${name}"], #${name}`);
    return input && "value" in input ? String(input.value || "").trim() : "";
  }

  function isOnlinePage() {
    if (document.querySelector('input[name="logout"], button[name="logout"], [name="logout"], [data-localize*="logout"]')) return true;
    const passwordInput = document.querySelector('input[type="password"]');
    const text = document.body ? document.body.innerText || "" : "";
    return /注销|下线|已登录|已连接|online|logout/i.test(text) && !passwordInput;
  }


  /* 扩展重载/更新后，已开门户页里的内容脚本会孤儿化：chrome.runtime 不可用，
     任何消息都会抛 "Extension context invalidated"。此时摘除现代界面并给出明确的
     刷新引导，避免用户面对"点击无响应"的假死界面。 */
  let contextLostHandled = false;

  function handleExtensionContextLost() {
    if (contextLostHandled) return;
    contextLostHandled = true;
    try {
      removeModernPortal();
      if (document.getElementById("drcom-context-lost-hint")) return;
      const hint = document.createElement("div");
      hint.id = "drcom-context-lost-hint";
      hint.setAttribute("role", "alert");
      hint.innerHTML = `<span>${t("portal_context_lost")}</span>`
        + `<button id="drcom-context-lost-refresh" type="button">${t("portal_refresh_page")}</button>`;
      hint.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:12px;padding:10px 16px;background:#1a1a1a;color:#fff;font:13px/1.5 system-ui,sans-serif;border:1px solid rgba(255,255,255,.2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);";
      hint.querySelector("#drcom-context-lost-refresh")?.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        window.location.reload();
      });
      document.body.append(hint);
    } catch (error) {}
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            if (/context invalidated|Extension context/i.test(error.message || "")) {
              handleExtensionContextLost();
            }
            reject(new Error(error.message));
            return;
          }
          if (!response) {
            reject(new Error(t("portal_backend_no_response")));
            return;
          }
          if (response.ok === false) {
            reject(new Error(response.error || response.message || t("portal_backend_request_failed")));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        if (/context invalidated|Extension context/i.test(String(error && error.message))) {
          handleExtensionContextLost();
          reject(new Error(t("portal_extension_updated")));
          return;
        }
        reject(error);
      }
    });
  }

  function safeSend(message) {
    sendMessage(message).catch(() => {});
  }
})();
