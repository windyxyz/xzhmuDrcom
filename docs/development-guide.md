# DrCom徐医开发指南

## 1. 项目定位

DrCom徐医是面向徐州医科大学 DrCOM 校园网的 Chrome Manifest V3 扩展。当前稳定版本为 2.5.3，源码位于 CRX/，使用原生 HTML、CSS 和 JavaScript，不依赖第三方 npm 包。

项目解决以下问题：

- 首次安装后引导用户进入 10.10.10.2；
- 管理校园网、电信、联通、移动等多个账号；
- 统一完成登录、下线、状态检测、启动自动登录和定时保活；
- 网络临时失败时有限重试，凭据或设备错误时停止自动重试；
- 在学校门户上提供可以随时撤回的现代登录界面；
- 捕获原门户表单或脚本中的真实账号与网络参数；
- 在欢迎页、弹窗、设置页和门户之间共享主题与自定义背景；
- 对请求记录、界面文本和诊断信息进行凭据脱敏；
- 通过无外部依赖的测试、确定性 ZIP 和 SHA-256 完成可复现发布。

运行行为以 CRX/manifest.json 和 CRX/ 源码为准；工程命令以 package.json 为准；版本变化以 CHANGELOG.md 为准；安全报告流程以 SECURITY.md 为准。

## 2. 功能总览

| 功能 | 用户可见行为 | 主要实现 |
| --- | --- | --- |
| 首次安装 | 只在首次安装打开欢迎页，更新不重复打扰 | welcome.*、background.js |
| 多账号 | 保存、选择、编辑、删除、运营商后缀、抓包网络参数 | account-utils.js、account-service.js |
| 登录 | 保存账号登录或临时账号登录；所有入口共享一个在途任务 | connection-service.js、drcom-client.js |
| 下线 | 始终针对最近实际认证身份；成功后立即同步离线 | connection-service.js |
| 状态恢复 | 检查门户、连接阶段、退避重试、浏览器启动登录 | connection-service.js、storage.session |
| 保活 | Chrome Alarm 周期检查，离线后按策略恢复 | connection-service.js |
| 防跳转 | 登录后短时间最多拦截一次自动离开门户 | portal-service.js |
| 现代门户 | 覆盖层不删除原 DOM，可以立即恢复学校原页面 | portal-ui.js、portal-modernizer.js |
| 在线详情 | 读取状态、换算时间/流量/余额并只展示脱敏字段 | portal-session.js、drcom-client.js |
| 原请求捕获 | 读取原表单和动态脚本中的账号、密码与网络参数 | portal-modernizer.js |
| 外观 | 系统/浅色/深色、强调色、自定义背景、压缩和可读性参数 | appearance.js、design-tokens.css |
| 私有门户背景 | 图片只进入 closed Shadow DOM，轻 DOM 不出现 Data URL | portal-modernizer.js |
| 危险操作确认 | 删除、覆盖导入、恢复设置、清空记录、清除背景均可取消 | confirm-dialog.js |
| 请求记录 | 最近 10 次登录、下线和状态记录，默认脱敏 | state-store.js、drcom-client.js |
| 门户诊断 | 用户选择后在默认门户本机记录脱敏的页面结构、操作类型和资源元数据 | portal-diagnostics-utils.js、portal-diagnostics.js、diagnostics-service.js |
| 发布 | 固定白名单、顺序、时间戳和 SHA-256 | scripts/package-extension.js |

## 3. 目录与职责

~~~text
CRX/
├─ manifest.json
├─ account-utils.js
├─ portal-session.js
├─ appearance.js
├─ confirm-dialog.js
├─ design-tokens.css
├─ background.js
├─ background/
│  ├─ state-store.js
│  ├─ diagnostics-service.js
│  ├─ portal-context.js
│  ├─ drcom-client.js
│  ├─ account-service.js
│  ├─ connection-service.js
│  ├─ portal-service.js
│  └─ message-router.js
├─ welcome.html / welcome.css / welcome.js
├─ popup.html / popup.css / popup.js
├─ options.html / options.css / options.js
├─ portal-ui.js / portal-modernizer.js / portal.css
├─ portal-diagnostics-utils.js / portal-diagnostics.js
└─ portal-preview.html / portal-preview.js

scripts/
├─ browser-test-process.js
├─ package-extension.js
├─ run-tests.js
└─ verify-release.js

tests/                         单元、合约、安全、浏览器和打包测试
docs/development-guide.md      本开发指南
docs/product-design.md         产品与界面设计约束
.github/workflows/             CI 和标签发布工作流
~~~

各后台模块职责：

- **background.js**：按固定顺序调用 importScripts，只注册安装、启动、Alarm、消息和标签更新事件。
- **background/state-store.js**：schema 12、默认值、迁移、串行写入、容量预算、Session 状态和请求记录。
- **background/portal-context.js**：请求门户首页，按白名单静态解析实时 IP；不执行页面脚本，也不把正文或具体地址写入日志。
- **background/drcom-client.js**：请求构造、超时、响应解析、错误分类与敏感信息清理。
- **background/account-service.js**：账号规范化、自然键去重、保存、选择、删除和网络参数更新。
- **background/connection-service.js**：登录单通道、连接状态、重试、活动身份、下线、状态检查和保活。
- **background/portal-service.js**：自定义内容脚本注册、标签页短时保护、外观输出和网页 sender 校验。
- **background/message-router.js**：可信上下文限制、动作白名单和返回数据裁剪。
- **background/diagnostics-service.js**：门户诊断的二次脱敏、串行写入、容量预留和会话裁剪。
- **portal-session.js**：共享的在线会话字段白名单、单位换算、时间格式化和标识脱敏。
- **portal-diagnostics-utils.js**：内容脚本和后台共用的 URL、文本、目标和记录脱敏工具。
- **portal-diagnostics.js**：只在默认门户隔离世界运行的尽力而为诊断记录器。

portal-preview.* 不是扩展运行入口，也不进入发布 ZIP，但真实浏览器测试直接依赖它来渲染生产门户表单，因此必须保留。

## 4. 运行时架构

后台保持 Manifest V3 经典 Service Worker，不切换 ES Module。background.js 通过 importScripts 载入共享账号工具和八个后台模块，测试 VM 使用同一加载顺序。

~~~mermaid
flowchart LR
  W[欢迎页] --> R[消息路由]
  P[弹窗] --> R
  O[设置页] --> R
  M[门户内容脚本] -->|严格来源校验与动作白名单| R
  R --> S[状态与 Session]
  R --> A[账号服务]
  R --> C[连接服务]
  C --> X[门户运行上下文]
  C --> D[DrCOM 客户端]
  R --> G[门户服务]
  X --> H[10.10.10.2 门户首页]
  S --> L[storage.local]
  S --> SS[storage.session]
  C --> AL[chrome.alarms]
  D --> E[10.10.10.2 eportal]
~~~

核心边界如下：

1. 后台是账号、配置、活动认证身份和连接状态的唯一所有者。
2. 扩展自身页面可以读取完整状态。
3. HTTP 门户中的内容脚本只能调用经过白名单和 sender 校验的动作。
4. 门户页面轻 DOM、宿主属性和 CSS 变量不能获得自定义背景 Data URL。
5. 密码只在登录所需的可信路径中使用，不进入界面状态、日志或导出。

门户内容脚本必须按依赖顺序加载：

~~~text
account-utils.js
  -> portal-session.js
  -> appearance.js
  -> portal-ui.js
  -> confirm-dialog.js
  -> portal-diagnostics-utils.js
  -> portal-diagnostics.js
  -> portal-modernizer.js
~~~

`portal-ui.js` 在浏览器中依赖前两个共享模块，在 CommonJS 测试中则通过 `require()` 加载；`portal-modernizer.js` 最后执行，负责组合界面、确认对话框、诊断和后台消息。该顺序同时维护在 `manifest.json`、`background/portal-service.js` 的自定义门户注册列表、浏览器 fixture 和打包白名单中，修改任一入口时必须同步更新对应合约测试。

## 5. 扩展生命周期

### 5.1 安装与更新

chrome.runtime.onInstalled 会读取并规范化状态、同步保活和内容脚本。只有 details.reason 为 install 时才打开 welcome.html；update 不重复打开欢迎页。

### 5.2 浏览器启动

chrome.runtime.onStartup 会重新核对保活 Alarm 和自定义门户脚本。启用启动登录时，后台使用自动模式登录当前选中账号，并遵守 storage.session 中的阻断和下次重试时间。

### 5.3 Alarm

- drcomAssistant.keepAlive：周期检查门户，确认离线后尝试恢复。
- drcomAssistant.retry：临时网络失败后的单次登录重试。

配置未变化时不会重复清除并创建相同保活任务。

### 5.4 标签更新

登录动作可以给当前门户标签加短时保护。若页面在保护期内自动离开门户，扩展最多重定向一次到门户并立刻清除保护；它不是长期站点拦截器。

## 6. 账号生命周期

### 6.1 统一解析

DrcomAccountUtils 同时供浏览器页面、后台和 CommonJS 测试使用，提供：

- 最多两轮 URL 解码；
- 去除 DrCOM 常见的 ,0, 前缀；
- 识别 @telecom、@unicom、@cmcc 及中英文别名；
- 标签、脱敏显示和 MAC 规范化；
- 自然键生成。

自然键为“去除首尾空白的用户名 + NUL 分隔符 + 小写后缀”。用户名大小写保持不变，因此 Student 与 student 是不同账号；运营商后缀统一为小写。

### 6.2 保存与历史去重

没有显式 ID 的保存按自然键更新原记录，不新增重复项。历史迁移发现同一自然键多条记录时：

1. 优先保留当前 selectedAccountId；
2. 否则保留 updatedAt 最近的记录 ID；
3. 名称、密码和网络字段采用时间顺序中最近的非空值；
4. selectedAccountId 重映射到保留 ID。

抓包网络更新优先匹配抓包账号，不会把陌生账号参数写进当前选中账号。

### 6.3 临时账号与活动身份

用户取消“保存账号”时，登录使用临时账号。确认登录成功后只把实际认证身份和本次实时网络上下文写入 chrome.storage.session 的 activeIdentity：

- 保存账号 ID（临时账号为空）；
- 用户名和后缀；
- IP、IPv6、MAC、AC IP、AC 名称；
- saved 或 transient 来源；
- 认证时间。

activeIdentity 不保存密码，也不依赖长期账号中的历史 IP；它能在 Service Worker 被回收后继续用于本次浏览器 Session 的下线。

### 6.4 下线与删除

下线只使用 activeIdentity，绝不回退到界面当前选择或调用参数中的其他账号。后台先尝试取得当前门户 IP，失败时才使用 activeIdentity 中的本次会话网络。存在有效 MAC 时先调用 unbind_mac；没有 MAC、解绑失败、复核仍在线或状态未知时，改用包含协议占位字段和当前网络参数的完整 Portal/logout。

unbind_mac 或 Portal/logout 返回成功并不等于最终成功。后台按 300ms、800ms、1500ms 复核 `/drcom/chkstatus`；只有明确 offline 才清除重试/保活 Alarm、清空 activeIdentity，并把连接状态原子设置为 offline。状态 online 或 unknown 时保留真实状态与活动身份，并返回可理解错误。

删除账号前显示具体名称和脱敏账号，默认焦点在取消按钮，Escape 可以取消。删除只影响选定账号；设置重置明确保留账号。

## 7. 连接状态与 DrCOM 协议

### 7.1 连接阶段

连接状态 phase 包括 idle、checking、captive、authenticating、waiting、action_required、online 和 offline。状态还保存 attempt、nextRetryAt、blocked、message 和 updatedAt。

### 7.2 登录单通道与退避

所有入口共享 drcom-login 单通道，同一时刻只发送一个真实登录任务。手工登录会清除旧重试；自动登录在 blocked 为 true 或尚未到 nextRetryAt 时跳过。

登录状态机固定为：

~~~text
/drcom/chkstatus 明确在线 -> 直接成功，不发送密码
离线或未知 -> 获取当前门户运行上下文
无有效 IP -> 失败，不构造含 user_password 的请求
有有效 IP -> 可选 find_mac，并采用其有效 MAC -> Portal/login
result=1 -> 成功
result=0 + ret_code=2 + 已在线语义 -> 再查状态，只有 online 才成功
其他明确失败或未知响应 -> 失败
~~~

当前 IP 始终覆盖账号历史 IP；账号历史 `network.wlanUserIp` 不参与自动回退。IP 缺失时，后台在构造登录 URL 之前停止，因此密码不会被发送。保活只在状态明确为 offline 时调用登录；unknown 不会发送凭据。

临时网络错误从 30 秒开始指数退避，增加最多 20% 抖动，最长 5 分钟。密码/账号、设备/MAC、流量/余额错误进入 action_required 并停止自动重试。

### 7.3 登录原理与调用链

登录由后台统一执行，页面不直接拼接或发送 DrCOM URL。现代门户、弹窗、设置页、启动自动登录、重试和保活最终都进入 `connection-service.js` 的同一条登录通道；区别只在账号来源、是否携带门户页面 URL，以及是否受自动重试阻断状态约束。

现代门户的一次实际认证调用如下：

~~~mermaid
sequenceDiagram
  actor U as 用户
  participant M as portal-modernizer.js
  participant R as message-router.js
  participant C as connection-service.js
  participant X as portal-context.js
  participant D as drcom-client.js
  participant G as DrCOM 门户/API

  U->>M: 提交账号、后缀、密码和“保存账号”
  opt 保存账号
    M->>R: account:save(account)
    R-->>M: accountId
  end
  M->>R: drcom:login(accountId 或临时 account)
  R->>R: 校验 sender、顶层 frame、门户 origin 与 action
  R->>C: loginAccount(..., portalPageUrl=sender.url)
  C->>D: queryPortalSessionStatus()
  D->>G: GET /drcom/chkstatus
  alt 已明确在线
    G-->>C: online
    C-->>M: 成功，不发送密码
  else 离线或未知
    C->>X: resolvePortalRuntimeContext(config, portalPageUrl)
    X->>G: GET 门户首页
    X-->>C: 当前网络上下文
    opt 已启用 findMacBeforeLogin
      C->>D: buildFindMacRequest() + fetchDrcom()
      D->>G: GET Portal/find_mac
      G-->>C: 可用 MAC 或安全回退
    end
    C->>D: buildLoginRequest() + fetchDrcom()
    D->>G: GET Portal/login
    G-->>D: JSON、JSONP 或兼容键值响应
    D-->>C: 结构化认证结果
    C->>C: recordLoginOutcome()
    C-->>M: online、失败原因或重试信息
  end
~~~

#### 7.3.1 页面入口与消息边界

`portal-modernizer.js` 的 `loginFromPortal()` 先用 `portal-ui.js` 规范化用户名、运营商后缀和密码。选择“保存账号”时，页面先发送 `account:save`，再用返回的 `accountId` 发送 `drcom:login`；不保存时则把临时 `account` 直接放入 `drcom:login`，不会写入 `storage.local`。

保存账号登录的内部消息形状：

~~~js
await chrome.runtime.sendMessage({
  action: "drcom:login",
  accountId: "已保存账号的内部 ID"
});
~~~

临时账号登录的内部消息形状：

~~~js
await chrome.runtime.sendMessage({
  action: "drcom:login",
  account: {
    username: "虚构学号",
    suffix: "@telecom",
    password: "仅本次调用使用",
    network: {}
  }
});
~~~

这两种消息是扩展内部接口，不是供普通网页调用的公共 HTTP API。调用方只根据返回的 `success`、`online`、`phase`、`message`、`retryable` 和 `retryAt` 更新界面，不读取或展示后台使用的认证凭据。

`message-router.js` 在分派前验证网页发送者。来自门户的登录消息必须来自扩展自身内容脚本、顶层 frame、精确的默认门户 origin，且 `sender.tab.url` 仍位于该门户；`drcom:login` 还必须处于网页动作白名单。验证通过后，路由器把可信 `sender.url` 作为 `portalPageUrl` 传给连接服务。扩展弹窗和设置页不是网页发送者，因此不携带这一 URL，但仍走同一个后台登录服务。

#### 7.3.2 后台函数调用顺序

| 顺序 | 调用 | 责任与输出 |
| --- | --- | --- |
| 1 | `loginAccount(accountId, transientAccount, options)` | 进入全局 `drcom-login` single-flight；手工登录清除旧重试，自动登录先检查 `blocked` 和 `nextRetryAt`；连接阶段改为 `authenticating`。 |
| 2 | `performLoginAccount(...)` | 读取保存账号或清理临时账号；没有可用账号时立即失败。 |
| 3 | `queryPortalSessionStatus(config)` | 请求 `/drcom/chkstatus`。明确在线直接成功，后续上下文、`find_mac` 和密码请求全部跳过。 |
| 4 | `resolvePortalRuntimeContext(config, portalPageUrl)` | 请求门户首页，并结合可信页面 URL 静态解析本次 IPv4；失败且没有合法全局 IP 时终止，返回“密码尚未发送”。 |
| 5 | `mergeRuntimeLoginNetwork(...)` | 用实时 IP 建立最终网络参数；MAC、IPv6 和 AC 参数才允许按当前上下文、账号兼容字段、全局设置的顺序补齐。 |
| 6 | `buildFindMacRequest()` / `fetchDrcom()` | 可选步骤。取得有效 IP 后先尝试纯学号，再尝试带后缀账号；仅采用格式合法的返回 MAC。 |
| 7 | `buildLoginRequest()` / `fetchDrcom()` | 构造并发送唯一包含真实密码的 `Portal/login` 请求；解析 HTTP、JSON/JSONP/兼容键值和协议字段。 |
| 8 | `normalizeDrcomResult()` | 把网关响应归一为明确成功、待状态复核、明确失败或未知失败。 |
| 9 | `recordLoginOutcome()` | 成功时写入 `online` 和活动身份；失败时分类为可重试网络问题或需人工处理的问题，并更新 Alarm 与连接阶段。 |

`performLoginAccount()` 在发送认证请求后返回候选 `authenticatedIdentity`，但 `recordLoginOutcome()` 只在结果成功时才把它写入 Session。登录前检查已经明确在线时不会凭空构造新的活动身份；已有会话身份也不会被当前界面所选账号替换。

#### 7.3.3 网络调用与凭据出现位置

| 请求 | 地址/动作 | 主要输入 | 是否包含密码 | 用途 |
| --- | --- | --- | --- | --- |
| 状态检查 | 门户 origin 的 `/drcom/chkstatus` | `callback`、随机值 | 否 | 区分 `online`、`offline`、`unknown`。 |
| 上下文获取 | `config.portalUrl` | 浏览器同源 Cookie；无账号查询参数 | 否 | 从页面 URL 或静态变量取得当前 IP。 |
| MAC 查询 | `config.apiUrl`，`c=Portal&a=find_mac` | 学号/完整账号、当前 IP、协议版本 | 否 | 尽力取得本次会话 MAC；失败不会单独判定登录失败。 |
| 实际认证 | `config.apiUrl`，`c=Portal&a=login` | 完整账号、密码、当前网络参数和协议字段 | **是** | 唯一会发送真实密码的网络请求。 |

这些调用均为 GET。`credentials: "include"` 只用于门户状态和上下文关联现有校园网页会话，不会把密码写入 Cookie。由于学校接口是 HTTP，`Portal/login` 的查询参数在网络层不是端到端加密；日志脱敏只能保护扩展输出，不能保护传输链路。

#### 7.3.4 登录参数来源

| 参数 | 生成规则 |
| --- | --- |
| `user_account` | `accountPrefix`（默认 `,0,`）+ 规范化用户名 + 小写运营商后缀。 |
| `user_password` | 当前保存账号或临时账号的密码；只在最终登录请求构造时读取。 |
| `wlan_user_ip` | 当前页面 URL/门户静态变量解析结果；都缺失时才允许使用设置页明确填写的合法全局 IP。账号历史 IP 不参与。 |
| `wlan_user_mac` | 当前上下文或有效 `find_mac` 结果 → 账号兼容字段 → 全局设置 → `000000000000`。 |
| IPv6、AC IP、AC 名称 | 当前上下文 → 账号兼容字段 → 全局设置。 |
| `login_method`、`jsVersion` | 登录配置；缺失时分别使用 `1` 和 `3.3.2`。 |
| `callback`、`v` | 每次请求生成的 JSONP 回调名和随机值，用于协议兼容与避免缓存。 |

页面 URL 的 IP 查询参数优先于门户 HTML。`portal-context.js` 只识别白名单字段和简单字符串字面量；`ss3` 只按八位十六进制 IPv4 解码。任何页面函数、表达式或脚本都不会执行，门户正文和具体网络地址也不会写入诊断。

#### 7.3.5 结果、状态与后续动作

| 结果 | 对外状态 | 活动身份与自动化 |
| --- | --- | --- |
| 登录前状态明确 `online` | 返回成功 | 不发送密码，不用当前表单覆盖活动身份。 |
| `Portal/login` 返回 `result=1` | `phase=online` | 清除重试；把实际账号和本次网络写入 `storage.session.activeIdentity`，不保存密码。 |
| `result=0, ret_code=2` 且有“已经在线”语义 | 暂不成功 | 再查 `/drcom/chkstatus`；只有复核 `online` 才按成功处理。 |
| 密码、账号、余额、设备或绑定类明确失败 | `phase=action_required` | 停止自动重试，保留可理解错误供用户处理。 |
| 网络、HTTP 或一般临时失败 | `phase=waiting` | 从 30 秒开始指数退避并设置单次重试 Alarm。 |
| 空响应、未知协议或状态 `unknown` | 安全失败 | 不猜测成功；保活也不会在 `unknown` 下发送凭据。 |

### 7.4 请求构造

默认 API 为 http://10.10.10.2:801/eportal/。登录前由 portal-context.js 使用 `credentials: "include"`、`cache: "no-store"` 和 8 秒超时请求门户首页。IP 优先级为当前页面 URL 的 `ip`、`wlanuserip`、`wlan_user_ip`、`userip`、`user-ip`、`UserIP`、`uip`、`station_ip`，随后依次为页面静态字符串变量 `v46ip`、`ss5`、`v4ip`、按原门户算法解码的 `ss3`，最后才是设置页明确填写且验证有效的全局 IP。解析器只接受白名单变量、简单字符串字面量和合法 IPv4，不使用 eval、Function 或脚本注入。

登录使用 GET，并写入 Portal/login、callback、login_method、user_account、user_password、本次网络参数、jsVersion 和随机值。启用 findMacBeforeLogin 时，取得有效 IP 后依次用纯学号和带后缀账号调用 find_mac；返回的有效 MAC 会进入最终登录请求。

完整 Portal/logout 写入 `login_method`、协议占位 `user_account=drcom`、`user_password=123`、`ac_logout=1`、`register_mode=1`、当前 IP/IPv6/MAC/AC 参数、空 VLAN、jsVersion、callback 和随机值。请求日志中的 URL 会隐藏占位密码及其他敏感查询参数。

### 7.5 响应解析优先级

DrCOM 响应固定按以下优先级处理：

1. 网络或 HTTP 错误；
2. 明确协议字段和协议码；
3. 可识别的状态响应；
4. 安全兜底。

`result=1` 是明确登录成功；`result=0 + ret_code=2` 只有同时包含“已经在线”语义时才进入待复核，复核为 online 才成功。ret_code=2/3 不再统一解释为 MAC 冲突，而是结合账号、密码、余额、设备和绑定语义分类。

`/drcom/chkstatus` 只把明确协议结果映射为 online/offline；网络、HTTP、超时、未知协议和空壳页面均为 unknown。门户 HTML 兼容回退必须出现明确登录表单或注销标志。未知结果按失败处理，不因文本中偶然出现 success、logout 或类似关键词而误报成功。诊断记录保留 HTTP 状态码和必要协议信息，但不保留门户正文，并清除密码、完整账号、具体 IP/MAC、敏感查询参数和返回体中的凭据。

## 8. 门户接管与隐私隔离

### 8.1 现代界面

内容脚本在页面可识别为登录页或在线页时挂载现代界面。学校原 DOM 始终保留，只通过 CSS 切换可见性；“使用原始登录页”会立即撤下覆盖层。初始化或后台通信失败时也恢复原页面。

登录表单支持账号、运营商、密码和是否保存，运营商顺序固定为校园网、联通、电信、移动；重置按钮清空账号和密码并恢复默认校园网与保存选项。自助服务、账号激活、找回密码和使用说明使用学校官方地址，以 `target="_blank"` 和 `rel="noopener noreferrer"` 打开；这些外部业务不嵌入扩展，也不由扩展代理提交。

登录成功后切换在线视图。默认 `classic` 模式在主卡片显示已用时间和总流量，并提供自助服务、刷新和注销；折叠详情显示账号、上下行流量、余额、登录时间、外网映射地址及安全网络字段。`full` 默认展开详情，`minimal` 只保留刷新、自助服务和注销，`hidden` 只保留注销。缺失或异常字段直接隐藏，不推测值。下线按钮明确标注“注销并解绑 MAC”，先经统一确认对话框；取消不发送 `drcom:logout`，失败时保持在线视图并显示错误。

检测到 `input[name="captcha"]` 时，现代界面不接管页面，学校原验证码和操作控件保持可见，并显示非阻断提示。二维码登录和移动端验证码不复刻；用户应切回或继续使用学校原页面。

原门户能力与实现位置如下：

| 原门户能力 | 现代界面行为 | 实现与后台调用 |
| --- | --- | --- |
| 四种运营商 | 校园网、联通、电信、移动固定排序 | `portal-ui.js` 生成表单，`account-utils.js` 规范化后缀 |
| 保存密码 | 勾选后先 `account:save`，再用 `accountId` 登录 | `portal-modernizer.js` → `message-router.js` → `account-service.js` |
| 临时登录 | 不写入 `storage.local`，只在本次消息中携带账号 | `drcom:login` 的临时 `account` 分支 |
| 重置 | 清空账号和密码，恢复校园网及保存选项 | `portal-modernizer.js` 本地处理，不发后台消息 |
| 在线状态 | 首次挂载和手动刷新读取脱敏结构化摘要 | `portal:status:get` → `/drcom/chkstatus` |
| 自助服务 | 新窗口打开学校自助服务 | 官方外链，不读取目标页面 |
| 注销并解绑 | 确认后发送一次 `drcom:logout` | 活动身份 → `unbind_mac` → 必要时 `Portal/logout` → 状态复核 |
| 验证码/扫码 | 不接管，保留学校原控件 | `portal-modernizer.js` 安全降级 |

辅助入口由 `portal-ui.js` 的固定白名单生成：自助服务 `http://self.xzhmu.edu.cn`、使用说明 `http://self.xzhmu.edu.cn/guide.htm`、账号激活和找回密码位于 `https://authserver.xzhmu.edu.cn/retrieve-password/`。所有链接都新开窗口并隔离 `window.opener`；扩展不向这些系统转发账号、密码或状态摘要。

### 8.2 背景与个性化

portal:config:get 只返回启用状态、标题、门户地址、主题、强调色和 `onlineDetailMode`，不返回 backgroundImage。完整外观通过 portal:appearance:get 单独获取。

自定义图片只写入内容脚本创建的 closed Shadow DOM 私有层。门户轻 DOM、宿主元素属性和 CSS 变量中不出现 Data URL。门户右上角提供 44px 个性化按钮，包含提示和无障碍名称，点击后发送 options:open 打开设置。

### 8.3 网页消息来源

网页消息必须同时满足：

- sender.id 等于当前扩展 ID；
- frameId 为 0；
- origin 和 sender.url 的 origin 属于可信门户集合；
- sender.tab.id 有效；
- chrome.tabs.get 返回的当前标签仍在同一可信 origin；
- action 位于网页白名单。

可信门户集合由默认门户 `http://10.10.10.2` 与当前配置的门户 URL origin 组成，与内容脚本的注入范围保持一致：自定义网关只有在设置页显式授权来源并保存配置后才注册现代界面内容脚本，未配置时集合退化为默认门户。iframe、伪造来源、过期标签和非白名单动作都会被拒绝。门户诊断消息不受此扩展影响，仍然只接受默认门户顶层页面。

### 8.4 原门户捕获

portal-modernizer 会观察原表单提交和动态登录/下线脚本，读取 user_account、user_password 和明确网络字段。脚本捕获优先于 900ms 表单兜底。现代登录消息经过严格 sender 校验后，由后台使用 `sender.url` 参与当前门户上下文解析；内容脚本不再从可见页面文字猜测 IP。密码可以进入用户明确选择保存的账号，但不会进入请求记录。

### 8.5 异步接管状态机

内容脚本在 DOMContentLoaded 后异步读取门户配置和外观。配置确认启用后，`MutationObserver` 等待页面形成可识别的登录或在线状态，并通过一个 microtask 合并连续 DOM 变化。识别到密码字段的登录页或在线页且 `shouldTakeOver` 允许时，观察器停止、覆盖层挂载；原始 DOM 不删除。

挂载、配置读取或后台通信出错时会移除覆盖层，原页面继续可用。用户点击“使用原始登录页”会停止就绪观察器、移除覆盖层，并在本次内容脚本生命周期内保持为终止状态，不会再次自动接管。在线视图的下线只在用户点击下线控件后发送 `drcom:logout`；失败时仍停留在线视图并显示错误。

页面识别与在线刷新采用以下状态转换：

~~~text
初始空壳
  -> MutationObserver 等待学校脚本渲染
  -> 检测验证码：停止接管观察，只显示原页提示
  -> 检测密码框：挂载现代登录页
  -> 检测在线标记：先挂载在线页，再异步 portal:status:get

portal:status:get
  -> online：用脱敏 session 重绘在线页
  -> offline：切换回现代登录页
  -> unknown：保留在线页并显示“无法确认”，不伪造离线
  -> 消息异常：保留当前 DOM，在状态区显示可恢复错误
~~~

重绘在线页会重新绑定刷新、注销、恢复原页和个性化事件，但不会重新启动页面就绪观察器。用户已经恢复原页面时，迟到的状态响应会被丢弃，避免覆盖用户选择。

### 8.6 在线状态字段与脱敏链路

在线界面不读取学校页面轻 DOM 中的账号或网络值。`portal-modernizer.js` 向后台发送 `portal:status:get`，`message-router.js` 先复用顶层门户 sender 校验，再由 `connection-service.js` 调用 `queryPortalSessionStatus()` 请求同源 `/drcom/chkstatus`。后台只返回 `state`、`phase`、`message`、`checkedAt` 和已经规范化的 `session`，不返回原始 JSONP、Cookie、门户正文或完整标识。

`portal-session.js` 是后台、内容脚本和测试共用的纯函数模块。只有明确 `result=1` 的状态数据才生成会话摘要；来源及转换如下：

| 页面字段 | 公共会话字段 | 转换与边界 |
| --- | --- | --- |
| `uid`、`user_name`、`account` | `account` | 去除协议前缀/运营商后缀后只保留首尾少量字符。 |
| `time` | `usedMinutes` | 非负分钟整数，显示为“n 分钟”。 |
| `flow`/`flux`、`flow_in`、`flow_out` | 总量、上行、下行 KB | 按学校原逻辑视为 KB，再格式化为 KB/MB/GB。 |
| `fee` | `balanceYuan` | 按 `fee / 10000` 换算人民币并保留两位小数。 |
| `login_time` 等 | `loginAt` | 合法秒/毫秒时间戳转换为本地时间；异常值隐藏。 |
| `xip`、IPv4/IPv6、MAC、AC IP | 脱敏地址 | IPv4 隐藏中间段，IPv6 隐藏中间组，MAC 只保留前三组。 |
| VLAN、AC 名称 | `network` 文本 | 只读取白名单字段；模板输出前仍执行 HTML 转义。 |

手动刷新与首次在线挂载使用同一条消息链路。`offline` 会切回登录视图；`unknown` 保留在线视图并显示无法确认的状态，避免把临时网络故障当成已经离线。

门户可见的返回结构固定为：

~~~js
{
  state: "online | offline | unknown",
  phase: "online | offline | checking | ...",
  message: "可展示的状态说明",
  checkedAt: 0,
  session: {
    account: "de***42",
    usedMinutes: 125,
    totalKilobytes: 1234567,
    uploadKilobytes: 500000,
    downloadKilobytes: 734567,
    balanceYuan: 12.34,
    loginAt: 1769990400000,
    externalIp: "198.***.***.202",
    network: {
      ipv4: "192.***.***.3",
      ipv6: "2001:***::***:1",
      mac: "02:00:00:**:**:**",
      vlan: "example-vlan",
      acIp: "192.***.***.2",
      acName: "example-ac"
    }
  }
}
~~~

示例只使用演示账号和 RFC 文档网段。`session` 仅在明确在线且存在合法字段时生成，字段可能部分缺失；调用方必须按可选字段处理，不能依赖固定完整对象。返回值禁止增加原始响应、诊断对象、状态 URL、Cookie、完整账号或完整网络标识。

### 8.7 门户诊断模式

门户诊断是独立于请求记录的可选本地功能，默认关闭。其完整数据流如下：

~~~text
portal-diagnostics.js (isolated world)
  -> diagnostics:status/start/append/end
message-router.js (strict sender validation)
  -> diagnostics-service.js (second redaction + serialized mutation + pruning)
  -> chrome.storage.local.drcomPortalDiagnostics
options.js
  -> diagnostics:set/get/export/clear (extension pages only)
~~~

诊断内容脚本先限定自身只在 `http://10.10.10.2` 运行。网页发送方还必须是顶层 frame，且 `sender.url` 与当前 `sender.tab.url` 的 origin 都精确为该默认 origin；自定义网关、iframe 和扩展页管理动作都会被拒绝。扩展页面可管理、读取、导出或清空；网页内容脚本只可使用以下会话动作。

| action | 发送方 | 含义 |
| --- | --- | --- |
| `diagnostics:status` | 已验证的默认门户 | 查询开关，不返回会话内容 |
| `diagnostics:start` | 已验证的默认门户 | 创建当前页面会话 |
| `diagnostics:append` | 已验证的默认门户 | 追加一条已脱敏记录 |
| `diagnostics:end` | 已验证的默认门户 | 标记会话结束 |
| `diagnostics:set`、`diagnostics:get`、`diagnostics:export`、`diagnostics:clear` | 扩展页 | 设置、读取、导出或清空本地记录 |

本地键为 `chrome.storage.local.drcomPortalDiagnostics`，schema 为 version、enabled、updatedAt、droppedRecords、paused 和 sessions；默认值为 version 1、`enabled: false`、`updatedAt: 0`、`droppedRecords: 0`、`paused: false`、空 sessions。每个会话含 id、startedAt、endedAt、origin、pageKind、title、url、records 与 truncated；每条记录只保留允许的类型、时间、页面种类，以及经脱敏后的 URL、目标描述、方法、资源发起类型、状态、时长、摘要或消息。

共享清理器先在隔离世界脱敏，后台写入前再脱敏一次。它不记录输入值、凭据、Cookie、存储内容、完整账号、IP 或 MAC；URL 查询键和值及主机标签都会按同一敏感标识规则清理并限制长度；文本中的敏感标识也会清理。诊断不是加密容器，导出固定包含脱敏边界与“记录可能不完整”的提示，导出前和分享前仍必须人工复核。

所有会话按 startedAt 排序，先删除最早会话以维持最多 10 个会话；超过总计 1 MiB 时继续从最早会话裁剪；只剩一个会话仍超限时删除其最早记录并标记 `truncated`。每次淘汰都会累计到 `droppedRecords`。单条 DOM 摘要最大 64 KiB，URL 最大 4096 字节。写入还保留 512 KiB 本地存储余量：总存储达到或预计达到软限制时，本次开始或追加会返回“记录已暂停”并持久化 `paused: true`，不会越过该余量；用户重新开启诊断后才清除暂停状态。

会话先查询状态，开启时才 start；随后记录初始 DOM 摘要、click/submit/change/focus、资源及资源错误、去抖后的 mutation，并在 pagehide 追加结束事件后 end。待发送队列最多保留 20 条；后台传输暂不可用时，队首保留以便下一次 flush 重试；后台明确拒绝或返回 `stored: false` 时，记录器停止继续采集，避免无声丢失；溢出时丢弃最早待发送项。pagehide 会清除定时器并断开 MutationObserver 和 PerformanceObserver，且 end 至多发送一次；整个记录器失败时静默退出，不影响门户。

未来做门户兼容性时，可由用户在扩展设置页导出诊断 JSON，并自行保存相应页面的 MHTML，再在不含私人捕获的工作目录中导入为本地测试 fixture。先人工确认导出内容没有原始密码、账号、IP 或 MAC。私人 JSON/MHTML 只允许临时保存在已由本机忽略规则（例如 `.git/info/exclude`）覆盖、且经 `git check-ignore -q TEMP` 验证的仓库内 `TEMP/`，或仓库外的私有位置；人工复核前绝不能暂存、提交、分享、引用或摘录，也不能把原始值放入问题、文档或测试。基于人工复核并进一步脱敏的 fixture 做差异分析应另立计划，不能改变此诊断模式的本地、默认关闭边界。

## 9. 数据模型与迁移

### 9.1 storage.local

主键为 drcomAssistantState，当前 schemaVersion: 12。

~~~js
{
  schemaVersion: 12,
  selectedAccountId: "account-id",
  accounts: [{
    id: "account-id",
    label: "主账号",
    username: "2026...",
    suffix: "@telecom",
    password: "本机明文密码",
    network: {
      wlanUserIp: "",
      wlanUserIpv6: "",
      wlanUserMac: "000000000000",
      wlanAcIp: "",
      wlanAcName: ""
    },
    updatedAt: "ISO-8601"
  }],
  recentRequests: [],
  config: {
    portalUrl: "http://10.10.10.2/",
    apiUrl: "http://10.10.10.2:801/eportal/",
    login: {
      accountPrefix: ",0,",
      callbackPrefix: "dr",
      loginMethod: "1",
      jsVersion: "3.3.2",
      findMacBeforeLogin: true
    },
    network: {
      wlanUserIp: "",
      wlanUserIpv6: "",
      wlanUserMac: "000000000000",
      wlanAcIp: "",
      wlanAcName: ""
    },
    ui: {
      modernizePortal: true,
      onlineDetailMode: "classic",
      title: "徐医校园网",
      accent: "#007aff",
      theme: "system",
      background: "fresh",
      backgroundImage: "",
      backgroundBlur: 14,
      backgroundDim: 0.42,
      backgroundScale: 1.04
    },
    redirect: { returnToPortal: true, guardSeconds: 4 },
    automation: { loginOnStartup: true, keepAlive: true, intervalMinutes: 3 }
  }
}
~~~

账号、配置和请求记录通过串行写入队列更新，避免并发覆盖。完整状态写入前执行 8 MB 预算检查；背景图片保存目标约 3 MB。

schema 12 会合并历史重复自然键账号；成功写回后删除旧顶层 username/password；删除历史账号 note 以及 ui.subtitle、ui.density、ui.hideOriginalPortal。规范化前后状态会比较，即使存储已经标记为 schema 12，也会把残留字段幂等写回清理。写回失败时不会提前删除旧凭据源字段。

### 9.2 storage.session

主键为 drcomAssistantSession。

~~~js
{
  guards: { "tabId": { until: 0 } },
  connection: {
    phase: "idle",
    attempt: 0,
    nextRetryAt: 0,
    blocked: false,
    message: "",
    updatedAt: 0
  },
  activeIdentity: {
    accountId: "",
    username: "2026...",
    suffix: "@telecom",
    network: {},
    source: "saved | transient",
    authenticatedAt: 0
  }
}
~~~

Session 状态只在当前扩展/浏览器 Session 内使用；activeIdentity 不含密码。

## 10. 内部消息接口

| action | 作用 | 扩展页 | 受验证门户 |
| --- | --- | --- | --- |
| state:get | 完整账号与配置 | 是 | 否 |
| connection:get | 当前连接状态 | 是 | 否 |
| portal:config:get | 安全门户配置，不含图片 | 是 | 是 |
| portal:appearance:get | 完整外观，供私有背景层使用 | 是 | 是 |
| portal:status:get | 裁剪后的状态、检查时间和脱敏在线摘要 | 否 | 是，仅可信顶层门户 |
| account:save | 保存或更新账号 | 是，返回完整结果 | 是，只返回 accountId |
| account:delete | 删除账号 | 是 | 否 |
| account:select | 切换默认账号 | 是 | 否 |
| account:network:update | 更新匹配账号网络参数 | 是 | 是，只返回摘要 |
| requestLog:clear | 清空请求记录 | 是 | 否 |
| config:save | 合并配置 | 是 | 否 |
| config:reset | 恢复默认配置 | 是 | 否 |
| drcom:login | 保存账号或临时账号登录 | 是 | 是 |
| drcom:logout | 针对活动身份下线 | 是 | 是 |
| drcom:status | 主动状态检查 | 是 | 否 |
| redirect:markPortalTab | 开启短时保护 | 是 | 是 |
| redirect:clearPortalTab | 清除保护 | 是 | 否 |
| options:open | 打开扩展设置 | 是 | 是 |
| diagnostics:status/start/append/end | 默认门户诊断会话 | 否 | 是，仅限顶层 `http://10.10.10.2` |
| diagnostics:set/get/export/clear | 诊断管理与导出 | 是 | 否 |

message-router.js 先判定发送方，再执行白名单，最后裁剪门户可见返回值。门户不能通过包装未知 action 绕过校验。

## 11. 页面与交互

### 11.1 欢迎页

展示三步安装引导、当前门户地址、主按钮和设置入口。主按钮在当前标签打开门户，次按钮打开设置。

### 11.2 弹窗

显示连接阶段、脱敏请求 URL、账号表单、登录/保存/下线、账号选择和删除。忙碌状态结束后不会错误启用空账号选择框。

### 11.3 设置页

分为网络、账号、外观、高级和关于。网络提供连接概览、门户、状态测试、启动登录和保活；账号管理密码和每账号网络参数；外观处理主题、强调色、背景、本机压缩及门户在线信息的 `classic/full/minimal/hidden` 显示模式；高级包含门户/API、协议、抓包 URL、短时保护、请求记录、默认关闭的门户诊断卡和恢复默认。诊断卡展示开关、占用、会话数、JSON 导出与确认后的清空。抓包导入若命中已有自然键，会在覆盖名称、密码和网络参数前确认。

页首提供“自动同步”“立即同步”和“重新加载页面”。`config.ui.autoRefreshSettings` 默认 `true`，保存在 `drcomAssistantState`，不进入门户可见配置。自动同步通过四类信号工作：

- `chrome.storage.local.drcomAssistantState` 变化时安全同步账号、配置、连接状态和诊断摘要；
- `chrome.storage.session.drcomAssistantSession` 变化时只同步连接状态；
- 页面重新获得焦点或从隐藏恢复可见时补做一次安全同步；
- 页面可见且自动同步开启时，每 15 秒只刷新连接状态；隐藏或销毁时清除定时器，恢复后只创建一个。

所有触发共用单个在途刷新任务，避免重复请求和定时器叠加。账号表单与配置表单分别跟踪未保存状态：存在编辑时，自动或手动同步只更新连接状态和诊断摘要，不重新填充表单，并在页首提示编辑保护；保存、删除、恢复默认或成功重新填充后清除相应标记。自动同步失败只写入页首状态，避免周期性 Toast；用户点击“立即同步”失败时才显示错误。自动同步不会重载 HTML/CSS/JS；“重新加载页面”在有未保存编辑时必须先通过安全确认，取消不会调用 `location.reload()`。

### 11.4 确认对话框

confirm-dialog.js 动态创建原生 dialog，标题和正文使用 textContent，避免把账号标签当成 HTML。对话框支持 Escape、取消、确认和点击遮罩取消；默认焦点明确落在取消按钮。

## 12. 权限与安全边界

固定权限为 alarms、storage、tabs 和默认主机 http(s)://10.10.10.2/*。可选的 http://*/*、https://*/* 只在用户保存自定义门户/API 时按具体 origin 请求；scripting 用于自定义门户内容脚本注册。

后台启动时调用 chrome.storage.local.setAccessLevel(TRUSTED_CONTEXTS)。这能减少普通内容脚本读取 storage.local 的机会，但不是加密。

必须明确：

- 密码为支持自动登录而保存在本机 storage.local；
- 默认门户和 API 使用 HTTP，学校协议把密码放入 GET 参数；
- 设备失陷、操作系统账号被控制、调试权限被滥用或恶意扩展仍可能读取敏感信息；
- 界面、请求日志和导出默认隐藏密码；
- 项目、测试、截图和缺陷报告不得包含真实账号或完整认证 URL。

详见根目录 SECURITY.md。

## 13. 本地开发与验证

加载扩展：打开 chrome://extensions/，开启开发者模式，选择“加载已解压的扩展程序”和 CRX/；修改后刷新扩展并重新打开相关页面。

~~~powershell
npm run check
npm run test:unit
npm run test:browser
npm run verify:package
npm run verify
~~~

- npm run check：运行时和构建脚本语法检查。
- npm run test:unit：账号、迁移、协议、权限、UI 逻辑、文档与开源合约。
- npm run test:browser：启动本机 Chrome/Edge，验证欢迎页、设置页、弹窗和门户预览的真实布局。
- npm run verify:package：验证 ZIP 白名单、固定时间戳、排除规则和重复构建一致性。
- npm run verify：汇总静态、单元、浏览器和打包测试。

浏览器清理会在 kill 前注册 exit 监听；正常退出有有限等待，超时后使用 SIGKILL，再删除独立临时 profile，任何路径都不会无限等待。

门户状态能力、诊断与异步接管的定向回归位于 `tests/portal-session.test.js`、`tests/portal-ui.test.js`、`tests/portal-diagnostics-utils.test.js`、`tests/portal-diagnostics.test.js`、`tests/portal-modernizer.test.js`、`tests/background.test.js`、`tests/options-ui.test.js` 和 `tests/ui-contract.test.js`。在接触真实门户前，先运行：

~~~powershell
node --test tests/portal-session.test.js tests/portal-ui.test.js tests/portal-diagnostics-utils.test.js tests/portal-diagnostics.test.js tests/portal-modernizer.test.js tests/background.test.js tests/options-ui.test.js tests/ui-contract.test.js
~~~

手工回归至少覆盖安装/更新、四种后缀、保存/临时登录、活动身份下线、结构化协议结果、失败重试、保活、防跳转、门户切换、私有背景、危险操作取消/确认、窄屏/触控/高对比，以及所有输出无真实凭据。

## 14. 打包与发布

### 14.1 构建

~~~powershell
npm run package
~~~

输出：

- dist/drcom-xuzhou-medical-2.5.3.zip
- dist/drcom-xuzhou-medical-2.5.3.sha256

ZIP 根目录直接包含 manifest.json 和 LICENSE。打包器使用显式白名单、固定顺序、1980-01-01 DOS 时间和 STORE 方法。tests/、docs/、portal-preview.*、截图和本地状态不会进入发布包。dist/ 已加入 .gitignore。

### 14.2 标签校验

~~~powershell
npm run verify:release -- v2.5.3
~~~

脚本要求标签精确等于 v + Manifest 版本，同时检查 package.json 版本，并从 CHANGELOG.md 提取当前版本到 dist/release-notes.md。

### 14.3 工作流

.github/workflows/ci.yml 在 push 和 pull request 上执行静态、单元、浏览器、打包验证并上传构建产物。.github/workflows/release.yml 只在 v* 标签上运行，完整验证后构建 ZIP、SHA-256、提取变更说明并调用 gh release create。

这些文件不会自行登录或发布；只有将源码放入 GitHub 仓库并推送相应事件后才会运行。

## 15. 文件精简规则

删除文件前必须同时确认：

1. 不是 Manifest、HTML、package.json、脚本或测试入口；
2. rg 搜索没有有效引用；
3. 哈希与内容比较表明没有需要迁移的独有信息；
4. 不是构建、测试、发布或人工验收的必要依赖；
5. 独有结论已经进入 README、开发指南、产品设计、SECURITY 或 CHANGELOG；
6. 删除后定向测试和 npm run verify 全部通过。

当前保留 portal-preview.*，因为真实浏览器测试直接使用。完成整改后，旧审阅建议已迁入 CHANGELOG 和本指南；无版本、已过时的 UI 截图由自动化真实浏览器测试替代。Git 历史保留删除前基线和逐项整改提交。

## 16. 常见问题

### 状态一直显示等待重试

检查 connection.nextRetryAt。手工登录会清除旧重试；凭据错误需要先修正账号，不能依靠自动重试。

### 临时账号无法下线

检查 activeIdentity 是否存在有效网络参数，尤其是 wlan_user_mac。可先在原门户完成一次操作，让捕获逻辑补充参数。

### 自定义背景无法保存

原图上限为 48 MB，保存目标约 3 MB，完整状态预算为 8 MB。浏览器不支持图片压缩时需要换用更小图片。

### 自定义门户现代界面无法调用后台

2.5.3 的网页消息安全边界精确限制为 http://10.10.10.2。自定义地址可由扩展页访问，但不会获得默认门户的敏感消息能力。

### 打包哈希变化

先确认源码内容、Manifest 版本和 LICENSE 没有变化，再运行 npm run verify:package。dist/ 中的旧文件不参与输入。
