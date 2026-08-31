"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const appearance = require("../CRX/appearance.js");

test("外观配置会拒绝不安全背景并把数值限制在可读范围", () => {
  const normalized = appearance.normalizeAppearance({
    theme: "neon",
    accent: "red",
    background: "custom",
    backgroundImage: "javascript:alert(1)",
    backgroundBlur: 999,
    backgroundDim: -1,
    backgroundScale: 9
  });

  assert.deepEqual(normalized, {
    theme: "system",
    accent: "#007aff",
    background: "fresh",
    backgroundImage: "",
    backgroundBlur: 32,
    backgroundDim: 0.2,
    backgroundScale: 1.15
  });
});

test("自定义背景尊重手动主题并把外观值应用到页面根节点", () => {
  const values = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty(name, value) {
        values.set(name, value);
      }
    }
  };

  const result = appearance.applyToRoot(root, {
    theme: "light",
    accent: "#2563eb",
    background: "custom",
    backgroundImage: "data:image/webp;base64,AAAA",
    backgroundBlur: 18,
    backgroundDim: 0.46,
    backgroundScale: 1.06
  });

  assert.equal(root.dataset.theme, "light");
  assert.equal(root.dataset.appearanceBackground, "custom");
  assert.equal(values.get("--appearance-accent"), "#2563eb");
  assert.equal(values.get("--appearance-image"), 'url("data:image/webp;base64,AAAA")');
  assert.equal(values.get("--appearance-blur"), "18px");
  assert.equal(values.get("--appearance-dim"), "0.46");
  assert.equal(values.get("--appearance-scale"), "1.06");
  assert.equal(result.effectiveTheme, "light");
});
