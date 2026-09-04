"use strict";

(() => {
  let pendingFallbackCapture = null;
  let lastSavedCaptureKey = "";
  let trustedCaptureUntil = 0;

  function installPortalCapture(options = {}) {
    const ui = options.ui || globalThis.DrcomPortalUI;
    const sendMessage = typeof options.sendMessage === "function" ? options.sendMessage : null;
    if (!ui || !sendMessage) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.tagName !== "SCRIPT" || !node.src) continue;
          if (node.src.includes("a=unbind_mac")) {
            try {
              const url = new URL(node.src, location.href);
              const params = url.searchParams;
              captureLogoutNetwork(ui, sendMessage, params.get("user_account"), {
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
              captureFromData(ui, sendMessage, params.get("user_account"), params.get("user_password"), {
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
      if (!event.isTrusted) return;
      trustedCaptureUntil = Date.now() + 5000;
      markPortalTabBriefly(sendMessage);
      const form = event.target;
      if (!form || form.id === "drcom-login-form") return;
      try {
        const data = new FormData(form);
        const username = data.get("user_account") || data.get("DDDDD") || data.get("username");
        const password = data.get("user_password") || data.get("upass") || data.get("password") || data.get("0MKKey");
        if (username && password) {
          scheduleFallbackCapture(ui, sendMessage, username, password, {
            source: "form",
            wlanUserIp: data.get("wlan_user_ip"),
            wlanUserMac: data.get("wlan_user_mac")
          });
        }
      } catch (error) {}
    }, true);

    ["pointerdown", "mousedown", "touchstart", "click"].forEach((type) => {
      document.addEventListener(type, (event) => {
        if (!event.isTrusted) return;
        const target = event.target;
        if (!target || !target.closest || target.closest("#drcom-modern-root")) return;
        const button = target.closest('input[type="submit"], input[name="0MKKey"], #login, #loginLink, button[type="submit"], button[name*="login" i], button[id*="login" i], button[class*="login" i]');
        if (button) {
          trustedCaptureUntil = Date.now() + 5000;
          markPortalTabBriefly(sendMessage);
        }
      }, true);
    });
  }

  function scheduleFallbackCapture(ui, sendMessage, userAccount, userPassword, extra = {}) {
    if (pendingFallbackCapture) clearTimeout(pendingFallbackCapture);
    pendingFallbackCapture = setTimeout(() => {
      pendingFallbackCapture = null;
      captureFromData(ui, sendMessage, userAccount, userPassword, extra);
    }, 900);
  }

  function captureFromData(ui, sendMessage, userAccount, userPassword, extra = {}) {
    if (!userAccount || !userPassword) return;
    if (Date.now() > trustedCaptureUntil) return;
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

    sendMessage({
      action: "account:capture:stage",
      source,
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

  function captureLogoutNetwork(ui, sendMessage, userAccount, extra = {}) {
    const parsed = ui.parseAccount(userAccount);
    if (!parsed.username) return;
    sendMessage({
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

  function findNetworkValue(name) {
    const input = document.querySelector(`[name="${name}"], #${name}`);
    return input && "value" in input ? String(input.value || "").trim() : "";
  }

  function markPortalTabBriefly(sendMessage) {
    sendMessage({ action: "redirect:markPortalTab" });
  }

  globalThis.DrcomPortalCapture = { install: installPortalCapture };
})();
