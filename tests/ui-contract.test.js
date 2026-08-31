"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const extensionRoot = join(root, "CRX");

function readExtensionFile(path) {
  return readFileSync(join(extensionRoot, path), "utf8");
}

function referencedElementIds(source) {
  return new Set(Array.from(source.matchAll(/\$\("([^"]+)"\)/g), (match) => match[1]));
}

function declaredElementIds(source) {
  return new Set(Array.from(source.matchAll(/\bid=["']([^"']+)["']/g), (match) => match[1]));
}

function descendantIds(source, containerId) {
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack = [];
  const ids = new Set();
  let targetDepth = null;
  const tagPattern = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi;

  for (const match of source.matchAll(tagPattern)) {
    const token = match[0];
    const tag = match[1].toLowerCase();
    const closing = token.startsWith("</");
    if (closing) {
      if (targetDepth !== null && stack.length === targetDepth && stack.at(-1)?.id === containerId) {
        targetDepth = null;
      }
      stack.pop();
      continue;
    }

    const id = token.match(/\bid=["']([^"']+)["']/i)?.[1] || "";
    if (targetDepth !== null && id) ids.add(id);
    if (!voidElements.has(tag) && !token.endsWith("/>")) {
      stack.push({ tag, id });
      if (id === containerId) targetDepth = stack.length;
    }
  }

  return ids;
}

for (const page of ["popup", "options"]) {
  test(`${page}.js 引用的元素都存在于对应 HTML`, () => {
    const referenced = referencedElementIds(readExtensionFile(`${page}.js`));
    const declared = declaredElementIds(readExtensionFile(`${page}.html`));
    const missing = Array.from(referenced).filter((id) => !declared.has(id));
    assert.deepEqual(missing, []);
  });
}

test("manifest 引用的本地入口文件都存在", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const paths = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((script) => [...script.css, ...script.js])
  ];
  const missing = paths.filter((path) => !existsSync(join(extensionRoot, path)));
  assert.deepEqual(missing, []);
});

test("扩展版本与开发元数据保持一致", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, packageJson.version);
});

test("首次安装体验和共享视觉资产会随扩展打包", () => {
  const required = [
    "welcome.html",
    "welcome.css",
    "welcome.js",
    "appearance.js",
    "design-tokens.css"
  ];
  const missing = required.filter((path) => !existsSync(join(extensionRoot, path)));
  assert.deepEqual(missing, []);
});

test("扩展页面在页面样式前加载共享设计令牌", () => {
  const pages = [
    ["popup.html", "popup.css"],
    ["options.html", "options.css"],
    ["welcome.html", "welcome.css"]
  ];
  const invalid = pages.filter(([html, pageCss]) => {
    if (!existsSync(join(extensionRoot, html))) return true;
    const source = readExtensionFile(html);
    const tokensIndex = source.indexOf('href="design-tokens.css"');
    const pageIndex = source.indexOf(`href="${pageCss}"`);
    return tokensIndex < 0 || pageIndex < 0 || tokensIndex > pageIndex;
  });
  assert.deepEqual(invalid, []);
});

test("设置页把低频配置统一放进高级设置", () => {
  const source = readExtensionFile("options.html");
  const advanced = descendantIds(source, "advanced-settings");
  const lowFrequency = [
    "portal-url",
    "api-url",
    "default-ip",
    "default-mac",
    "raw-url",
    "return-to-portal",
    "guard-seconds",
    "modernize-portal",
    "request-log",
    "clear-request-log",
    "reset-config",
    "interval-minutes",
    "interval-seconds"
  ];
  const common = [
    "account-list",
    "account-form",
    "login-on-startup",
    "keep-alive"
  ];

  assert.deepEqual(lowFrequency.filter((id) => !advanced.has(id)), []);
  assert.deepEqual(common.filter((id) => advanced.has(id)), []);
});

test("正式界面使用功能性玻璃层并提供降级与减弱透明度支持", () => {
  const tokens = readExtensionFile("design-tokens.css");
  const options = readExtensionFile("options.html");
  assert.match(tokens, /--glass-fill:/);
  assert.match(tokens, /@supports not\s*\(/);
  assert.match(tokens, /prefers-reduced-transparency/);
  assert.match(options, /class="[^"]*settings-sidebar/);
  assert.doesNotMatch(options, /traffic-light|window-controls|window-dot/);
});

test("设置页采用带无障碍 SVG 图标的系统分类侧栏与连接概览", () => {
  const source = readExtensionFile("options.html");
  assert.match(source, /id="connection-overview"/);
  assert.match(source, /id="test-connection"/);
  assert.match(source, /id="settings-connection-status"[^>]*aria-live="polite"/);
  const sidebar = source.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.equal((sidebar.match(/<button type="button" data-settings-target=/g) || []).length, 5);
  assert.equal((sidebar.match(/<svg[^>]*aria-hidden="true"/g) || []).length, 5);
  assert.doesNotMatch(sidebar, /[●↻◐⋯]/);
  assert.doesNotMatch(source, /class="sidebar-mark"|>XM</);
});

test("门户共享令牌和纯逻辑模块在内容脚本之前加载", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const portalScript = manifest.content_scripts[0];
  assert.deepEqual(portalScript.css, ["design-tokens.css", "portal.css"]);
  assert.deepEqual(portalScript.js, ["appearance.js", "portal-ui.js", "portal-modernizer.js"]);
});

test("弹窗状态更新可被辅助技术感知且刷新操作有明确名称", () => {
  const source = readExtensionFile("popup.html");
  assert.match(
    source,
    /<section[^>]*id="status-panel"[^>]*role="status"[^>]*aria-live="polite"/
  );
  assert.match(
    source,
    /<button[^>]*id="refresh-status"[^>]*aria-label="刷新连接状态"/
  );
});
