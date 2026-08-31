(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DrcomAppearance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = Object.freeze({
    theme: "system",
    accent: "#007aff",
    background: "fresh",
    backgroundImage: "",
    backgroundBlur: 14,
    backgroundDim: 0.42,
    backgroundScale: 1.04
  });

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function normalizeImage(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 6000000) return "";
    if (/^data:image\/(?:png|jpe?g|webp|avif);base64,[a-z0-9+/=]+$/i.test(raw)) return raw;
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
    } catch (error) {
      return "";
    }
  }

  function normalizeAppearance(input = {}) {
    const theme = ["system", "light", "dark"].includes(input.theme) ? input.theme : DEFAULTS.theme;
    const accent = /^#[0-9a-f]{6}$/i.test(String(input.accent || "")) ? String(input.accent) : DEFAULTS.accent;
    const backgroundImage = normalizeImage(input.backgroundImage);
    const background = input.background === "custom" && backgroundImage ? "custom" : "fresh";
    return {
      theme,
      accent,
      background,
      backgroundImage: background === "custom" ? backgroundImage : "",
      backgroundBlur: clamp(input.backgroundBlur, 0, 32, DEFAULTS.backgroundBlur),
      backgroundDim: clamp(input.backgroundDim, 0.2, 0.72, DEFAULTS.backgroundDim),
      backgroundScale: clamp(input.backgroundScale, 1, 1.15, DEFAULTS.backgroundScale)
    };
  }

  function applyToRoot(rootElement, input) {
    const normalized = normalizeAppearance(input);
    const effectiveTheme = normalized.theme;
    if (!rootElement || !rootElement.dataset || !rootElement.style) {
      return { ...normalized, effectiveTheme };
    }

    if (effectiveTheme === "system") delete rootElement.dataset.theme;
    else rootElement.dataset.theme = effectiveTheme;
    rootElement.dataset.appearanceBackground = normalized.background;
    rootElement.style.setProperty("color-scheme", effectiveTheme === "system" ? "light dark" : effectiveTheme);
    rootElement.style.setProperty("--appearance-accent", normalized.accent);
    rootElement.style.setProperty("--appearance-image", normalized.backgroundImage ? `url("${normalized.backgroundImage}")` : "none");
    rootElement.style.setProperty("--appearance-blur", `${normalized.backgroundBlur}px`);
    rootElement.style.setProperty("--appearance-dim", String(normalized.backgroundDim));
    rootElement.style.setProperty("--appearance-scale", String(normalized.backgroundScale));
    return { ...normalized, effectiveTheme };
  }

  return { DEFAULTS, normalizeAppearance, applyToRoot };
});
