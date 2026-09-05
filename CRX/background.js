"use strict";

/* 依赖加载：Chrome 以 Service Worker 运行，importScripts 加载全部后台模块；
   Firefox 的 event page（manifest background.scripts 已按相同顺序预载）没有
   importScripts，此处自动跳过，避免重复或缺失。 */
(function loadBackgroundModules() {
  if (typeof importScripts !== "function") return;
  importScripts(
    "account-utils.js",
    "portal-session.js",
    "portal-diagnostics-utils.js",
    "background/state-store.js",
    "background/response-reader.js",
    "background/diagnostics-service.js",
    "background/portal-context.js",
    "background/drcom-client.js",
    "background/account-service.js",
    "background/connection-service.js",
    "background/wallpaper-service.js",
    "background/portal-service.js",
    "background/message-router.js"
  );
})();

const backgroundReady = restrictStorageAccess();

chrome.runtime.onInstalled.addListener(handleInstalled);

async function handleInstalled(details = {}) {
  await backgroundReady;
  const state = await getState();
  await setupAutomation(state);
  await syncPortalContentScript(state);
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
  if (details.reason === "update") {
    /* 内容脚本不会注入更新前已打开的门户页；刷新它们避免旧脚本孤儿化后点击无响应。 */
    try {
      await reloadPortalTabs();
    } catch (error) {}
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await backgroundReady;
  const state = await getState();
  await setupAutomation(state);
  await syncPortalContentScript(state);
  if (state.config.automation.loginOnStartup) {
    await loginSelectedAccount("浏览器启动自动登录", { automatic: true });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await backgroundReady;
  if (alarm.name === KEEPALIVE_ALARM) {
    void keepAliveTick();
  }
  if (alarm.name === RETRY_ALARM) {
    void loginSelectedAccount("网络失败自动重试", { automatic: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  backgroundReady.then(() => handleMessage(message, sender))
    .then((payload) => sendResponse(payload))
    .catch((error) => sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    void backgroundReady.then(() => handleTabRedirect(tabId, changeInfo.url));
  }
});
