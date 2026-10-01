# DrCom徐医 OpenWrt 脚本

`drcom-xzhmu.sh` 是一个独立的 OpenWrt/BusyBox `ash` 脚本，用于在路由器上完成徐医 DrCOM 校园网登录、状态检查、保活和注销。它同步浏览器扩展 1.1.1 经生产抓包验证的登录与终端解绑逻辑，但不依赖 Chrome、Node.js、curl、jq 或 Python。

## 部署

复制脚本到路由器，例如：

```sh
scp drcom-xzhmu.sh root@192.168.1.1:/usr/bin/drcom-xzhmu
ssh root@192.168.1.1 'chmod 755 /usr/bin/drcom-xzhmu'
```

创建配置文件：

```sh
cat >/etc/drcom-xzhmu.conf <<'EOF'
USERNAME='你的学号'
PASSWORD='你的密码'
SUFFIX=''
PORTAL='http://10.10.10.2'
# 可选。默认会按学校协议从 PORTAL 主机推导 :801/eportal/；
# 自定义网关/API 不同源或使用特殊端口时应显式填写。
API_URL='http://10.10.10.2:801/eportal/'
ENABLE_FIND_MAC='1'
DEBUG_BIND='127.0.0.1'
DEBUG_PORT='8765'
CONNECT_TIMEOUT='8'
API_RESPONSE_LIMIT='65536'
PORTAL_RESPONSE_LIMIT='1048576'
EOF
chmod 600 /etc/drcom-xzhmu.conf
```

`SUFFIX` 可按学校账号类型填写，例如 `@telecom`、`@unicom`、`@cmcc`；校园网账号可留空。一个配置文件只管理一个账号。需要多账号时，使用多个配置文件并通过 `DRCOM_CONFIG=/path/to/file` 指定。

`API_URL` 可以省略。省略时，HTTP 门户会使用同一主机的 `801` 端口，HTTPS 门户使用同一 origin 下的 `/eportal/`；如果学校网关、反向代理或自定义环境不是这个布局，请显式设置 `API_URL`，避免依赖推导。

## 命令

```sh
drcom-xzhmu status
drcom-xzhmu login
drcom-xzhmu logout
drcom-xzhmu keepalive
drcom-xzhmu debug-server
```

`keepalive` 只在 `/drcom/chkstatus` 明确返回离线时才会登录；状态未知时不会发送密码。

## 登录原理

脚本登录顺序与扩展保持一致：

1. 先访问 `/drcom/chkstatus`。如果已经在线，直接成功，不发送密码。
2. 离线或未知时获取当前门户上下文。
3. 优先从刚获取的门户首页静态变量 `v46ip`、`ss5`、`v4ip`、`ss3` 解析当前 IPv4；页面没有有效值时才回退到 `PORTAL` URL 参数，避免旧重定向参数覆盖当前网络状态。
4. 没有有效 IP 时停止，避免构造任何包含 `user_password` 的认证请求。
5. 登录请求严格沿用学校生产页面：只使用本次 IPv4，MAC 固定为 `000000000000`，IPv6 与 AC 字段留空；登录前不调用 `find_mac`。
6. 发送 `Portal/login`。只有 `result=1`，或 `ret_code=2` 且带“已在线”语义并复核在线，才认为登录成功。

登录失败时会附带与扩展一致的结构化错误代码，例如 `bad_credentials`、`user_not_found`、`device_limit`、`account_restricted`、`network_parameters`；无法识别的响应使用 `gateway_rejected` 或 `protocol_unknown`，便于日志与自动化统一分类。

脚本不会执行门户页面 JavaScript，只读取白名单变量的简单字符串字面量。账号历史 IP 不参与自动回退；如果需要固定 IP 回退，可在配置里显式写 `WLAN_USER_IP='x.x.x.x'`。

## 注销原理

登录成功后，脚本在 `/tmp/drcom-xzhmu.session` 保存本次会话上下文，只有当前 IP、MAC 和时间，不含账号、后缀和密码。注销时：

1. 先查询 `chkstatus`；已离线时直接清理旧会话记录。
2. 在线时优先读取 `uid`、`v46ip` 与 `ss4`，即学校原始页面使用的账号、IP 和 MAC 来源。
3. `ss4` 为全零、全一或无效时，只用完整在线账号调用一次 `Portal/find_mac`，并按当前 IP 匹配 `list[].online_mac`，不拿其他终端的 MAC。
4. 取得有效 MAC 后请求 `Portal/unbind_mac`，固定等待 5 秒再复核，避免把仍在生效中的解绑误判为失败。
5. 仍未明确离线时，请求带 `wlan_vlan_id=1` 的完整 `Portal/logout` 并再次复核。
6. 只有 `/drcom/chkstatus` 明确离线，才删除会话文件。

如果注销请求已发送但状态未知，脚本会保留会话文件并返回失败，避免把真实在线状态显示成离线。

## 调试端口

`debug-server` 需要系统存在 `nc`。默认只监听：

```text
127.0.0.1:8765
```

返回内容是脱敏 JSON，只包含状态、检查时间、脱敏账号和脱敏网络信息。需要从局域网访问时，手动设置：

```sh
DEBUG_BIND='0.0.0.0'
```

不要把调试端口暴露到公网。

## 开机和断线恢复

脚本不会自动修改 OpenWrt 启动项、防火墙或网络配置。最简单的定时保活方式是手动添加 cron：

```sh
*/3 * * * * /usr/bin/drcom-xzhmu keepalive >/tmp/drcom-xzhmu.log 2>&1
```

如果要在接口恢复时自动尝试，可以在热插拔脚本中调用 `drcom-xzhmu keepalive`。建议先手动验证 `status`、`login`、`logout` 都符合预期，再启用自动化。

## 安全边界

- 配置文件按 `KEY=VALUE` 字段白名单解析（`USERNAME`、`PASSWORD`、`SUFFIX`、`PORTAL`、`API_URL`、`ENABLE_FIND_MAC`、`CONNECT_TIMEOUT` 等），不会作为 shell 脚本执行；配置中的任何 shell 元字符都只是普通字符串。
- 密码明文保存在路由器本机 `/etc/drcom-xzhmu.conf`，建议 `chmod 600`。
- 学校 DrCOM 门户使用 HTTP GET 协议，最终登录请求会在 URL 查询参数中携带密码；脚本无法把学校协议升级为加密传输。认证 URL 默认写入仅本机可读的临时文件并经 `wget -i` 发送，避免密码短暂出现在 `ps` 与 `/proc/*/cmdline`。
- 旧版 BusyBox 的 wget 不支持 `-i` 时，脚本默认拒绝发送密码并终止登录，而不是自动降级为不安全参数传递；只有在明确接受风险后设置 `ALLOW_INSECURE_WGET=1` 才允许降级。
- `login`、`logout`、`keepalive` 共用 `/tmp/drcom-xzhmu.lock` 原子锁文件，避免 cron 保活与手动注销并发操作网关；`status` 只读不取锁。获取锁时先写好含本进程 PID 的私有临时文件，再以 `ln` 硬链接原子创建公共锁文件，锁文件一出现就携带完整 PID，不存在"锁已存在但 PID 未写入"的中间窗口；释放前校验锁内 PID 仍为本进程。SIGTERM/SIGINT/HUP 等正常可捕获退出会由 trap 自动释放锁；若 SIGKILL、异常断电等留下 PID 缺失、损坏或已不存在的残留锁，脚本会安全失败并保留锁文件，不会自动删除，以避免竞态下误删另一个进程刚取得的新锁。确认没有 `drcom-xzhmu` 进程运行后，再手工删除 `/tmp/drcom-xzhmu.lock`。
- 每个进程只探测一次 `wget -i` 支持；请求文件和响应文件位于权限为 0700 的私有临时目录。Dr.COM API 响应默认限制为 64 KiB，门户 HTML 默认限制为 1 MiB，超限响应不会进入 shell 变量。
- 会话文件带 `SESSION_VERSION=1` 版本字段，按字段白名单读取，不会作为 shell 脚本执行；旧格式、损坏或符号链接的会话一律拒绝。保存时先写入私有临时文件再原子替换。会话仍只包含版本、IP、MAC 与时间，且永远不作为在线状态的权威来源——网关 `chkstatus` 优先。
- 脚本日志、状态输出和调试端口默认不输出完整账号、密码、IP、MAC 或认证 URL。
- 不要把真实配置文件、抓包、HAR、MHTML 或 `/tmp/drcom-xzhmu.session` 提交到仓库或发给别人。
