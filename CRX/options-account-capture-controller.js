"use strict";

(() => {
  function createPendingAccountCaptureController(deps) {
    let pendingAccountCaptureId = "";
    let pendingCapture = null;
    const $ = deps.$;
    const t = deps.t || ((key) => ({
      capture_unknown_source: "未知来源",
      capture_replace_impact: "确认后会覆盖同账号已有凭据。",
      capture_add_impact: "确认后会新增一个本地账号。",
      capture_saved: "门户账号已保存",
      capture_discarded: "已丢弃门户账号候选"
    })[key] || key);

    function render() {
      if (!pendingCapture) return;
      $("capture-source").textContent = String(pendingCapture.sourceOrigin || t("capture_unknown_source"));
      $("capture-account").textContent = `${String(pendingCapture.maskedUsername || "****")}${String(pendingCapture.suffix || "")}`;
      $("capture-impact").textContent = pendingCapture.replacesExisting
        ? t("capture_replace_impact")
        : t("capture_add_impact");
    }

    async function load() {
      const card = $("capture-confirmation");
      if (!card) return;
      const response = await deps.sendMessage({ action: "account:capture:get" });
      const capture = response && response.capture;
      if (!capture || Number(capture.expiresAt) <= Date.now()) {
        pendingAccountCaptureId = "";
        pendingCapture = null;
        card.hidden = true;
        return;
      }
      pendingAccountCaptureId = String(capture.id || "");
      pendingCapture = capture;
      render();
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
      pendingCapture = null;
      $("capture-confirmation").hidden = true;
      if (response && response.state && $("account-list")) {
        deps.setState(response.state);
        deps.renderAccounts();
      }
      deps.toast(t("capture_saved"));
    }

    async function discard() {
      if (pendingAccountCaptureId) {
        await deps.sendMessage({
          action: "account:capture:discard",
          captureId: pendingAccountCaptureId
        });
      }
      pendingAccountCaptureId = "";
      pendingCapture = null;
      $("capture-confirmation").hidden = true;
      deps.toast(t("capture_discarded"));
    }

    return {
      commit,
      discard,
      load,
      render,
      pendingCaptureId: () => pendingAccountCaptureId
    };
  }

  globalThis.DrcomOptionsAccountCapture = {
    createPendingAccountCaptureController
  };
  globalThis.createPendingAccountCaptureController = createPendingAccountCaptureController;
})();
