"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const projectRoot = join(__dirname, "..");

function read(path) {
  return readFileSync(join(projectRoot, path), "utf8");
}

test("README、开发文档和安全策略明确记录凭据威胁模型", () => {
  for (const path of ["README.md", "docs/development-guide.md", "SECURITY.md"]) {
    const content = read(path);
    assert.match(content, /storage\.local/, `${path} 必须说明本机凭据存储位置`);
    assert.match(content, /HTTP/, `${path} 必须说明门户明文传输边界`);
    assert.match(content, /设备失陷|设备被攻破/, `${path} 必须说明设备失陷风险`);
    assert.match(content, /恶意扩展/, `${path} 必须说明恶意扩展风险`);
    assert.match(content, /界面、日志和导出|界面、请求日志和导出/, `${path} 必须说明默认隐藏密码`);
  }
});

test("安全策略禁止在漏洞报告中附带真实凭据", () => {
  const security = read("SECURITY.md");
  assert.match(security, /不要.*真实账号|不得.*真实账号/);
  assert.match(security, /密码|凭据/);
  assert.match(security, /私密|非公开/);
});
test("安全策略登记保留体验后的延期和接受风险", () => {
  const security = read("SECURITY.md");
  for (const term of [
    "门户内嵌密码框",
    "HTTP 宿主页面",
    "宿主脚本可能观察",
    "closed Shadow DOM",
    "只阻断持久账号投毒",
    "明文存在受限 `storage.local`",
    "HTTP GET 发送凭据"
  ]) {
    assert.equal(security.includes(term), true, term);
  }
});
