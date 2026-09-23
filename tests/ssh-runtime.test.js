"use strict";

const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const projectRoot = join(__dirname, "..");
const scriptPath = join(projectRoot, "SSH", "drcom-xzhmu.sh");

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
  const bin = join(root, "bin");
  const responses = join(root, "responses");
  mkdirSync(bin);
  mkdirSync(responses);

  const ip = options.ip || "172.28.180.144";
  writeFixture(join(root, "config"), [
    "USERNAME='configured-user'",
    "PASSWORD='test-password'",
    "SUFFIX=''",
    "PORTAL='http://10.10.10.2'",
    "ENABLE_FIND_MAC='1'",
    "CONNECT_TIMEOUT='1'",
    ""
  ].join("\n"));
  writeFixture(join(responses, "portal"), `var v46ip = "${ip}";\n`);
  writeFixture(join(responses, "status-online"), options.statusOnline ||
    `dr1001({"result":1,"uid":"student@telecom","v46ip":"${ip}","ss4":"580205DC58C2"})`);
  writeFixture(join(responses, "status-after"), options.statusAfter ||
    "dr1001({\"result\":0,\"msg\":\"offline\"})");
  writeFixture(join(responses, "find-mac"), options.findMac ||
    "dr1004({\"result\":0})");
  writeFixture(join(responses, "login"), "dr1002({\"result\":1,\"msg\":\"login success\"})");
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
    if [ "$count" -eq 1 ]; then source="$FAKE_RESPONSE_DIR/status-online"; else source="$FAKE_RESPONSE_DIR/status-after"; fi
    ;;
  *a=find_mac*) source="$FAKE_RESPONSE_DIR/find-mac" ;;
  *a=login*) source="$FAKE_RESPONSE_DIR/login" ;;
  *a=unbind_mac*) source="$FAKE_RESPONSE_DIR/unbind" ;;
  *a=logout*) source="$FAKE_RESPONSE_DIR/logout" ;;
  *) source="$FAKE_RESPONSE_DIR/portal" ;;
esac
if [ "$output" = "-" ]; then cat "$source"; else cat "$source" > "$output"; fi
`);
  writeFixture(join(bin, "sleep"), `#!/bin/sh
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
    sleepLog: join(root, "sleep.log")
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
    `export FAKE_SLEEP_LOG=${shellQuote(shellPath(paths.sleepLog))}`
  ];

  return {
    paths,
    run(command) {
      const invocation = `${exports.join("; ")}; sh ${shellQuote(shellPath(scriptPath))} ${command}`;
      return spawnSync(process.platform === "win32" ? "bash" : "sh", ["-c", invocation], {
        encoding: "utf8",
        timeout: 15000
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

test("SSH 无本地会话时使用 chkstatus 的在线身份和 ss4 解绑", () => {
  const harness = createHarness();
  try {
    const result = harness.run("logout");
    const rawRequests = requestUrls(harness.paths.requestLog);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${rawRequests.join("\n")}`);
    const requests = rawRequests.map((value) => new URL(value));
    const unbind = requests.find((url) => url.searchParams.get("a") === "unbind_mac");
    assert.equal(requests.filter((url) => url.hostname === "127.0.0.1").length, 1, "wget -i 能力只探测一次");
    assert.ok(unbind, "应发送 unbind_mac");
    assert.equal(unbind.searchParams.get("user_account"), "student@telecom");
    assert.equal(unbind.searchParams.get("wlan_user_ip"), "172.28.180.144");
    assert.equal(unbind.searchParams.get("wlan_user_mac"), "580205DC58C2");
    assert.equal(requests.some((url) => url.searchParams.get("a") === "logout"), false);
    assert.equal(readFileSync(harness.paths.sleepLog, "utf8").trim().split(/\r?\n/)[0], "5");
  } finally {
    harness.cleanup();
  }
});

test("SSH 的 ss4 无效时只采用 find_mac 中当前 IP 对应的 MAC", () => {
  const harness = createHarness({
    statusOnline: "dr1001({\"result\":1,\"uid\":\"student\",\"v46ip\":\"172.28.180.144\",\"ss4\":\"111111111111\"})",
    findMac: "dr1004({\"result\":1,\"list\":[{\"online_ip\":\"172.28.180.99\",\"online_mac\":\"11:22:33:44:55:66\"},{\"online_ip\":\"172.28.180.144\",\"online_mac\":\"58:02:05:DC:58:C2\"}]})"
  });
  try {
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    const findMac = requests.filter((url) => url.searchParams.get("a") === "find_mac");
    const unbind = requests.find((url) => url.searchParams.get("a") === "unbind_mac");
    assert.equal(findMac.length, 1);
    assert.equal(findMac[0].searchParams.get("user_account"), "student");
    assert.ok(unbind, `${result.stderr}\n${requestUrls(harness.paths.requestLog).join("\n")}`);
    assert.equal(unbind.searchParams.get("wlan_user_mac"), "580205DC58C2");
  } finally {
    harness.cleanup();
  }
});

test("SSH 会话文件按数据解析，不执行其中的 shell 内容", () => {
  const harness = createHarness();
  const marker = join(harness.paths.root, "executed");
  try {
    writeFixture(harness.paths.session, [
      "SESSION_IP=172.28.180.144",
      "SESSION_MAC=580205DC58C2",
      `touch ${shellQuote(shellPath(marker))}`,
      ""
    ].join("\n"));
    harness.run("logout");
    assert.equal(existsSync(marker), false);
  } finally {
    harness.cleanup();
  }
});

test("SSH 拒绝超过 64 KiB 的状态响应", () => {
  const largeStatus = `dr1001({"result":1,"msg":"${"a".repeat(70 * 1024)}"})`;
  const harness = createHarness({ statusOnline: largeStatus, statusAfter: largeStatus });
  try {
    const result = harness.run("status");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /state=unknown/);
  } finally {
    harness.cleanup();
  }
});

test("SSH 状态响应通过有界管道读取，不让 wget 先写完整临时文件", () => {
  const largeStatus = `dr1001({"result":1,"msg":"${"a".repeat(70 * 1024)}"})`;
  const harness = createHarness({ statusOnline: largeStatus, statusAfter: largeStatus });
  try {
    const result = harness.run("status");
    const outputs = readFileSync(harness.paths.wgetOutputLog, "utf8").trim().split(/\r?\n/);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /state=unknown/);
    assert.equal(outputs[1], "-", "chkstatus 应经 stdout 管道进入大小限制读取器");
  } finally {
    harness.cleanup();
  }
});

test("SSH 登录沿用生产请求：不查询 find_mac 且网络身份字段保持空值", () => {
  const harness = createHarness({
    statusOnline: "dr1001({\"result\":0,\"msg\":\"offline\"})",
    statusAfter: "dr1001({\"result\":1,\"uid\":\"configured-user\",\"v46ip\":\"172.28.180.144\"})"
  });
  try {
    const result = harness.run("login");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    assert.equal(requests.some((url) => url.searchParams.get("a") === "find_mac"), false);
    const login = requests.find((url) => url.searchParams.get("a") === "login");
    assert.ok(login, "应发送 Portal/login");
    assert.equal(login.searchParams.get("wlan_user_mac"), "000000000000");
    assert.equal(login.searchParams.get("wlan_user_ipv6"), "");
    assert.equal(login.searchParams.get("wlan_ac_ip"), "");
    assert.equal(login.searchParams.get("wlan_ac_name"), "");
  } finally {
    harness.cleanup();
  }
});

test("SSH 完整注销兜底携带学校页面要求的 VLAN 标记", () => {
  const harness = createHarness({
    statusOnline: "dr1001({\"result\":1,\"v46ip\":\"172.28.180.144\",\"ss4\":\"111111111111\"})"
  });
  try {
    const result = harness.run("logout");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const requests = requestUrls(harness.paths.requestLog).map((value) => new URL(value));
    const logout = requests.find((url) => url.searchParams.get("a") === "logout");
    assert.ok(logout, "应发送完整 Portal/logout");
    assert.equal(logout.searchParams.get("wlan_vlan_id"), "1");
  } finally {
    harness.cleanup();
  }
});
