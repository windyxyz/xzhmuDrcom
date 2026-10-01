"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { existsSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  cleanupBrowserProfile,
  discoverBrowserWebSocket,
  isTransientDevToolsFileError,
  stopBrowser
} = require("../scripts/browser-test-process.js");

class ImmediateExitChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

class StubbornChild extends ImmediateExitChild {
  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    if (signal === "SIGKILL") {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    }
    return true;
  }
}

test("浏览器同步退出时，清理逻辑不会错过 exit 事件", async () => {
  const child = new ImmediateExitChild();

  const exited = await stopBrowser(child, { gracefulTimeoutMs: 20, forceTimeoutMs: 20 });

  assert.equal(exited, true);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(child.listenerCount("exit"), 0);
});

test("浏览器未正常退出时，有限等待后会强制回收", async () => {
  const child = new StubbornChild();

  const exited = await stopBrowser(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 20 });

  assert.equal(exited, true);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("exit"), 0);
});

test("finally 清理即使浏览器退出也会删除临时配置目录", async () => {
  const child = new ImmediateExitChild();
  const profile = mkdtempSync(join(tmpdir(), "drcom-browser-cleanup-"));
  writeFileSync(join(profile, "Lockfile"), "test");

  await cleanupBrowserProfile(child, profile, { gracefulTimeoutMs: 20, forceTimeoutMs: 20 });

  assert.equal(existsSync(profile), false);
});


test("清理阶段可从 profile 的 DevToolsActivePort 重新发现真实浏览器", () => {
  const profile = mkdtempSync(join(tmpdir(), "drcom-browser-discover-"));
  const child = new ImmediateExitChild();
  child.exitCode = 0;
  child.__drcomProfile = profile;
  writeFileSync(
    join(profile, "DevToolsActivePort"),
    "46789\n/devtools/browser/late-browser-id\n",
    "utf8"
  );

  try {
    assert.equal(
      discoverBrowserWebSocket(child),
      "ws://127.0.0.1:46789/devtools/browser/late-browser-id"
    );
    assert.equal(
      child.__drcomBrowserWebSocketUrl,
      "ws://127.0.0.1:46789/devtools/browser/late-browser-id"
    );
  } finally {
    require("node:fs").rmSync(profile, { recursive: true, force: true });
  }
});


test("清理阶段读取 DevToolsActivePort 时也容忍 Windows 瞬时文件锁", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "EBUSY", "EAGAIN"]) {
    assert.equal(isTransientDevToolsFileError({ code }), true, code);
  }
  assert.equal(isTransientDevToolsFileError({ code: "EIO" }), false);
});
