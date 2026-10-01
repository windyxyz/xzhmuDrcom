#!/bin/ash

CONFIG_FILE="${DRCOM_CONFIG:-/etc/drcom-xzhmu.conf}"
SESSION_FILE="${DRCOM_SESSION:-/tmp/drcom-xzhmu.session}"
LOCK_FILE="${DRCOM_LOCK:-${TMPDIR:-/tmp}/drcom-xzhmu.lock}"

# 会话文件与请求临时文件默认仅 root 可读写。
umask 077

PORTAL="${PORTAL:-http://10.10.10.2}"
API_URL="${API_URL:-}"
ENABLE_FIND_MAC="${ENABLE_FIND_MAC:-1}"
DEBUG_BIND="${DEBUG_BIND:-127.0.0.1}"
DEBUG_PORT="${DEBUG_PORT:-8765}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-8}"
API_RESPONSE_LIMIT="${API_RESPONSE_LIMIT:-65536}"
PORTAL_RESPONSE_LIMIT="${PORTAL_RESPONSE_LIMIT:-1048576}"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-,0,}"
LOGIN_METHOD="${LOGIN_METHOD:-1}"
JS_VERSION="${JS_VERSION:-3.3.2}"
CALLBACK_PREFIX="${CALLBACK_PREFIX:-dr}"
# 不安全降级默认关闭：只有用户显式设置 1 才允许把认证 URL 放进 wget 参数。
ALLOW_INSECURE_WGET="${ALLOW_INSECURE_WGET:-0}"
SESSION_VERSION=1
RUNTIME_IP=""
RUNTIME_IP_SOURCE=""

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# 配置文件按“KEY=VALUE”白名单解析，只接受下面列出的键，值一律当作普通字符串，
# 不再作为 shell 脚本 source 执行；配置中的任何 shell 元字符都不会被执行。
config_assign() {
  key="$1"
  value="$2"
  case "$key" in
    USERNAME) USERNAME="$value" ;;
    PASSWORD) PASSWORD="$value" ;;
    SUFFIX) SUFFIX="$value" ;;
    PORTAL) PORTAL="$value" ;;
    API_URL) API_URL="$value" ;;
    ENABLE_FIND_MAC) ENABLE_FIND_MAC="$value" ;;
    DEBUG_BIND) DEBUG_BIND="$value" ;;
    DEBUG_PORT) DEBUG_PORT="$value" ;;
    CONNECT_TIMEOUT) CONNECT_TIMEOUT="$value" ;;
    API_RESPONSE_LIMIT) API_RESPONSE_LIMIT="$value" ;;
    PORTAL_RESPONSE_LIMIT) PORTAL_RESPONSE_LIMIT="$value" ;;
    ACCOUNT_PREFIX) ACCOUNT_PREFIX="$value" ;;
    LOGIN_METHOD) LOGIN_METHOD="$value" ;;
    JS_VERSION) JS_VERSION="$value" ;;
    CALLBACK_PREFIX) CALLBACK_PREFIX="$value" ;;
    WLAN_USER_IP) WLAN_USER_IP="$value" ;;
    WLAN_USER_IPV6) WLAN_USER_IPV6="$value" ;;
    WLAN_AC_IP) WLAN_AC_IP="$value" ;;
    WLAN_AC_NAME) WLAN_AC_NAME="$value" ;;
    ALLOW_INSECURE_WGET) ALLOW_INSECURE_WGET="$value" ;;
  esac
}

load_config() {
  [ -r "$CONFIG_FILE" ] || fail "config not found: $CONFIG_FILE"
  while IFS= read -r config_line || [ -n "$config_line" ]; do
    config_line="$(printf '%s' "$config_line" | sed 's/^[[:space:]]*//;s/[[:space:]]*\r$//;s/[[:space:]]*$//')"
    case "$config_line" in
      ''|\#*|\;*) continue ;;
    esac
    case "$config_line" in
      *=*) ;;
      *) continue ;;
    esac
    config_key="${config_line%%=*}"
    config_value="${config_line#*=}"
    case "$config_key" in
      ''|*[!A-Za-z0-9_]*) continue ;;
    esac
    case "$config_value" in
      \"*\") config_value="${config_value#\"}"; config_value="${config_value%\"}" ;;
      \'*\') config_value="${config_value#\'}"; config_value="${config_value%\'}" ;;
    esac
    config_assign "$config_key" "$config_value"
  done < "$CONFIG_FILE"
  PORTAL="${PORTAL:-http://10.10.10.2}"
  API_URL="${API_URL:-}"
  ENABLE_FIND_MAC="${ENABLE_FIND_MAC:-1}"
  DEBUG_BIND="${DEBUG_BIND:-127.0.0.1}"
  DEBUG_PORT="${DEBUG_PORT:-8765}"
  CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-8}"
  API_RESPONSE_LIMIT="${API_RESPONSE_LIMIT:-65536}"
  PORTAL_RESPONSE_LIMIT="${PORTAL_RESPONSE_LIMIT:-1048576}"
  ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-,0,}"
  LOGIN_METHOD="${LOGIN_METHOD:-1}"
  JS_VERSION="${JS_VERSION:-3.3.2}"
  CALLBACK_PREFIX="${CALLBACK_PREFIX:-dr}"
  ALLOW_INSECURE_WGET="${ALLOW_INSECURE_WGET:-0}"
  ensure_runtime_dir || fail "cannot create private runtime directory"
  [ -n "$WGET_I_SUPPORTED" ] || probe_wget_i || WGET_I_SUPPORTED="0"
}

portal_origin() {
  printf '%s' "$PORTAL" | sed 's#^\(https\{0,1\}://[^/?]*\).*#\1#'
}

api_base() {
  if [ -n "$API_URL" ]; then
    case "$API_URL" in
      http://*|https://*) ;;
      *) return 1 ;;
    esac
    api="$API_URL"
    api="${api%%\#*}"
    api="${api%%\?*}"
    api="${api%/}"
    case "$api" in
      */eportal) printf '%s/' "$api" ;;
      *) printf '%s/eportal/' "$api" ;;
    esac
    return
  fi

  origin="$(portal_origin)"
  case "$origin" in
    *:801) printf '%s/eportal/' "$origin" ;;
    https://*) printf '%s/eportal/' "$origin" ;;
    http://*)
      authority="${origin#http://}"
      case "$authority" in
        \[*\]:[0-9]*) authority="${authority%%]:*}]" ;;
        *:[0-9]*) authority="${authority%:*}" ;;
      esac
      printf 'http://%s:801/eportal/' "$authority"
      ;;
    *) return 1 ;;
  esac
}

nonce() {
  printf '%s%s' "$(date +%s 2>/dev/null)" "$$"
}

callback() {
  printf '%s%s' "$CALLBACK_PREFIX" "$(nonce)"
}

url_encode() {
  bytes="$(printf '%s' "$1" | od -An -tx1 | tr -d ' \n')"
  encoded=""
  while [ -n "$bytes" ]; do
    byte="${bytes%${bytes#??}}"
    bytes="${bytes#??}"
    encoded="${encoded}%$(printf '%s' "$byte" | tr 'abcdef' 'ABCDEF')"
  done
  printf '%s' "$encoded"
}

# 认证 URL 携带密码，不能放在 wget 参数里（会暴露在 /proc/*/cmdline）。
# 优先写入临时文件用 wget -i 读取后立即删除；旧 BusyBox（<1.31）的 wget
# 没有 -i 时默认拒绝发送密码，只有显式允许 ALLOW_INSECURE_WGET=1 才降级。
RUNTIME_DIR=""
REQUEST_URL_FILE=""
RESPONSE_FILE=""
RESPONSE_PIPE=""
WGET_I_SUPPORTED=""

ensure_runtime_dir() {
  [ -n "$RUNTIME_DIR" ] && return 0
  RUNTIME_DIR="${TMPDIR:-/tmp}/drcom-xzhmu.$$"
  if ! mkdir "$RUNTIME_DIR" 2>/dev/null; then
    RUNTIME_DIR=""
    return 1
  fi
  chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
  REQUEST_URL_FILE="$RUNTIME_DIR/request.url"
  RESPONSE_FILE="$RUNTIME_DIR/response.body"
  RESPONSE_PIPE="$RUNTIME_DIR/response.pipe"
}

cleanup_runtime() {
  if [ -n "$RUNTIME_DIR" ]; then
    rm -f "$REQUEST_URL_FILE" "$REQUEST_URL_FILE.probe" "$RESPONSE_FILE" "$RESPONSE_PIPE" "$RUNTIME_DIR/session.new"
    rmdir "$RUNTIME_DIR" 2>/dev/null || true
  fi
  release_lock
}

# 跨进程互斥：login / logout / keepalive 同一时间只允许一个实例运行，
# 避免 cron keepalive 与用户手动 logout 并发操作网关。锁是单个文件：
# 先写好含本进程 PID 的私有临时文件，再用 ln 硬链接原子地创建公共锁文件。
# 硬链接创建要么成功要么失败（等价于"锁是否已存在"），且锁文件一出现就
# 携带完整 PID，不存在"锁已存在但 PID 尚未写入"的中间窗口；临时文件与
# 锁文件同目录，保证同一文件系统，ln 不会因跨设备而失败。
LOCK_HELD=""
LOCK_STALE=""

try_take_lock() {
  lock_tmp="$LOCK_FILE.$$"
  # 写入失败（如磁盘满）不得留下空锁文件，否则释放时无法校验所有者。
  if ! printf '%s\n' "$$" > "$lock_tmp" 2>/dev/null; then
    rm -f "$lock_tmp" 2>/dev/null
    return 1
  fi
  if ! ln "$lock_tmp" "$LOCK_FILE" 2>/dev/null; then
    rm -f "$lock_tmp" 2>/dev/null
    return 1
  fi
  rm -f "$lock_tmp" 2>/dev/null
  LOCK_HELD=1
  LOCK_STALE=""
  return 0
}

acquire_lock() {
  # 本进程已持锁（keepalive 离线时内部转调 login）时直接复用。
  [ "$LOCK_HELD" = "1" ] && return 0
  LOCK_STALE=""
  if try_take_lock; then
    return 0
  fi

  # 只识别残留锁，不在这里自动删除。
  # “检查旧锁 -> rm -> 重试”不是原子操作：另一个进程可能在检查后已经取得
  # 新锁，随后却被本进程误删。宁可安全失败并要求人工确认，也不能破坏互斥。
  lock_pid="$(cat "$LOCK_FILE" 2>/dev/null)"
  case "$lock_pid" in
    ''|*[!0-9]*) LOCK_STALE=1 ;;
    *)
      if ! kill -0 "$lock_pid" 2>/dev/null; then
        LOCK_STALE=1
      fi
      ;;
  esac
  return 1
}

release_lock() {
  [ "$LOCK_HELD" = "1" ] || return
  # 所有权校验：只有锁内 PID 仍是本进程时才删除，避免误删已被接管的锁。
  lock_pid="$(cat "$LOCK_FILE" 2>/dev/null)"
  if [ "$lock_pid" = "$$" ]; then
    rm -f "$LOCK_FILE" 2>/dev/null
  fi
  LOCK_HELD=""
}

# quiet=quiet 时（cron keepalive）拿不到活动锁按成功跳过，避免重复操作。
# 残留锁不会自动删除；自动删除存在 TOCTOU 竞态，可能误删另一个进程的新锁。
acquire_lock_or_fail() {
  command_name="$1"
  quiet="$2"
  acquire_lock && return 0
  if [ "$LOCK_STALE" = "1" ]; then
    if [ "$quiet" = "quiet" ]; then
      log "$command_name: stale lock detected at $LOCK_FILE; skipped (verify no drcom-xzhmu process is running, then remove the lock manually)"
      exit 0
    fi
    fail "$command_name: stale lock detected at $LOCK_FILE; verify no drcom-xzhmu process is running, then remove the lock manually"
  fi
  if [ "$quiet" = "quiet" ]; then
    log "$command_name: another drcom-xzhmu operation holds the lock; skipped"
    exit 0
  fi
  fail "$command_name: another drcom-xzhmu operation holds the lock; abort"
}

trap cleanup_runtime EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

probe_wget_i() {
  ensure_runtime_dir || return 1
  probe_err=""
  printf '%s\n' "http://127.0.0.1:1/" > "$REQUEST_URL_FILE.probe"
  probe_err="$(wget -i "$REQUEST_URL_FILE.probe" -T 1 -q -O /dev/null 2>&1)"
  case "$probe_err" in
    *"unrecognized option"*|*"invalid option"*) WGET_I_SUPPORTED="0" ;;
    *) WGET_I_SUPPORTED="1" ;;
  esac
  rm -f "$REQUEST_URL_FILE.probe"
}

http_get() {
  url="$1"
  limit="${2:-$API_RESPONSE_LIMIT}"
  case "$limit" in ''|*[!0-9]*) return 1 ;; esac
  limit="$(printf '%s' "$limit" | sed 's/^0*//')"
  [ -n "$limit" ] || limit="0"
  [ "$limit" -le 2147483646 ] 2>/dev/null || return 1
  ensure_runtime_dir || return 1
  [ -n "$WGET_I_SUPPORTED" ] || probe_wget_i
  rm -f "$RESPONSE_PIPE"
  mkfifo "$RESPONSE_PIPE" || return 1
  if [ "$WGET_I_SUPPORTED" = "1" ]; then
    if ! printf '%s' "$url" > "$REQUEST_URL_FILE"; then
      rm -f "$RESPONSE_PIPE"
      return 1
    fi
    wget -q -T "$CONNECT_TIMEOUT" -O - -i "$REQUEST_URL_FILE" > "$RESPONSE_PIPE" &
    wget_pid="$!"
  else
    wget -q -T "$CONNECT_TIMEOUT" -O - "$url" > "$RESPONSE_PIPE" &
    wget_pid="$!"
  fi

  head -c "$((limit + 1))" "$RESPONSE_PIPE" > "$RESPONSE_FILE"
  head_status="$?"
  wget_status="0"
  wait "$wget_pid" || wget_status="$?"
  rm -f "$REQUEST_URL_FILE"
  rm -f "$RESPONSE_PIPE"
  [ "$head_status" = "0" ] || { rm -f "$RESPONSE_FILE"; return 1; }
  bytes="$(wc -c < "$RESPONSE_FILE" | tr -d ' ')"
  case "$bytes" in ''|*[!0-9]*) rm -f "$RESPONSE_FILE"; return 1 ;; esac
  if [ "$bytes" -gt "$limit" ] 2>/dev/null; then
    rm -f "$RESPONSE_FILE"
    return 2
  fi
  [ "$wget_status" = "0" ] || { rm -f "$RESPONSE_FILE"; return "$wget_status"; }
  cat "$RESPONSE_FILE"
  rm -f "$RESPONSE_FILE"
}

protocol_payload() {
  body="$(printf '%s' "$1" | tr '\r\n' '  ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$body" in
    \{*\}) payload="$body" ;;
    *\(\{*\}\)\;|*\(\{*\}\))
      callback_name="${body%%(*}"
      case "$callback_name" in
        ''|*[!A-Za-z0-9_.$]*) return 1 ;;
      esac
      payload="${body#*(}"
      payload="${payload%;}"
      payload="${payload%)}"
      case "$payload" in \{*\}) ;; *) return 1 ;; esac
      ;;
    *=*)
      case "$body" in *[[:space:]\<\>\{\}]* ) return 1 ;; esac
      oldifs="$IFS"
      IFS='&'
      set -- $body
      IFS="$oldifs"
      for pair in "$@"; do
        case "$pair" in
          [A-Za-z]*=*)
            pair_key="${pair%%=*}"
            case "$pair_key" in *[!A-Za-z0-9_-]*) return 1 ;; esac
            ;;
          *) return 1 ;;
        esac
      done
      payload="$body"
      ;;
    *) return 1 ;;
  esac
  printf '%s' "$payload"
}

extract_value() {
  key="$2"
  case "$key" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  payload="$(protocol_payload "$1")" || return
  case "$payload" in
    \{*\})
      # 键名必须从对象边界（{ 或 ,）开始，避免 notresult 误命中 result。
      # 先读取引号值，保留其中的空格/逗号；再处理数字、true、success 等裸值。
      value="$(printf '%s' "$payload" |
        sed -n "s/.*[{,][[:space:]]*[\"']\{0,1\}${key}[\"']\{0,1\}[[:space:]]*:[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" |
        sed -n '1p')"
      if [ -n "$value" ]; then
        printf '%s' "$value"
        return 0
      fi
      printf '%s' "$payload" |
        sed -n "s/.*[{,][[:space:]]*[\"']\{0,1\}${key}[\"']\{0,1\}[[:space:]]*:[[:space:]]*\([^\"',;}[:space:]][^,;}[:space:]]*\).*/\1/p" |
        sed -n '1p'
      ;;
    *=*)
      oldifs="$IFS"
      IFS='&'
      set -- $payload
      IFS="$oldifs"
      for pair in "$@"; do
        pair_key="${pair%%=*}"
        if [ "$pair_key" = "$key" ]; then
          printf '%s' "${pair#*=}"
          return 0
        fi
      done
      ;;
  esac
}

extract_message() {
  msg="$(extract_value "$1" msg)"
  [ -n "$msg" ] || msg="$(extract_value "$1" msga)"
  [ -n "$msg" ] || msg="$(extract_value "$1" message)"
  printf '%s' "$msg"
}

query_status_state() {
  url="$(portal_origin)/drcom/chkstatus?callback=$(callback)&v=$(nonce)"
  body="$(http_get "$url" 2>/dev/null)" || {
    STATUS_BODY=""
    STATUS_MESSAGE="status unknown"
    STATUS_STATE="unknown"
    STATUS_UID=""
    STATUS_IP=""
    STATUS_MAC=""
    return
  }
  STATUS_BODY="$body"
  result="$(extract_value "$body" result)"
  case "$result" in
    1) STATUS_MESSAGE="online"; STATUS_STATE="online" ;;
    0) STATUS_MESSAGE="offline"; STATUS_STATE="offline" ;;
    *) STATUS_MESSAGE="unknown"; STATUS_STATE="unknown" ;;
  esac
  STATUS_UID="$(extract_value "$body" uid)"
  STATUS_IP=""
  for key in v46ip wlan_user_ip user_ip v4ip; do
    candidate="$(extract_value "$body" "$key")"
    if valid_ipv4 "$candidate"; then STATUS_IP="$candidate"; break; fi
  done
  STATUS_MAC=""
  for key in ss4 olmac wlan_user_mac online_mac; do
    candidate="$(extract_value "$body" "$key")"
    if usable_mac "$candidate"; then STATUS_MAC="$(normalize_mac "$candidate")"; break; fi
  done
}

valid_ipv4() {
  text="$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ "$text" = "0.0.0.0" ] && return 1
  oldifs="$IFS"
  IFS=.
  set -- $text
  IFS="$oldifs"
  [ "$#" -eq 4 ] || return 1
  for part in "$@"; do
    case "$part" in
      ''|*[!0-9]*) return 1 ;;
    esac
    [ "$part" != "0" ] && case "$part" in 0*) return 1 ;; esac
    [ "$part" -le 255 ] 2>/dev/null || return 1
  done
  return 0
}

query_param() {
  url="$1"
  name="$2"
  case "$url" in
    *\?*) query="${url#*\?}" ;;
    *) return ;;
  esac
  query="${query%%#*}"
  oldifs="$IFS"
  IFS='&'
  set -- $query
  IFS="$oldifs"
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    [ "$key" = "$name" ] && {
      printf '%s' "$value"
      return
    }
  done
}

read_static_string() {
  name="$2"
  printf '%s' "$1" |
    tr ';\r\n' '\n\n\n' |
    sed -n "s/^[[:space:]]*\(var\|let\|const\)\{0,1\}[[:space:]]*${name}[[:space:]]*=[[:space:]]*[\"']\([^\"']*\)[\"'].*/\2/p" |
    sed -n '1p'
}

# 部分 BusyBox printf 不接受 0x 前缀参数，改用字符位查表换算。
hex_digit_value() {
  digit="$1"
  case "$digit" in
    [0-9]) printf '%s' "$digit" ;;
    [A-F]) case "$digit" in
      A) printf '10' ;; B) printf '11' ;; C) printf '12' ;;
      D) printf '13' ;; E) printf '14' ;; F) printf '15' ;;
    esac ;;
    *) return 1 ;;
  esac
}

decode_ss3_ipv4() {
  hex="$(printf '%s' "$1" | tr 'abcdef' 'ABCDEF')"
  case "$hex" in
    ????????) ;;
    *) return ;;
  esac
  case "$hex" in
    *[!0-9A-F]*) return ;;
  esac
  byte() {
    high="$(hex_digit_value "$(printf '%s' "$1" | cut -c 1)")" || return 1
    low="$(hex_digit_value "$(printf '%s' "$1" | cut -c 2)")" || return 1
    printf '%d' $((high * 16 + low))
  }
  a="$(byte "${hex%${hex#??}}")" || return
  rest="${hex#??}"
  b="$(byte "${rest%${rest#??}}")" || return
  rest="${rest#??}"
  c="$(byte "${rest%${rest#??}}")" || return
  rest="${rest#??}"
  d="$(byte "$rest")" || return
  printf '%s.%s.%s.%s' "$a" "$b" "$c" "$d"
}

resolve_runtime_ip() {
  page_url="${1:-$PORTAL}"
  RUNTIME_IP=""
  RUNTIME_IP_SOURCE=""
  html="$(http_get "$PORTAL" "$PORTAL_RESPONSE_LIMIT" 2>/dev/null)" || html=""
  for key in v46ip ss5 v4ip; do
    candidate="$(read_static_string "$html" "$key")"
    if valid_ipv4 "$candidate"; then
      RUNTIME_IP="$candidate"
      RUNTIME_IP_SOURCE="$key"
      return 0
    fi
  done

  ss3="$(read_static_string "$html" ss3)"
  candidate="$(decode_ss3_ipv4 "$ss3")"
  if valid_ipv4 "$candidate"; then
    RUNTIME_IP="$candidate"
    RUNTIME_IP_SOURCE="ss3"
    return 0
  fi

  # 地址栏/配置 URL 可能保留上一次重定向的旧 IP。只有刚获取的门户正文没有
  # 有效运行时 IP 时才使用 URL 参数，避免旧参数覆盖当前链路状态。
  for key in ip wlanuserip wlan_user_ip userip user-ip UserIP uip station_ip; do
    candidate="$(query_param "$page_url" "$key")"
    if valid_ipv4 "$candidate"; then
      RUNTIME_IP="$candidate"
      RUNTIME_IP_SOURCE="url:$key"
      return 0
    fi
  done

  if valid_ipv4 "$WLAN_USER_IP"; then
    RUNTIME_IP="$WLAN_USER_IP"
    RUNTIME_IP_SOURCE="config"
    return 0
  fi
  return 1
}

normalize_mac() {
  # '-' 必须放在集合末尾，否则被 tr 当作 ':' 到 '.' 的反向区间。
  printf '%s' "$1" | tr 'abcdef' 'ABCDEF' | tr -d ':.-'
}

usable_mac() {
  mac="$(normalize_mac "$1")"
  case "$mac" in
    000000000000|111111111111|"") return 1 ;;
    ????????????) case "$mac" in *[!0-9A-F]*) return 1 ;; *) return 0 ;; esac ;;
    *) return 1 ;;
  esac
}

extract_mac() {
  for key in mac user_mac wlan_user_mac wlanUserMac online_user_mac onlineUserMac; do
    candidate="$(extract_value "$1" "$key")"
    if usable_mac "$candidate"; then
      normalize_mac "$candidate"
      return
    fi
  done
}

compose_login_account() {
  printf '%s%s%s' "$ACCOUNT_PREFIX" "$USERNAME" "$SUFFIX"
}

compose_logout_account() {
  printf '%s%s' "$USERNAME" "$SUFFIX"
}

build_find_mac_url() {
  account="$1"
  ip="$2"
  base="$(api_base)"
  printf '%s?c=Portal&a=find_mac&callback=dr1004&user_account=%s&login_method=%s&find_mac=0&wlan_user_ip=%s&jsVersion=%s&v=%s' \
    "$base" "$(url_encode "$account")" "$(url_encode "$LOGIN_METHOD")" "$(url_encode "$ip")" "$(url_encode "$JS_VERSION")" "$(nonce)"
}

extract_mac_for_ip() {
  payload="$(protocol_payload "$1")" || return
  expected_ip="$2"
  printf '%s' "$payload" |
    sed 's/}[[:space:]]*,[[:space:]]*{/}\
{/g' |
    while IFS= read -r record || [ -n "$record" ]; do
      record_ip="$(extract_value "$record" online_ip)"
      [ "$record_ip" = "$expected_ip" ] || continue
      record_mac="$(extract_value "$record" online_mac)"
      if usable_mac "$record_mac"; then
        normalize_mac "$record_mac"
        break
      fi
    done
}

try_find_mac_for_account() {
  [ "$ENABLE_FIND_MAC" = "0" ] && return
  account="$1"
  ip="$2"
  body="$(http_get "$(build_find_mac_url "$account" "$ip")" 2>/dev/null)" || return
  mac="$(extract_mac_for_ip "$body" "$ip")"
  if usable_mac "$mac"; then
    printf '%s' "$mac"
    return
  fi
  payload="$(protocol_payload "$body")" || return
  case "$payload" in *list*) return ;; esac
  mac="$(extract_mac "$body")"
  usable_mac "$mac" && printf '%s' "$mac"
}

build_login_url() {
  ip="$1"
  mac="$2"
  base="$(api_base)"
  printf '%s?c=Portal&a=login&callback=%s&login_method=%s&user_account=%s&user_password=%s&wlan_user_ip=%s&wlan_user_ipv6=%s&wlan_user_mac=%s&wlan_ac_ip=%s&wlan_ac_name=%s&jsVersion=%s&v=%s' \
    "$base" "$(callback)" "$(url_encode "$LOGIN_METHOD")" "$(url_encode "$(compose_login_account)")" "$(url_encode "$PASSWORD")" \
    "$(url_encode "$ip")" "$(url_encode "")" "$(url_encode "${mac:-000000000000}")" \
    "$(url_encode "")" "$(url_encode "")" "$(url_encode "$JS_VERSION")" "$(nonce)"
}

build_unbind_url() {
  account="$1"
  ip="$2"
  mac="$3"
  base="$(api_base)"
  printf '%s?c=Portal&a=unbind_mac&callback=%s&user_account=%s&wlan_user_mac=%s&wlan_user_ip=%s&jsVersion=%s&v=%s' \
    "$base" "$(callback)" "$(url_encode "$account")" "$(url_encode "$mac")" "$(url_encode "$ip")" "$(url_encode "$JS_VERSION")" "$(nonce)"
}

build_logout_url() {
  ip="$1"
  mac="$2"
  base="$(api_base)"
  printf '%s?c=Portal&a=logout&callback=%s&login_method=%s&user_account=drcom&user_password=123&ac_logout=1&register_mode=1&wlan_user_ip=%s&wlan_user_ipv6=%s&wlan_vlan_id=1&wlan_user_mac=%s&wlan_ac_ip=%s&wlan_ac_name=%s&jsVersion=%s&v=%s' \
    "$base" "$(callback)" "$(url_encode "$LOGIN_METHOD")" "$(url_encode "$ip")" "$(url_encode "$WLAN_USER_IPV6")" \
    "$(url_encode "${mac:-000000000000}")" "$(url_encode "$WLAN_AC_IP")" "$(url_encode "$WLAN_AC_NAME")" "$(url_encode "$JS_VERSION")" "$(nonce)"
}

already_online_response() {
  msg="$(extract_message "$1")"
  printf '%s' "$msg" | grep -Eiq '已经在线|已在线|already online|has been online|E2620'
}

classify_failure_code() {
  msg="$(extract_message "$1")"
  if printf '%s' "$msg" | grep -Eiq 'userid error1|用户不存在|账号不存在'; then printf '%s' 'user_not_found'; return; fi
  if printf '%s' "$msg" | grep -Eiq 'userid error2|密码(错误|不正确|失效)|password[[:space:]]*(fail|error|incorrect|invalid|wrong)'; then printf '%s' 'bad_credentials'; return; fi
  if printf '%s' "$msg" | grep -Eiq 'AC999|设备数量|终端数量|MAC[[:space:]]*冲突'; then printf '%s' 'device_limit'; return; fi
  if printf '%s' "$msg" | grep -Eiq 'flux out|balance|欠费|流量|停机'; then printf '%s' 'account_restricted'; return; fi
  if printf '%s' "$msg" | grep -Eiq '(^|[^[:alnum:]_])(ip|mac)([^[:alnum:]_].*)?(mismatch|invalid|error)|(^|[^[:alnum:]_])(bind|unbind)([^[:alnum:]_]|$)|绑定'; then printf '%s' 'network_parameters'; return; fi
  printf '%s' 'gateway_rejected'
}

login_success_response() {
  body="$1"
  LOGIN_FAILURE_CODE=""
  result="$(extract_value "$body" result)"
  ret_code="$(extract_value "$body" ret_code)"
  case "$result" in
    1|true|success|ok) return 0 ;;
    0)
      [ "$ret_code" = "2" ] && already_online_response "$body" && return 2
      LOGIN_FAILURE_CODE="$(classify_failure_code "$body")"
      return 1
      ;;
    *) LOGIN_FAILURE_CODE="protocol_unknown"; return 1 ;;
  esac
}

save_session() {
  umask 077
  ensure_runtime_dir || return 1
  {
    printf 'SESSION_VERSION=%s\n' "$SESSION_VERSION"
    printf 'SESSION_IP=%s\n' "$1"
    printf 'SESSION_MAC=%s\n' "$2"
    printf 'SESSION_AT=%s\n' "$(date +%s 2>/dev/null)"
  } > "$RUNTIME_DIR/session.new" || return 1
  chmod 600 "$RUNTIME_DIR/session.new" 2>/dev/null || true
  mv -f "$RUNTIME_DIR/session.new" "$SESSION_FILE"
}

load_session() {
  [ -r "$SESSION_FILE" ] || return 1
  [ ! -L "$SESSION_FILE" ] && [ ! -h "$SESSION_FILE" ] || return 1
  session_version=""
  session_ip=""
  session_mac=""
  session_at=""
  while IFS='=' read -r key value; do
    case "$key" in
      '') continue ;;
      SESSION_VERSION) [ "$value" = "$SESSION_VERSION" ] || return 1; session_version="$value" ;;
      SESSION_IP) valid_ipv4 "$value" || return 1; session_ip="$value" ;;
      SESSION_MAC)
        case "$(normalize_mac "$value")" in ????????????) session_mac="$(normalize_mac "$value")" ;; *) return 1 ;; esac
        ;;
      SESSION_AT) case "$value" in ''|*[!0-9]*) return 1 ;; *) session_at="$value" ;; esac ;;
      *) return 1 ;;
    esac
  done < "$SESSION_FILE"
  # 旧格式（无版本字段）或版本不匹配的会话缓存一律视为无效；会话只是辅助数据，
  # 在线状态永远以网关 chkstatus 为权威来源。
  [ -n "$session_version" ] || return 1
  [ -n "$session_ip" ] || return 1
  SESSION_IP="$session_ip"
  SESSION_MAC="$session_mac"
  SESSION_AT="$session_at"
}

clear_session() {
  rm -f "$SESSION_FILE"
}

confirm_offline() {
  for delay in 5 2; do
    sleep "$delay"
    query_status_state
    state="$STATUS_STATE"
    [ "$state" = "offline" ] && return 0
  done
  return 1
}

mask_account() {
  value="$1"
  [ -n "$value" ] || { printf '%s' ""; return; }
  short="$(printf '%s' "$value" | sed 's/@.*$//')"
  length="${#short}"
  prefix="$(printf '%s' "$short" | cut -c 1-2)"
  start=$((length - 1))
  [ "$start" -lt 1 ] && start=1
  suffix="$(printf '%s' "$short" | cut -c "$start"-"$length")"
  printf '%s***%s' "$prefix" "$suffix"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

mask_ip() {
  oldifs="$IFS"
  IFS=.
  set -- $1
  IFS="$oldifs"
  [ "$#" -eq 4 ] && printf '%s.***.***.%s' "$1" "$4"
}

mask_mac() {
  mac="$(normalize_mac "$1")"
  case "$mac" in
    ????????????) printf '%s:%s:%s:**:**:**' "$(printf '%s' "$mac" | cut -c 1-2)" "$(printf '%s' "$mac" | cut -c 3-4)" "$(printf '%s' "$mac" | cut -c 5-6)" ;;
  esac
}

cmd_login() {
  load_config
  [ -n "$USERNAME" ] || fail "USERNAME is required"
  [ -n "$PASSWORD" ] || fail "PASSWORD is required"
  acquire_lock_or_fail login

  query_status_state
  state="$STATUS_STATE"
  if [ "$state" = "online" ]; then
    log "already online; password request skipped"
    return 0
  fi

  # 安全闸门放在确认离线、即将构造登录请求之后：已在线时无需密码，
  # 老版本 wget 也不应因此被拒绝查询。
  if [ "$WGET_I_SUPPORTED" != "1" ] && [ "$ALLOW_INSECURE_WGET" != "1" ]; then
    fail "refusing to send password: wget does not support '-i'; to avoid exposing the campus password in the process list, login aborted (set ALLOW_INSECURE_WGET=1 only if you accept the risk)"
  fi

  resolve_runtime_ip "$PORTAL" || fail "missing portal runtime IP; password request skipped"
  ip="$RUNTIME_IP"
  # 学校生产门户的登录请求固定使用全零 MAC；find_mac 仅用于注销时定位本机终端。
  mac="000000000000"
  body="$(http_get "$(build_login_url "$ip" "$mac")" 2>/dev/null)" || fail "login request failed"
  login_success_response "$body"
  rc="$?"
  if [ "$rc" = "0" ]; then
    query_status_state
    state="$STATUS_STATE"
    if [ "$state" = "online" ]; then
      save_session "$ip" "$mac"
      log "login success confirmed: account=$(mask_account "$USERNAME") ip=$(mask_ip "$ip") mac=$(mask_mac "$mac") source=$RUNTIME_IP_SOURCE"
      return 0
    fi
  fi
  if [ "$rc" = "2" ]; then
    query_status_state
    state="$STATUS_STATE"
    if [ "$state" = "online" ]; then
      save_session "$ip" "$mac"
      log "already online confirmed: account=$(mask_account "$USERNAME") ip=$(mask_ip "$ip")"
      return 0
    fi
  fi
  fail "login failed or response is unknown (code=${LOGIN_FAILURE_CODE:-protocol_unknown})"
}

cmd_status() {
  load_config
  query_status_state
  state="$STATUS_STATE"
  log "state=$state message=$STATUS_MESSAGE"
}

cmd_keepalive() {
  load_config
  acquire_lock_or_fail keepalive quiet
  query_status_state
  state="$STATUS_STATE"
  case "$state" in
    online) log "online; keepalive skipped" ;;
    offline) cmd_login ;;
    *) log "unknown; keepalive will not send password" ;;
  esac
}

cmd_logout() {
  load_config
  acquire_lock_or_fail logout
  SESSION_IP=""
  SESSION_MAC=""
  SESSION_AT=""
  load_session || true
  query_status_state
  live_state="$STATUS_STATE"
  if [ "$live_state" = "offline" ]; then
    clear_session
    log "already offline"
    return 0
  fi

  account="$STATUS_UID"
  [ -n "$account" ] || account="$(compose_logout_account)"
  ip="$STATUS_IP"
  if [ -z "$ip" ] && resolve_runtime_ip "$PORTAL" 2>/dev/null; then
    ip="$RUNTIME_IP"
  fi
  [ -n "$ip" ] || ip="$SESSION_IP"
  [ -n "$ip" ] || fail "missing logout IP"
  mac="$STATUS_MAC"
  usable_mac "$mac" || mac="$SESSION_MAC"
  if ! usable_mac "$mac" && [ "$live_state" = "online" ] && [ -n "$STATUS_UID" ]; then
    mac="$(try_find_mac_for_account "$STATUS_UID" "$ip")"
  fi
  [ -n "$mac" ] || mac="000000000000"

  if usable_mac "$mac"; then
    http_get "$(build_unbind_url "$account" "$ip" "$mac")" >/dev/null 2>&1 || true
    if confirm_offline; then
      clear_session
      log "logout confirmed offline after unbind"
      return 0
    fi
  fi

  http_get "$(build_logout_url "$ip" "$mac")" >/dev/null 2>&1 || true
  if confirm_offline; then
    clear_session
    log "logout confirmed offline"
    return 0
  fi

  query_status_state
  state="$STATUS_STATE"
  [ "$state" = "online" ] && fail "logout not completed; session is still online"
  fail "logout request sent but offline state is not confirmed"
}

debug_json() {
  load_config
  query_status_state
  state="$STATUS_STATE"
  ip=""
  if resolve_runtime_ip "$PORTAL" 2>/dev/null; then
    ip="$RUNTIME_IP"
  fi
  load_session || true
  [ -n "$ip" ] || ip="$SESSION_IP"
  mac="$SESSION_MAC"
  printf '{"state":"%s","message":"%s","checkedAt":%s,"account":"%s","network":{"ipv4":"%s","mac":"%s"}}\n' \
    "$(json_escape "$state")" "$(json_escape "$STATUS_MESSAGE")" "$(date +%s 2>/dev/null)" "$(json_escape "$(mask_account "$USERNAME")")" "$(mask_ip "$ip")" "$(mask_mac "$mac")"
}

cmd_debug_server() {
  command -v nc >/dev/null 2>&1 || fail "nc not found; install netcat or use status"
  load_config
  log "debug server listening on $DEBUG_BIND:$DEBUG_PORT"
  while true; do
    body="$(debug_json)"
    length="$(printf '%s' "$body" | wc -c | tr -d ' ')"
    {
      printf 'HTTP/1.1 200 OK\r\n'
      printf 'Content-Type: application/json; charset=utf-8\r\n'
      printf 'Cache-Control: no-store\r\n'
      printf 'Content-Length: %s\r\n' "$length"
      printf '\r\n'
      printf '%s' "$body"
    } | nc -l -s "$DEBUG_BIND" -p "$DEBUG_PORT"
  done
}

usage() {
  cat <<'EOF'
Usage: drcom-xzhmu.sh <command>

Commands:
  login         Login through the XuZhou Medical University DrCOM portal.
  logout        Logout; tries unbind_mac before full Portal/logout.
  status        Print online/offline/unknown.
  keepalive     Login only when status is explicitly offline.
  debug-server  Serve redacted JSON status on DEBUG_BIND:DEBUG_PORT when nc exists.
  help          Show this help.

Config:
  /etc/drcom-xzhmu.conf, or DRCOM_CONFIG=/path/to/file
EOF
}

case "${1:-help}" in
  login) cmd_login ;;
  logout) cmd_logout ;;
  status) cmd_status ;;
  keepalive) cmd_keepalive ;;
  debug-server) cmd_debug_server ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
