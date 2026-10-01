"use strict";

const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = join(__dirname, "..", "..");
const scriptPath = join(projectRoot, "SSH", "drcom-xzhmu.sh");

/* SSH 运行时测试依赖 POSIX FIFO 与真实 shell 语义。Windows 上通过 WSL 的
   /mnt/<盘符> 路径执行；WSL 不可用时测试应跳过而不是报假失败。 */
let shellProbe = null;

function detectSshShell() {
  if (shellProbe) return shellProbe;
  if (process.platform !== "win32") {
    shellProbe = "native";
    return shellProbe;
  }
  try {
    const probe = spawnSync(
      "bash",
      ["-c", 'if [ -d /mnt/c ] || [ -d /mnt/d ]; then echo wsl; else echo unavailable; fi'],
      { encoding: "utf8", timeout: 15000 }
    );
    shellProbe = !probe.error && String(probe.stdout).trim() === "wsl" ? "wsl" : "unavailable";
  } catch (error) {
    shellProbe = "unavailable";
  }
  return shellProbe;
}

const SSH_SKIP_REASON =
  "SSH 运行时测试需要 WSL（Windows）或原生 POSIX 环境；当前环境缺少 /mnt/<盘符> 挂载，已跳过。";

async function sshEnvironmentReady(testContext) {
  const shell = detectSshShell();
  if (shell === "unavailable") {
    if (testContext && typeof testContext.skip === "function") testContext.skip(SSH_SKIP_REASON);
    return false;
  }
  return true;
}

function shellPath(path) {
  if (process.platform !== "win32") return path;
  const match = String(path).match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return String(path).replaceAll("\\", "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeFixture(path, content) {
  writeFileSync(path, content, "utf8");
}

function createHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "drcom-ssh-"));
  const defaultLockPath = `/tmp/drcom-xzhmu-test-lock-${basename(root)}`;
  const lockPath = options.lockPath || defaultLockPath;
  const bin = join(root, "bin");
  const responses = join(root, "responses");
  mkdirSync(bin);
  mkdirSync(responses);

  const ip = options.ip || "172.28.180.144";
  writeFixture(join(root, "config"), [
    "USERNAME='configured-user'",
    "PASSWORD='test-password'",
    "SUFFIX=''",
    `PORTAL='${options.portal || "http://10.10.10.2"}'`,
    ...(options.apiUrl ? [`API_URL='${options.apiUrl}'`] : []),
    "ENABLE_FIND_MAC='1'",
    "CONNECT_TIMEOUT='1'",
    ""
  ].join("\n"));
  writeFixture(join(responses, "portal"), `var v46ip = "${ip}";\n`);
  writeFixture(join(responses, "status-online"), options.statusOnline ||
    `dr1001({"result":1,"uid":"student@telecom","v46ip":"${ip}","ss4":"580205DC58C2"})`);
  writeFixture(join(responses, "status-after"), options.statusAfter ||
    "dr1001({\"result\":0,\"msg\":\"offline\"})");
  writeFixture(join(responses, "status-3"), options.status3 ||
    options.statusAfter || "dr1001({\"result\":0,\"msg\":\"offline\"})");
  writeFixture(join(responses, "status-4"), options.status4 ||
    options.statusAfter || "dr1001({\"result\":0,\"msg\":\"offline\"})");
  writeFixture(join(responses, "find-mac"), options.findMac ||
    "dr1004({\"result\":0})");
  writeFixture(join(responses, "login"), options.loginResponse || "dr1002({\"result\":1,\"msg\":\"login success\"})");
  writeFixture(join(responses, "unbind"), "dr1002({\"result\":1,\"msg\":\"unbind success\"})");
  writeFixture(join(responses, "logout"), "dr1002({\"result\":1,\"msg\":\"logout success\"})");

  writeFixture(join(bin, "wget"), `#!/bin/sh
input=""
url=""
output="-"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -i) shift; input="$1" ;;
    -O) shift; output="$1" ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done
[ -n "$input" ] && url="$(cat "$input")"
printf '%s\\n' "$url" >> "$FAKE_WGET_LOG"
printf '%s\\n' "$output" >> "$FAKE_WGET_OUTPUT_LOG"
source=""
case "$url" in
  http://127.0.0.1:1/*) exit 1 ;;
  *chkstatus*)
    count="$(grep -c 'chkstatus' "$FAKE_WGET_LOG")"
    source="$FAKE_RESPONSE_DIR/status-after"
    case "$count" in
      1) source="$FAKE_RESPONSE_DIR/status-online" ;;
      3) source="$FAKE_RESPONSE_DIR/status-3" ;;
      4|5|6|7|8|9|10|11|12|13|14|15) source="$FAKE_RESPONSE_DIR/status-4" ;;
    esac
    ;;
  *a=find_mac*) source="$FAKE_RESPONSE_DIR/find-mac" ;;
  *a=login*) source="$FAKE_RESPONSE_DIR/login" ;;
  *a=unbind_mac*) source="$FAKE_RESPONSE_DIR/unbind" ;;
  *a=logout*) source="$FAKE_RESPONSE_DIR/logout" ;;
  *) source="$FAKE_RESPONSE_DIR/portal" ;;
esac
if [ "$output" = "-" ]; then cat "$source"; else cat "$source" > "$output"; fi
`);
  writeFixture(join(bin, "sleep"), options.sleep || `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SLEEP_LOG"
`);
  chmodSync(join(bin, "wget"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);

  const paths = {
    root,
    bin,
    responses,
    config: join(root, "config"),
    session: join(root, "session"),
    requestLog: join(root, "requests.log"),
    wgetOutputLog: join(root, "wget-output.log"),
    sleepLog: join(root, "sleep.log"),
    lock: lockPath
  };
  const exports = [
    `export PATH=${shellQuote(shellPath(bin))}:"$PATH"`,
    `export DRCOM_CONFIG=${shellQuote(shellPath(paths.config))}`,
    `export DRCOM_SESSION=${shellQuote(shellPath(paths.session))}`,
    // DrvFS-backed Windows temp directories do not support named pipes; the
    // runtime FIFO must live on the WSL/Linux filesystem used to run the script.
    `export TMPDIR=/tmp`,
    `export FAKE_RESPONSE_DIR=${shellQuote(shellPath(responses))}`,
    `export FAKE_WGET_LOG=${shellQuote(shellPath(paths.requestLog))}`,
    `export FAKE_WGET_OUTPUT_LOG=${shellQuote(shellPath(paths.wgetOutputLog))}`,
    `export FAKE_SLEEP_LOG=${shellQuote(shellPath(paths.sleepLog))}`,
    // 默认每个 harness 一个真正唯一的锁路径，避免 Node 并行 test 文件互相干扰；
    // 不使用单引号中的 "$$"（那会成为字面量而不是 shell PID）。并发/锁测试
    // 通过 options.lockPath 显式指定共享锁路径。
    `export DRCOM_LOCK=${shellQuote(lockPath)}`
  ];

  let compositeCounter = 0;

  function writeCompositeScript(script) {
    /* 复合脚本（含 $!、$?、引号等）必须落盘后由 WSL 直接读取执行：
       WSL 的 bash.exe 在 -c 参数传递时会吃掉裸 $ 展开，写成文件则原样保留。 */
    compositeCounter += 1;
    const scriptFile = join(root, `.composite-${compositeCounter}.sh`);
    const body = `${exports.join("\n")}\n${String(script).replace(/\r\n/g, "\n")}\n`;
    writeFileSync(scriptFile, body, "utf8");
    return scriptFile;
  }

  return {
    paths,
    run(command, runOptions = {}) {
      const invocation = [
        exports.join("; "),
        runOptions.envPrefix || "",
        `sh ${shellQuote(shellPath(scriptPath))} ${command}`
      ].filter(Boolean).join("; ");
      const spawnOptions = {
        encoding: "utf8",
        timeout: runOptions.timeout || 15000
      };
      if (runOptions.signal) spawnOptions.signal = runOptions.signal;
      return spawnSync(process.platform === "win32" ? "bash" : "sh", ["-c", invocation], spawnOptions);
    },
    runShell(script, runOptions = {}) {
      // 在被测环境（WSL/POSIX）内部执行一段组合脚本，用于信号与并发时序控制。
      // 脚本先落盘再执行，避免 WSL bash.exe 对 -c 参数里的 $ 展开做二次处理。
      const scriptFile = writeCompositeScript(script);
      try {
        return spawnSync(process.platform === "win32" ? "bash" : "sh", [shellPath(scriptFile)], {
          encoding: "utf8",
          timeout: runOptions.timeout || 60000
        });
      } finally {
        rmSync(scriptFile, { force: true });
      }
    },
    spawnDetached(command) {
      // 用于信号测试：返回 child_process.spawn 结果，由调用方控制生命周期。
      const { spawn } = require("node:child_process");
      const scriptFile = writeCompositeScript(`sh ${shellPath(scriptPath)} ${command}\n`);
      return spawn(process.platform === "win32" ? "bash" : "sh", [shellPath(scriptFile)], {
        encoding: "utf8"
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function requestUrls(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
}

module.exports = {
  SSH_SKIP_REASON,
  createHarness,
  detectSshShell,
  requestUrls,
  scriptPath,
  shellPath,
  shellQuote,
  sshEnvironmentReady,
  writeFixture
};
