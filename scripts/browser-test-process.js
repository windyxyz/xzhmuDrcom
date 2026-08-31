"use strict";

const { rmSync } = require("node:fs");

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
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

async function stopBrowser(child, options = {}) {
  if (hasExited(child)) return true;

  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 1_000;
  const gracefulExit = waitForExit(child, gracefulTimeoutMs);

  try {
    child.kill();
  } catch {
    // The bounded exit wait below still handles processes that raced with kill().
  }

  if (await gracefulExit) return true;
  if (hasExited(child)) return true;

  const forcedExit = waitForExit(child, forceTimeoutMs);
  try {
    child.kill("SIGKILL");
  } catch {
    // Returning false is preferable to hanging the complete browser test run.
  }
  return forcedExit;
}

async function cleanupBrowserProfile(child, profile, options = {}) {
  try {
    await stopBrowser(child, options);
  } finally {
    if (profile) {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

module.exports = {
  cleanupBrowserProfile,
  hasExited,
  stopBrowser,
  waitForExit
};
