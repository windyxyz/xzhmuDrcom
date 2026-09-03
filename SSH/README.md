# DrCom徐医 OpenWrt 脚本

`drcom-xzhmu.sh` 是一个独立的 OpenWrt/BusyBox `ash` 脚本，用于在路由器上完成徐医 DrCOM 校园网登录、状态检查、保活和注销。它吸收浏览器扩展 1.0.1 的登录经验，但不依赖 Chrome、Node.js、curl、jq 或 Python。

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
ENABLE_FIND_MAC='1'
DEBUG_BIND='127.0.0.1'
DEBUG_PORT='8765'
CONNECT_TIMEOUT='8'
EOF
chmod 600 /etc/drcom-xzhmu.conf
```

`SUFFIX` 可按学校账号类型填写，例如 `@telecom`、`@unicom`、`@cmcc`；校园网账号可留空。一个配置文件只管理一个账号。需要多账号时，使用多个配置文件并通过 `DRCOM_CONFIG=/path/to/file` 指定。

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
3. 依次从 `PORTAL` URL 参数、门户首页静态变量 `v46ip`、`ss5`、`v4ip`、`ss3` 解析当前 IPv4。
4. 没有有效 IP 时停止，避免构造任何包含 `user_password` 的认证请求。
5. 获取 IP 后可选调用 `Portal/find_mac`，有效 MAC 会进入最终登录请求。
6. 发送 `Portal/login`。只有 `result=1`，或 `ret_code=2` 且带“已在线”语义并复核在线，才认为登录成功。

脚本不会执行门户页面 JavaScript，只读取白名单变量的简单字符串字面量。账号历史 IP 不参与自动回退；如果需要固定 IP 回退，可在配置里显式写 `WLAN_USER_IP='x.x.x.x'`。

## 注销原理

登录成功后，脚本在 `/tmp/drcom-xzhmu.session` 保存本次会话上下文，只有当前 IP、MAC 和时间，不含账号、后缀和密码。注销时：

1. 优先重新解析当前门户 IP，失败时使用会话文件里的 IP。
2. 有有效 MAC 时先请求 `Portal/unbind_mac`。
3. 复核仍未明确离线时，请求完整 `Portal/logout`。
4. 只有 `/drcom/chkstatus` 明确离线，才删除会话文件。

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

- 密码明文保存在路由器本机 `/etc/drcom-xzhmu.conf`，建议 `chmod 600`。
- 学校 DrCOM 门户使用 HTTP GET 协议，最终登录请求会在 URL 查询参数中携带密码；脚本无法把学校协议升级为加密传输。认证 URL 默认写入仅本机可读的临时文件并经 `wget -i` 发送，避免密码短暂出现在 `ps` 与 `/proc/*/cmdline`；旧版 BusyBox 的 wget 不支持 `-i` 时自动退回参数传递。
- 脚本日志、状态输出和调试端口默认不输出完整账号、密码、IP、MAC 或认证 URL。
- 不要把真实配置文件、抓包、HAR、MHTML 或 `/tmp/drcom-xzhmu.session` 提交到仓库或发给别人。
