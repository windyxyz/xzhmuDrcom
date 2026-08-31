"use strict";

importScripts(
  "background/state-store.js",
  "background/drcom-client.js",
  "background/account-service.js",
  "background/connection-service.js",
  "background/portal-service.js",
  "background/message-router.js"
);

void restrictLocalStorageAccess();

chrome.runtime.onInstalled.addListener(handleInstalled);

async function handleInstalled(details = {}) {
  const state = await getState();
  await setupAutomation(state);
  await syncPortalContentScript(state);
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
}

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  await setupAutomation(state);
  await syncPortalContentScript(state);
  if (state.config.automation.loginOnStartup) {
    await loginSelectedAccount("浏览器启动自动登录", { automatic: true });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    void keepAliveTick();
  }
  if (alarm.name === RETRY_ALARM) {
    void loginSelectedAccount("网络失败自动重试", { automatic: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((payload) => sendResponse(payload))
    .catch((error) => sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    void handleTabRedirect(tabId, changeInfo.url);
  }
});
