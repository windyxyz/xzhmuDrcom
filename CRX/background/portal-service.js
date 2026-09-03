"use strict";

function portalMatchPattern(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.protocol}//${url.hostname}/*`;
  } catch (error) {
    return "";
  }
}

async function syncPortalContentScript(state) {
  const scripting = chrome.scripting;
  if (!scripting?.getRegisteredContentScripts || !scripting?.registerContentScripts || !scripting?.unregisterContentScripts) {
    return false;
  }

  const portalUrl = state?.config?.portalUrl || DEFAULT_STATE.config.portalUrl;
  const pattern = portalMatchPattern(portalUrl);
  const hostname = (() => {
    try { return new URL(portalUrl).hostname; }
    catch (error) { return ""; }
  })();
  const shouldRegister = state?.config?.ui?.modernizePortal !== false && pattern && hostname !== "10.10.10.2";
  const existing = await scripting.getRegisteredContentScripts({ ids: [CUSTOM_PORTAL_SCRIPT_ID] });

  if (!shouldRegister) {
    if (existing.length) await scripting.unregisterContentScripts({ ids: [CUSTOM_PORTAL_SCRIPT_ID] });
    return false;
  }

  const hasAccess = await chrome.permissions.contains({
    origins: [pattern],
    permissions: ["scripting"]
  });
  if (!hasAccess) return false;

  const current = existing[0];
  if (current && Array.isArray(current.matches) && current.matches.length === 1 && current.matches[0] === pattern) {
    return true;
  }
  if (existing.length) await scripting.unregisterContentScripts({ ids: [CUSTOM_PORTAL_SCRIPT_ID] });
  await scripting.registerContentScripts([{
    id: CUSTOM_PORTAL_SCRIPT_ID,
    matches: [pattern],
    css: ["design-tokens.css", "portal.css"],
    js: [
      "account-utils.js",
      "portal-session.js",
      "appearance.js",
      "portal-ui.js",
      "confirm-dialog.js",
      "portal-modernizer.js"
    ],
    runAt: "document_start",
    persistAcrossSessions: true
  }]);
  return true;
}

async function handleTabRedirect(tabId, targetUrl) {
  const guard = await getTabGuard(tabId);
  if (!guard || Date.now() > guard.until) {
    await setTabGuard(tabId, null);
    return;
  }

  const state = await getState();
  if (!state.config.redirect.returnToPortal) {
    await setTabGuard(tabId, null);
    return;
  }

  if (isPortalUrl(targetUrl, state.config.portalUrl)) {
    return;
  }

  // 只防一次“登录后的自动离开网关页”，防完立即解除；不再做长期外站拦截。
  await setTabGuard(tabId, null);
  chrome.tabs.update(tabId, { url: `${state.config.portalUrl}?drcom_kept=1` }, () => {
    void chrome.runtime.lastError;
  });
}

async function markSenderTab(sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return;
  }

  const state = await getState();
  if (state.config.redirect.returnToPortal === false) return;
  await setTabGuard(sender.tab.id, {
    until: Date.now() + state.config.redirect.guardSeconds * 1000
  });
}

async function clearSenderTab(sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return;
  }
  await setTabGuard(sender.tab.id, null);
}

function isPortalUrl(targetUrl, portalUrl) {
  try {
    const target = new URL(targetUrl);
    const portal = new URL(portalUrl);
    return target.protocol === portal.protocol && target.hostname === portal.hostname;
  } catch (error) {
    return false;
  }
}

function normalizeAccent(value) {
  const color = stringValue(value).trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_STATE.config.ui.accent;
}

function normalizeImageUrl(value) {
  const raw = stringValue(value).trim();
  if (!raw || raw.length > 6000000) {
    return "";
  }
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(raw)) {
    return raw;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function publicAppearance(input) {
  const ui = input && typeof input === "object" ? input : {};
  const backgroundImage = normalizeImageUrl(ui.backgroundImage);
  const background = ui.background === "custom" && backgroundImage
    ? "custom"
    : ui.background === "daily"
      ? "daily"
      : "fresh";
  return {
    theme: ["system", "light", "dark"].includes(ui.theme) ? ui.theme : DEFAULT_STATE.config.ui.theme,
    accent: normalizeAccent(ui.accent),
    background,
    backgroundImage: background === "custom" ? backgroundImage : "",
    backgroundBlur: clampNumber(ui.backgroundBlur, 0, 32, DEFAULT_STATE.config.ui.backgroundBlur),
    backgroundDim: clampNumber(ui.backgroundDim, 0.2, 0.72, DEFAULT_STATE.config.ui.backgroundDim),
    backgroundScale: clampNumber(ui.backgroundScale, 1, 1.15, DEFAULT_STATE.config.ui.backgroundScale),
    backgroundPosition: ["left top", "center top", "right top", "left center", "center", "right center", "left bottom", "center bottom", "right bottom"].includes(ui.backgroundPosition)
      ? ui.backgroundPosition
      : "center",
    panelColor: /^#[0-9a-f]{6}$/i.test(String(ui.panelColor || "").trim()) ? String(ui.panelColor).trim() : "",
    panelPattern: ["grid", "dots", "none"].includes(ui.panelPattern) ? ui.panelPattern : "grid"
  };
}

function safePortalAppearance(input) {
  const appearance = publicAppearance(input);
  return { theme: appearance.theme, accent: appearance.accent };
}

function isWebPageSender(sender) {
  return Boolean(sender && typeof sender.url === "string" && /^https?:/i.test(sender.url));
}

async function trustedPortalOrigins() {
  // 默认门户始终可信；用户显式配置的自定义网关只有在保存时逐来源授权后，
  // 内容脚本才会注册到那里，因此这里的配置来源与注入范围保持一致。
  const origins = new Set(["http://10.10.10.2"]);
  try {
    const configured = new URL(stringValue((await getState()).config.portalUrl));
    if (configured.protocol === "http:" || configured.protocol === "https:") {
      origins.add(configured.origin);
    }
  } catch (error) {}
  return origins;
}

async function validatePortalSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) {
    throw new Error("拒绝非本扩展发起的网页消息");
  }
  if (sender.frameId !== 0) {
    throw new Error("网页消息只允许来自门户顶层 frame");
  }
  const trustedOrigins = await trustedPortalOrigins();
  if (!trustedOrigins.has(sender.origin)) {
    throw new Error("网页消息来源不是受信任门户");
  }
  try {
    if (!trustedOrigins.has(new URL(sender.url).origin)) {
      throw new Error("网页消息 URL 不是受信任门户");
    }
  } catch (error) {
    throw new Error("网页消息 URL 不是受信任门户");
  }
  if (!sender.tab || typeof sender.tab.id !== "number") {
    throw new Error("网页消息缺少有效标签页");
  }

  let currentTab;
  try {
    currentTab = await chrome.tabs.get(sender.tab.id);
  } catch (error) {
    throw new Error("无法确认网页消息标签页");
  }
  try {
    if (!currentTab || !trustedOrigins.has(new URL(currentTab.url || "").origin)) {
      throw new Error("标签页已经离开受信任门户");
    }
  } catch (error) {
    throw new Error("标签页已经离开受信任门户");
  }
  return true;
}
