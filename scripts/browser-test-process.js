"use strict";

const { readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const TRANSIENT_DEVTOOLS_FILE_ERRORS = new Set(["ENOENT", "EACCES", "EPERM", "EBUSY", "EAGAIN"]);

function isTransientDevToolsFileError(error) {
  return TRANSIENT_DEVTOOLS_FILE_ERRORS.has(error?.code);
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function signalBrowser(child, signal = "SIGTERM") {
  if (!child) return false;
  if (child.__drcomProcessGroup && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      return false;
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);

    child.once("exit", onExit);
    timer = setTimeout(() => finish(hasExited(child)), Math.max(1, timeoutMs));
  });
}

function discoverBrowserWebSocket(child) {
  if (child?.__drcomBrowserWebSocketUrl) return child.__drcomBrowserWebSocketUrl;
  const profile = child?.__drcomProfile;
  if (!profile) return null;
  const activePortPath = join(profile, "DevToolsActivePort");
  try {
    const [portLine, websocketPath] = readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
    const port = Number.parseInt(portLine, 10);
    if (!Number.isInteger(port) || port <= 0 || !websocketPath?.startsWith("/")) return null;
    const webSocketUrl = `ws://127.0.0.1:${port}${websocketPath}`;
    child.__drcomBrowserWebSocketUrl = webSocketUrl;
    return webSocketUrl;
  } catch (error) {
    if (isTransientDevToolsFileError(error)) return null;
    throw error;
  }
}

function closeBrowserViaDevTools(child, timeoutMs = 2_000) {
  const webSocketUrl = discoverBrowserWebSocket(child);
  if (!webSocketUrl || typeof WebSocket !== "function") return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let commandSent = false;
    let socket;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve(closed);
    };
    const timer = setTimeout(() => finish(commandSent), Math.max(1, timeoutMs));

    try {
      socket = new WebSocket(webSocketUrl);
      socket.addEventListener("open", () => {
        commandSent = true;
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.id === 1) finish(!message.error);
        } catch {
          // Browser.close often terminates the socket before a useful response.
        }
      });
      socket.addEventListener("close", () => finish(commandSent));
      socket.addEventListener("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function stopBrowser(child, options = {}) {
  if (!child) return true;

  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 1_000;
  const devToolsTimeoutMs = options.devToolsTimeoutMs ?? 2_000;

  /* On Windows the process returned by spawn(chrome.exe/msedge.exe) may be only
     a short-lived launcher. Closing through the browser-level CDP endpoint is
     therefore the reliable way to terminate the real browser instance that
     owns the temporary profile. */
  if (discoverBrowserWebSocket(child)) {
    const closedViaDevTools = await closeBrowserViaDevTools(child, devToolsTimeoutMs);
    if (closedViaDevTools) {
      if (!hasExited(child)) await waitForExit(child, gracefulTimeoutMs);
      if (child.__drcomProcessGroup) signalBrowser(child, "SIGTERM");
      return true;
    }
  }

  if (hasExited(child)) {
    if (child.__drcomProcessGroup) signalBrowser(child, "SIGTERM");
    return true;
  }

  const gracefulExit = waitForExit(child, gracefulTimeoutMs);
  signalBrowser(child, "SIGTERM");

  if (await gracefulExit) {
    if (child.__drcomProcessGroup) signalBrowser(child, "SIGTERM");
    return true;
  }
  if (hasExited(child)) return true;

  const forcedExit = waitForExit(child, forceTimeoutMs);
  signalBrowser(child, "SIGKILL");
  return forcedExit;
}

async function removeProfileWithRetry(profile, options = {}) {
  if (!profile) return true;
  const timeoutMs = options.profileCleanupTimeoutMs ?? 6_000;
  const deadline = Date.now() + timeoutMs;
  let retryDelayMs = 50;

  while (true) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return true;
    } catch (error) {
      const retryable = ["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(error?.code);
      if (!retryable || Date.now() >= deadline) throw error;
      await delay(retryDelayMs);
      retryDelayMs = Math.min(300, Math.round(retryDelayMs * 1.5));
    }
  }
}

async function cleanupBrowserProfile(child, profile, options = {}) {
  try {
    await stopBrowser(child, options);
  } finally {
    await removeProfileWithRetry(profile, options);
  }
}

module.exports = {
  cleanupBrowserProfile,
  closeBrowserViaDevTools,
  discoverBrowserWebSocket,
  hasExited,
  isTransientDevToolsFileError,
  removeProfileWithRetry,
  stopBrowser,
  waitForExit
};
