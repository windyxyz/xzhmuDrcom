"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  createHarness,
  requestUrls,
  scriptPath,
  shellPath,
  sshEnvironmentReady,
  writeFixture
} = require("./fixtures/ssh-harness");

const testSsh = (name, fn) => test(name, async (t) => {
  if (!(await sshEnvironmentReady(t))) return;
  return fn(t);
});

const SHARED_LOCK = "/tmp/drcom-xzhmu-shared.lock";

/* 持锁进程与被测命令必须在同一个 WSL 会话里运行：跨 wsl.exe 调用的后台进程
   不保证存活（部分 WSL 配置会在会话结束时回收），因此锁竞争测试统一采用
   “同一会话内先起持锁进程、再跑脚本”的自包含结构。 */
function runWithForeignLock(harness, command) {
  return harness.runShell([
    `rm -f ${SHARED_LOCK}`,
    "/bin/sleep 300 &",
    "holder=$!",
    `printf '%s\\n' "$holder" > ${SHARED_LOCK}`,
    /* 持锁进程必须真的活着，否则锁会被脚本的残留清理逻辑合法回收。 */
    `[ -d "/proc/$holder" ] && [ "$(cat ${SHARED_LOCK})" = "$holder" ] && echo HOLDER-ALIVE`,
    command,
    "inner_rc=$?",
    'echo "INNER_RC=$inner_rc"',
    `kill "$holder" 2>/dev/null`,
    `rm -f ${SHARED_LOCK}`
  ].join("\n"));
}

function readLog(path) {
  return readFileSync(path, "utf8").trim().split(/\r?\n/);
}

/* 兜底清理：删除共享锁文件（持锁进程已随其会话结束）。 */
function releaseSharedLock(harness) {
  harness.runShell(`rm -f ${SHARED_LOCK}`);
}

function parseRequests(path) {
  return requestUrls(path).map((value) => new URL(value));
}

/* 网关不回传可用 MAC 的在线状态：注销时只能依赖会话文件或 find_mac。 */
const NO_LIVE_MAC_STATUS =
  "dr1001({\"result\":1,\"uid\":\"student@telecom\",\"v46ip\":\"172.28.180.144\",\"ss4\":\"000000000000\"})";

/* 登录成功需要“登录前 offline、登录复核 online”两段网关响应。 */
const OFFLINE_THEN_ONLINE = {
  statusOnline: "dr1001({\"result\":0,\"msg\":\"offline\"})",
  statusAfter: "dr1001({\"result\":1,\"uid\":\"configured-user\",\"v46ip\":\"172.28.180.144\"})"
};

testSsh("login 遇到其他进程持锁时立即失败且不发送任何登录请求", () => {
  const harness = createHarness({ lockPath: SHARED_LOCK });
  try {
    const result = runWithForeignLock(harness, `sh ${shellPath(scriptPath)} login`);
    assert.match(result.stdout, /HOLDER-ALIVE/, `持锁进程未能存活：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /INNER_RC=1/, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /holds the lock/);
    assert.equal(
      parseRequests(harness.paths.requestLog).some((url) => url.searchParams.get("a") === "login"),
      false
    );
  } finally {
    harness.cleanup();
  }
});

testSsh("keepalive 遇到其他进程持锁时静默跳过并以 0 退出", () => {
  const harness = createHarness({ lockPath: SHARED_LOCK });
  try {
    const result = runWithForeignLock(harness, `sh ${shellPath(scriptPath)} keepalive`);
    assert.match(result.stdout, /HOLDER-ALIVE/, `持锁进程未能存活：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /INNER_RC=0/, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /holds the lock; skipped/);
    assert.equal(
      requestUrls(harness.paths.requestLog).some((url) => url.includes("user_password")),
      false
    );
  } finally {
    harness.cleanup();
  }
});

testSsh("status 只读不取锁，持锁期间仍可查询", () => {
  const harness = createHarness({ lockPath: SHARED_LOCK });
  try {
    const result = runWithForeignLock(harness, `sh ${shellPath(scriptPath)} status`);
    assert.match(result.stdout, /HOLDER-ALIVE/, `持锁进程未能存活：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /INNER_RC=0/, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /state=(online|offline|unknown)/);
  } finally {
    harness.cleanup();
  }
});

testSsh("logout 被 SIGTERM 后 trap 清理锁文件，后续 login 可正常取锁", () => {
  /* 网关响应按 chkstatus 次数推进。SIGTERM 相对注销进程的落点有两个窗口：
     ① 落在注销首查（chkstatus#1）之前 → 后续 login 首查命中 #1（在线）→ already online；
     ② 落在 confirm_offline 的真实 sleep 期间（kill 在锁出现后立即发出，而注销的
        复核查询要等 sleep 5 之后，故注销最多只消费 #1，此窗口为常态）→ login
        依次消费 #2（离线，登录前）与 #3（在线，登录复核成功）。
     因此 #3 与 #4 都必须是在线，login 才能在两个窗口下都确定性地成功。 */
  const ONLINE_CONFIRMED =
    "dr1001({\"result\":1,\"uid\":\"configured-user\",\"v46ip\":\"172.28.180.144\"})";
  const harness = createHarness({
    lockPath: SHARED_LOCK,
    // confirm_offline 依赖 sleep 制造 5 秒窗口；改用真实 sleep 保证信号有发令窗口。
    sleep: "#!/bin/sh\nexec /bin/sleep \"$@\"\n",
    status3: ONLINE_CONFIRMED,
    status4: ONLINE_CONFIRMED
  });
  try {
    // 包装脚本 exec 目标脚本，使 kill 命中的就是脚本进程本身。
    const wrapperPath = join(harness.paths.root, "probe-logout.sh");
    writeFileSync(wrapperPath, `#!/bin/sh\nexec sh ${shellPath(scriptPath)} logout\n`);
    const script = `
rm -f ${SHARED_LOCK}
sh ${shellPath(wrapperPath)} &
logout_pid=$!
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 \\
         21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
  [ -f ${SHARED_LOCK} ] && break
  /bin/sleep 0.2
done
[ -f ${SHARED_LOCK} ] || { echo NO-LOCK-OBSERVED; exit 3; }
kill -TERM "$logout_pid"
wait "$logout_pid" 2>/dev/null
if [ -f ${SHARED_LOCK} ]; then echo LOCK-LEFT; exit 4; fi
echo LOCK-RELEASED
`;
    const result = harness.runShell(script);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /LOCK-RELEASED/);
    assert.doesNotMatch(result.stdout, /LOCK-LEFT/);
    const login = harness.run("login", { timeout: 30000 });
    assert.equal(login.status, 0, `${login.stdout}\n${login.stderr}`);
  } finally {
    releaseSharedLock(harness);
    harness.cleanup();
  }
});

testSsh("pid 缺失或损坏的残留锁会安全失败且不会被自动删除", () => {
  const harness = createHarness({ lockPath: SHARED_LOCK });
  try {
    harness.runShell(`rm -f ${SHARED_LOCK}; : > ${SHARED_LOCK}`);
    const result = harness.run("login");
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /stale lock detected/);
    const preserved = harness.runShell(`[ -f ${SHARED_LOCK} ] && echo STALE-PRESERVED`);
    assert.match(preserved.stdout, /STALE-PRESERVED/, "残留锁不得被自动删除，否则存在误删新锁的竞态");

    // 管理员确认没有 drcom-xzhmu 进程后手工清除，下一次操作应可恢复。
    harness.runShell(`rm -f ${SHARED_LOCK}`);
    const retry = harness.run("login");
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  } finally {
    releaseSharedLock(harness);
    harness.cleanup();
  }
});

testSsh("持锁进程已不存在的残留锁会安全失败且保留现场", () => {
  const harness = createHarness({ lockPath: SHARED_LOCK });
  try {
    // Linux pid_max 默认上限附近、实际不可能存活进程的 PID。
    harness.runShell(`rm -f ${SHARED_LOCK}; printf '%s\\n' 4194301 > ${SHARED_LOCK}`);
    const result = harness.run("login");
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /stale lock detected/);
    const preserved = harness.runShell(`test "$(cat ${SHARED_LOCK})" = 4194301 && echo STALE-PRESERVED`);
    assert.match(preserved.stdout, /STALE-PRESERVED/, "死 PID 锁不得在检查后自动 rm");
  } finally {
    releaseSharedLock(harness);
    harness.cleanup();
  }
});

testSsh("keepalive 遇到残留锁时不修改锁并安全跳过", () => {
  const harness = createHarness({ lockPath: SHARED_LOCK });
  try {
    harness.runShell(`rm -f ${SHARED_LOCK}; printf '%s\\n' 4194301 > ${SHARED_LOCK}`);
    const result = harness.run("keepalive");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /stale lock detected/);
    assert.match(result.stdout, /skipped/);
    const preserved = harness.runShell(`test "$(cat ${SHARED_LOCK})" = 4194301 && echo STALE-PRESERVED`);
    assert.match(preserved.stdout, /STALE-PRESERVED/);
  } finally {
    releaseSharedLock(harness);
    harness.cleanup();
  }
});

testSsh("wget 不支持 -i 时默认拒绝发送密码", () => {
  // 闸门位于确认离线之后：预置离线→在线序列，确保走到发密码前才被拒绝。
  const harness = createHarness({ ...OFFLINE_THEN_ONLINE, lockPath: "/tmp/drcom-xzhmu-noi.lock" });
  const noiWget = [
    "#!/bin/sh",
    "for a in \"$@\"; do",
    '  if [ "$a" = "-i" ]; then echo "wget: unrecognized option: -i" >&2; exit 1; fi',
    "done",
    `exec ${shellPath(join(harness.paths.bin, "wget"))} "$@"`,
    ""
  ].join("\n");
  try {
    const setup = [
      "mkdir -p /tmp/drcom-noi-bin",
      `printf '%s' '${Buffer.from(noiWget).toString("base64")}' | base64 -d > /tmp/drcom-noi-bin/wget`,
      "chmod +x /tmp/drcom-noi-bin/wget",
      "echo NOI-READY"
    ].join("; ");
    const prepared = harness.runShell(setup);
    assert.match(prepared.stdout, /NOI-READY/, prepared.stderr);

    const result = harness.run("login", { envPrefix: 'PATH=/tmp/drcom-noi-bin:"$PATH"' });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /refusing to send password/);
    assert.equal(
      parseRequests(harness.paths.requestLog).some((url) => url.searchParams.get("a") === "login"),
      false,
      "拒绝降级时不得发送任何登录请求"
    );
  } finally {
    harness.runShell("rm -rf /tmp/drcom-noi-bin");
    harness.cleanup();
  }
});

testSsh("ALLOW_INSECURE_WGET=1 时才允许不安全降级", () => {
  const harness = createHarness(OFFLINE_THEN_ONLINE);
  try {
    const result = harness.run("login", { envPrefix: "ALLOW_INSECURE_WGET=1" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const login = parseRequests(harness.paths.requestLog).find((url) => url.searchParams.get("a") === "login");
    assert.ok(login, "显式允许后应发送登录请求");
    assert.equal(login.searchParams.get("user_password"), "test-password");
  } finally {
    harness.cleanup();
  }
});

testSsh("默认配置下认证 URL 经 wget -i 发送，密码不出现在进程参数", () => {
  const harness = createHarness(OFFLINE_THEN_ONLINE);
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const rawLines = requestUrls(harness.paths.requestLog);
    const urls = parseRequests(harness.paths.requestLog);
    const loginIndex = rawLines.findIndex((line) => line.includes("a=login"));
    assert.ok(loginIndex >= 0, "应发送登录请求");
    const outputs = readLog(harness.paths.wgetOutputLog);
    /* 输出目标日志模拟 /proc 目录下的 cmdline：登录请求必须是 "-"（经 -i 文件读取）。 */
    assert.equal(outputs[loginIndex], "-", "登录请求应经 -i 文件发送");
    /* 密码与完整账号不得进入 stdout/stderr/会话文件。 */
    assert.doesNotMatch(result.stdout, /test-password/);
    assert.doesNotMatch(result.stderr, /test-password/);
    assert.doesNotMatch(result.stdout, /configured-user/);
    assert.match(result.stdout, /account=co\*\*\*er/);
    if (existsSync(harness.paths.session)) {
      assert.doesNotMatch(readFileSync(harness.paths.session, "utf8"), /test-password|configured-user/);
    }
  } finally {
    harness.cleanup();
  }
});

testSsh("旧格式（无版本字段）会话文件被拒绝，注销回退完整 Portal/logout", () => {
  const harness = createHarness({ statusOnline: NO_LIVE_MAC_STATUS });
  try {
    writeFixture(harness.paths.session, [
      "SESSION_IP=172.28.180.144",
      "SESSION_MAC=580205DC58C2",
      "SESSION_AT=100",
      ""
    ].join("\n"));
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /logout confirmed offline/);
    assert.equal(
      parseRequests(harness.paths.requestLog).some((url) => url.searchParams.get("a") === "unbind_mac"),
      false,
      "旧会话中的 MAC 不得被采信"
    );
  } finally {
    harness.cleanup();
  }
});

testSsh("新版本会话文件带 SESSION_VERSION=1，注销时 MAC 可被采信", () => {
  const harness = createHarness({ statusOnline: NO_LIVE_MAC_STATUS });
  try {
    writeFixture(harness.paths.session, [
      "SESSION_VERSION=1",
      "SESSION_IP=172.28.180.144",
      "SESSION_MAC=580205DC58C2",
      "SESSION_AT=100",
      ""
    ].join("\n"));
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /logout confirmed offline after unbind/);
    const unbind = parseRequests(harness.paths.requestLog).find((url) => url.searchParams.get("a") === "unbind_mac");
    assert.ok(unbind, "有效会话提供 MAC 时应走 unbind_mac");
    assert.equal(unbind.searchParams.get("wlan_user_mac"), "580205DC58C2");
  } finally {
    harness.cleanup();
  }
});

testSsh("会话文件被替换为符号链接时拒绝读取其内容", () => {
  const harness = createHarness({ statusOnline: NO_LIVE_MAC_STATUS });
  const target = join(harness.paths.root, "evil-target");
  try {
    writeFixture(target, [
      "SESSION_VERSION=1",
      "SESSION_IP=172.28.180.144",
      "SESSION_MAC=580205DC58C2",
      "SESSION_AT=100",
      ""
    ].join("\n"));
    rmSync(harness.paths.session, { force: true });
    symlinkSync(target, harness.paths.session);
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      parseRequests(harness.paths.requestLog).some((url) => url.searchParams.get("a") === "unbind_mac"),
      false,
      "符号链接会话中的 MAC 不得被采信"
    );
  } finally {
    harness.cleanup();
  }
});

testSsh("损坏的会话文件被拒绝且不中断注销", () => {
  const harness = createHarness({ statusOnline: NO_LIVE_MAC_STATUS });
  try {
    writeFixture(harness.paths.session, "GARBAGE !!!\n");
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      parseRequests(harness.paths.requestLog).some((url) => url.searchParams.get("a") === "unbind_mac"),
      false
    );
  } finally {
    harness.cleanup();
  }
});

testSsh("keepalive 与 login 并发时登录请求只发送一次", () => {
  const harness = createHarness({ ...OFFLINE_THEN_ONLINE, lockPath: SHARED_LOCK });
  try {
    harness.runShell(`rm -f ${SHARED_LOCK}`);
    const outcomes = [];
    const exits = [];
    const first = harness.spawnDetached("keepalive");
    const second = harness.spawnDetached("login");
    exits.push(new Promise((resolve) => {
      first.on("exit", (code) => {
        outcomes.push({ command: "keepalive", code });
        resolve();
      });
    }));
    exits.push(new Promise((resolve) => {
      second.on("exit", (code) => {
        outcomes.push({ command: "login", code });
        resolve();
      });
    }));
    return Promise.all(exits).then(() => {
      for (const entry of outcomes) {
        assert.ok([0, 1].includes(entry.code), `${entry.command} 异常退出：${entry.code}`);
      }
      const logins = parseRequests(harness.paths.requestLog).filter((url) => url.searchParams.get("a") === "login");
      /* 锁保证两个进程不会各自登录：认证请求至多一次。
         keepalive 先拿到锁时，其内部复核可能直接发现"已在线"（合成网关按时序响应），
         此时 login 进程因拿不到锁退出，全程 0 次登录请求——同样符合互斥预期。 */
      assert.ok(logins.length <= 1, `并发下登录请求不得超过一次，实际：${logins.length}\n${logins.join("\n")}`);
    }).finally(() => {
      releaseSharedLock(harness);
      harness.cleanup();
    });
  } catch (error) {
    releaseSharedLock(harness);
    harness.cleanup();
    throw error;
  }
});
