"use strict";

const previewRoot = document.getElementById("drcom-modern-root");

previewRoot.innerHTML = globalThis.DrcomPortalUI.renderPortalMarkup({
  title: "徐医校园网",
  online: false
});

globalThis.DrcomAppearance.applyToRoot(previewRoot, {
  theme: "system",
  accent: "#007aff",
  background: "fresh"
});

const previewFrame = previewRoot.querySelector("[data-characters]");
if (previewFrame && globalThis.DrcomCharacters) {
  globalThis.DrcomCharacters.mount(previewFrame, { interactive: true });
}

previewRoot.querySelector("#drcom-login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const status = previewRoot.querySelector("#drcom-form-status");
  status.textContent = "这是界面预览，不会发送登录请求。";
  status.dataset.state = "progress";
});

previewRoot.querySelector("#drcom-restore-original").addEventListener("click", () => {
  const status = previewRoot.querySelector("#drcom-form-status");
  status.textContent = "正式接管页面中，这里会立即恢复学校原始登录页。";
  status.dataset.state = "progress";
});
