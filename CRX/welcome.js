"use strict";

let portalUrl = "http://10.10.10.2/";

document.addEventListener("DOMContentLoaded", async () => {
  if (globalThis.DrcomAppearance) {
    globalThis.DrcomAppearance.applyToRoot(document.documentElement, {});
  }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      const response = await chrome.runtime.sendMessage({ action: "state:get" });
      if (response && response.state) {
        globalThis.DrcomAppearance?.applyToRoot(document.documentElement, response.state.config.ui);
        portalUrl = response.state.config.portalUrl || portalUrl;
        const host = gatewayHost(portalUrl);
        const title = document.getElementById("portal-title");
        const button = document.getElementById("open-portal");
        if (title) title.textContent = host;
        if (button) button.textContent = `打开 ${host} 并登录`;
      }
    } catch (error) {}
  }

  document.getElementById("open-portal").addEventListener("click", () => {
    chrome.tabs.update({ url: portalUrl });
  });

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  if (typeof document.querySelector === "function" && globalThis.DrcomCharacters) {
    const frame = document.querySelector("[data-characters]");
    if (frame) {
      globalThis.DrcomCharacters.mount(frame, { interactive: true });
    }
  }
});

function gatewayHost(value) {
  try { return new URL(value).host || "认证网关"; }
  catch (error) { return "认证网关"; }
}
