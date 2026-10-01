"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { isTransientDevToolsFileError, waitForDebugger } = require("../scripts/browser-test-launcher.js");

class FakeBrowserChild extends EventEmitter {
  constructor(profile) {
    super();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.__drcomProfile = profile;
  }
}

test("Windows 风格启动器退出码 0 后仍从 DevToolsActivePort 接管真实浏览器", async () => {
  const profile = mkdtempSync(join(tmpdir(), "drcom-devtools-active-port-"));
  const child = new FakeBrowserChild(profile);

  try {
    const waiting = waitForDebugger(child, { timeoutMs: 1_000, pollIntervalMs: 10 });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    setTimeout(() => {
      writeFileSync(
        join(profile, "DevToolsActivePort"),
        "45678\n/devtools/browser/test-browser-id\n",
        "utf8"
      );
    }, 30);

    const webSocketUrl = await waiting;
    assert.equal(webSocketUrl, "ws://127.0.0.1:45678/devtools/browser/test-browser-id");
    assert.equal(child.__drcomBrowserWebSocketUrl, webSocketUrl);
    assert.equal(child.__drcomDevToolsPort, 45678);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("浏览器非零退出仍立即报告真实启动失败", async () => {
  const profile = mkdtempSync(join(tmpdir(), "drcom-devtools-failure-"));
  const child = new FakeBrowserChild(profile);

  try {
    const waiting = waitForDebugger(child, { timeoutMs: 1_000, pollIntervalMs: 10 });
    child.stderr.write("fatal browser startup error\n");
    child.exitCode = 7;
    child.emit("exit", 7, null);

    await assert.rejects(
      waiting,
      /浏览器提前退出，退出码 7[\s\S]*fatal browser startup error/
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});


test("DevToolsActivePort 的 Windows 瞬时文件锁会被视为可重试", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "EBUSY", "EAGAIN"]) {
    assert.equal(isTransientDevToolsFileError({ code }), true, code);
  }
  assert.equal(isTransientDevToolsFileError({ code: "EIO" }), false);
});

test("Windows 浏览器发现优先系统稳定版，不会优先使用兜底浏览器", () => {
  const { findBrowser } = require("../scripts/browser-test-launcher.js");
  const stableChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const fallbackEdgeBeta = "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe";
  const existing = new Set([stableChrome, fallbackEdgeBeta]);

  assert.equal(findBrowser({
    platform: "win32",
    env: {},
    existsSync: (path) => existing.has(path)
  }), stableChrome);
});

test("Windows 找不到常规浏览器时按约定顺序使用两个本地兜底浏览器", () => {
  const { findBrowser, WINDOWS_BROWSER_FALLBACKS } = require("../scripts/browser-test-launcher.js");
  assert.deepEqual(WINDOWS_BROWSER_FALLBACKS, [
    "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
    "D:\\Program Files (x86)\\RunningCheeseHelium\\App\\chrome.exe"
  ]);

  const onlyEdgeBeta = new Set([WINDOWS_BROWSER_FALLBACKS[0]]);
  assert.equal(findBrowser({
    platform: "win32",
    env: {},
    existsSync: (path) => onlyEdgeBeta.has(path)
  }), WINDOWS_BROWSER_FALLBACKS[0]);

  const onlyHelium = new Set([WINDOWS_BROWSER_FALLBACKS[1]]);
  assert.equal(findBrowser({
    platform: "win32",
    env: {},
    existsSync: (path) => onlyHelium.has(path)
  }), WINDOWS_BROWSER_FALLBACKS[1]);
});

test("CHROME_BIN 显式指定始终高于系统浏览器和兜底浏览器", () => {
  const { findBrowser, WINDOWS_BROWSER_FALLBACKS } = require("../scripts/browser-test-launcher.js");
  const custom = "D:\\Portable\\Chrome\\chrome.exe";
  const stableEdge = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
  const existing = new Set([custom, stableEdge, ...WINDOWS_BROWSER_FALLBACKS]);

  assert.equal(findBrowser({
    platform: "win32",
    env: { CHROME_BIN: custom },
    existsSync: (path) => existing.has(path)
  }), custom);
});

test("Windows 专用兜底路径不会污染 Linux 浏览器候选", () => {
  const { getBrowserCandidates, WINDOWS_BROWSER_FALLBACKS } = require("../scripts/browser-test-launcher.js");
  const candidates = getBrowserCandidates({ platform: "linux", env: {} });
  for (const fallback of WINDOWS_BROWSER_FALLBACKS) {
    assert.equal(candidates.includes(fallback), false);
  }
  assert.ok(candidates.includes("/usr/bin/google-chrome"));
});
