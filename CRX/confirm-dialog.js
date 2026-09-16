(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DrcomConfirmDialog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  let defaultController = null;

  function createController(elements, localization = {}) {
    let pendingResolve = null;
    let pendingOptions = null;
    const t = (key) => typeof localization.t === "function"
      ? localization.t(key)
      : root.DrcomI18n?.t?.(key) || key;

    function render(options = pendingOptions || {}) {
      elements.title.textContent = options.title || t("confirm_default_title");
      elements.message.textContent = options.message || t("confirm_default_message");
      elements.confirmButton.textContent = options.confirmLabel || t("confirm_default_action");
      elements.cancelButton.textContent = options.cancelLabel || t("cancel");
    }

    function finish(value) {
      if (!pendingResolve) return;
      const resolve = pendingResolve;
      pendingResolve = null;
      pendingOptions = null;
      if (elements.dialog.open) elements.dialog.close();
      resolve(value);
    }

    elements.cancelButton.addEventListener("click", () => finish(false));
    elements.confirmButton.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      finish(true);
    });
    elements.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    elements.dialog.addEventListener("close", () => finish(false));
    elements.dialog.addEventListener("click", (event) => {
      if (event.target === elements.dialog) finish(false);
    });

    return {
      ask(options = {}) {
        if (pendingResolve) return Promise.resolve(false);
        pendingOptions = options;
        render(options);

        const answer = new Promise((resolve) => {
          pendingResolve = resolve;
        });
        elements.dialog.showModal();
        elements.cancelButton.focus();
        return answer;
      },
      setLanguage(preference) {
        localization.setLanguage?.(preference);
        if (pendingResolve) render();
        else elements.cancelButton.textContent = t("cancel");
      }
    };
  }

  function buildDialog(documentObject) {
    const dialog = documentObject.createElement("dialog");
    const surface = documentObject.createElement("div");
    const title = documentObject.createElement("h2");
    const message = documentObject.createElement("p");
    const actions = documentObject.createElement("div");
    const cancelButton = documentObject.createElement("button");
    const confirmButton = documentObject.createElement("button");

    dialog.className = "confirm-dialog";
    dialog.setAttribute("aria-labelledby", "drcom-confirm-title");
    dialog.setAttribute("aria-describedby", "drcom-confirm-message");
    surface.className = "confirm-dialog-surface";
    title.id = "drcom-confirm-title";
    message.id = "drcom-confirm-message";
    actions.className = "confirm-dialog-actions";
    cancelButton.type = "button";
    cancelButton.className = "confirm-dialog-cancel";
    cancelButton.textContent = root.DrcomI18n?.t?.("cancel") || "取消";
    cancelButton.autofocus = true;
    confirmButton.type = "button";
    confirmButton.className = "confirm-dialog-danger";
    actions.append(cancelButton, confirmButton);
    surface.append(title, message, actions);
    dialog.append(surface);
    documentObject.body.append(dialog);

    return { cancelButton, confirmButton, dialog, message, title };
  }

  function ask(options) {
    if (!defaultController) {
      defaultController = createController(buildDialog(document));
    }
    return defaultController.ask(options);
  }

  root.chrome?.runtime?.onMessage?.addListener?.((message, sender) => {
    if (sender?.id && sender.id !== root.chrome.runtime.id) return;
    if (message?.action !== "language:changed") return;
    root.DrcomI18n?.setLanguage?.(message.preference);
    defaultController?.setLanguage(message.preference);
  });

  return { ask, buildDialog, createController };
});
