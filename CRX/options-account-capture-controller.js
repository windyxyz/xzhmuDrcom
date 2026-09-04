"use strict";

(() => {
  function createPendingAccountCaptureController(deps) {
    let pendingAccountCaptureId = "";
    const $ = deps.$;

    async function load() {
      const card = $("capture-confirmation");
      if (!card) return;
      const response = await deps.sendMessage({ action: "account:capture:get" });
      const capture = response && response.capture;
      if (!capture || Number(capture.expiresAt) <= Date.now()) {
        pendingAccountCaptureId = "";
        card.hidden = true;
        return;
      }
      pendingAccountCaptureId = String(capture.id || "");
      $("capture-source").textContent = String(capture.sourceOrigin || "未知来源");
      $("capture-account").textContent = `${String(capture.maskedUsername || "****")}${String(capture.suffix || "")}`;
      $("capture-impact").textContent = capture.replacesExisting
        ? "确认后会覆盖同账号已有凭据。"
        : "确认后会新增一个本地账号。";
      card.hidden = false;
      $("capture-discard")?.focus();
    }

    async function commit() {
      if (!pendingAccountCaptureId) return;
      const response = await deps.sendMessage({
        action: "account:capture:commit",
        captureId: pendingAccountCaptureId
      });
      pendingAccountCaptureId = "";
      $("capture-confirmation").hidden = true;
      if (response && response.state && $("account-list")) {
        deps.setState(response.state);
        deps.renderAccounts();
      }
      deps.toast("门户账号已保存");
    }

    async function discard() {
      if (pendingAccountCaptureId) {
        await deps.sendMessage({
          action: "account:capture:discard",
          captureId: pendingAccountCaptureId
        });
      }
      pendingAccountCaptureId = "";
      $("capture-confirmation").hidden = true;
      deps.toast("已丢弃门户账号候选");
    }

    return {
      commit,
      discard,
      load,
      pendingCaptureId: () => pendingAccountCaptureId
    };
  }

  globalThis.DrcomOptionsAccountCapture = {
    createPendingAccountCaptureController
  };
  globalThis.createPendingAccountCaptureController = createPendingAccountCaptureController;
})();
