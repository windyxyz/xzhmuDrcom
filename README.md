<p align="center">
  <img src="docs/assets/xzhmu-drcom-logo.png" width="320" height="320" alt="徐医校园网xzhmu Logo">
</p>

<h1 align="center">徐医校园网xzhmu</h1>

<p align="center">为徐州医科大学 Dr.COM 校园网提供快捷登录、多账号管理和掉线重连的浏览器扩展。</p>
<p align="center">
  <a href="https://github.com/windyxyz/xzhmuDrcom/releases/latest">GitHub Releases</a> ·
  <a href="https://microsoftedge.microsoft.com/addons/detail/cdcpalakhfpmnkfpogooipghkflmboei">Edge 扩展商店</a> ·
  <a href="https://addons.mozilla.org/zh-CN/firefox/addon/%E5%BE%90%E5%8C%BB%E6%A0%A1%E5%9B%AD%E7%BD%91xzhmu/">Firefox Add-ons</a>
</p>
## 安装

| 平台 | 安装方式 |
| --- | --- |
| Edge 桌面 | [Edge 扩展商店](https://microsoftedge.microsoft.com/addons/detail/cdcpalakhfpmnkfpogooipghkflmboei) |
| Firefox 桌面 | [Firefox Add-ons](https://addons.mozilla.org/zh-CN/firefox/addon/%E5%BE%90%E5%8C%BB%E6%A0%A1%E5%9B%AD%E7%BD%91xzhmu/) |
| Chrome 桌面 / Edge 桌面手动安装 | 从 [GitHub Releases](https://github.com/windyxyz/xzhmuDrcom/releases/latest) 下载 Chromium ZIP，解压后在扩展管理页加载 |

当前开发版本为 **1.1.3**。商店版的可用版本以各商店审核和上架进度为准。

支持范围为 Chrome 桌面、Edge 桌面、Edge Android 和 Firefox 桌面。移动端布局通过 Chromium 移动视口模拟验证。Edge Android 真机完整链路仍未验证。Chrome Android 不在支持范围内。

**手动安装 Chromium 版**

1. 解压 Release 中的 `drcom-xuzhou-medical-chrome-1.1.3.zip`。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，开启开发者模式。
3. 选择「加载已解压的扩展程序」，打开包含 `manifest.json` 的解压目录。从源码安装时选择仓库内的 `CRX/`。
4. 连上校园网后打开 `http://10.10.10.2`，或从浏览器工具栏打开扩展。

Firefox 的 Release ZIP 用于商店提交。日常安装请使用 Firefox Add-ons 提供的签名版本。

## 账号保存规则

- 在扩展提供的现代登录页勾选「保存账号」后，登录时会保存该账号。取消勾选可临时登录。
- 在学校原始登录页提交表单时，扩展短暂接收候选账号。启用「暂存并确认」后，可到设置页查看来源和掩码提示，并确认是否写入账号库。

## 界面语言

可选择「跟随浏览器」「简体中文」或「English」。跟随浏览器时，中文语言环境显示简体中文，其他语言环境显示 English。

## 主要功能

- **登录与连接恢复**｜在工具栏登录、注销或查询连接状态，按需启用自动登录和掉线重连。
- **多账号管理**｜保存、切换或新建账号，支持校园网、电信、联通和移动账号后缀。
- **校园网门户美化**｜在现代界面与学校原始页面之间切换。账号激活、找回密码和使用说明仍通过学校页面办理。
- **外观与诊断**｜切换主题、强调色和背景，使用自定义图片或每日壁纸。需要排查问题时可按需启用增强诊断并导出日志。

## 隐私

保存账号时，凭据存放在当前浏览器配置文件的扩展 `storage.local` 中。默认 Dr.COM 网关通过 HTTP GET 发送认证凭据。界面、日志和导出默认隐藏密码。校园网页面的宿主脚本可能观察输入或用户事件，设备失陷或安装恶意扩展也可能导致凭据泄露。报告问题时请移除真实账号、密码、Cookie、认证 URL、IP 和 MAC。详见 [安全策略](SECURITY.md)。

## OpenWrt / SSH

`SSH/drcom-xzhmu.sh` 可在 OpenWrt 的 BusyBox `ash` 环境独立运行，提供状态查询、登录、保活和注销。安装和配置见 [OpenWrt / SSH 使用指南](SSH/README.md)。

## 开发与贡献

项目使用原生 HTML、CSS 和 JavaScript。开发需要 Node.js 22 或更高版本，后台状态由 `CRX/background/state-store.js` 管理。

```powershell
npm test
npm run package
npm run package:firefox
npm run verify:release -- v1.1.3
```

构建输出位于 `dist/`，包含 `drcom-xuzhou-medical-chrome-1.1.3.zip`、`drcom-xuzhou-medical-firefox-1.1.3.zip` 和各自的 SHA-256 校验文件。推送版本标签后，GitHub Actions 验证源码和包，再创建 Release。

[开发指南](docs/development-guide.md) · [产品设计](docs/product-design.md) · [测试指南](docs/testing-guide.md) · [贡献指南](CONTRIBUTING.md) · [GPL-3.0-only](LICENSE)
