"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const extensionRoot = join(root, "CRX");

function readExtensionFile(path) {
  // 契约断言常嵌入精确源码片段；Windows 检出默认 CRLF 会破坏含 \n 的多行模板，统一按 LF 读取。
  return readFileSync(join(extensionRoot, path), "utf8").replace(/\r\n/g, "\n");
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

test("Firefox manifest 引用的全部本地文件都存在", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.firefox.json"));
  const paths = [
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap((script) => [...script.css, ...script.js])
  ];
  assert.deepEqual(paths.filter((path) => !existsSync(join(extensionRoot, path))), []);
});

test("welcome.js 引用的必需元素都存在于欢迎页", () => {
  const source = readExtensionFile("welcome.js");
  const referenced = new Set(Array.from(
    source.matchAll(/getElementById[(]"([^"]+)"[)]/g),
    (match) => match[1]
  ));
  const declared = declaredElementIds(readExtensionFile("welcome.html"));
  assert.deepEqual(Array.from(referenced).filter((id) => !declared.has(id)), []);
});

test("默认门户可读取扩展内置图标字体且公开范围仅限网关", () => {
  const expected = [{
    resources: ["fonts/segoe-fluent-icons.ttf"],
    matches: ["http://10.10.10.2/*", "https://10.10.10.2/*"]
  }];
  for (const fileName of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(readExtensionFile(fileName));
    assert.deepEqual(manifest.web_accessible_resources, expected, fileName);
  }
  assert.equal(existsSync(join(extensionRoot, "fonts", "segoe-fluent-icons.ttf")), true);
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
    "account-utils.js",
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

test("portal diagnostics controls live inside advanced settings", () => {
  const source = readExtensionFile("options.html");
  const advanced = descendantIds(source, "advanced-settings");
  for (const id of [
    "portal-diagnostics-enabled",
    "portal-diagnostics-status",
    "portal-diagnostics-storage",
    "portal-diagnostics-sessions",
    "portal-diagnostics-dropped",
    "export-portal-diagnostics",
    "clear-portal-diagnostics"
  ]) {
    assert.ok(advanced.has(id), `${id} must be inside advanced settings`);
  }
});

test("portal diagnostics card exposes live status, privacy warning, and keyboard actions", () => {
  const source = readExtensionFile("options.html");
  assert.match(source, /class="diagnostics-card"[^>]*aria-labelledby="portal-diagnostics-title"/);
  assert.match(source, /仅在本机记录脱敏后的页面结构和操作类型/);
  assert.match(source, /id="portal-diagnostics-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /<button[^>]*id="export-portal-diagnostics"[^>]*type="button"/);
  assert.match(source, /<button[^>]*id="clear-portal-diagnostics"[^>]*type="button"/);
  const styles = readExtensionFile("options.css");
  assert.match(styles, /diagnostics-card/);
  assert.match(styles, /diagnostics-actions button[^}]*min-height: 44px/);
  assert.match(styles, /\.switch\s*\{[^}]*min-height:\s*44px/);
  assert.match(styles, /\.switch input\[type="checkbox"\]\s*\{[^}]*width:\s*40px/);
  assert.match(styles, /\.switch input\[type="checkbox"\]\s*\{[^}]*height:\s*20px/);
  assert.match(styles, /border-radius:\s*10px/);
  assert.match(styles, /prefers-reduced-motion/);
});

test("正式界面使用功能性玻璃层并提供降级与减弱透明度支持", () => {
  const tokens = readExtensionFile("design-tokens.css");
  const options = readExtensionFile("options.html");
  assert.match(tokens, /--flyout-bg:/);
  assert.match(tokens, /@supports not\s*\(/);
  assert.match(tokens, /prefers-reduced-transparency/);
  assert.match(options, /class="[^"]*settings-sidebar/);
  assert.doesNotMatch(options, /traffic-light|window-controls|window-dot/);
});

test("设置页采用带无障碍字形图标的系统分类侧栏与连接概览", () => {
  const source = readExtensionFile("options.html");
  assert.match(source, /id="connection-overview"/);
  assert.match(source, /id="test-connection"/);
  assert.match(source, /id="settings-connection-status"[^>]*aria-live="polite"/);
  const sidebar = source.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.equal((sidebar.match(/<button type="button" class="win-nav-item" data-settings-target=/g) || []).length, 5);
  assert.equal((sidebar.match(/data-glyph="/g) || []).length, 5);
  assert.equal((sidebar.match(/class="nav-icon win-glyph"/g) || []).length, 5);
  assert.doesNotMatch(sidebar, /[●↻◐⋯]/);
  assert.doesNotMatch(source, /class="sidebar-mark"|>XM</);
  assert.doesNotMatch(source, /class="[^"]*tone-/);
  assert.doesNotMatch(source, /<svg/);
});

test("设置页提供四种固定的在线信息显示模式", () => {
  const html = readExtensionFile("options.html");
  const select = html.match(/<select id="online-detail-mode">([\s\S]*?)<\/select>/)?.[1] || "";
  assert.deepEqual(
    [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
    ["classic", "full", "minimal", "hidden"]
  );
});

test("设置页提供自动同步、立即同步和安全重载控件", () => {
  const source = readExtensionFile("options.html");
  assert.match(source, /id="auto-refresh-settings"[^>]*type="checkbox"[^>]*checked/);
  assert.match(source, /id="refresh-settings"[^>]*><span class="win-glyph win-glyph--16" aria-hidden="true">&#xE72C;<\/span><span[^>]*data-i18n="sync_now"[^>]*>立即同步<\/span>/);
  assert.match(source, /id="reload-settings-page"[^>]*>重新加载页面</);
  assert.match(source, /id="settings-refresh-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("设置页刷新控制器作为独立模块先于 options.js 加载", () => {
  const source = readExtensionFile("options.html");
  assert.match(readExtensionFile("options-refresh-controller.js"), /DrcomOptionsRefresh/);
  assert.match(source, /<script src="options-refresh-controller\.js"><\/script>\s*<script src="options-account-capture-controller\.js"><\/script>\s*<script src="options\.js"><\/script>/);
});
test("设置页捕获确认控制器作为独立模块先于 options.js 加载", () => {
  const source = readExtensionFile("options.html");
  assert.match(readExtensionFile("options-account-capture-controller.js"), /DrcomOptionsAccountCapture/);
  assert.match(source, /<script src="options-account-capture-controller\.js"><\/script>\s*<script src="options\.js"><\/script>/);
});
test("设置页外观图片工具作为独立模块先于 options.js 加载", () => {
  const source = readExtensionFile("options.html");
  assert.match(readExtensionFile("options-appearance-images.js"), /DrcomOptionsAppearanceImages/);
  assert.match(source, /<script src="options-appearance-images\.js"><\/script>\s*<script src="options-refresh-controller\.js"><\/script>/);
});
test("门户共享令牌和纯逻辑模块在内容脚本之前加载", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const portalScript = manifest.content_scripts[0];
  assert.deepEqual(portalScript.css, ["design-tokens.css", "portal.css"]);
  assert.deepEqual(portalScript.js, [
    "account-utils.js",
    "portal-session.js",
    "appearance.js",
    "animated-characters.js",
    "portal-ui.js",
    "portal-capture.js",
    "confirm-dialog.js",
    "portal-diagnostics-utils.js",
    "portal-diagnostics.js",
    "portal-modernizer.js"
  ]);
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

test("异步壁纸回调、门户孤儿提示和清理逻辑保持防御性", () => {
  const welcome = readExtensionFile("welcome.js");
  const modernizer = readExtensionFile("portal-modernizer.js");
  assert.ok(welcome.includes("chrome.runtime.lastError"));
  assert.ok(modernizer.includes("xzhmu徐医校园网 已更新"));
  assert.equal(modernizer.includes("context invalidated|Extension context|Cannot read"), false);
  const removeModernPortal = modernizer.slice(
    modernizer.indexOf("function removeModernPortal()"),
    modernizer.indexOf("function showCaptchaFallbackHint()")
  );
  assert.ok(removeModernPortal.includes("clearTimeout(sadRevertTimer)"));
});

test("动画和侧栏交互会完整清理临时状态", () => {
  const characters = readExtensionFile("animated-characters.js");
  const options = readExtensionFile("options.js");
  assert.ok(characters.includes("timers.delete(id)"));
  assert.ok(characters.includes("timers.clear()"));
  assert.ok(
    characters.includes(
      'if (typeof window !== "undefined") {\n          if (interactive) window.removeEventListener("mousemove", onMouseMove);\n          window.removeEventListener("resize", handleResize);\n        }'
    )
  );
  assert.ok(options.includes('button.addEventListener("pointercancel"'));
});

test("会切换 hidden 属性的页面都提供强制隐藏样式", () => {
  for (const fileName of ["popup.css", "welcome.css", "portal.css"]) {
    assert.ok(readExtensionFile(fileName).includes("[hidden] { display: none !important; }"), fileName);
  }
});
