(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DrcomConfirmDialog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  let defaultController = null;

  function createController(elements) {
    let pendingResolve = null;

    function finish(value) {
      if (!pendingResolve) return;
      const resolve = pendingResolve;
      pendingResolve = null;
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
        elements.title.textContent = options.title || "确认操作？";
        elements.message.textContent = options.message || "此操作可能无法撤销。";
        elements.confirmButton.textContent = options.confirmLabel || "确认";

        const answer = new Promise((resolve) => {
          pendingResolve = resolve;
        });
        elements.dialog.showModal();
        elements.cancelButton.focus();
        return answer;
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
    cancelButton.textContent = "取消";
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

  return { ask, buildDialog, createController };
});
