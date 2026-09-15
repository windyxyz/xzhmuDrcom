"use strict";

const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");
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

function runDevToolsCommands(webSocketUrl, commands) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("浏览器调试命令超时"));
    }, 10_000);
    const results = [];
    let index = 0;

    const closeWithError = (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    };

    const sendNext = () => {
      if (index >= commands.length) {
        clearTimeout(timeout);
        socket.close();
        resolve(results);
        return;
      }
      const command = commands[index];
      index += 1;
      socket.send(JSON.stringify({ id: index, ...command }));
    };

    socket.addEventListener("open", () => {
      sendNext();
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== index) return;
      if (message.error) return closeWithError(new Error(message.error.message));
      results.push(message.result);
      sendNext();
    });
    socket.addEventListener("error", () => {
      closeWithError(new Error("无法连接浏览器调试目标"));
    });
  });
}

async function evaluateAtViewport(webSocketUrl, width, height, expression, { coarsePointer = false } = {}) {
  const commands = [{
    method: "Emulation.setDeviceMetricsOverride",
    params: { width, height, deviceScaleFactor: 1, mobile: true }
  }];
  if (coarsePointer) {
    commands.push(
      {
        method: "Emulation.setTouchEmulationEnabled",
        params: { enabled: true, maxTouchPoints: 5, configuration: "mobile" }
      },
      {
        method: "Emulation.setEmulatedMedia",
        params: { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] }
      }
    );
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = (await runDevToolsCommands(webSocketUrl, [...commands, {
        method: "Runtime.evaluate",
        params: {
          // Keep evaluation in the emulation session; Edge resets these CDP
          // overrides when the WebSocket disconnects.
          expression: `(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return await (${expression}); })()`,
          returnByValue: true,
          awaitPromise: true
        }
      }])).at(-1);
      if (!result || result.exceptionDetails || !result.result) {
        const details = result?.exceptionDetails;
        const description = details?.exception?.description || details?.exception?.value || details?.text;
        throw new Error(description || "浏览器返回了空结果");
      }
      return result.result.value;
    } catch (error) {
      const contextWasDestroyed = /Execution context was destroyed/.test(error.message);
      if (!contextWasDestroyed || attempt === 2) throw error;
      // Edge may recreate the document context after a mobile viewport transition.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function focusAndTouchScroll(webSocketUrl, { x, startY, endY, width, height }) {
  const touchPoint = (y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  const commands = [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: { width, height, deviceScaleFactor: 1, mobile: true }
    },
    {
      method: "Emulation.setTouchEmulationEnabled",
      params: { enabled: true, maxTouchPoints: 5, configuration: "mobile" }
    },
    {
      method: "Emulation.setEmulatedMedia",
      params: { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] }
    },
    {
      method: "Runtime.evaluate",
      params: {
        expression: `(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const root = document.querySelector("#drcom-modern-root");
          const password = document.querySelector("#drcom-password");
          globalThis.__drcomTouchEvents = [];
          ["touchstart", "touchmove", "touchend"].forEach((type) => {
            root.addEventListener(type, () => globalThis.__drcomTouchEvents.push(type), { passive: true });
          });
          password.focus();
          globalThis.__drcomFocusedLayout = {
            passwordFocused: document.activeElement === password,
            visualViewportHeight: window.visualViewport?.height || window.innerHeight,
            rootScrollTop: root.scrollTop
          };
        })()`,
        returnByValue: true,
        awaitPromise: true
      }
    },
    {
      method: "Input.dispatchTouchEvent",
      params: { type: "touchStart", touchPoints: touchPoint(startY) }
    },
    {
      method: "Input.dispatchTouchEvent",
      params: { type: "touchMove", touchPoints: touchPoint(Math.round((startY * 3 + endY) / 4)) }
    },
    {
      method: "Input.dispatchTouchEvent",
      params: { type: "touchMove", touchPoints: touchPoint(Math.round((startY + endY) / 2)) }
    },
    {
      method: "Input.dispatchTouchEvent",
      params: { type: "touchMove", touchPoints: touchPoint(Math.round((startY + endY * 3) / 4)) }
    },
    {
      method: "Input.dispatchTouchEvent",
      params: { type: "touchMove", touchPoints: touchPoint(endY) }
    },
    {
      method: "Input.dispatchTouchEvent",
      params: { type: "touchEnd", touchPoints: [] }
    }
  ];
  commands.push({
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const root = document.querySelector("#drcom-modern-root");
        const submit = document.querySelector("#drcom-submit");
        const rootRect = root.getBoundingClientRect();
        const submitRect = submit.getBoundingClientRect();
        return {
          focusedLayout: globalThis.__drcomFocusedLayout,
          keyboardLayout: {
            viewportWidth: window.innerWidth,
            visualViewportHeight: window.visualViewport?.height || window.innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            coarsePointer: matchMedia("(pointer: coarse)").matches,
            submitHeight: submitRect.height,
            submitTop: submitRect.top,
            submitBottom: submitRect.bottom,
            rootTop: rootRect.top,
            rootBottom: rootRect.bottom,
            rootScrollTop: root.scrollTop,
            rootScrollHeight: root.scrollHeight,
            rootClientHeight: root.clientHeight,
            touchEvents: globalThis.__drcomTouchEvents
          }
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    }
  });
  const result = (await runDevToolsCommands(webSocketUrl, commands)).at(-1);
  if (!result || result.exceptionDetails || !result.result) {
    const details = result?.exceptionDetails;
    const description = details?.exception?.description || details?.exception?.value || details?.text;
    throw new Error(description || "浏览器返回了空结果");
  }
  return result.result.value;
}

async function inspectFilePage({ browser, path, width, height, expression, coarsePointer = false }) {
  const profile = mkdtempSync(join(tmpdir(), "drcom-file-layout-"));
  const pageUrl = pathToFileURL(join(__dirname, "..", "CRX", path)).href;
  const child = spawn(browser, [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    pageUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggerUrl = await waitForDebugger(child);
    const pageDebuggerUrl = await waitForPage(new URL(debuggerUrl).port, path);
    return await evaluateAtViewport(pageDebuggerUrl, width, height, expression, { coarsePointer });
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
}

function startPortalFixtureServer() {
  const routes = new Map([
    ["/portal-async.html", [join(__dirname, "fixtures", "portal-async.html"), "text/html; charset=utf-8"]],
    ["/CRX/design-tokens.css", [join(__dirname, "..", "CRX", "design-tokens.css"), "text/css; charset=utf-8"]],
    ["/CRX/portal.css", [join(__dirname, "..", "CRX", "portal.css"), "text/css; charset=utf-8"]],
    ["/CRX/account-utils.js", [join(__dirname, "..", "CRX", "account-utils.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/appearance.js", [join(__dirname, "..", "CRX", "appearance.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/portal-ui.js", [join(__dirname, "..", "CRX", "portal-ui.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/portal-capture.js", [join(__dirname, "..", "CRX", "portal-capture.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/portal-diagnostics-utils.js", [join(__dirname, "..", "CRX", "portal-diagnostics-utils.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/background/diagnostics-service.js", [join(__dirname, "..", "CRX", "background", "diagnostics-service.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/portal-diagnostics.js", [join(__dirname, "..", "CRX", "portal-diagnostics.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/portal-modernizer.js", [join(__dirname, "..", "CRX", "portal-modernizer.js"), "text/javascript; charset=utf-8"]],
    ["/CRX/fonts/segoe-fluent-icons.ttf", [join(__dirname, "..", "CRX", "fonts", "segoe-fluent-icons.ttf"), "font/ttf"]]
  ]);
  const server = createServer((request, response) => {
    let pathname = "";
    try {
      pathname = new URL(request.url, "http://10.10.10.2").pathname;
    } catch (error) {
      response.writeHead(400);
      response.end("bad request");
      return;
    }
    const route = routes.get(pathname);
    if (!route) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": route[1]
    });
    response.end(readFileSync(route[0]));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function closePortalFixtureServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withBrowserProfileCleanup(run, cleanup) {
  let result;
  let runError;
  try {
    result = await run();
  } catch (error) {
    runError = error;
  }

  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], "浏览器测试和配置清理均失败");
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  return result;
}

async function withPortalFixtureServer(run) {
  let fixtureServer;
  let runError;
  let result;
  try {
    fixtureServer = await startPortalFixtureServer();
    result = await run(fixtureServer);
  } catch (error) {
    runError = error;
  }

  let cleanupError;
  if (fixtureServer) {
    try {
      await closePortalFixtureServer(fixtureServer.server);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], "门户 fixture 测试和服务器清理均失败");
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  return result;
}

test("门户 fixture 在后续设置失败或浏览器清理失败后仍恰好关闭一次", async () => {
  const setupError = new Error("后续设置失败");
  const browserCleanupError = new Error("浏览器配置清理失败");
  const scenarios = [
    {
      name: "后续设置失败",
      expectedError: setupError,
      run: () => withBrowserProfileCleanup(
        async () => { throw setupError; },
        async () => {}
      )
    },
    {
      name: "浏览器配置清理失败",
      expectedError: browserCleanupError,
      run: () => withBrowserProfileCleanup(
        async () => {},
        async () => { throw browserCleanupError; }
      )
    }
  ];

  for (const scenario of scenarios) {
    const events = [];
    let closeAttempts = 0;
    await assert.rejects(
      () => withPortalFixtureServer(async (fixtureServer) => {
        const close = fixtureServer.server.close.bind(fixtureServer.server);
        fixtureServer.server.close = (callback) => {
          closeAttempts += 1;
          events.push("server-close");
          return close(callback);
        };
        events.push(scenario.name);
        return scenario.run();
      }),
      (error) => error === scenario.expectedError
    );
    assert.equal(closeAttempts, 1, `${scenario.name} 后必须尝试关闭一次 loopback fixture server`);
    assert.deepEqual(events, [scenario.name, "server-close"]);
  }
});

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
    assert.equal(layout.motionTiming, "cubic-bezier(0.1, 0.9, 0.2, 1)");
    assert.equal(layout.motionDuration, "0.45s");
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
      const refreshControls = document.querySelector('.settings-refresh-controls');
      const refreshRect = refreshControls.getBoundingClientRect();
      const refreshItems = Array.from(refreshControls.children).map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left, right: rect.right, height: rect.height };
      });
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sectionLeft: sectionRect.left,
        sectionRight: sectionRect.right,
        appearanceColumns: getComputedStyle(appearance).gridTemplateColumns,
        backgroundTuningDisplay: getComputedStyle(document.querySelector('#background-controls')).display,
        refreshLeft: refreshRect.left,
        refreshRight: refreshRect.right,
        refreshItems,
        motionTiming: shellStyle.animationTimingFunction,
        motionDuration: shellStyle.animationDuration
      };
    })()`);

    assert.equal(layout.viewportWidth, 390, `浏览器测试视口应为 390px：${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.viewportWidth, `设置页不应横向溢出：${JSON.stringify(layout)}`);
    assert.ok(layout.refreshLeft >= 0 && layout.refreshRight <= layout.viewportWidth, "刷新控件应留在视口内：" + JSON.stringify(layout));
    assert.ok(layout.refreshItems.every((item) => item.left >= 0 && item.right <= layout.viewportWidth && item.height >= 38), "刷新控件应可操作且不溢出：" + JSON.stringify(layout));
    assert.ok(layout.sectionLeft >= 0 && layout.sectionRight <= layout.viewportWidth, `设置卡片应完整留在视口内：${JSON.stringify(layout)}`);
    assert.equal(layout.appearanceColumns.split(" ").length, 1, `外观区在手机上应为单列：${JSON.stringify(layout)}`);
    assert.equal(layout.backgroundTuningDisplay, "none", `简洁底色下不应显示图片调节项：${JSON.stringify(layout)}`);
    assert.equal(layout.motionTiming, "cubic-bezier(0.1, 0.9, 0.2, 1)");
    assert.equal(layout.motionDuration, "0.45s");
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
      const waitFor = async (selector) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const found = document.querySelector(selector);
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return document.querySelector(selector);
      };
      const title = await waitFor('.popup-header h1');
      const accountSelect = await waitFor('#account-select');
      const body = document.body;
      const shell = await waitFor('.shell');
      const accountPanel = await waitFor('.account-panel');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (getComputedStyle(accountPanel).display === 'grid' && getComputedStyle(title).fontSize === '16px') break;
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

test("四个界面在中英文 320、360、390px 粗指针矩阵中保持可触及", { timeout: 120_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器布局测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器布局测试");
    return;
  }

  const pages = [
    {
      path: "popup.html",
      controls: ["language-toggle", "login", "open-options"],
      ready: "globalThis.DrcomI18n",
      prepare: (language) => `globalThis.DrcomI18n.setLanguage(${JSON.stringify(language)}); globalThis.DrcomI18n.apply(document, ${JSON.stringify(language)});`
    },
    {
      path: "welcome.html",
      controls: ["language-toggle", "open-portal", "open-options"],
      ready: "globalThis.DrcomI18n",
      prepare: (language) => `globalThis.DrcomI18n.setLanguage(${JSON.stringify(language)}); globalThis.DrcomI18n.apply(document, ${JSON.stringify(language)});`
    },
    {
      path: "options.html",
      controls: ["ui-language", "account-login"],
      ready: "globalThis.DrcomI18n",
      prepare: (language) => `globalThis.DrcomI18n.setLanguage(${JSON.stringify(language)}); globalThis.DrcomI18n.apply(document, ${JSON.stringify(language)}); document.querySelector("#accounts-section").hidden = false; document.querySelector("#about-section").hidden = false;`
    },
    {
      path: "portal-preview.html",
      controls: ["drcom-language-toggle", "drcom-password-toggle", "drcom-submit"],
      ready: "globalThis.DrcomI18n && globalThis.DrcomPortalUI",
      prepare: (language) => `globalThis.DrcomPortalUI.setLanguage(${JSON.stringify(language)}); const root = document.querySelector("#drcom-modern-root"); root.innerHTML = globalThis.DrcomPortalUI.renderPortalMarkup({ title: globalThis.DrcomI18n.t("brand_name", undefined, ${JSON.stringify(language)}) }); globalThis.DrcomI18n.apply(root, ${JSON.stringify(language)});`
    }
  ];

  for (const page of pages) {
    for (const language of ["zh-CN", "en"]) {
      for (const width of [320, 360, 390]) {
        let layout;
        try {
          layout = await inspectFilePage({
            browser,
            path: page.path,
            width,
            height: 720,
            coarsePointer: true,
            expression: `(async () => {
              for (let attempt = 0; attempt < 50; attempt += 1) {
                if (document.readyState === "complete" && (${page.ready})) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              if (!(${page.ready})) throw new Error("页面 i18n 依赖未就绪");
              ${page.prepare(language)}
              return {
                viewportWidth: window.innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
                coarsePointer: matchMedia("(pointer: coarse)").matches,
                controls: ${JSON.stringify(page.controls)}.map((id) => {
                  const rect = document.getElementById(id).getBoundingClientRect();
                  return { id, height: rect.height };
                })
              };
            })()`
          });
        } catch (error) {
          error.message = `${page.path} ${language} ${width}px: ${error.message}`;
          throw error;
        }
        assert.equal(layout.viewportWidth, width, `${page.path} 应使用 ${width}px 视口：${JSON.stringify(layout)}`);
        assert.equal(layout.coarsePointer, true, `${page.path} 必须处于粗指针媒体环境：${JSON.stringify(layout)}`);
        assert.ok(layout.scrollWidth <= layout.viewportWidth, `${page.path} ${language} 不应横向溢出：${JSON.stringify(layout)}`);
        assert.ok(layout.controls.every((item) => item.height >= 43.99), `${page.path} ${language} 主要控件必须至少 44px：${JSON.stringify(layout)}`);
      }
    }
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
      const waitFor = async (selector) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const found = document.querySelector(selector);
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return document.querySelector(selector);
      };
      const login = await waitFor('#login');
      const savedTitle = await waitFor('#saved-accounts-title');
      const actions = await waitFor('.actions');
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

test("800px 设置页使用左侧纵向 WinUI 导航窗格", { timeout: 20_000 }, async (t) => {
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
      const visiblePanels = Array.from(document.querySelectorAll('[data-settings-panel]:not([hidden])')).map((item) => item.id);
      const sidebarRect = sidebar.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const style = getComputedStyle(sidebar);
      const refreshRect = document.querySelector('.settings-refresh-controls').getBoundingClientRect();
      const currentItem = document.querySelector('.sidebar-nav .win-nav-item[aria-current="page"]');
      const indicator = currentItem ? getComputedStyle(currentItem, '::before') : null;
      return {
        visiblePanels,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        sidebarWidth: sidebarRect.width,
        sidebarHeight: sidebarRect.height,
        workspaceLeft: workspaceRect.left,
        flexDirection: style.flexDirection,
        position: style.position,
        refreshLeft: refreshRect.left,
        refreshRight: refreshRect.right,
        indicatorWidth: indicator ? parseFloat(indicator.width) : 0,
        indicatorHeight: indicator ? parseFloat(indicator.height) : 0
      };
    })()`);

    assert.equal(layout.flexDirection, "column");
    assert.ok(["relative", "sticky"].includes(layout.position), JSON.stringify(layout));
    assert.ok(layout.sidebarWidth >= 230 && layout.sidebarWidth <= 300, JSON.stringify(layout));
    assert.ok(layout.sidebarHeight > layout.sidebarWidth * 2, JSON.stringify(layout));
    assert.ok(layout.workspaceLeft >= layout.sidebarRight, "工作区应位于导航窗格右侧：" + JSON.stringify(layout));
    assert.deepEqual(layout.visiblePanels, ["connection-overview", "automation-section"]);
    assert.ok(layout.refreshLeft >= layout.workspaceLeft && layout.refreshRight <= 800, JSON.stringify(layout));
    assert.ok(Math.abs(layout.indicatorWidth - 3) < 1.5 && Math.abs(layout.indicatorHeight - 16) < 1.5,
      "选中项应有 3×16 的强调色指示条：" + JSON.stringify(layout));
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
    "--touch-events=enabled",
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
        coarsePointer: matchMedia("(pointer: coarse)").matches,
        surfaceWidth: surface ? surface.getBoundingClientRect().width : 0,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        previewMessage: document.querySelector('#drcom-form-status')?.textContent || ''
      };
    })()`, { coarsePointer: true });

    assert.equal(view.hasRoot, true, `预览应挂载门户根节点：${JSON.stringify(view)}`);
    assert.equal(view.hasLoginForm, true, `预览应显示真实登录表单：${JSON.stringify(view)}`);
    assert.equal(view.title, "徐医校园网");
    assert.equal(view.rootPosition, "fixed");
    assert.equal(view.coarsePointer, true, `门户触控断言必须使用粗指针环境：${JSON.stringify(view)}`);
    assert.ok(view.surfaceWidth > 300 && view.surfaceWidth <= 440, `登录面板宽度应保持可读：${JSON.stringify(view)}`);
    assert.ok(view.scrollWidth <= view.viewportWidth, `预览不应横向溢出：${JSON.stringify(view)}`);
    assert.equal(view.previewMessage, "这是界面预览，不会发送登录请求。");

    const { focusedLayout, keyboardLayout } = await focusAndTouchScroll(pageUrl, {
      x: 195,
      startY: 300,
      endY: 80,
      width: 390,
      height: 360
    });
    assert.equal(focusedLayout.passwordFocused, true, `密码框必须获得焦点：${JSON.stringify(focusedLayout)}`);
    assert.ok(focusedLayout.visualViewportHeight <= 360, `CDP 必须缩小可视视口高度：${JSON.stringify(focusedLayout)}`);
    assert.ok(keyboardLayout.scrollWidth <= keyboardLayout.viewportWidth, `软键盘高度下门户不应横向溢出：${JSON.stringify(keyboardLayout)}`);
    assert.equal(keyboardLayout.coarsePointer, true, `门户软键盘断言必须使用粗指针环境：${JSON.stringify(keyboardLayout)}`);
    assert.ok(keyboardLayout.visualViewportHeight <= 360, `可视视口必须保持缩小：${JSON.stringify(keyboardLayout)}`);
    assert.ok(keyboardLayout.submitHeight >= 44, `门户提交按钮必须至少 44px：${JSON.stringify(keyboardLayout)}`);
    assert.equal(keyboardLayout.touchEvents[0], "touchstart", `移动拖拽必须以触摸开始：${JSON.stringify(keyboardLayout)}`);
    assert.equal(keyboardLayout.touchEvents.at(-1), "touchend", `移动拖拽必须以触摸结束：${JSON.stringify(keyboardLayout)}`);
    assert.ok(keyboardLayout.touchEvents.filter((type) => type === "touchmove").length >= 2, `移动拖拽必须包含触摸移动：${JSON.stringify(keyboardLayout)}`);
    assert.ok(keyboardLayout.rootScrollTop > focusedLayout.rootScrollTop, `触摸拖拽后门户根容器必须实际滚动：${JSON.stringify({ focusedLayout, keyboardLayout })}`);
    assert.ok(keyboardLayout.submitTop >= keyboardLayout.rootTop && keyboardLayout.submitBottom <= keyboardLayout.rootBottom, `聚焦密码并用户滚动后提交按钮必须进入可视区：${JSON.stringify(keyboardLayout)}`);
    assert.ok(keyboardLayout.rootScrollHeight >= keyboardLayout.rootClientHeight, `门户根容器必须支持纵向滚动：${JSON.stringify(keyboardLayout)}`);
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
        hasModernRoot: Boolean(document.querySelector('#drcom-modern-root')),
        hasReset: Boolean(document.querySelector('#drcom-reset')),
        supportLinks: Array.from(document.querySelectorAll('.drcom-support-links a')).map((link) => ({
          label: link.textContent.trim(),
          rel: link.rel,
          target: link.target
        }))
      };
    })()`);

    assert.equal(view.hasLoginForm, true, `异步登录页应被接管：${JSON.stringify(view)}`);
    assert.equal(view.hasOriginalPortal, true, `异步门户原始结构应已出现：${JSON.stringify(view)}`);
    assert.equal(view.hasModernRoot, true, `异步门户应渲染现代根节点：${JSON.stringify(view)}`);
    assert.equal(view.hasReset, true, `现代登录页应提供重置：${JSON.stringify(view)}`);
    assert.equal(view.supportLinks.length, 4, `现代登录页应提供四个辅助入口：${JSON.stringify(view)}`);
    assert.ok(view.supportLinks.every((link) => link.target === "_blank" && /noopener/.test(link.rel) && /noreferrer/.test(link.rel)));
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
        hasOriginalPortal: Boolean(document.querySelector('#school-portal-fixture')),
        usedTime: document.querySelector('#drcom-used-time')?.textContent || '',
        totalFlow: document.querySelector('#drcom-total-flow')?.textContent || '',
        detailsOpen: document.querySelector('#drcom-session-details')?.open,
        summaryDisplay: getComputedStyle(document.querySelector('.drcom-session-summary')).display,
        fitsViewport: document.querySelector('.drcom-surface').scrollWidth <= innerWidth
      };
    })()`);

    assert.equal(view.hasLogout, true, `异步在线页应显示下线操作：${JSON.stringify(view)}`);
    assert.equal(view.status, "已经连接校园网", `异步在线页应显示连接状态：${JSON.stringify(view)}`);
    assert.equal(view.hasOriginalPortal, true, `异步在线标记应已出现：${JSON.stringify(view)}`);
    assert.equal(view.usedTime, "125 分钟", `经典模式应显示已用时间：${JSON.stringify(view)}`);
    assert.equal(view.totalFlow, "1.18 GB", `经典模式应显示总流量：${JSON.stringify(view)}`);
    assert.equal(view.detailsOpen, false, `经典模式完整详情应默认折叠：${JSON.stringify(view)}`);
    assert.equal(view.summaryDisplay, "grid", `在线摘要应使用自适应网格：${JSON.stringify(view)}`);
    assert.equal(view.fitsViewport, true, `在线详情不应产生横向溢出：${JSON.stringify(view)}`);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("验证码异步页面保持学校原始控件并显示非阻断提示", { timeout: 20_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器门户测试");
    return;
  }
  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器门户测试");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "drcom-portal-captcha-"));
  const fixtureUrl = `${pathToFileURL(join(__dirname, "fixtures", "portal-async.html")).href}?mode=captcha`;
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
        if (document.querySelector('#drcom-captcha-hint')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      document.querySelector('#school-action')?.click();
      return {
        hasCaptcha: Boolean(document.querySelector('input[name="captcha"]')),
        hasModernRoot: Boolean(document.querySelector('#drcom-modern-root')),
        hasHint: Boolean(document.querySelector('#drcom-captcha-hint')),
        modernActive: document.documentElement.classList.contains('drcom-modern-active'),
        schoolActionCount: globalThis.portalDiagnosticsFixture?.schoolActionCount || 0
      };
    })()`);

    assert.equal(view.hasCaptcha, true, `学校验证码控件应保留：${JSON.stringify(view)}`);
    assert.equal(view.hasModernRoot, false, `验证码场景不应接管：${JSON.stringify(view)}`);
    assert.equal(view.hasHint, true, `验证码场景应提供说明：${JSON.stringify(view)}`);
    assert.equal(view.modernActive, false, `验证码场景不得隐藏原页面：${JSON.stringify(view)}`);
    assert.equal(view.schoolActionCount, 1, `学校原始操作仍应可点击：${JSON.stringify(view)}`);
  } finally {
    await cleanupBrowserProfile(child, profile);
  }
});

test("真实浏览器诊断支持采集导出、关闭停写且失败不阻断学校控件", { timeout: 30_000 }, async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("当前 Node.js 不提供内置 WebSocket，跳过真实浏览器门户诊断测试");
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    t.skip("未安装 Chrome 或 Edge，跳过真实浏览器门户诊断测试");
    return;
  }

  await withPortalFixtureServer(async (fixtureServer) => {
    let profile;
    let child;
    return withBrowserProfileCleanup(async () => {
      profile = mkdtempSync(join(tmpdir(), "drcom-portal-diagnostics-"));
      const fixtureUrl = "http://10.10.10.2/portal-async.html?diagnostics=enabled&modernize=off";
      child = spawn(browser, [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--remote-debugging-port=0",
        `--proxy-server=http://127.0.0.1:${fixtureServer.port}`,
        "--proxy-bypass-list=<-loopback>",
        `--user-data-dir=${profile}`,
        "--window-size=390,844",
        fixtureUrl
      ], { stdio: ["ignore", "ignore", "pipe"] });

    const debuggerUrl = await waitForDebugger(child);
    const port = new URL(debuggerUrl).port;
    let pageUrl = await waitForPage(port, "portal-async.html");
    const captured = await evaluateAtViewport(pageUrl, 390, 844, `(async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (globalThis.portalDiagnosticsFixture && document.querySelector('#school-action')) {
          const state = await globalThis.portalDiagnosticsFixture.read();
          if (state.sessionCount === 1 && state.sessions[0].records.length > 0) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!globalThis.portalDiagnosticsFixture) return { missingFixtureApi: true };
      const button = document.querySelector('#school-action');
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const enabledState = await globalThis.portalDiagnosticsFixture.read();
      const exported = await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'diagnostics:export' }, resolve));
      const beforeDisable = enabledState.sessions[0].records.length;
      await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'diagnostics:set', enabled: false }, resolve));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const disabledState = await globalThis.portalDiagnosticsFixture.read();
      return {
        missingFixtureApi: false,
        hasClickRecord: enabledState.sessions[0].records.some((record) => record.type === 'click' && record.target.id === 'school-action'),
        exportRecordCount: exported.export.diagnostics.sessions[0].records.length,
        redactionNotice: exported.export.redactionNotice,
        beforeDisable,
        afterDisable: disabledState.sessions[0].records.length,
        schoolActionCount: globalThis.portalDiagnosticsFixture.schoolActionCount,
        enabledAfterDisable: disabledState.enabled
      };
    })()`);

    assert.equal(captured.missingFixtureApi, false, `诊断 fixture API 必须存在：${JSON.stringify(captured)}`);
    assert.equal(captured.hasClickRecord, true, `真实记录器必须捕获学校控件：${JSON.stringify(captured)}`);
    assert.ok(captured.exportRecordCount > 0, `真实服务必须导出记录：${JSON.stringify(captured)}`);
    assert.equal(captured.redactionNotice, "输入值、凭据、Cookie、存储内容、完整账号、IP 和 MAC 已排除或脱敏。");
    assert.equal(captured.afterDisable, captured.beforeDisable, `关闭后不得新增记录：${JSON.stringify(captured)}`);
    assert.equal(captured.schoolActionCount, 2, `关闭诊断不应阻断学校控件：${JSON.stringify(captured)}`);
    assert.equal(captured.enabledAfterDisable, false);

    await evaluateAtViewport(pageUrl, 390, 844, `(() => {
      location.href = 'http://10.10.10.2/portal-async.html?diagnostics=enabled&modernize=off&failAppends=100';
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    pageUrl = await waitForPage(port, "portal-async.html");
    const failed = await evaluateAtViewport(pageUrl, 390, 844, `(async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (globalThis.portalDiagnosticsFixture && document.querySelector('#school-action')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!globalThis.portalDiagnosticsFixture) return { missingFixtureApi: true };
      document.querySelector('#school-action').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = await globalThis.portalDiagnosticsFixture.read();
      return {
        missingFixtureApi: false,
        appendFailures: globalThis.portalDiagnosticsFixture.appendFailures,
        storedRecords: state.sessions[0].records.length,
        schoolActionCount: globalThis.portalDiagnosticsFixture.schoolActionCount,
        schoolButtonEnabled: document.querySelector('#school-action').disabled === false,
        originalPasswordPresent: Boolean(document.querySelector('input[type="password"]'))
      };
    })()`);

    assert.equal(failed.missingFixtureApi, false, `失败 fixture API 必须存在：${JSON.stringify(failed)}`);
    assert.ok(failed.appendFailures >= 2, `必须实际注入记录器消息失败：${JSON.stringify(failed)}`);
    assert.equal(failed.storedRecords, 0);
    assert.equal(failed.schoolActionCount, 1, `记录器失败不应阻断学校点击：${JSON.stringify(failed)}`);
    assert.equal(failed.schoolButtonEnabled, true);
    assert.equal(failed.originalPasswordPresent, true);
    }, () => cleanupBrowserProfile(child, profile));
  });
});
