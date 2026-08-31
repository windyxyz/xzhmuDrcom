"use strict";

(() => {
  const ui = globalThis.DrcomPortalUI;
  let pendingFallbackCapture = null;
  let lastSavedCaptureKey = "";
  let activePortalConfig = null;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
  } else {
    void boot();
  }

  async function boot() {
    try {
      if (!ui) throw new Error("门户界面模块未加载");
      installOriginalLoginCapture();
      await mountModernPortalWhenEligible();
    } catch (error) {
      restoreOriginalPortal();
    }
  }

  async function mountModernPortalWhenEligible() {
    const response = await sendMessage({ action: "portal:config:get" });
    const config = response.portal || {};
    const online = isOnlinePage();
    const hasPasswordField = Boolean(document.querySelector('input[type="password"]'));
    if (!ui.shouldTakeOver({ enabled: config.enabled === true, online, hasPasswordField })) {
      restoreOriginalPortal();
      return;
    }

    activePortalConfig = config;
    mountPortal(config, online);
  }

  function mountPortal(config, online) {
    restoreOriginalPortal();
    const root = document.createElement("div");
    root.id = "drcom-modern-root";
    root.innerHTML = ui.renderPortalMarkup({
      title: config.title || "徐医校园网",
      online,
      host: portalHost(config.portalUrl)
    });
    if (globalThis.DrcomAppearance) {
      globalThis.DrcomAppearance.applyToRoot(root, config.appearance || {});
    }
    document.body.append(root);
    document.documentElement.classList.add("drcom-modern-active");
    bindPortalEvents(root, online);
    if (!online) prefillFromOriginalPage(root);
  }

  function portalHost(value) {
    try { return new URL(value || location.href).host || location.host || "认证网关"; }
    catch (error) { return location.host || "认证网关"; }
  }

  function restoreOriginalPortal() {
    document.documentElement.classList.remove("drcom-modern-active");
    document.getElementById("drcom-modern-root")?.remove();
  }

  function bindPortalEvents(root, online) {
    root.querySelector("#drcom-restore-original")?.addEventListener("click", restoreOriginalPortal);
    if (online) {
      root.querySelector("#drcom-logout")?.addEventListener("click", () => void logoutFromPortal(root));
      return;
    }
    root.querySelector("#drcom-login-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void loginFromPortal(root);
    });
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
        return;
      }
      setPortalStatus(root, result.message || "认证未通过，请检查账号和密码", "error");
    } catch (error) {
      setPortalStatus(root, error.message || String(error), "error");
    } finally {
      setPortalBusy(root, false);
    }
  }

  async function logoutFromPortal(root) {
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
      wlanUserIp: findNetworkValue("wlan_user_ip") || guessIp(),
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
        wlanUserIp: extra.wlanUserIp || findNetworkValue("wlan_user_ip") || guessIp(),
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
        wlanUserIp: extra.wlanUserIp || findNetworkValue("wlan_user_ip") || guessIp(),
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

  function guessIp() {
    const text = document.documentElement ? document.documentElement.innerText || "" : "";
    const match = text.match(/\b(?:10|172|192)\.(?:\d{1,3}\.){2}\d{1,3}\b/);
    return match ? match[0] : "";
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
