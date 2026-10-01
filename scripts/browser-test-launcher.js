"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

const TRANSIENT_DEVTOOLS_FILE_ERRORS = new Set(["ENOENT", "EACCES", "EPERM", "EBUSY", "EAGAIN"]);

function isTransientDevToolsFileError(error) {
  return TRANSIENT_DEVTOOLS_FILE_ERRORS.has(error?.code);
}

const WINDOWS_BROWSER_FALLBACKS = Object.freeze([
  "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
  "D:\\Program Files (x86)\\RunningCheeseHelium\\App\\chrome.exe"
]);

function getBrowserCandidates({ env = process.env, platform = process.platform } = {}) {
  const localAppData = env.LOCALAPPDATA;
  const explicit = [env.CHROME_BIN, env.EDGE_BIN].filter(Boolean);

  if (platform === "win32") {
    const systemCandidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      localAppData ? join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ].filter(Boolean);
    return [...explicit, ...systemCandidates, ...WINDOWS_BROWSER_FALLBACKS];
  }

  return [
    ...explicit,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
}

function findBrowser(options = {}) {
  /* CHROME_BIN / EDGE_BIN 始终拥有最高优先级。Windows 下先尝试系统常见
     Chrome / Edge 稳定版；仅当这些路径都不存在时，才使用本机约定的
     Edge Beta / RunningCheese Helium 作为兜底。兜底浏览器不会触发额外
     测试矩阵，只用于当前这一轮 browser 测试。 */
  const fileExists = options.existsSync || existsSync;
  return getBrowserCandidates(options).find((path) => path && fileExists(path));
}

function launchBrowser(browser, args, options = {}) {
  const noSandbox = process.env.CHROME_NO_SANDBOX === "1"
    || (typeof process.getuid === "function" && process.getuid() === 0);
  /* 测试默认在中文环境断言"跟随浏览器"的界面语言；CI Linux runner 的
     系统语言是 en，会让默认语言断言随机失败。显式固定 --lang=zh-CN，
     双语布局测试仍通过页面内 DrcomI18n.setLanguage 显式切换，不受影响。 */
  const languageArgs = args.some((arg) => arg.startsWith("--lang="))
    ? []
    : ["--lang=zh-CN"];
  const launchArgs = noSandbox && !args.includes("--no-sandbox")
    ? ["--no-sandbox", ...languageArgs, ...args]
    : [...languageArgs, ...args];
  const spawnOptions = { ...options };
  if (process.platform !== "win32" && spawnOptions.detached === undefined) {
    // Give Chromium and its helper processes their own process group so cleanup
    // can terminate the complete tree instead of only the browser parent.
    spawnOptions.detached = true;
  }
  const child = spawn(browser, launchArgs, spawnOptions);
  child.__drcomProcessGroup = spawnOptions.detached === true && process.platform !== "win32";
  child.__drcomProfile = launchArgs
    .find((arg) => arg.startsWith("--user-data-dir="))
    ?.slice("--user-data-dir=".length) || null;
  return child;
}

function readDevToolsActivePort(profile) {
  if (!profile) return null;
  const path = join(profile, "DevToolsActivePort");

  try {
    const [portLine, websocketPath] = readFileSync(path, "utf8").trim().split(/\r?\n/);
    const port = Number.parseInt(portLine, 10);
    if (!Number.isInteger(port) || port <= 0 || !websocketPath?.startsWith("/")) return null;
    return `ws://127.0.0.1:${port}${websocketPath}`;
  } catch (error) {
    // Chromium may create DevToolsActivePort before the write is complete.
    if (isTransientDevToolsFileError(error)) return null;
    throw error;
  }
}

function waitForDebugger(child, options = {}) {
  /* CI runner 冷启动 Chromium 可能超过 10 秒（首轮最慢，后续复用进程更快），
     10 秒会让第一个浏览器测试随机超时，放宽到 30 秒。 */
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let cleanLauncherExit = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let launcherExitTimer = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (launcherExitTimer) clearTimeout(launcherExitTimer);
      child.removeListener("exit", onExit);
      child.stderr?.removeListener("data", onStderr);
    };

    const finish = (webSocketUrl) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.__drcomBrowserWebSocketUrl = webSocketUrl;
      try {
        child.__drcomDevToolsPort = Number.parseInt(new URL(webSocketUrl).port, 10);
      } catch {
        child.__drcomDevToolsPort = null;
      }
      resolve(webSocketUrl);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const pollActivePort = () => {
      try {
        const webSocketUrl = readDevToolsActivePort(child.__drcomProfile);
        if (webSocketUrl) finish(webSocketUrl);
      } catch (error) {
        fail(error);
      }
    };

    const onStderr = (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(match[1]);
    };

    const onExit = (code, signal) => {
      /* Windows Chrome/Edge may let the initially spawned process exit with 0
         after handing the profile to the real browser process. In that case
         DevToolsActivePort is the authoritative readiness signal, not the
         lifetime of the launcher process. */
      if (code === 0 && child.__drcomProfile) {
        cleanLauncherExit = true;
        pollActivePort();
        launcherExitTimer = setTimeout(() => {
          const stderrTail = output.trim().slice(-2048);
          fail(new Error(
            `浏览器启动器以退出码 0 结束，但真实浏览器未在限定时间内创建 DevToolsActivePort${stderrTail ? `\n浏览器 stderr 尾部：\n${stderrTail}` : ""}`
          ));
        }, options.launcherHandoffTimeoutMs ?? 5_000);
        return;
      }
      const stderrTail = output.trim().slice(-2048);
      fail(new Error(
        `浏览器提前退出，退出码 ${code}${signal ? `，信号 ${signal}` : ""}${stderrTail ? `\n浏览器 stderr 尾部：\n${stderrTail}` : "\n（无 stderr 输出）"}`
      ));
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    pollTimer = setInterval(pollActivePort, pollIntervalMs);
    timeoutTimer = setTimeout(() => {
      const stderrTail = output.trim().slice(-2048);
      const launcherNote = cleanLauncherExit
        ? "；启动器进程已正常退出，但未发现可用的 DevToolsActivePort"
        : "";
      fail(new Error(
        `浏览器调试端口启动超时${launcherNote}${stderrTail ? `\n浏览器 stderr 尾部：\n${stderrTail}` : ""}`
      ));
    }, timeoutMs);

    pollActivePort();
  });
}

async function waitForPage(port, pageName = "welcome.html") {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  let lastError = null;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
      const pages = await response.json();
      const page = pages.find((entry) => entry.type === "page" && entry.url.includes(pageName));
      if (page) return page.webSocketDebuggerUrl;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`未找到欢迎页浏览器目标${lastError ? `：${lastError.message}` : ""}`);
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


module.exports = {
  WINDOWS_BROWSER_FALLBACKS,
  findBrowser,
  getBrowserCandidates,
  isTransientDevToolsFileError,
  launchBrowser,
  waitForDebugger,
  waitForPage,
  runDevToolsCommands,
  evaluateAtViewport,
  focusAndTouchScroll
};
