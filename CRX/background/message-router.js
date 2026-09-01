"use strict";


async function validateDefaultPortalDiagnosticsSender(sender) {
  if (!sender || sender.frameId !== 0) throw new Error("门户诊断只接受顶层页面");
  try {
    const senderUrl = new URL(sender.url || "");
    const tabUrl = new URL(sender.tab && sender.tab.url || "");
    if (senderUrl.origin !== "http://10.10.10.2" || tabUrl.origin !== "http://10.10.10.2") {
      throw new Error("门户诊断只允许默认校园网认证页");
    }
  } catch (error) {
    if (error && error.message === "门户诊断只允许默认校园网认证页") throw error;
    throw new Error("门户诊断只允许默认校园网认证页");
  }
}
async function restrictLocalStorageAccess() {
  const storage = chrome.storage && chrome.storage.local;
  if (!storage || typeof storage.setAccessLevel !== "function") return false;
  try {
    await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return true;
  } catch (error) {
    return false;
  }
}

async function handleMessage(message, sender) {
  const action = message && message.action;
  const fromWebPage = isWebPageSender(sender);

  if (fromWebPage) {
    if (PORTAL_DIAGNOSTIC_WEB_ACTIONS.has(action)) await validateDefaultPortalDiagnosticsSender(sender);
    await validatePortalSender(sender);
    if (!WEB_PAGE_ACTIONS.has(action)) {
      if (action === "state:get") {
        throw new Error("网页内容脚本不能读取完整扩展状态");
      }
      throw new Error("网页内容脚本无权执行此操作");
    }
  }

  switch (action) {
    case "diagnostics:status":
      return getPortalDiagnosticsStatus();
    case "diagnostics:start":
      return startPortalDiagnosticsSession(message.page || {}, sender);
    case "diagnostics:append":
      return appendPortalDiagnosticRecord(message.sessionId || "", message.record || {});
    case "diagnostics:end":
      return endPortalDiagnosticsSession(message.sessionId || "");
    case "diagnostics:set":
      return setPortalDiagnosticsEnabled(message.enabled === true);
    case "diagnostics:get":
      return readPortalDiagnostics();
    case "diagnostics:export":
      return exportPortalDiagnostics();
    case "diagnostics:clear":
      return clearPortalDiagnostics();
    case "state:get":
      return { ok: true, state: await getState() };

    case "connection:get":
      return { ok: true, connection: await getConnectionState() };

    case "portal:config:get": {
      const state = await getState();
      return {
        ok: true,
        portal: {
          enabled: state.config.ui.modernizePortal !== false,
          title: stringValue(state.config.ui.title).trim() || DEFAULT_STATE.config.ui.title,
          portalUrl: state.config.portalUrl,
          onlineDetailMode: state.config.ui.onlineDetailMode,
          appearance: safePortalAppearance(state.config.ui)
        }
      };
    }

    case "portal:appearance:get": {
      const state = await getState();
      return { ok: true, appearance: publicAppearance(state.config.ui) };
    }

    case "portal:status:get": {
      const result = await checkStatus();
      return {
        state: result.state,
        phase: result.phase,
        message: result.message,
        checkedAt: Date.now(),
        session: result.session || null
      };
    }

    case "account:save": {
      const result = await saveAccount(message.account || {});
      if (message.openOptions) {
        // 抓到真实登录请求后准备打开配置页，此时解除该网关标签页的短时间防跳转。
        await clearSenderTab(sender);
        setTimeout(() => {
          chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
        }, 2000);
      }
      return fromWebPage ? { ok: true, accountId: result.account.id } : result;
    }

    case "account:delete":
      return deleteAccount(message.accountId || "");

    case "account:select":
      return selectAccount(message.accountId || "");

    case "account:network:update": {
      const result = await updateAccountNetwork(message.userAccount || "", message.network || {});
      return fromWebPage ? { ok: result.ok, message: result.message || "" } : result;
    }

    case "requestLog:clear":
      return clearRequestLog();

    case "config:save":
      return saveConfig(message.config || {});

    case "config:reset":
      return resetConfig();

    case "drcom:login":
      await markSenderTab(sender);
      return loginAccount(message.accountId || "", message.account || null, {
        portalPageUrl: fromWebPage ? String(sender.url || "") : ""
      });

    case "drcom:logout":
      return logout();

    case "drcom:status":
      return checkStatus();

    case "redirect:markPortalTab":
      await markSenderTab(sender);
      return { ok: true };

    case "redirect:clearPortalTab":
      await clearSenderTab(sender);
      return { ok: true };

    case "options:open":
      await clearSenderTab(sender);
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      throw new Error(`未知操作：${action || "空"}`);
  }
}
