"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const launcher = require("../scripts/browser-test-launcher.js");
const processUtils = require("../scripts/browser-test-process.js");

class FakeChild extends EventEmitter {
  constructor(profile = null) {
    super();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.__drcomProfile = profile;
    this.killSignals = [];
  }
  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    return true;
  }
}

test("DevToolsActivePort 已存在时 waitForDebugger 可立即接管", async () => {
  const profile = mkdtempSync(join(tmpdir(), "drcom-edge-port-ready-"));
  const child = new FakeChild(profile);
  try {
    writeFileSync(join(profile, "DevToolsActivePort"), "51234\n/devtools/browser/ready\n", "utf8");
    const ws = await launcher.waitForDebugger(child, { timeoutMs: 200, pollIntervalMs: 5 });
    assert.equal(ws, "ws://127.0.0.1:51234/devtools/browser/ready");
    assert.equal(child.__drcomDevToolsPort, 51234);
    assert.equal(child.listenerCount("exit"), 0);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("stderr 的 DevTools listening 信号可在没有 profile 时完成启动", async () => {
  const child = new FakeChild(null);
  const waiting = launcher.waitForDebugger(child, { timeoutMs: 200, pollIntervalMs: 5 });
  child.stderr.write("[info] DevTools listening on ws://127.0.0.1:60001/devtools/browser/stderr-id\n");
  assert.equal(await waiting, "ws://127.0.0.1:60001/devtools/browser/stderr-id");
});

test("退出码 0 但没有 profile 时仍被视为提前退出", async () => {
  const child = new FakeChild(null);
  const waiting = launcher.waitForDebugger(child, { timeoutMs: 200, pollIntervalMs: 5 });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await assert.rejects(waiting, /浏览器提前退出，退出码 0/);
});

test("Windows 启动器转交后超时会给出明确 DevToolsActivePort 诊断", async () => {
  const profile = mkdtempSync(join(tmpdir(), "drcom-edge-handoff-timeout-"));
  const child = new FakeChild(profile);
  try {
    const waiting = launcher.waitForDebugger(child, {
      timeoutMs: 500,
      pollIntervalMs: 5,
      launcherHandoffTimeoutMs: 25
    });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await assert.rejects(waiting, /真实浏览器未在限定时间内创建 DevToolsActivePort/);
    assert.equal(child.listenerCount("exit"), 0);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("浏览器非零退出错误只保留 stderr 尾部而不会无限膨胀", async () => {
  const child = new FakeChild(null);
  const waiting = launcher.waitForDebugger(child, { timeoutMs: 200, pollIntervalMs: 5 });
  child.stderr.write("A".repeat(4096) + "TAIL-MARKER");
  child.exitCode = 9;
  child.emit("exit", 9, null);
  await assert.rejects(waiting, (error) => {
    assert.match(error.message, /退出码 9/);
    assert.match(error.message, /TAIL-MARKER/);
    assert.ok(error.message.length < 2600);
    return true;
  });
});

test("清理侧发现 malformed DevToolsActivePort 时返回 null 而不是连接错误端口", () => {
  const profile = mkdtempSync(join(tmpdir(), "drcom-edge-malformed-port-"));
  const child = new FakeChild(profile);
  try {
    for (const content of ["", "abc\n/devtools/browser/x\n", "0\n/devtools/browser/x\n", "12345\nnot-a-path\n"]) {
      writeFileSync(join(profile, "DevToolsActivePort"), content, "utf8");
      delete child.__drcomBrowserWebSocketUrl;
      assert.equal(processUtils.discoverBrowserWebSocket(child), null, content);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("discoverBrowserWebSocket 缓存首次发现的真实浏览器地址", () => {
  const profile = mkdtempSync(join(tmpdir(), "drcom-edge-cache-port-"));
  const child = new FakeChild(profile);
  try {
    writeFileSync(join(profile, "DevToolsActivePort"), "52345\n/devtools/browser/first\n", "utf8");
    assert.equal(processUtils.discoverBrowserWebSocket(child), "ws://127.0.0.1:52345/devtools/browser/first");
    writeFileSync(join(profile, "DevToolsActivePort"), "52346\n/devtools/browser/second\n", "utf8");
    assert.equal(processUtils.discoverBrowserWebSocket(child), "ws://127.0.0.1:52345/devtools/browser/first");
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("waitForExit 超时后移除监听器，不给后续测试残留事件", async () => {
  const child = new FakeChild();
  assert.equal(await processUtils.waitForExit(child, 10), false);
  assert.equal(child.listenerCount("exit"), 0);
});

test("waitForExit 在等待期间收到 exit 会立即成功并清理监听器", async () => {
  const child = new FakeChild();
  const waiting = processUtils.waitForExit(child, 100);
  setTimeout(() => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  }, 5);
  assert.equal(await waiting, true);
  assert.equal(child.listenerCount("exit"), 0);
});

test("已经退出且没有 DevTools 实例的浏览器不会再发送 kill", async () => {
  const child = new FakeChild();
  child.exitCode = 0;
  assert.equal(await processUtils.stopBrowser(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 5 }), true);
  assert.deepEqual(child.killSignals, []);
});

test("不存在的临时 profile 可以幂等清理", async () => {
  const profile = join(tmpdir(), `drcom-edge-missing-${Date.now()}-${Math.random()}`);
  assert.equal(await processUtils.removeProfileWithRetry(profile, { profileCleanupTimeoutMs: 10 }), true);
});

test("瞬时 DevTools 文件错误白名单不会吞掉真实 I/O 故障", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "EBUSY", "EAGAIN"]) {
    assert.equal(launcher.isTransientDevToolsFileError({ code }), true);
    assert.equal(processUtils.isTransientDevToolsFileError({ code }), true);
  }
  for (const code of ["EIO", "ENOSPC", "EROFS", "EINVAL"]) {
    assert.equal(launcher.isTransientDevToolsFileError({ code }), false);
    assert.equal(processUtils.isTransientDevToolsFileError({ code }), false);
  }
});
