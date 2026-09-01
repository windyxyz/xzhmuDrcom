"use strict";

const assert = require("node:assert/strict");
const { existsSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { cleanupBrowserProfile } = require("../scripts/browser-test-process.js");

function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];

  return candidates.find((path) => path && existsSync(path));
}

function waitForDebugger(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("浏览器调试端口启动超时")), 10_000);
    let output = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`浏览器提前退出，退出码 ${code}`));
    });
  });
}

async function waitForPage(port, pageName = "welcome.html") {
  const endpoint = `http://127.0.0.1:${port}/json/list`;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pages = await fetch(endpoint).then((response) => response.json());
    const page = pages.find((entry) => entry.type === "page" && entry.url.includes(pageName));
    if (page) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("未找到欢迎页浏览器目标");
}

function evaluateAtViewport(webSocketUrl, width, height, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("读取浏览器计算布局超时"));
    }, 10_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Emulation.setDeviceMetricsOverride",
        params: { width, height, deviceScaleFactor: 1, mobile: true }
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        if (message.error) {
          clearTimeout(timeout);
          socket.close();
          reject(new Error(message.error.message));
          return;
        }
        socket.send(JSON.stringify({
          id: 2,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true }
        }));
        return;
      }
      if (message.id !== 2) return;
      clearTimeout(timeout);
      socket.close();
      if (message.result.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text));
        return;
      }
      resolve(message.result.result.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("无法连接浏览器调试目标"));
    });
  });
}

test("375px 视口下步骤编号留在第一列且标题保持横排", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器布局测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器布局测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-welcome-layout-"));
  const welcomeUrl = pathToFileURL(join(__dirname, "..", "CRX", "welcome.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=375,812",
    welcomeUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port);
    const layout = await evaluateAtViewport(pageUrl, 375, 812, `(async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = document.querySelector('.setup-steps li');
        if (candidate && getComputedStyle(candidate).display === 'grid') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const item = document.querySelector('.setup-steps li');
      const number = item.querySelector('.step-number');
      const title = item.querySelector('strong');
      const welcomeTitle = document.querySelector('#welcome-title');
      const welcomeShellStyle = getComputedStyle(document.querySelector('.welcome-shell'));
      const numberRect = number.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const welcomeTitleRect = welcomeTitle.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        itemDisplay: getComputedStyle(item).display,
        numberColumn: getComputedStyle(number).gridColumnStart,
        numberRight: numberRect.right,
        titleLeft: titleRect.left,
        titleWidth: titleRect.width,
        titleHeight: titleRect.height,
        welcomeTitleWidth: welcomeTitleRect.width,
        welcomeTitleHeight: welcomeTitleRect.height,
        motionTiming: welcomeShellStyle.animationTimingFunction,
        motionDuration: welcomeShellStyle.animationDuration
      };
    })()`);

    assert.equal(layout.viewportWidth, 375, `浏览器测试视口应为 375px：${JSON.stringify(layout)}`);
    assert.equal(layout.itemDisplay, "grid", `欢迎页样式表没有成功应用：${JSON.stringify(layout)}`);
    assert.equal(layout.numberColumn, "1");
    assert.ok(layout.titleLeft >= layout.numberRight, `标题应位于编号右侧：${JSON.stringify(layout)}`);
    assert.ok(layout.titleWidth >= 100, `标题不应被压成竖排：${JSON.stringify(layout)}`);
    assert.ok(layout.titleHeight <= 30, `标题应保持单行：${JSON.stringify(layout)}`);
    assert.ok(layout.welcomeTitleHeight <= 70, `欢迎主标题不应留下单字孤行：${JSON.stringify(layout)}`);
    assert.equal(layout.motionTiming, "cubic-bezier(0.2, 0.8, 0.2, 1)");
    assert.equal(layout.motionDuration, "0.24s");
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("390px 视口下设置页单列排版且没有横向溢出", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器布局测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器布局测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-options-layout-"));
  const optionsUrl = pathToFileURL(join(__dirname, "..", "CRX", "options.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=390,844",
    optionsUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "options.html");
    const layout = await evaluateAtViewport(pageUrl, 390, 844, `(async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const shell = document.querySelector('.settings-shell');
        const appearance = document.querySelector('.appearance-layout');
        if (shell && appearance && getComputedStyle(shell).animationDuration === '0.24s' && getComputedStyle(appearance).display === 'grid') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const section = document.querySelector('.settings-section');
      const appearance = document.querySelector('.appearance-layout');
      const shellStyle = getComputedStyle(document.querySelector('.settings-shell'));
      const sectionRect = section.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sectionLeft: sectionRect.left,
        sectionRight: sectionRect.right,
        appearanceColumns: getComputedStyle(appearance).gridTemplateColumns,
        backgroundTuningDisplay: getComputedStyle(document.querySelector('#background-controls')).display,
        motionTiming: shellStyle.animationTimingFunction,
        motionDuration: shellStyle.animationDuration
      };
    })()`);

    assert.equal(layout.viewportWidth, 390, `浏览器测试视口应为 390px：${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.viewportWidth, `设置页不应横向溢出：${JSON.stringify(layout)}`);
    assert.ok(layout.sectionLeft >= 0 && layout.sectionRight <= layout.viewportWidth, `设置卡片应完整留在视口内：${JSON.stringify(layout)}`);
    assert.equal(layout.appearanceColumns.split(" ").length, 1, `外观区在手机上应为单列：${JSON.stringify(layout)}`);
    assert.equal(layout.backgroundTuningDisplay, "none", `简洁底色下不应显示图片调节项：${JSON.stringify(layout)}`);
    assert.equal(layout.motionTiming, "cubic-bezier(0.2, 0.8, 0.2, 1)");
    assert.equal(layout.motionDuration, "0.24s");
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("扩展弹窗在标准任务宽度内完整显示且不横向溢出", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器布局测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器布局测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-popup-layout-"));
  const popupUrl = pathToFileURL(join(__dirname, "..", "CRX", "popup.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=420,800",
    popupUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "popup.html");
    const layout = await evaluateAtViewport(pageUrl, 420, 800, `(async () => {
      const title = document.querySelector('.popup-header h1');
      const accountSelect = document.querySelector('#account-select');
      const body = document.body;
      const shell = document.querySelector('.shell');
      const accountPanel = document.querySelector('.account-panel');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (getComputedStyle(accountPanel).display === 'grid' && getComputedStyle(title).fontSize === '19px') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyWidth: body.getBoundingClientRect().width,
        shellWidth: shell.getBoundingClientRect().width,
        accountPanelWidth: accountPanel.getBoundingClientRect().width,
        titleWidth: title.getBoundingClientRect().width,
        titleHeight: title.getBoundingClientRect().height,
        selectWidth: accountSelect.getBoundingClientRect().width
      };
    })()`);

    assert.equal(layout.viewportWidth, 420, `弹窗应保持标准任务宽度：${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.viewportWidth, `弹窗不应产生横向溢出：${JSON.stringify(layout)}`);
    assert.ok(layout.titleHeight <= 28, `标题应保持一行：${JSON.stringify(layout)}`);
    assert.ok(layout.selectWidth >= 340, `表单控件应使用弹窗可用宽度：${JSON.stringify(layout)}`);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("弹窗关键操作在标准宽度保持清晰的三列布局", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器布局测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器布局测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-popup-zoom-layout-"));
  const popupUrl = pathToFileURL(join(__dirname, "..", "CRX", "popup.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=420,800",
    popupUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "popup.html");
    const layout = await evaluateAtViewport(pageUrl, 420, 800, `(async () => {
      const login = document.querySelector('#login');
      const savedTitle = document.querySelector('#saved-accounts-title');
      const actions = document.querySelector('.actions');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (getComputedStyle(actions).display === 'grid' && getComputedStyle(login).minHeight === '44px') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        actionColumns: getComputedStyle(actions).gridTemplateColumns,
        loginHeight: login.getBoundingClientRect().height,
        loginWritingMode: getComputedStyle(login).writingMode,
        savedTitleHeight: savedTitle.getBoundingClientRect().height,
        savedTitleWritingMode: getComputedStyle(savedTitle).writingMode
      };
    })()`);

    assert.equal(layout.viewportWidth, 420, `弹窗应保持标准任务宽度：${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.viewportWidth, `弹窗不应横向溢出：${JSON.stringify(layout)}`);
    assert.equal(layout.actionColumns.split(" ").length, 3, `登录、保存和下线应保持三列：${JSON.stringify(layout)}`);
    assert.equal(layout.loginWritingMode, "horizontal-tb");
    assert.equal(layout.savedTitleWritingMode, "horizontal-tb");
    assert.ok(layout.loginHeight <= 54, `登录按钮文字不应逐字竖排：${JSON.stringify(layout)}`);
    assert.ok(layout.savedTitleHeight <= 30, `账号标题不应逐字竖排：${JSON.stringify(layout)}`);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("设置页在窄屏使用底部分类栏并且一次只显示一个设置面板", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器布局测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器布局测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-options-navigation-"));
  const optionsUrl = pathToFileURL(join(__dirname, "..", "CRX", "options.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=390,844",
    optionsUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "options.html");
    const layout = await evaluateAtViewport(pageUrl, 390, 844, `(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (document.readyState === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const navigation = document.querySelector('.settings-sidebar');
      const accountButton = document.querySelector('[data-settings-target="accounts-section"]');
      const overviewListRect = document.querySelector('.overview-list').getBoundingClientRect();
      const overviewIconRect = document.querySelector('.overview-row .setting-icon').getBoundingClientRect();
      const before = Array.from(document.querySelectorAll('[data-settings-panel]:not([hidden])')).map((item) => item.id);
      accountButton?.click();
      const after = Array.from(document.querySelectorAll('[data-settings-panel]:not([hidden])')).map((item) => item.id);
      const rect = navigation.getBoundingClientRect();
      return {
        before,
        after,
        pageTitle: document.querySelector('#settings-title')?.textContent || '',
        navigationPosition: getComputedStyle(navigation).position,
        navigationBottomGap: Math.round(window.innerHeight - rect.bottom),
        overviewIconInset: Math.round(overviewIconRect.left - overviewListRect.left),
        hasDecorativeHeader: Boolean(document.querySelector('.app-header')),
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      };
    })()`);

    assert.deepEqual(layout.before, ["connection-overview", "automation-section"]);
    assert.deepEqual(layout.after, ["accounts-section"]);
    assert.equal(layout.pageTitle, "账号");
    assert.equal(layout.navigationPosition, "fixed");
    assert.ok(layout.navigationBottomGap >= 0 && layout.navigationBottomGap <= 16, `底栏应贴近安全区底部：${JSON.stringify(layout)}`);
    assert.ok(layout.overviewIconInset >= 12, `卡片图标必须留在容器内边距中：${JSON.stringify(layout)}`);
    assert.equal(layout.hasDecorativeHeader, false);
    assert.ok(layout.scrollWidth <= layout.viewportWidth, `设置页不应横向溢出：${JSON.stringify(layout)}`);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("800px 设置页仍使用左侧纵向玻璃侧栏", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器布局测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器布局测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-options-sidebar-"));
  const optionsUrl = pathToFileURL(join(__dirname, "..", "CRX", "options.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=800,900",
    optionsUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "options.html");
    const layout = await evaluateAtViewport(pageUrl, 800, 900, `(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sidebar = document.querySelector('.settings-sidebar');
      const workspace = document.querySelector('.settings-workspace');
      const settingsWindow = document.querySelector('.settings-window');
      const visiblePanels = Array.from(document.querySelectorAll('[data-settings-panel]:not([hidden])')).map((item) => item.id);
      const sidebarRect = sidebar.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const style = getComputedStyle(sidebar);
      const windowStyle = getComputedStyle(settingsWindow);
      return {
        visiblePanels,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        sidebarWidth: sidebarRect.width,
        sidebarHeight: sidebarRect.height,
        workspaceLeft: workspaceRect.left,
        flexDirection: style.flexDirection,
        position: style.position,
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || '',
        workspaceGap: Math.round(workspaceRect.left - sidebarRect.right),
        windowRadius: parseFloat(windowStyle.borderTopLeftRadius),
        windowOverflow: windowStyle.overflow,
        windowBackdropFilter: windowStyle.backdropFilter || windowStyle.webkitBackdropFilter || ''
      };
    })()`);

    assert.equal(layout.flexDirection, "column");
    assert.ok(["relative", "sticky"].includes(layout.position), JSON.stringify(layout));
    assert.ok(layout.sidebarWidth >= 210 && layout.sidebarWidth <= 260, JSON.stringify(layout));
    assert.ok(layout.sidebarHeight > layout.sidebarWidth * 2, JSON.stringify(layout));
    assert.ok(layout.workspaceGap >= -20 && layout.workspaceGap <= 1, JSON.stringify(layout));
    assert.match(layout.backdropFilter, /blur\(/);
    assert.deepEqual(layout.visiblePanels, ["connection-overview", "automation-section"]);
    assert.ok(layout.windowRadius >= 20, JSON.stringify(layout));
    assert.equal(layout.windowOverflow, "hidden");
    assert.match(layout.windowBackdropFilter, /blur\(/);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("门户预览会在真实浏览器中渲染生产登录表单", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器预览测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器预览测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-portal-preview-"));
  const previewUrl = pathToFileURL(join(__dirname, "..", "CRX", "portal-preview.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=390,844",
    previewUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "portal-preview.html");
    const view = await evaluateAtViewport(pageUrl, 390, 844, `(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (document.querySelector('#drcom-login-form')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const root = document.querySelector('#drcom-modern-root');
      const surface = document.querySelector('.drcom-surface');
      const username = document.querySelector('#drcom-username');
      const password = document.querySelector('#drcom-password');
      if (username) username.value = '202600000001';
      if (password) password.value = 'preview-only';
      document.querySelector('#drcom-login-form')?.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        hasRoot: Boolean(root),
        hasLoginForm: Boolean(document.querySelector('#drcom-login-form')),
        title: document.querySelector('#drcom-login-title')?.textContent || '',
        rootPosition: root ? getComputedStyle(root).position : '',
        surfaceWidth: surface ? surface.getBoundingClientRect().width : 0,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        previewMessage: document.querySelector('#drcom-form-status')?.textContent || ''
      };
    })()`);

    assert.equal(view.hasRoot, true, `预览应挂载门户根节点：${JSON.stringify(view)}`);
    assert.equal(view.hasLoginForm, true, `预览应显示真实登录表单：${JSON.stringify(view)}`);
    assert.equal(view.title, "徐医校园网");
    assert.equal(view.rootPosition, "fixed");
    assert.ok(view.surfaceWidth > 300 && view.surfaceWidth <= 440, `登录面板宽度应保持可读：${JSON.stringify(view)}`);
    assert.ok(view.scrollWidth <= view.viewportWidth, `预览不应横向溢出：${JSON.stringify(view)}`);
    assert.equal(view.previewMessage, "这是界面预览，不会发送登录请求。");
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("异步出现的门户登录控件会触发真实浏览器接管", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器门户测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器门户测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-portal-async-login-"));
  const fixtureUrl = pathToFileURL(join(__dirname, "fixtures", "portal-async.html")).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=390,844",
    fixtureUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "portal-async.html");
    const view = await evaluateAtViewport(pageUrl, 390, 844, `(async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (document.querySelector('#drcom-login-form')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        hasLoginForm: Boolean(document.querySelector('#drcom-login-form')),
        hasOriginalPortal: Boolean(document.querySelector('#school-portal-fixture')),
        hasModernRoot: Boolean(document.querySelector('#drcom-modern-root'))
      };
    })()`);

    assert.equal(view.hasLoginForm, true, `异步登录页应被接管：${JSON.stringify(view)}`);
    assert.equal(view.hasOriginalPortal, true, `异步门户原始结构应已出现：${JSON.stringify(view)}`);
    assert.equal(view.hasModernRoot, true, `异步门户应渲染现代根节点：${JSON.stringify(view)}`);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("异步出现的在线标记会渲染真实浏览器连接状态", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器门户测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器门户测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-portal-async-online-"));
  const fixtureUrl = `${pathToFileURL(join(__dirname, "fixtures", "portal-async.html")).href}?mode=online`;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=390,844",
    fixtureUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageUrl = await waitForPage(new URL(debuggerUrl).port, "portal-async.html");
    const view = await evaluateAtViewport(pageUrl, 390, 844, `(async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (document.querySelector('#drcom-logout')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        hasLogout: Boolean(document.querySelector('#drcom-logout')),
        status: document.querySelector('#drcom-state-title')?.textContent || '',
        hasOriginalPortal: Boolean(document.querySelector('#school-portal-fixture'))
      };
    })()`);

    assert.equal(view.hasLogout, true, `异步在线页应显示下线操作：${JSON.stringify(view)}`);
    assert.equal(view.status, "已经连接校园网", `异步在线页应显示连接状态：${JSON.stringify(view)}`);
    assert.equal(view.hasOriginalPortal, true, `异步在线标记应已出现：${JSON.stringify(view)}`);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});
