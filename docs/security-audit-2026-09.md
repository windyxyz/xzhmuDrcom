# 徐医网络tools 安全审计报告（2026-09-04 · 第三轮）

- **审计基线**：`main` @ `2a99fb6`（1.0.2），工作树干净。
- **审计范围**：前两轮未覆盖的代码深度审计（扩展自有页面、构建脚本、SSH 脚本、测试与文档对照）+ 旧发现 18 项轻量复验。
- **结论摘要**：本轮未发现新的高危（P1）或中危（P2）漏洞；新增 3 项 P3 级发现。旧报告 18 项发现**全部仍存在于当前 HEAD**（锚点逐条复核，见第六节）。扩展自有页面（options/popup/welcome/portal-preview）转义与消息面审计结果干净，未发现 XSS 入口。
- **处置**：本报告只记录发现与修复建议，不修改任何代码（按用户决定）。

---

## 一、审计方法

- 参考 xz.aliyun.com/news/91642（原文已被阿里云 WAF 拦截且无快照，采用同主题同作者替代：LoRexxar《从0开始入门 Chrome Ext 安全》系列）的**三层攻击面模型**（Web 层 → Content 层 → Bg 层）、**中转函数/恶意函数定位法**、**危险 Chrome API 清单**与 **manifest 逐字段检查清单**。
- 参考 [lintsinghua/DeepAudit](https://github.com/lintsinghua/DeepAudit) 的**多智能体流水线**（Orchestrator → Recon → Analysis → Verification），由审计者按序模拟执行；未部署 DeepAudit 本体（避免 Docker 依赖、LLM API key 与代码外传第三方）。
- 威胁模型沿用 `SECURITY.md`：门户 `http://10.10.10.2` 为 HTTP 明文，页面 DOM / 学校接口响应 / URL 可被 MITM 控制；设备失陷与恶意扩展为不可防御边界。
- 动态验证全部只读执行：仓库自带语法检查、单元测试、node 实测正则回溯，未访问真实网关或外网。

## 二、与前几轮三路审计的覆盖映射

前几轮按三路推进：内容脚本攻击面（报告一）、后台服务攻击面（报告二）、UI 页与发布供应链（第三路）。本轮按用户要求"旧发现简单看看、其他认真看看"执行，映射如下：

| 前几轮审计路 | 本轮处置 | 本轮实际覆盖 | 报告位置 |
| --- | --- | --- | --- |
| ① 内容脚本攻击面（报告一 7 项） | 轻量复验 | 7 项锚点逐条复核：portal-modernizer.js:94/113/263/417/429-433/448、portal-ui.js:130/186-188、confirm-dialog.js:21-28/74、portal-diagnostics-utils.js:67；全仓库 `isTrusted` 0 次、CSS 无动态值选择器（2 项动态实测） | 第六节·表一 |
| ② 后台服务攻击面（报告二 11 项） | 轻量复验 | 11 项锚点逐条复核：drcom-client.js:23/62/77/134/237/415/443、account-service.js:92-99、connection-service.js:313 及 `setupAutomation` 全部调用点、wallpaper-service.js:69/90、state-store.js:75-92/146-152/439-453、message-router.js:19-25、background.js:24/30/39；ReDoS 动态实测复现（200KB→16.0s） | 第六节·表二 |
| ③ UI 页与发布供应链 | **深度审计** | options.js（1706 行）逐行 + options/popup/welcome/portal-preview 全部页面 JS/HTML；scripts/ 4 个构建脚本逐行；打包白名单与 CRX/ **双向实测比对**（无漂移）；manifest 逐字段（permissions/host_permissions/optional/CSP/externally_connectable/web_accessible_resources/background 类型）；测试安全断言抽查；SECURITY.md 与 development-guide 声明对照 | 第四、五、七、九节 |
| 补充：SSH 路由器脚本 | **深度审计**（前三轮从未覆盖） | SSH/drcom-xzhmu.sh（559 行）逐行 + SSH/README.md；产生新发现 N1 | 第四节 N1、第七节第 7 条 |

说明：①②两路的本轮结论是"18 项旧发现全部仍存在于 HEAD，行号已更新"，深度分析结论沿用前几轮报告；③及 SSH 为本轮全新深度审计面。

## 三、动态验证结果

| 项目 | 结果 |
| --- | --- |
| `npm run check`（node --check 27 个源文件） | 全部通过 |
| `npm run test:unit`（node --test） | **235/235 通过**，0 失败 |
| loose 解析正则回溯实测（node 只读，非 JSON 长标识符输入） | 10KB→43ms；50KB→985ms；100KB→4.0s；200KB→**16.0s**，清晰 O(n²) |
| 发布白名单 vs CRX/ 实际文件双向比对 | 无漂移；仅按设计排除 `manifest.firefox.json` 与 `portal-preview.{html,js}` |
| 全仓库 `isTrusted` 使用次数 | **0 次**（合成事件类旧发现未变） |
| CSS 动态值属性选择器（`[value^=]` 等） | 0 处（无 CSS 侧信道） |

## 四、本轮新发现

### 【N1】【SSH/drcom-xzhmu.sh:115-117, 349-352, 354-366】【P3】SSH 脚本宽松响应解析 fail-open（与扩展后台旧发现 F6 同源）

**证据**：

```sh
# extract_value：贪婪 .* 从整个响应体任意位置抠 key=value
sed -n "s/.*[\"']\{0,1\}${key}[\"']\{0,1\}[[:space:]]*[:=][[:space:]]*[\"']\{0,1\}\([^\"',;}[:space:]]*\).*/\1/p"
# login_success_response：result 取任意位置，接受 1|true|success|ok
case "$result" in 1|true|success|ok) return 0 ;;
# already_online_response：对 msg+全文做原始子串匹配
printf '%s %s' "$msg" "$1" | grep -Eiq '已经在线|已在线|already online|has been online|E2620'
```

与扩展 `parseDrcomText` 的 loose 分支同源：只要响应正文任意位置出现 `result=1`、`"result":"true"`、`success` 等（HTML 注释、JS 字符串、广告文案均可），`cmd_login` 即判定成功并写会话文件，`keepalive` 随后停止补偿重试。在路由器场景，攻击者需在同 L2 网段对门户 IP 做 ARP/DNS 欺骗才能污染响应（威胁面小于浏览器内 MITM，故定 P3 而非更高）。缓解现状：`rc=2` 已在线路径有二次状态复核（正确方向）；`result=1` 路径无复核。另外 `extract_value` 的 key 均为硬编码常量（非攻击者可控），不存在 sed 脚本注入。

**修复建议**：`login_success_response` 对 `result=1` 路径同样要求 `query_status_state` 复核在线（与 rc=2 路径对齐）；或收紧 `extract_value` 为锚定形态（仅接受 JSONP/类 query 文本，如整体以 `[\w$.]+(` 开头或仅含 `k=v&` 形态）。

### 【N2】【scripts/package-extension.js:9-43, 143-165】【P3】发布白名单无"新增文件遗漏"反向检测

**证据**：`RELEASE_FILES` 固定白名单；`buildPackage` 对白名单内文件缺失会抛错（`打包白名单文件不存在`），但**没有任何检查发现"CRX/ 下存在但未进白名单"的新文件**。若未来向 manifest 新增内容脚本/资源文件而忘记同步白名单，打包会静默成功、发布包缺文件——manifest 引用了不存在的入口会导致扩展加载失败，或静默丢失功能。

本轮实测双向比对无漂移（当前唯一排除项 `manifest.firefox.json`、`portal-preview.*` 均为设计行为，且 `package-extension.test.js` 已断言排除 preview/tests/docs）。

**修复建议**：新增反向断言（测试或打包脚本内）：CRX/ 下文件集合 = 白名单 ∪ {`manifest.firefox.json`, `portal-preview.html`, `portal-preview.js`}，防止未来静默遗漏。属发布供应链完整性卫生项，非攻击者可达漏洞。

### 【N3】【options.html:108, popup.html:58 + options.js:1183, popup.js:160】【P3/信息】扩展页密码字段标注 `autocomplete="current-password"` 与程序化回填的密码管理器交互面

**证据**：两个密码输入框均标注 `autocomplete="current-password"`，且页面用 `$("account-password").value = account.password`（options.js:1183、popup.js:160）把 storage.local 明文密码程序化填入。部分浏览器的密码管理器会因此介入：把扩展页（`chrome-extension://` origin）里的密码捕获进浏览器密码库（扩展 storage.local 之外的第二个持久存储，超出 SECURITY.md 声明的"仅保存在本机浏览器扩展存储"），或把密码库中的陈旧条目回填覆盖页面刚填入的新密码，导致用户提交旧密码。

在威胁模型内影响有限（设备失陷已是不可防御边界；密码管理器是否介入扩展页面取决于具体浏览器实现），列为信息级。

**修复建议**：若意图是凭据只存于扩展 storage，把这两处改为 `autocomplete="off"`；若刻意保留（方便用户记忆），应在 SECURITY.md 补一句说明该交互面。

## 五、消息面矩阵交叉核对（Recon 复核，无新增越权面）

`WEB_PAGE_ACTIONS`（state-store.js:75-92）共 9 项 + 诊断 4 项（双重门槛：`validateDefaultPortalDiagnosticsSender` 硬编码 `http://10.10.10.2` 顶层 frame + `validatePortalSender`）。本轮把 options/popup/welcome 实际发出的全部 action 与 router switch 逐一交叉核对：

- options.js 使用：`state:get`、`connection:get`、`diagnostics:get/set/export/clear`、`config:save/reset`、`account:save/delete/select`、`requestLog:clear`、`drcom:login/logout/status`、`wallpaper:get` —— 全部有对应分支，且均**不在**网页白名单内。
- popup.js 使用：`account:select/save/delete`、`drcom:login/logout/status`、`state:get`、`wallpaper:get` —— 同上。
- welcome.js 使用：`state:get`、`wallpaper:get` —— 同上。
- 四个扩展页面**均无 `chrome.runtime.onMessage` 入站监听器**（入站消息面为零）、无 `fetch`/XHR/WebSocket、无 `eval`/`new Function`。

矩阵无遗漏、无越权面；页面只读不改后台的安全敏感配置（`config:save` 等写动作均需用户手势触发且经确认对话框）。

## 六、旧发现 18 项状态快表（2026-09-04 复验）

### 报告一（内容脚本攻击面，7 项）

| 编号 | 严重度 | 主题 | 状态 | 当前锚点 |
| --- | --- | --- | --- | --- |
| F1 | P1 | 密码输入在明文页面普通 DOM + 合成事件驱动特权动作 | **仍存在** | portal-ui.js:186-188 密码框；portal-modernizer.js:94/113 root 注入；:263 表单 submit 监听；全仓库 isTrusted 0 次 |
| F2 | P1 | 原请求捕获通道可伪造，account:save 可静默覆盖已存账号密码并选中 | **仍存在** | portal-modernizer.js:429-433（`a=login` 捕获）、:417（`a=unbind_mac`）；account-service.js:92-99（naturalKey 整体替换+选中） |
| F3 | P2 | validatePortalSender 校验链完备但"门户 origin=攻击者"的语义信任 | **仍存在** | portal-service.js:170-212（frameId/origin/tab 三重校验，trustedPortalOrigins 含用户自定义 origin） |
| F4 | P2 | 确认对话框注入页面普通 DOM，页面 CSS/JS 可点击劫持或合成确认 | **仍存在** | confirm-dialog.js:74（body.append）；:21-28（监听器无 isTrusted） |
| F5 | P3 | 任意 submit（可合成）反复武装标签页跳转守卫 | **仍存在** | portal-modernizer.js:448（document 级 submit 捕获监听） |
| F6 | P3 | 诊断脱敏关键词表为英文，中文"密码/账号"与短字符串可存活 | **仍存在** | portal-diagnostics-utils.js:67（关键词集合未变） |
| F7 | P3 | `renderOnlineContent` 的 `${title}` 依赖调用方预转义 | **仍存在** | portal-ui.js:130（sink 处仍无二次转义） |

### 报告二（后台攻击面，11 项）

| 编号 | 严重度 | 主题 | 状态 | 当前锚点 |
| --- | --- | --- | --- | --- |
| F1 | P1 | parseDrcomText 平方级回溯 ReDoS + 响应体无上限 | **仍存在** | drcom-client.js:237（实测 200KB→16.0s，与上轮 25.2s 同阶）；:23/:77 无界 `response.text()` |
| F2 | P2 | 明文密码持久化 storage.local，state:get 全量返回 | **仍存在** | account-service.js:14；state-store.js:108-126 legacy 迁移 |
| F3 | P3 | setAccessLevel 未 await / 失败静默 / Firefox no-op | **仍存在** | message-router.js:19-25；background.js:24 `void restrictLocalStorageAccess()` |
| F4 | P2 | 自定义网关 = 后台向任意 http(s) URL 发含明文密码 GET | **仍存在** | drcom-client.js:134；state-store.js:439-453（http 合法、无 scheme 默认补 http://） |
| F5 | P3 | 请求记录脱敏正则绕过（别名/键大小写/双重编码/fragment） | **仍存在** | drcom-client.js:415（searchParams.has 精确匹配）、:443（字段集合固定） |
| F6 | P3 | loose 解析/文本子串判定可诱导误判成功（fail-open） | **仍存在** | drcom-client.js:236-241、:259-260、:333（本轮 SSH 脚本 N1 为其同源衍生） |
| F7 | P3 | 壁纸 urlbase 任意 URL + 类型 fallback 标 jpeg | **仍存在** | wallpaper-service.js:90（`startsWith("http")` 原样使用）、:69（类型不符 fallback） |
| F8 | P3 | 网页消息驱动的全量 state 序列化/写盘/外网抓取放大 | **仍存在** | message-router.js:34（每消息 getState）；state-store.js:146-152（整份 setState） |
| F9 | P3 | logout 清 KEEPALIVE_ALARM 后永不重建 | **仍存在** | connection-service.js:313；`setupAutomation` 调用点仅 state-store.js:314/321、background.js:30/39，登录成功路径不重建 |
| F10 | P3 | 网页可达 account:save 按 naturalKey 覆盖密码（投毒） | **仍存在** | account-service.js:92-99（与报告一 F2 同代码点） |
| F11 | P3 | find_mac 请求 redactedUrl 未脱敏 | **仍存在** | drcom-client.js:62（`redactedUrl: url.toString()`） |

**结论：18 项全部仍存在，无一已修复。** 行号与上轮报告基本一致（个别漂移已在表中更新）。修复优先级沿用上轮建议：P1（报告一 F1+F2、报告二 F1）→ P2（F3/F4/F2/F4）→ P3 其余。

## 七、确认安全项（防误报，勿重复审计）

1. **扩展自有页面零入站消息、零网络、零 eval**：options/popup/welcome/portal-preview 均无 `onMessage` 监听、无 fetch/XHR、无 eval/new Function/document.write，CSP 为 MV3 默认（`script-src 'self'`，manifest 未放宽）。
2. **innerHTML 转义完备**：options.js 4 处 innerHTML（setButtonBusy 硬编码字符串；renderAccounts/renderRequestLog 全量 `escapeHtml` 五字符覆盖）；popup.js 账号列表全量转义；welcome/portal-preview 用 textContent 或硬编码。测试断言转义（options-ui.test.js:583、popup-ui.test.js:134）。
3. **portalUrl/apiUrl 双保险**：保存时 `normalizeUrl`（http/https 白名单、剥 userinfo/hash），且 `getState` 每次读取都重新 `normalizeState`——storage 被污染也能在读出时归一化。popup.js:76 / options.js:934 / welcome.js:38 的 `tabs.create/update` 调用点因此无 `javascript:` 面；未加载状态不误跳默认地址有测试（popup-ui.test.js:151-164、options-ui.test.js:620）。
4. **权限请求收窄**：`requestGatewayAccess`（options.js:1095-1109）仅请求用户输入 URL 的精确 origin 模式 + 可选 `scripting`，有测试断言（options-ui.test.js:586-618）。
5. **storage.onChanged 消费面**：只读键存在性触发刷新（options.js:305-314），不消费 changes 内容。
6. **构建脚本**：无密钥硬编码、无 eval；manifest key 在 CWS 包剥离、Firefox 变体整体替换；ZIP 可复现（固定时间戳/CRC）；白名单当前无漂移。
7. **SSH 脚本防护到位**：`umask 077`（会话/临时文件仅 root 可读）；认证 URL 经 `wget -i` 临时文件发送避免 `/proc/*/cmdline` 泄露（旧 BusyBox 回退已文档化）；日志、状态输出与 debug-server 均脱敏（账号/ip/mac 掩码）；session 文件只存 IP/MAC/时间；页面只读白名单变量不执行 JS；IP/MAC 均有严格格式校验。
8. **文档与实现一致**：SECURITY.md 的明文存储、HTTP 凭据、网页 sender 六项校验、Shadow DOM、诊断脱敏声明与代码吻合，由 `security-docs.test.js` 契约强制。
9. **测试覆盖安全行为**：破坏性操作取消零消息（destructive-actions.test.js）；抓包覆盖导入需确认；captcha 页不接管不发消息；背景 Data URL 只进 closed Shadow DOM（portal-modernizer.test.js:446-481）；诊断不采集 input.value；脱敏管线全量断言。
10. **manifest 权限最小**：`alarms`/`storage`/`tabs` + optional `scripting`/hosts；无 `web_accessible_resources`、无 `externally_connectable`、content_scripts 仅默认门户 origin。

## 八、优先级汇总

| 编号 | 严重度 | 主题 | 来源 |
| --- | --- | --- | --- |
| 报告二 F1 | **P1** | parseDrcomText O(n²) ReDoS（实测 200KB→16s）+ 响应体无上限 | 旧，仍在 |
| 报告一 F1 | **P1** | 门户页密码输入普通 DOM / 无 isTrusted 合成事件 | 旧，仍在 |
| 报告一 F2 | **P1** | 捕获通道伪造 → 网页静默覆盖已存账号密码并选中 | 旧，仍在 |
| 报告二 F2 | P2 | 明文密码 storage.local 全量暴露面 | 旧，仍在 |
| 报告二 F4 | P2 | 自定义网关 HTTP 明文凭据外发无告警 | 旧，仍在 |
| 报告一 F3 / F4 | P2 | 门户 origin 语义信任 / 确认框点击劫持 | 旧，仍在 |
| N1 | P3 | SSH 脚本宽松解析 fail-open（与后台 F6 同源） | **本轮新增** |
| N2 | P3 | 打包白名单无新增文件反向检测 | **本轮新增** |
| N3 | P3 | 密码管理器交互面（autocomplete=current-password） | **本轮新增** |
| 报告一/二其余 | P3 | F5/F6/F7/F3/F5-F11 共 11 项 | 旧，仍在 |

## 九、豁免说明

- `TEMP/winui/` 与 `TEMP/登录界面/` 两个第三方参考项目不参与审计：仅作视觉参考、不进构建白名单、已被 `.git/info/exclude` 忽略；供应链扫描工具对其（含 node_modules、演示代码 `console.log` 密码）的告警属误报。
- `CRX/portal-preview.*` 为开发预览页，不进发布包（白名单已排除）。
- xz.aliyun.com/news/91642 原文被 WAF 拦截且无归档快照，方法论以同主题同作者文献替代（见第一节）。

---

*报告生成：2026-09-04 · 审计基线 `2a99fb6` · 代码零改动*
