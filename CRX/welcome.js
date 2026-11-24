"use strict";

let portalUrl = "http://10.10.10.2/";
let languagePreference = "auto";
const i18n = globalThis.DrcomI18n;

document.addEventListener("DOMContentLoaded", async () => {
  bindLanguageControls();
  document.getElementById("open-portal")?.addEventListener("click", () => {
    chrome.tabs.update({ url: portalUrl });
  });
  document.getElementById("open-options")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  if (typeof document.querySelector === "function" && globalThis.DrcomCharacters) {
    const frame = document.querySelector("[data-characters]");
    if (frame) {
      globalThis.DrcomCharacters.mount(frame, { interactive: true });
    }
  }

  await Promise.all([loadLanguage(), loadWelcomeState()]);
});

async function loadWelcomeState() {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      const response = await sendMessage({ action: "state:get" });
      if (response && response.state) {
        const ui = response.state.config.ui;
        if (globalThis.DrcomAppearance) {
          globalThis.DrcomAppearance.applyToRoot(document.documentElement, ui);
        }
        if (ui && ui.background === "daily") {
          chrome.runtime.sendMessage({ action: "wallpaper:get" }, (wallpaperResponse) => {
            if (chrome.runtime.lastError) return;
            const wallpaper = wallpaperResponse && wallpaperResponse.wallpaper;
            if (wallpaper && wallpaper.ok && wallpaper.dataUrl && globalThis.DrcomAppearance) {
              globalThis.DrcomAppearance.applyToRoot(document.documentElement, {
                ...ui,
                background: "custom",
                backgroundImage: wallpaper.dataUrl
              });
            }
          });
        }
        portalUrl = response.state.config.portalUrl || portalUrl;
        updatePortalCopy();
        return;
      }
    } catch (error) {}
  }

  if (globalThis.DrcomAppearance) {
    globalThis.DrcomAppearance.applyToRoot(document.documentElement, {});
  }
}

function updatePortalCopy() {
  const host = gatewayHost(portalUrl);
  const title = document.getElementById("portal-title");
  const button = document.getElementById("open-portal");
  if (title) title.textContent = host;
  if (button) button.textContent = i18n.t("gateway_open", [host]);
}

function gatewayHost(value) {
  try { return new URL(value).host || i18n.t("authentication_gateway"); }
  catch (error) { return i18n.t("authentication_gateway"); }
}

function bindLanguageControls() {
  document.getElementById("language-toggle")?.addEventListener("click", async () => {
    const preference = i18n.getLanguage() === "zh-CN" ? "en" : "zh-CN";
    try {
      const response = await sendMessage({ action: "language:set", preference });
      clearLanguageSaveFailure();
      applyLanguage(response.preference || preference);
    } catch (error) {
      applyLanguage(preference);
      showLanguageSaveFailure();
    }
  });
  chrome.runtime.onMessage?.addListener((message, sender) => {
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    if (message?.action !== "language:changed") return;
    applyLanguage(message.preference);
  });
}

function showLanguageSaveFailure() {
  const status = document.getElementById("language-save-status");
  if (!status) return;
  status.textContent = i18n.t("language_not_saved");
  status.hidden = false;
}

function clearLanguageSaveFailure() {
  const status = document.getElementById("language-save-status");
  if (!status) return;
  status.textContent = "";
  status.hidden = true;
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
  i18n.apply(document, language);
  if (document.documentElement) {
    document.documentElement.lang = language;
    document.documentElement.dir = "ltr";
  }
  const toggle = document.getElementById("language-toggle");
  if (toggle) toggle.textContent = language === "zh-CN" ? "EN" : "中文";
  updatePortalCopy();
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || "runtime error"));
        else if (!response || response.ok === false) reject(new Error(response?.error || "runtime error"));
        else resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}
