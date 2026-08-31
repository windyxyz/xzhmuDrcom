# 参与贡献

感谢你改进 DrCom徐医。项目使用原生 HTML、CSS、JavaScript 和 Chrome Manifest V3，不引入运行时或测试第三方依赖。

## 开发环境

- Node.js 20 或更高版本；持续集成使用 Node.js 24。
- 本机 Chrome、Edge 或其他 Chromium 浏览器，用于真实布局测试和手工加载。
- 从源码加载时，在扩展管理页开启开发者模式并选择 `CRX/`。

## 开发流程

1. 从最新代码建立独立分支。
2. 功能或缺陷修复先添加能失败的回归测试，再实现最小改动。
3. 只修改任务所需文件；删除文件前检查 Manifest、HTML、脚本、样式、测试和文档引用，并确认没有独有内容。
4. 运行定向测试，再执行完整验证：

   ```powershell
   npm run verify
   ```

5. 涉及发布内容时再执行：

   ```powershell
   npm run package
   ```

   `dist/` 是可重新生成的构建产物，不提交到源码仓库。

提交应保持单一目的，标题使用清楚的动词，例如 `fix: ...`、`feat: ...`、`refactor: ...`、`docs: ...` 或 `build: ...`。

## 验证要求

- `npm run check`：全部运行时和构建脚本语法检查。
- `npm run test:unit`：后台、状态迁移、安全边界和 UI 逻辑。
- `npm run test:browser`：使用本机 Chromium 验证真实页面布局和进程清理。
- `npm run verify:package`：发布白名单、固定时间戳和重复构建一致性。
- `npm run verify`：汇总以上全部检查。

改动账号、退出、消息来源、DrCOM 解析、迁移或打包逻辑时，必须补充对应边界场景；破坏性操作必须支持取消、键盘操作，并让默认焦点避开危险按钮。

## 安全与隐私

不要提交真实账号、密码、完整认证 URL、Cookie、浏览器配置文件、未脱敏日志或包含敏感数据的截图。测试固定值必须显然是虚构数据。

安全问题请遵循 [`SECURITY.md`](SECURITY.md)，使用私密、非公开渠道。不要用公开讨论代替漏洞报告。

## 许可证

提交贡献即表示你有权提供这些内容，并同意按 [GPL-3.0-only](LICENSE) 许可项目整体发布。
