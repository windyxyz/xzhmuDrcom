<p align="center">
  <img src="docs/assets/xuyi-helper-this-version-300-transparent.png" width="160" height="160" alt="徐医校园网xzhmu Logo">
</p>

<h1 align="center">徐医校园网xzhmu</h1>

<p align="center">为徐州医科大学 Dr.COM 校园网提供现代登录界面、多账号管理、自动登录、连接恢复与可靠下线。</p>

当前开发版本为 **1.1.1**。扩展默认服务于 `10.10.10.2`，保留学校原始页面作为随时可切换的兜底入口，不代理学校业务，也不会把账号或诊断数据上传到项目服务器。

## 安装

推荐从浏览器官方扩展商店安装，浏览器会负责签名校验和后续更新：

- [Firefox Add-ons：徐医校园网xzhmu](https://addons.mozilla.org/zh-CN/firefox/addon/xzhmu%E5%BE%90%E5%8C%BB%E6%A0%A1%E5%9B%AD%E7%BD%91/)
- [Microsoft Edge 扩展：徐医校园网xzhmu](https://microsoftedge.microsoft.com/addons/detail/xzhmu%E5%BE%90%E5%8C%BB%E6%A0%A1%E5%9B%AD%E7%BD%91/cdcpalakhfpmnkfpogooipghkflmboei)

GitHub Release 同时提供 Chrome 与 Firefox 的审核上传 ZIP 及 SHA-256。ZIP 主要供商店提交、代码审查和开发侧载；它不是经过商店签名的 `.crx` 或 `.xpi`，普通用户应优先使用上面的商店链接。

当前验证和支持范围为 Chrome 桌面、Edge 桌面、Edge Android 和 Firefox。Chrome Android 不在支持范围，本项目不宣称支持；移动端安装请使用 Edge Android，并优先通过上面的 Microsoft Edge 扩展商店页面安装。

开发者也可以从源码加载 Chrome/Edge 版本：

1. 下载或克隆仓库。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，开启“开发人员模式”。
3. 选择“加载解压缩的扩展”，指向仓库中的 `CRX/`。
4. 连接校园网后访问 `http://10.10.10.2`，按首次安装引导完成登录。

## 账号保存规则

现代登录页和学校原始登录页采用两条不同的保存路径：

- **现代登录页**：勾选“保存账号”后，可信的真实提交会直接保存并登录；未勾选时只进行本次临时登录，不会保存账号或密码。
- **学校原始登录页**：扩展只在真实用户提交后的短窗口内捕获候选，并将其暂存并确认。登录跳转后会打开设置页显示来源、脱敏账号和覆盖提示；只有用户确认才写入持久账号，丢弃、超时或来源变化都不会保存。

网页内容脚本不能直接覆盖已经保存的账号，也不能改变当前选择或触发自动登录。

## 界面语言

扩展提供“跟随浏览器”“中文”和“English”三种语言模式。默认为“跟随浏览器”：浏览器首选语言为中文时显示中文，否则显示英文；手动选择中文或 English 后会固定使用该语言。中文品牌为“徐医校园网xzhmu”，英文品牌为“XZHMU Campus Network”。

欢迎页、弹窗、设置页和现代门户都提供语言入口，切换后会立即同步到其他扩展页面；已经填写的账号、密码和设置值不会因切换语言而被重置。学校原始页面不会被扩展翻译。

## 主要功能

- 校园网、联通、电信、移动账号管理，支持保存账号与一次性临时登录。
- 现代认证页与学校原始页面无刷新切换；验证码或页面异常时自动恢复原页面。
- 所有入口共享单一登录任务，避免弹窗、门户、浏览器启动和保活重复认证。
- 网络失败有限退避，后台重启后恢复连接状态；状态不明确时保活不会发送密码。
- 下线优先依据实时 `chkstatus` 身份解绑当前终端，必要时按当前 IP 从 `find_mac` 结果选择本机 MAC，再回退完整注销并复核离线。
- WinUI 3 风格界面、浅色/深色/跟随系统主题、强调色、材质、遮罩、自定义背景与必应每日壁纸。
- 在线信息可选经典、完整、简化或隐藏模式；账号、IP、MAC 和请求参数在界面、请求日志和导出中脱敏。
- 门户诊断模式默认关闭，仅在本机保存脱敏结构，最多 10 个会话、总计 1 MiB。

## 使用提醒

- 二维码和移动端验证码没有复刻；出现验证码时请继续使用学校原始页面。
- 自助服务、账号激活、找回密码和使用说明均在新窗口打开学校官方页面，扩展不会读取这些外部页面。
- 自定义网关只有在用户保存时才申请对应来源权限；默认网关无需额外授权。
- 如果更新扩展后旧门户标签页没有响应，请刷新该标签页，让新内容脚本重新注入。

## 安全与隐私

为了实现保存账号和自动登录，密码会以明文保存在当前浏览器配置文件的扩展 `storage.local` 中；它不是独立密码保险库。默认 Dr.COM 协议使用 HTTP GET 发送凭据，扩展无法把学校既有协议升级为 HTTPS。

门户内嵌密码框仍位于 HTTP 宿主页面，宿主脚本可能观察输入或真实用户事件；closed Shadow DOM 不能完整隔离跨文档键盘观察。当前版本保留登录体验，同时阻断原页面候选直接覆盖持久账号的投毒路径。

如果本机、浏览器配置文件或扩展权限环境发生设备失陷，或同一浏览器中存在恶意扩展，已保存凭据仍可能被读取；高风险设备建议不要保存账号。

请勿在公共 Issue、聊天或测试数据中提交真实账号、密码、Cookie、完整认证 URL、HAR、IP 或 MAC。完整边界与报告方式见 [SECURITY.md](SECURITY.md)。

## OpenWrt / SSH 脚本

`SSH/drcom-xzhmu.sh` 可在 OpenWrt/BusyBox `ash` 环境中独立完成状态检查、登录、保活和注销，不依赖浏览器、Node.js、curl、jq 或 Python。

脚本与扩展采用相同的生产登录参数和终端解绑顺序，限制 API/门户响应大小，不执行会话文件内容，并默认避免把认证 URL 暴露在进程参数中。部署步骤和安全边界见 [SSH/README.md](SSH/README.md)。

## 项目文档

- [开发指南](docs/development-guide.md)：架构、数据结构、消息接口、登录/注销数据流、测试和发布。
- [产品设计](docs/product-design.md)：交互、视觉、账号保存语义与验收条件。
- [变更日志](CHANGELOG.md)：各版本的完整变化。
- [贡献指南](CONTRIBUTING.md)：开发约束、测试和提交要求。
- [安全策略](SECURITY.md)：凭据威胁模型、延期风险与漏洞报告方式。

核心后台按职责拆分，其中 `background/state-store.js` 负责 schema 13、主状态与独立请求日志的迁移和串行写入。完整文件职责表见开发指南。

## 开发与验证

项目运行时不依赖第三方 npm 包；真实浏览器测试要求 Node.js 22 或更高版本。

```powershell
npm run verify
```

该命令依次完成静态检查、单元测试、真实 Chromium 界面测试和确定性打包验证。所有测试都使用合成数据，不访问真实校园网。

生成商店审核包：

```powershell
npm run package
npm run package:firefox
```

产物位于 `dist/`：

- `drcom-xuzhou-medical-chrome-1.1.1.zip` 与 SHA-256；
- `drcom-xuzhou-medical-firefox-1.1.1.zip` 与 SHA-256。

发布标签检查：

```powershell
npm run verify:release -- v1.1.1
```

详细发布流程、白名单规则和 GitHub Actions 行为见开发指南。版本说明由 `CHANGELOG.md` 生成，不在 README 重复维护。

## 许可证

项目按 [GNU General Public License v3.0 only](LICENSE) 发布。
