# 测试指南

项目测试分为四层，并提供统一入口 `npm test`（等价于 `npm run test:all`）：

1. `npm run test:edge`：高风险边界测试。优先覆盖 Dr.COM 非标准响应、URL/origin、安全回退、Windows Chromium/CDP 生命周期、临时文件锁与门户 IP 解析。适合修改底层代码后先快速执行。
2. `npm run test:unit`：全部非真实浏览器测试，包含协议、状态迁移、消息信任边界、并发、SSH/WSL 运行测试和 edge 测试。
3. `npm run test:browser`：真实 Chrome/Edge E2E，验证 320/360/375/390/800px 布局、粗指针、门户异步接管、验证码保留和诊断流程。
4. `npm run verify:package`：验证 Chrome/Firefox 发布包白名单、加载顺序和必需文件。

## 推荐执行顺序

完整验证直接执行：

```powershell
npm test
```

静态检查由 `scripts/static-check.js` 直接调用当前 Node 的 `--check` 并自动扫描 `CRX/` 与 `scripts/`，不再在统一入口中嵌套启动 `npm.cmd`，从而避开 Windows 子进程兼容问题。

统一入口按“静态检查 → `test:unit` → `test:browser` → `verify:package`”运行。由于 `test:unit` 已经包含 edge 测试，统一入口不会重复执行 `test:edge`，但最终汇总会明确标记 edge 已由 unit 覆盖。中间阶段失败后仍继续运行后续阶段，便于一次收集完整故障信息；只要任一阶段失败，最终退出码即为非零。

日常小改动：

```powershell
npm run check
npm run test:edge
npm run test:unit
```

涉及 UI、门户内容脚本或发布前：

```powershell
npm run check
npm run test:edge
npm run test:unit
npm run test:browser
npm run verify:package
```

## Edge 测试重点

- 协议：JSON/JSONP/query/伪对象、未知返回码、HTTP 错误优先级、Base64 错误消息、误分类保护。
- URL/账号：默认端口、非默认端口、IPv6、非法 scheme、凭据 URL、双重编码后缀、MAC 规范化。
- 门户上下文：实时 IP 与旧 URL 冲突、非法 IPv4、转义字符串、网络失败回退、1 MiB 安全上限。
- 浏览器基础设施：Windows 启动器转交、`DevToolsActivePort`、EBUSY/EPERM、stderr readiness、退出监听清理、profile 幂等删除，以及系统浏览器与本机兜底浏览器的发现优先级。

新增 bug 修复时，优先先写一个能复现 bug 的测试，再修改实现；修复完成后保留该测试作为回归测试。
