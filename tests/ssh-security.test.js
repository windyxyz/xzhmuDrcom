"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const source = readFileSync(join(__dirname, "..", "SSH", "drcom-xzhmu.sh"), "utf8");

test("SSH 解析先验证完整协议容器且不从任意正文抽取字段", () => {
  assert.match(source, /protocol_payload\(\)/);
  const extractor = source.match(/extract_value\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(extractor, /payload="\$\(protocol_payload "\$1"\)"/);
  assert.match(extractor, /printf '%s' "\$payload"/);
  assert.doesNotMatch(extractor, /printf '%s' "\$1"/);
});

test("SSH 的明确登录成功仍必须复核在线，未知状态按失败处理", () => {
  const successBranch = source.match(/if \[ "\$rc" = "0" \]; then([\s\S]*?)\n  fi/)?.[1] || "";
  assert.match(successBranch, /query_status_state/);
  assert.match(successBranch, /\[ "\$state" = "online" \]/);
  assert.ok(successBranch.indexOf("query_status_state") < successBranch.indexOf("save_session"));
});

test("SSH 配置解析使用可移植 tr 清除 CR，短账号脱敏返回 ****，debug_server 失败时退避", () => {
  const loadConfig = source.match(/load_config\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(loadConfig, /tr -d '\\r'/);
  assert.doesNotMatch(loadConfig, /sed[^'\n]*\\r\$/);

  const maskAccount = source.match(/mask_account\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(maskAccount, /\[ "\$length" -le 4 \]/);
  assert.match(maskAccount, /printf '%s' "\*\*\*\*"/);

  const debugServer = source.match(/cmd_debug_server\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(debugServer, /if ! \{[\s\S]*nc -l -s "\$DEBUG_BIND" -p "\$DEBUG_PORT"; then\s+sleep 1/);
});
