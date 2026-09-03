"use strict";

(() => {
  const ui = globalThis.DrcomPortalUI;
  const characters = globalThis.DrcomCharacters;
  let pendingFallbackCapture = null;
  let lastSavedCaptureKey = "";
  let activePortalConfig = null;
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
      installOriginalLoginCapture();
      activePortalConfig = await loadPortalConfig();
      if (activePortalConfig.enabled !== true) return;
      startPortalReadinessObserver();
      schedulePortalRecognition();
    } catch (error) {
      removeModernPortal();
    }
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
      root.innerHTML = ui.renderPortalMarkup({
        title: config.title || "徐医校园网",
        online,
        host: portalHost(config.portalUrl),
        onlineDetailMode: config.onlineDetailMode || "classic",
        session: statusResult && statusResult.session,
        statusMessage: statusResult && statusResult.message,
        checkedAt: statusResult && statusResult.checkedAt
      });
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
    try { return new URL(value || location.href).host || location.host || "认证网关"; }
    catch (error) { return location.host || "认证网关"; }
  }

  function removeModernPortal() {
    document.documentElement.classList.remove("drcom-modern-active");
    document.getElementById("drcom-modern-root")?.remove();
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
      <strong>请使用学校原始页面</strong>
      <span>检测到验证码或扫码登录，本次不会接管或隐藏原始控件。</span>
      <button id="drcom-captcha-dismiss" type="button" aria-label="关闭提示">关闭</button>
    `;
    hint.querySelector("#drcom-captcha-dismiss")?.addEventListener("click", () => hint.remove());
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

  function characterStateFromForm(root) {
    const password = root.querySelector("#drcom-password");
    const visible = root.querySelector("#drcom-password-toggle")?.getAttribute("aria-pressed") === "true";
    if (password && password.value && visible) return "visible";
    if (password && password.value) return "hiding";
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
    username?.addEventListener("focus", () => setCharacterMode(root, "typing"));
    username?.addEventListener("input", () => setCharacterMode(root, "typing"));
    username?.addEventListener("blur", () => setCharacterMode(root, characterStateFromForm(root)));
    password?.addEventListener("input", () => setCharacterMode(root, characterStateFromForm(root)));
    password?.addEventListener("focus", () => setCharacterMode(root, characterStateFromForm(root)));
    password?.addEventListener("blur", () => setCharacterMode(root, characterStateFromForm(root)));
    toggle?.addEventListener("click", () => {
      if (!password) return;
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", show ? "true" : "false");
      toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
      const glyph = toggle.querySelector(".win-glyph");
      if (glyph) glyph.textContent = show ? "\uE7B3" : "\uE890";
      setCharacterMode(root, characterStateFromForm(root));
    });
    root.querySelector("#drcom-reset")?.addEventListener("click", () => {
      if (toggle) {
        toggle.setAttribute("aria-pressed", "false");
        toggle.setAttribute("aria-label", "显示密码");
        const glyph = toggle.querySelector(".win-glyph");
        if (glyph) glyph.textContent = "\uE890";
      }
      setCharacterMode(root, "idle");
    });
  }

  function bindPortalEvents(root, online) {
    root.querySelector("#drcom-restore-original")?.addEventListener("click", restoreOriginalPortal);
    root.querySelector("#drcom-open-options")?.addEventListener("click", () => {
      void sendMessage({ action: "options:open" });
    });
    if (online) {
      root.querySelector("#drcom-logout")?.addEventListener("click", () => void logoutFromPortal(root));
      root.querySelector("#drcom-refresh-status")?.addEventListener("click", () => void refreshPortalStatus(root));
      return;
    }
    root.querySelector("#drcom-login-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void loginFromPortal(root);
    });
    root.querySelector("#drcom-reset")?.addEventListener("click", (event) => {
      event.preventDefault();
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
    setPortalBusy(root, true, "正在刷新在线状态…");
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
      setPortalStatus(root, "请输入学号或 DrCOM 账号", "error");
      return;
    }
    if (!account.password) {
      setPortalStatus(root, "请输入认证密码", "error");
      return;
    }

    setPortalBusy(root, true, "正在连接校园网…");
    try {
      let result;
      if (remember) {
        const saved = await sendMessage({ action: "account:save", account });
        result = await sendMessage({ action: "drcom:login", accountId: saved.accountId });
      } else {
        result = await sendMessage({ action: "drcom:login", account });
      }

      if (result.online || result.success) {
        mountPortal(activePortalConfig || {}, true);
        setCharacterMode(document.getElementById("drcom-modern-root"), "happy");
        return;
      }
      setCharacterMode(root, "sad");
      sadRevertTimer = setTimeout(() => {
        sadRevertTimer = 0;
        setCharacterMode(root, characterStateFromForm(root));
      }, 3000);
      setPortalStatus(root, result.message || "认证未通过，请检查账号和密码", "error");
    } catch (error) {
      setPortalStatus(root, error.message || String(error), "error");
    } finally {
      setPortalBusy(root, false);
    }
  }

  async function logoutFromPortal(root) {
    const confirmDialog = globalThis.DrcomConfirmDialog;
    if (!confirmDialog || typeof confirmDialog.ask !== "function") {
      setPortalStatus(root, "无法打开注销确认，请使用学校原始页面。", "error");
      return;
    }
    const confirmed = await confirmDialog.ask({
      title: "注销当前校园网连接？",
      message: "确认后将注销并解绑 MAC；取消不会发送任何下线请求。",
      confirmLabel: "注销并解绑 MAC"
    });
    if (!confirmed) return;
    setPortalStatus(root, "正在下线…", "progress");
    try {
      const result = await sendMessage({ action: "drcom:logout" });
      if (!result.success) throw new Error(result.error || result.message || "下线失败");
      mountPortal(activePortalConfig || {}, false);
    } catch (error) {
      setPortalStatus(root, error.message || String(error), "error");
    }
  }

  function setPortalBusy(root, busy, message = "") {
    root.dataset.busy = busy ? "true" : "false";
    root.querySelectorAll("button, input, select").forEach((element) => {
      if (element.id !== "drcom-restore-original") element.disabled = busy;
    });
    if (message) setPortalStatus(root, message, "progress");
  }

  function setPortalStatus(root, message, state = "") {
    const status = root.querySelector("#drcom-form-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
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

  function installOriginalLoginCapture() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.tagName !== "SCRIPT" || !node.src) continue;
          if (node.src.includes("a=unbind_mac")) {
            try {
              const url = new URL(node.src, location.href);
              const params = url.searchParams;
              captureLogoutNetwork(params.get("user_account"), {
                wlanUserIp: params.get("wlan_user_ip"),
                wlanUserMac: params.get("wlan_user_mac"),
                wlanUserIpv6: params.get("wlan_user_ipv6"),
                wlanAcIp: params.get("wlan_ac_ip"),
                wlanAcName: params.get("wlan_ac_name")
              });
            } catch (error) {}
          } else if (node.src.includes("a=login") || node.src.includes("login_method")) {
            try {
              const url = new URL(node.src, location.href);
              const params = url.searchParams;
              captureFromData(params.get("user_account"), params.get("user_password"), {
                source: "script",
                wlanUserIp: params.get("wlan_user_ip"),
                wlanUserMac: params.get("wlan_user_mac"),
                wlanUserIpv6: params.get("wlan_user_ipv6"),
                wlanAcIp: params.get("wlan_ac_ip"),
                wlanAcName: params.get("wlan_ac_name")
              });
            } catch (error) {}
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener("submit", (event) => {
      markPortalTabBriefly();
      const form = event.target;
      if (!form || form.id === "drcom-login-form") return;
      try {
        const data = new FormData(form);
        const username = data.get("user_account") || data.get("DDDDD") || data.get("username");
        const password = data.get("user_password") || data.get("upass") || data.get("password") || data.get("0MKKey");
        if (username && password) {
          scheduleFallbackCapture(username, password, {
            source: "form",
            wlanUserIp: data.get("wlan_user_ip"),
            wlanUserMac: data.get("wlan_user_mac")
          });
        }
      } catch (error) {}
    }, true);

    ["pointerdown", "mousedown", "touchstart", "click"].forEach((type) => {
      document.addEventListener(type, (event) => {
        const target = event.target;
        if (!target || !target.closest || target.closest("#drcom-modern-root")) return;
        const button = target.closest('input[type="submit"], input[name="0MKKey"], #login, #loginLink, button[type="submit"], button[name*="login" i], button[id*="login" i], button[class*="login" i]');
        if (button) markPortalTabBriefly();
      }, true);
    });
  }

  function scheduleFallbackCapture(userAccount, userPassword, extra = {}) {
    if (pendingFallbackCapture) clearTimeout(pendingFallbackCapture);
    pendingFallbackCapture = setTimeout(() => {
      pendingFallbackCapture = null;
      captureFromData(userAccount, userPassword, extra);
    }, 900);
  }

  function captureFromData(userAccount, userPassword, extra = {}) {
    if (!userAccount || !userPassword) return;
    markPortalTabBriefly();
    const source = extra.source || "script";
    if (source === "script" && pendingFallbackCapture) {
      clearTimeout(pendingFallbackCapture);
      pendingFallbackCapture = null;
    }

    const parsed = ui.parseAccount(userAccount);
    if (!parsed.username) return;
    const captureKey = `${parsed.username}|${parsed.suffix}|${String(userPassword)}`;
    if (captureKey === lastSavedCaptureKey) return;
    lastSavedCaptureKey = captureKey;
    setTimeout(() => {
      if (lastSavedCaptureKey === captureKey) lastSavedCaptureKey = "";
    }, 3000);

    safeSend({
      action: "account:save",
      account: ui.buildAccount({
        username: parsed.username,
        suffix: parsed.suffix,
        password: String(userPassword)
      }, {
        wlanUserIp: extra.wlanUserIp || findNetworkValue("wlan_user_ip"),
        wlanUserMac: extra.wlanUserMac || findNetworkValue("wlan_user_mac"),
        wlanUserIpv6: extra.wlanUserIpv6 || findNetworkValue("wlan_user_ipv6"),
        wlanAcIp: extra.wlanAcIp || findNetworkValue("wlan_ac_ip"),
        wlanAcName: extra.wlanAcName || findNetworkValue("wlan_ac_name")
      })
    });
  }

  function captureLogoutNetwork(userAccount, extra = {}) {
    const parsed = ui.parseAccount(userAccount);
    if (!parsed.username) return;
    safeSend({
      action: "account:network:update",
      userAccount: parsed.username + parsed.suffix,
      network: {
        wlanUserIp: extra.wlanUserIp || findNetworkValue("wlan_user_ip"),
        wlanUserMac: extra.wlanUserMac || findNetworkValue("wlan_user_mac"),
        wlanUserIpv6: extra.wlanUserIpv6 || findNetworkValue("wlan_user_ipv6"),
        wlanAcIp: extra.wlanAcIp || findNetworkValue("wlan_ac_ip"),
        wlanAcName: extra.wlanAcName || findNetworkValue("wlan_ac_name")
      }
    });
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

  function markPortalTabBriefly() {
    safeSend({ action: "redirect:markPortalTab" });
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!response || response.ok === false) {
          reject(new Error(response && response.error ? response.error : "后台服务没有返回结果"));
          return;
        }
        resolve(response);
      });
    });
  }

  function safeSend(message) {
    sendMessage(message).catch(() => {});
  }
})();
