# 徐医校园网xzhmu 全面审阅、UI 宽度修复、功能推进与性能优化 Implementation Plan

> **Status:** 全部任务（Task 1–4）已完成并通过全量自动化测试与无头浏览器视觉验收。

**Goal:** 修复 Popup 弹出界面宽度坍缩与高度膨胀、Options 移动端导航栏与外观布局挤压、Portal 壁纸焦点与交互缺陷、Background 核心竞态与存储写入风暴等问题；推进“独立 `+` 新建账号按钮”、必应每日壁纸调节、门户外观实时同步等实用功能；全面优化 UI 细节与渲染/序列化性能。

**Tech Stack:** Manifest V3、原生 JavaScript IIFE/CommonJS 兼容模块、Chrome/Firefox WebExtension API、HTML/CSS（WinUI 3 风格 Design Tokens）、Node.js `node:test`、无头浏览器自动化测试、POSIX Shell (`SSH/drcom-xzhmu.sh`)。

---

## 已确认的产品与设计决策

1. **实施节奏**：本次先将完整计划入库保存，代码保持基线状态待后续分批或全量执行。
2. **新建账号入口**：在 Popup 与 Options 账号区域中，均采用**独立的 `+` 按钮**（如 `+` / `+ 新建账号`，带 `aria-label` 与双语提示），与已有账号切换控件分离，避免覆盖当前选中账号。
3. **必应每日一图（`daily`）外观调节**：在 Options 外观页中为 `daily` 每日壁纸开放与自定义壁纸相同的模糊度、暗化、缩放与九宫格焦点调节控件（`#background-controls` 在 `custom || daily` 时均显示）。

---

## 基线验证数据（2026-11-23）

| 检查项 | 结果 | 备注 |
| --- | --- | --- |
| `npm run check` | PASS | 44 个 JS 文件静态检查通过 |
| `npm run test:unit` | PASS | 536 项（497 通过，0 失败，39 跳过 — Windows 无 WSL 挂载的 SSH 运行时测试） |
| `npm run test:edge` | PASS | 96 项（86 通过，0 失败，10 跳过） |
| `npm run test:browser` | PASS | 14/14 项通过（Edge Beta 无头渲染） |

**实测可视渲染基线问题**：
- `CRX/popup.html`（420×680）：中文 `scrollHeight: 825px`、英文 `scrollHeight: 832px`，超出 Chrome 600px 弹窗上限 >225px，出现常驻垂直滚动条（吃掉约 15px 内容宽度），已保存账号与底部栏掉出首屏；英文 `.actions` 主按钮换行；360×680 下 `scrollHeight: 965px`。
- `CRX/options.html`（390×844）：移动端底部导航栏最左侧残留桌面端侧边栏折叠按钮（`≡`），占用约 1/6 宽度。
- `CRX/portal-preview.html`（390×844）：顶栏换行分为两行，品牌标题与操作按钮错位。

---

## Global Constraints（必须遵守的既有契约）

- 简体中文产品名保持 `徐医校园网xzhmu`，英文产品名保持 `XZHMU Campus Network`。
- `CRX/background.js` 行数保持 `< 100` 行（`tests/background.test.js:261`）。
- `CRX/i18n-messages.js` 保留测试专用键 `unsafe_test` 与 `zh_only_test`（`tests/i18n.test.js:45, 49`），未知网关原文不得强行翻译。
- `CRX/animated-characters.js` 保留 `destroy()` 清理代码片段（`tests/ui-contract.test.js:312`）；`CRX/options.html` 不引入内联 `<svg>` 且保持脚本加载顺序与 5 个导航项。
- `CRX/options.css` 保留 `@media (max-width: 1024px)` 下 `.cp-main` / `.cp-spectrum` / `.cp-side` 规则；`CRX/portal.css` 保留 `.drcom-password-toggle` 的 `44px × 44px` 最小热区（`tests/responsive-ui.test.js`）。
- `CRX/background/connection-service.js` 不因 `chkstatus result: 0` 短路跳过 `unbind_mac`/`logout`，且保持 `confirmPortalOffline >= 5000ms`（`tests/connection-runtime.test.js`）。
- 导出诊断日志后保留同步 `URL.revokeObjectURL` 调用契约（`tests/options-ui.test.js:477`）。
- 如新增任何扩展发布文件，必须同步更新 `scripts/package-extension.js` 中的 `RELEASE_FILES` 白名单。

---

## Task 1: Popup、Welcome、ConfirmDialog 宽度/布局修复与 UI/性能优化

**Exclusive Files:**
- Modify: `CRX/popup.html`, `CRX/popup.css`, `CRX/popup.js`
- Modify: `CRX/welcome.html`, `CRX/welcome.css`, `CRX/welcome.js`
- Modify: `CRX/confirm-dialog.js`
- Modify: `CRX/design-tokens.css`
- Modify: `tests/popup-ui.test.js`, `tests/welcome.test.js`, `tests/welcome-layout.test.js`, `tests/confirm-dialog.test.js`, `tests/responsive-ui.test.js`

### P0 — 宽度、高度与核心 UI 缺陷
- [x] **修复 Popup 真实扩展弹窗宽度坍缩**（`CRX/popup.css:5-6, 13`）：
  - 根因：`html { width: min(420px, 100vw); max-width: 100%; }` 在 Chromium `ExtensionViewHost::EnableAutoResize(min=25×25)` 初始化时按 25px 初始视口解析 `100vw`，导致弹窗无法撑开至 420px，并误触发 `@media (max-width: 380px)`。
  - 修复：桌面默认设显式 `html, body { width: 420px; }`；仅在 `@media (pointer: coarse), (hover: none), (max-width: 420px)` 下启用 `width: min(420px, 100vw); max-width: 100%;`；同步更新 `tests/responsive-ui.test.js:44-50`。
- [x] **修复桌面 Popup 控件被强制撑高至 44px 导致的高度膨胀与滚动条**（`CRX/design-tokens.css:442-453`, `CRX/popup.css:29`）：
  - 根因：`@media (max-width: 640px), (pointer: coarse)` 在 420px 桌面弹窗中恒成立且优先级高于 `popup.css`，导致总高超 825px 并挤出垂直滚动条。
  - 修复：将 Popup 内 44px 触控尺寸限定为 `@media (pointer: coarse)`，桌面端维持 32px/36px 紧凑控件与紧凑间距，力争首屏控制在 600px 以内；同步调整 `tests/welcome-layout.test.js:528` 的等待条件。
- [x] **修复 Popup 英文按钮换行、运营商下拉截断与对齐细节**（`CRX/popup.css:6, 76, 84, 112, 118`, `CRX/popup.html:29`）：
  - `body` 显式设置 `font-size: 14px`；
  - `.grid-two` 改为 `grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr)`；
  - `.actions` 改为 `grid-template-columns: minmax(0, 1fr) auto auto` 且次按钮 `white-space: nowrap`；
  - `footer` 去除多余左右 `8px` 内边距与卡片对齐；`.account-main strong` 加 `overflow-wrap: anywhere`；`#request-url:empty { display: none; }`。
- [x] **修复 `.toast` 居中样式冲突与实色材质背景透明**（`CRX/design-tokens.css:1032-1047`, `CRX/popup.css:121-123`）：
  - `design-tokens.css` 为 `.toast` 补充 `background: var(--flyout-bg);`；
  - `popup.css` 统一居中样式（`left: 50%; right: auto; transform: translateX(-50%); width: max-content; max-width: calc(100% - 24px); z-index: 1000;`）。
- [x] **修复 `ConfirmDialog` 窄屏溢出与取消按钮边框缺失**（`CRX/design-tokens.css:837-840, 888-892`）：
  - `min-width: min(320px, calc(100vw - 24px))`；`.confirm-dialog-cancel` 补充 `border-color: var(--stroke-default);`。
- [x] **修复 `#login .win-ring` 进度环弧长与颜色不可见**（`CRX/design-tokens.css:923-938`）：
  - `win-ring-trim` 关键帧改为 `stroke-dasharray: 50 50`（0→50→0 弧长）；增加 `.primary .win-ring circle { stroke: var(--accent-text); }`。
- [x] **修复 Welcome 页 `float: right` 语言按钮与窄屏安全区**（`CRX/welcome.html:25-30`, `CRX/welcome.css:25, 96-161, 220`）：
  - 改用 Flex 顶栏布局并补齐 `:hover`/`:active` 态；`.welcome-shell` 使用 `minmax(0, 1.05fr) minmax(0, 0.95fr)`；`.setup-steps li` 首列由 `40px` 调整为 `28px`；`.portal-panel h2` 加 `overflow-wrap: anywhere`；保留 `@media (max-width: 420px)` 下的 `env(safe-area-inset-*)`。
- [x] **全局 Design Tokens 补充修复**（`CRX/design-tokens.css:312-318, 694`）：
  - `body.app-themed-page::before` 增加 `background-repeat: no-repeat;`（修复 `contain` 模式壁纸平铺）；
  - 为 `<select>` 补充暗色模式下拉箭头对比度与 `@media (forced-colors: active) { select { appearance: auto; background-image: none; } }`。

### P1/P2 — 功能推进与前端性能
- [x] **Popup 新增独立 `+` 新建账号按钮**（`CRX/popup.html`, `CRX/popup.css`, `CRX/popup.js`）：
  - 在账号切换栏旁放置独立的 `+` 按钮（绑定 `new_account` 双语标题/无障碍标签），点击清空表单进入新建态，保存时生成新账号 ID 而不覆盖当前选中账号。
- [x] **Popup 交互与健壮性完善**（`CRX/popup.js`）：
  - 表单输入框支持 `Enter` 键提交登录；
  - 拆分 `setBusy()` 与刷新状态动画：点击 `#refresh-status` 时旋转刷新图标并加防重入保护，登录/注销时仅激活主按钮进度环；
  - 补齐 `state == null` 防护、`new URL(portalUrl)` 的 `try/catch`、`saveCurrentAccount()` 空字段校验；
  - 为 `.status-panel` 按 `data-state` 增加 WinUI InfoBar 语义色条。
- [x] **Welcome & ConfirmDialog 细节修复**（`CRX/welcome.js:67-68`, `CRX/confirm-dialog.js:24-57`）：
  - 语言切换成功后自动隐藏 `#language-save-status` 错误条；
  - 对话框关闭时恢复焦点至打开前的触发元素。
- [x] **Popup & Welcome 渲染与启动性能**：
  - 移除 `popup.html` 中 `.status-panel` 上多余的 `.glass-chrome` 类（消除额外 `backdrop-filter: blur(30px)` GPU 回读）；
  - `welcome.css` `.welcome-blob` 由 `filter: blur(80px)` 改为无滤镜 `radial-gradient`；
  - 并行化 `popup.js` / `welcome.js` 启动时的 `loadLanguage()` 与 `state:get`，并在 Popup 会话内缓存 `wallpaper:get` 的 Data URL；
  - 柔化 Popup `.shell` 入场动画（保持 `.welcome-shell`/`.settings-shell` 的 `0.45s` 测试契约）。

---

## Task 2: Options 设置页、Portal 美化层、外观与动画角色

**Exclusive Files:**
- Modify: `CRX/options.html`, `CRX/options.css`, `CRX/options.js`, `CRX/options-*.js`
- Modify: `CRX/portal.css`, `CRX/portal-*.js`, `CRX/portal-preview.html`, `CRX/portal-preview.js`
- Modify: `CRX/appearance.js`
- Modify: `CRX/animated-characters.js`
- Modify: `tests/options-ui.test.js`, `tests/portal-ui.test.js`, `tests/portal-modernizer.test.js`, `tests/portal-diagnostics.test.js`, `tests/appearance.test.js`

### P0 — 宽度、响应式与功能缺陷
- [x] **修复 Options 移动端底部 Dock 被覆盖及残留折叠按钮 `≡`**（`CRX/options.css:61-66, 815-846, 1058-1080, 1130-1133`）：
  - 提高 `@media (max-width: 640px)` 规则优先级以压过 `.settings-layout.nav-compact` 和 `:root[data-nav-pane-position="top"]`；
  - 在 `<=640px` 与 `top` 导航模式下隐藏 `.sidebar-top`（`#pane-toggle`）；
  - 修正 `@media (max-height: 540px) and (orientation: landscape)` 防止破坏底部 Dock。
- [x] **修复 Options 外观双栏挤压、窄屏溢出与样式 Bug**（`CRX/options.html:325, 331, 448`, `CRX/options.css:57, 277, 411-440, 805-811, 939-959, 1042-1050`）：
  - `@media (max-width: 960px)` 将 `.appearance-layout` 改为单列 `1fr`；
  - 为 `<label class="file-picker secondary">` 补齐次按钮样式、`:focus-within` 聚焦环与移动端 44px 高度；
  - 修正 `options.html:448` `setting-row` 拼写错误为 `settings-row`；修正 `options.html:331` 回退文案 `3 MB` → `1.9 MB`；
  - `.duration-control` 增加 `flex-wrap: wrap`；`<=640px` 下 `.slider-control` 设为 `width: 100%`、`.toast` 抬高至 `bottom: 72px`；
  - 修复 `options.css:57` 无效 5 参数 `cubic-bezier(0, 0, 0.35, 0.15, 1)`；为 `#background-preview` 增加 `background-repeat: no-repeat`。
- [x] **修复 Portal 壁纸九宫格焦点/缩放失效与移动端布局缺陷**（`CRX/portal-modernizer.js:215-225, 336-469, 580`, `CRX/portal.css:32-35, 209-298, 561`）：
  - 闭合 Shadow DOM `#drcom-private-appearance` 直接注入校验后的 `backgroundPosition` 与 `FIT_TO_CSS[backgroundFit]`（解决 `:host { all: initial; }` 无法继承 CSS 变量的问题）；
  - 优化 `<=560px` 下 `.drcom-header` 移动端排版，避免 390px 视口两行错位；
  - 移动端自定义壁纸卡片（`[data-appearance-background="custom"]`）保留 `.drcom-surface` 左右与底部内边距；
  - 保持 `.drcom-password-toggle` 44×44 触控热区，同时约束可视悬停高亮不溢出 32px 桌面输入框；
  - 断连提示条内联样式增加 `max-width: calc(100vw - 24px); flex-wrap: wrap;`；
  - `#drcom-reset` 重置表单时同步将 `password.type = "password"`；
  - `refreshPortalStatus()` 原地更新在线会话详情，不再销毁重建 `#drcom-modern-root` 打断登录成功庆祝动画。
- [x] **修复 Options 控制器、权限手势与动画角色 Bug**（`CRX/options.js:318-347, 618-652, 1143-1178, 1351`, `CRX/options-account-controller.js:141-163`, `CRX/animated-characters.js:49, 237-256, 334-398`, `CRX/appearance.js:48`）：
  - `syncPicker` / `syncPickerFromHex` 同步更新亮度滑块 `#cp-value`；
  - `parseCapturedUrl` 写入网关字段后调用 `renderGatewaySecurityWarning()` 并调度自动保存；
  - 将网关 `chrome.permissions.request` 移出 `250ms setTimeout`，确保在用户交互手势上下文内同步触发；
  - 切换语言时保留折叠侧边栏 `#pane-toggle` 的正确 `title`；
  - **开放必应每日壁纸调节**（已确认）：`options.js:1351` 改为 `$("background-controls").hidden = !(custom || daily)`；
  - `appearance.js:48` `DATA_IMAGE_URL_PATTERN` 对齐支持 `image/gif`；
  - `animated-characters.js` 严格遵守 `prefers-reduced-motion: reduce`、修复 `schedulePeek` 重复定时器泄漏、为黄色嘴部 `<path>` 补充 `setAttribute("d", ...)`。

### P1/P2 — 功能推进与性能优化
- [x] **Options 账号页增加独立 `+` 新建账号按钮 + 删除按钮可用态控制**（`CRX/options.html:101-156`, `CRX/options-account-controller.js:17-64`）：
  - 在账号列表/表单头部增加独立 `+` 新建账号按钮，点击清空 `editingAccountId` 与表单；当 `editingAccountId` 为空时禁用 `#account-delete`。
- [x] **Portal 实时同步外观、预览页交互与视觉润色**：
  - `portal-modernizer.js` 订阅外观变更（`storage.onChanged` / 页面可见时刷新），在设置页修改主题/壁纸后门户页无需刷新即时生效；
  - `portal-preview.js` 补齐密码显隐、语言切换、重置与角色互动演示；
  - 为 `#drcom-session-details summary` 增加 WinUI 展开箭头指示器；
  - 导出诊断日志后弹出 `diagnostics_export_review_notice` 提示 Toast（保留同步 `revokeObjectURL`）。
- [x] **前端性能深度优化**：
  - 取色器 `drawSpectrum()` 缓存 `lastDrawnV` 并对 `pointermove` 做 RAF 节流（消除每帧 65,536 像素重算）；
  - Options 抑制自身保存触发的 `chrome.storage.onChanged` 回显风暴；`guard-seconds` 滑动不触发外观重绘；非外观项自动保存不再重复传输 1.9MB 壁纸 Data URL；
  - `animated-characters.js` 的 `renderBodies()` 改用 GPU `transform: translate3d(...)` 替代 `left`/`top` 回流；在 `document.hidden` 或 `<900px` 隐藏品牌栏时暂停监听与眨眼定时器；`spawnConfetti()` 粒子数由 180 降至 ~70；`.drcom-blob` 改为无滤镜 `radial-gradient`；
  - `portal-modernizer.js` `isOnlinePage()` 改用轻选择器 + `textContent` 替代触发同步回流的 `innerText`，并增加页面加载后观察超时上限；`portal-capture.js` 触摸监听增加 `{ capture: true, passive: true }`。

---

## Task 3: Background 核心服务、协议解析、多语言与 SSH 脚本

**Exclusive Files:**
- Modify: `CRX/background.js`, `CRX/background/*.js`
- Modify: `CRX/account-utils.js`
- Modify: `CRX/i18n.js`, `CRX/i18n-messages.js`, `CRX/_locales/*`
- Modify: `CRX/manifest.json`, `CRX/manifest.firefox.json`
- Modify: `SSH/drcom-xzhmu.sh`
- Modify: `tests/background.test.js`, `tests/connection-concurrency.test.js`, `tests/connection-runtime.test.js`, `tests/drcom-response-runtime.test.js`, `tests/edge-protocol.test.js`, `tests/i18n.test.js`, `tests/i18n-ui.test.js`, `tests/language-service.test.js`, `tests/wallpaper-service.test.js`, `tests/ssh-runtime.test.js`, `tests/ssh-security.test.js`, `tests/edge-ssh.test.js`

### P0 — 逻辑缺陷、竞态与兼容性
- [x] **消除每次标签页跳转的 `storage.session` 写入风暴 & 补齐关闭清理**（`CRX/background/portal-service.js:82-87`, `CRX/background.js:84-88`）：
  - `!guard` 时立即返回；仅过期时清理；监听 `chrome.tabs.onRemoved` 清理已关闭标签守卫，并在 `background.js:86` 补 `.catch()`。
- [x] **修复 Options 页登录劫持自身标签页跳转到 `10.10.10.2`**（`CRX/background/message-router.js:182-186`）：
  - 仅在 `fromWebPage === true` 时调用 `markSenderTab(sender)`，登录失败时清除守卫。
- [x] **修复 `publicAppearance()` 丢弃 `backgroundFit` 与 `material`**（`CRX/background/portal-service.js:177-200`, `tests/background.test.js:508-523`）。
- [x] **修复空/非法 `callbackPrefix` 破坏 JSONP 响应解析**（`CRX/background/drcom-client.js:186, 227, 243`, `CRX/background/state-store.js:29-35`）：
  - `normalizeState()` 校验 `callbackPrefix` 为合法 JS 标识符（默认 `"dr"`），`drcom-client.js` 三处请求构建补齐 `|| "dr"`。
- [x] **修复 `checkStatus()` 竞态覆盖登录/注销状态并加入单飞去重**（`CRX/background/connection-service.js:514-545`）。
- [x] **扩展字体 `web_accessible_resources` 以支持自定义网关**（`CRX/manifest.json:33-43`, `CRX/manifest.firefox.json:66-76`）：
  - 仅字体条目 `matches` 扩展为 `["http://*/*", "https://*/*"]`。
- [x] **修复 `decodeMessage()` 将短 ASCII 误解码为控制字符**（`CRX/background/drcom-protocol.js:111-124`）：
  - 拒绝解码后含 C0/DEL 控制字符（`/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/`）的结果。
- [x] **补齐英文界面漏译后台状态消息、新增双语键与脱敏补全**（`CRX/i18n.js:14-24`, `CRX/i18n-messages.js`, `CRX/background/state-store.js:216-222, 616`, `CRX/background/drcom-client.js:380-399`）：
  - 将扩展自有中文状态文案纳入 `KNOWN_MESSAGE_KEYS` 与双语字典；新增 `new_account`（`新建账号` / `New account`）与 `diagnostics_export_review_notice`（`已导出诊断日志，分享前请先检查内容。` / `Diagnostics exported. Please review before sharing.`）；对齐 `background_storage_note` 文案 `3 MB` → `1.9 MB`；修复 `updateActionBadge` 回退标题为官方名 `徐医校园网xzhmu`；
  - `redactSensitiveText` 扩展脱敏 `uid`/`username`/`account`/`user_name`/`DDDDD`；修复 `getState()` 脏 `recentRequests` 比较逻辑。

### P1/P2 — 离线体验、SSH 加固与后台性能
- [x] **每日壁纸离线/未登录回退与 60s 失败冷却**（`CRX/background/wallpaper-service.js:62-79, 120-134`）：
  - 拉取失败时回退至上一日缓存壁纸（`stale: true`）；加入 60 秒内存冷却避免未登录校园网时反复 10s 超时；补 `Content-Length` 预检。
- [x] **消除 `saveConfig` TOCTOU 竞态 & 补齐 HTTPS 门户重载 / 失效脚本注销**（`CRX/background/state-store.js:450-464`, `CRX/background/portal-service.js:55-67, 110-131`）。
- [x] **连接与错误处理细节**（`CRX/background/connection-service.js:234, 338, 568`, `CRX/background/drcom-client.js:19`）：
  - 统一 `MAC 冲突` 与 `network_parameters` 分类；`logout()` 内 `setManualLogout(true)` 补 `.catch(() => {})`；`queryPortalPageStatus` 改用 `portalUrlUtils.host(config.portalUrl, "10.10.10.2")`；`fetchDrcom` 识别 `response.type === "opaqueredirect"` 返回明确重定向提示。
- [x] **SSH 脚本加固**（`SSH/drcom-xzhmu.sh:69, 750-760, 918-929`）：
  - 第 69 行 `sed 's/\r$//'` 换为 `tr -d '\r'`；`mask_account` 对 `<=4` 位短账号返回 `"****"`；`cmd_debug_server` 检查 `nc` 退出码并在出错时休眠。
- [x] **后台核心性能优化**（`CRX/background/state-store.js:185-255, 638, 701`, `CRX/background/message-router.js:50-137`, `CRX/background/language-service.js:33-38`, `CRX/background/diagnostics-service.js:27-29, 180-198`, `CRX/background/response-reader.js:47`）：
  - `stripRecentRequests` / `withRecentRequests` 改为浅拷贝；`storedMainSerialized === persistedStateSerialized` 时跳过重复 `JSON.stringify`；`setState()` 单次序列化复用；`validatePortalSender` 透传 `state` 消除双重 `getState()`；
  - `language-service.js` 仅向扩展页与门户页广播 `language:changed`（保留 `!tab.url` 测试透传）；
  - `diagnostics-service.js` 跳过 `STATE_UNCHANGED` 空写，复用模块级 `TextEncoder`。

---

## Task 4: 全量回归测试与修复前后视觉验收

- [x] 运行静态检查：`npm run check`
- [x] 运行单元测试：`npm run test:unit`
- [x] 运行边界测试：`npm run test:edge`
- [x] 运行真实浏览器测试：`npm run test:browser`
- [x] 运行打包与发布校验：`npm run verify:package`、`npm run verify:release`
- [x] 使用无头浏览器在相同视口（Popup 420×680 中/英、360×680、Options 1280×860 / 390×844、Welcome 1024×768 / 375×812、Portal Preview 1280×800 / 390×844）采集修复后截图并逐一对比验收（验收后不将临时截图提交至仓库）。
