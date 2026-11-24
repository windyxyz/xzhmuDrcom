"use strict";

const previewRoot = document.getElementById("drcom-modern-root");
const previewI18n = globalThis.DrcomI18n;
const previewUi = globalThis.DrcomPortalUI;
let previewCharacters = null;

if (previewI18n) previewI18n.setLanguage("zh-CN");
if (previewUi) previewUi.setLanguage("zh-CN");

previewRoot.innerHTML = previewUi.renderPortalMarkup({
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
  previewCharacters = globalThis.DrcomCharacters.mount(previewFrame, { interactive: true });
}

const previewUsername = previewRoot.querySelector("#drcom-username");
const previewPassword = previewRoot.querySelector("#drcom-password");
const previewToggle = previewRoot.querySelector("#drcom-password-toggle");
const previewStatus = previewRoot.querySelector("#drcom-form-status");
let previewPasswordFocused = false;
let previewSadTimer = 0;

function setPreviewCharacterMode(next) {
  if (!previewCharacters) return;
  if (previewSadTimer) {
    clearTimeout(previewSadTimer);
    previewSadTimer = 0;
  }
  previewCharacters.setState(next);
}

function previewCharacterState() {
  const visible = previewToggle?.getAttribute("aria-pressed") === "true";
  if (previewPasswordFocused || (previewPassword && previewPassword.value)) {
    return visible ? "visible" : "hiding";
  }
  return "idle";
}

function syncPreviewCharacters() {
  setPreviewCharacterMode(previewCharacterState());
}

previewUsername?.addEventListener("focus", () => setPreviewCharacterMode("typing"));
previewUsername?.addEventListener("input", () => setPreviewCharacterMode("typing"));
previewUsername?.addEventListener("blur", syncPreviewCharacters);
previewPassword?.addEventListener("focus", () => {
  previewPasswordFocused = true;
  setPreviewCharacterMode(previewCharacterState());
});
["input", "change", "keyup"].forEach((type) => {
  previewPassword?.addEventListener(type, syncPreviewCharacters);
});
previewPassword?.addEventListener("blur", () => {
  previewPasswordFocused = false;
  syncPreviewCharacters();
});

previewToggle?.addEventListener("click", () => {
  if (!previewPassword) return;
  const show = previewPassword.type === "password";
  previewPassword.type = show ? "text" : "password";
  previewToggle.setAttribute("aria-pressed", show ? "true" : "false");
  if (previewI18n) {
    previewToggle.setAttribute("aria-label", show ? previewI18n.t("portal_hide_password") : previewI18n.t("reveal_password"));
  }
  const glyph = previewToggle.querySelector(".win-glyph");
  if (glyph) glyph.textContent = show ? "\uE7B3" : "\uE890";
  syncPreviewCharacters();
});

previewRoot.querySelector("#drcom-reset")?.addEventListener("click", (event) => {
  event.preventDefault();
  if (previewUsername) previewUsername.value = "";
  const suffix = previewRoot.querySelector("#drcom-suffix");
  if (suffix) suffix.value = "";
  if (previewPassword) {
    previewPassword.value = "";
    previewPassword.type = "password";
  }
  const remember = previewRoot.querySelector("#drcom-remember");
  if (remember) remember.checked = true;
  if (previewToggle) {
    previewToggle.setAttribute("aria-pressed", "false");
    if (previewI18n) previewToggle.setAttribute("aria-label", previewI18n.t("reveal_password"));
    const glyph = previewToggle.querySelector(".win-glyph");
    if (glyph) glyph.textContent = "\uE890";
  }
  previewPasswordFocused = false;
  if (previewStatus) {
    previewStatus.textContent = "";
    previewStatus.dataset.state = "";
  }
  setPreviewCharacterMode("idle");
});

previewRoot.querySelector("#drcom-language-toggle")?.addEventListener("click", () => {
  if (!previewI18n) return;
  const next = previewI18n.getLanguage() === "zh-CN" ? "en" : "zh-CN";
  previewI18n.setLanguage(next);
  if (previewUi) previewUi.setLanguage(next);
  document.documentElement.lang = next;
  previewI18n.apply(previewRoot, next);
  const brandTitle = previewRoot.querySelector("#drcom-brand-title");
  const loginTitle = previewRoot.querySelector("#drcom-login-title");
  const localizedTitle = previewUi.localizeTitle("徐医校园网");
  if (brandTitle) brandTitle.textContent = localizedTitle;
  if (loginTitle) loginTitle.textContent = localizedTitle;
  const brandContext = previewRoot.querySelector("#drcom-brand-context");
  if (brandContext) brandContext.textContent = previewI18n.t("portal_brand_context", ["10.10.10.2"]);
  if (previewToggle?.getAttribute("aria-pressed") === "true") {
    previewToggle.setAttribute("aria-label", previewI18n.t("portal_hide_password"));
  }
});

previewRoot.querySelector("#drcom-login-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const hasCreds = Boolean(previewUsername?.value?.trim() && previewPassword?.value);
  if (!hasCreds) {
    setPreviewCharacterMode("sad");
    previewSadTimer = setTimeout(() => {
      previewSadTimer = 0;
      syncPreviewCharacters();
    }, 3000);
    previewStatus.textContent = previewI18n?.getLanguage() === "en"
      ? "Enter an account and password to preview sign-in feedback."
      : "请输入账号和密码以预览登录反馈。";
    previewStatus.dataset.state = "error";
    return;
  }
  setPreviewCharacterMode("happy");
  previewStatus.textContent = previewI18n?.getLanguage() === "en"
    ? "Preview mode: no real sign-in request is sent."
    : "这是界面预览，不会发送登录请求。";
  previewStatus.dataset.state = "progress";
});

previewRoot.querySelector("#drcom-restore-original")?.addEventListener("click", () => {
  previewStatus.textContent = previewI18n?.getLanguage() === "en"
    ? "In a live portal page, this restores the original campus login page."
    : "正式接管页面中，这里会立即恢复学校原始登录页。";
  previewStatus.dataset.state = "progress";
});
