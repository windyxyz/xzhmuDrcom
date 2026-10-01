(function attachOptionsColorUtils(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DrcomOptionsColorUtils = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  function normalizeHex(value) {
    const raw = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : "";
  }

  function hsvToRgb(h, s, v) {
    const segment = ((h % 360) + 360) % 360 / 60;
    const i = Math.floor(segment);
    const f = segment - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    const map = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
    const [r, g, b] = map[i % 6];
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }

  function hexToRgb(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!match) return null;
    return {
      r: parseInt(match[1].slice(0, 2), 16),
      g: parseInt(match[1].slice(2, 4), 16),
      b: parseInt(match[1].slice(4, 6), 16)
    };
  }

  function rgbToHsv(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = 60 * (((gn - bn) / d) % 6);
      else if (max === gn) h = 60 * ((bn - rn) / d + 2);
      else h = 60 * ((rn - gn) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }

  function hexToHsv(hex) {
    const rgb = hexToRgb(hex);
    return rgb ? rgbToHsv(rgb.r, rgb.g, rgb.b) : null;
  }

  return { normalizeHex, hsvToRgb, rgbToHex, hexToRgb, rgbToHsv, hexToHsv };
});
