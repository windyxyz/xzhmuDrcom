#!/bin/ash

CONFIG_FILE="${DRCOM_CONFIG:-/etc/drcom-xzhmu.conf}"
SESSION_FILE="${DRCOM_SESSION:-/tmp/drcom-xzhmu.session}"

# 会话文件与请求临时文件默认仅 root 可读写。
umask 077

PORTAL="${PORTAL:-http://10.10.10.2}"
ENABLE_FIND_MAC="${ENABLE_FIND_MAC:-1}"
DEBUG_BIND="${DEBUG_BIND:-127.0.0.1}"
DEBUG_PORT="${DEBUG_PORT:-8765}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-8}"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-,0,}"
LOGIN_METHOD="${LOGIN_METHOD:-1}"
JS_VERSION="${JS_VERSION:-3.3.2}"
CALLBACK_PREFIX="${CALLBACK_PREFIX:-dr}"

log() {
  printf '%s\n' "$*"
}

fail() {
  log "error: $*"
  exit 1
}

load_config() {
  [ -r "$CONFIG_FILE" ] || fail "config not found: $CONFIG_FILE"
  . "$CONFIG_FILE"
  PORTAL="${PORTAL:-http://10.10.10.2}"
  ENABLE_FIND_MAC="${ENABLE_FIND_MAC:-1}"
  DEBUG_BIND="${DEBUG_BIND:-127.0.0.1}"
  DEBUG_PORT="${DEBUG_PORT:-8765}"
  CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-8}"
  ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-,0,}"
  LOGIN_METHOD="${LOGIN_METHOD:-1}"
  JS_VERSION="${JS_VERSION:-3.3.2}"
  CALLBACK_PREFIX="${CALLBACK_PREFIX:-dr}"
}

portal_origin() {
  printf '%s' "$PORTAL" | sed 's#^\(https\{0,1\}://[^/?]*\).*#\1#'
}

api_base() {
  origin="$(portal_origin)"
  case "$origin" in
    *:801) printf '%s/eportal/' "$origin" ;;
    https://*) printf '%s/eportal/' "$origin" ;;
    *) printf '%s:801/eportal/' "$origin" ;;
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
# 没有 -i，探测失败时退回参数传递。
REQUEST_URL_FILE="${TMPDIR:-/tmp}/drcom-xzhmu.url.$$"
WGET_I_SUPPORTED=""

cleanup_request_file() {
  rm -f "$REQUEST_URL_FILE" "$REQUEST_URL_FILE.probe"
}

probe_wget_i() {
  probe_err=""
  printf '%s\n' "http://127.0.0.1:1/" > "$REQUEST_URL_FILE.probe"
  probe_err="$(wget -i "$REQUEST_URL_FILE.probe" -T 1 -q -O /dev/null 2>&1)"
  case "$probe_err" in
    *"unrecognized option"*|*"invalid option"*) WGET_I_SUPPORTED="0" ;;
    *) WGET_I_SUPPORTED="1" ;;
  esac
  cleanup_request_file
}

http_get() {
  [ -n "$WGET_I_SUPPORTED" ] || probe_wget_i
  if [ "$WGET_I_SUPPORTED" = "1" ]; then
    if ! printf '%s' "$1" > "$REQUEST_URL_FILE"; then
      return 1
    fi
    wget -q -T "$CONNECT_TIMEOUT" -O - -i "$REQUEST_URL_FILE"
    wget_status="$?"
    rm -f "$REQUEST_URL_FILE"
    return "$wget_status"
  fi
  wget -q -T "$CONNECT_TIMEOUT" -O - "$1"
}

trap cleanup_request_file EXIT

extract_value() {
  key="$2"
  printf '%s' "$1" |
    tr '\r\n' '  ' |
    sed -n "s/.*[\"']\{0,1\}${key}[\"']\{0,1\}[[:space:]]*[:=][[:space:]]*[\"']\{0,1\}\([^\"',;}[:space:]]*\).*/\1/p" |
    sed -n '1p'
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
    printf '%s' "unknown"
    return
  }
  STATUS_BODY="$body"
  result="$(extract_value "$body" result)"
  case "$result" in
    1) STATUS_MESSAGE="online"; printf '%s' "online" ;;
    0) STATUS_MESSAGE="offline"; printf '%s' "offline" ;;
    *) STATUS_MESSAGE="unknown"; printf '%s' "unknown" ;;
  esac
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
  for key in ip wlanuserip wlan_user_ip userip user-ip UserIP uip station_ip; do
    candidate="$(query_param "$page_url" "$key")"
    if valid_ipv4 "$candidate"; then
      RUNTIME_IP_SOURCE="url:$key"
      printf '%s' "$candidate"
      return 0
    fi
  done

  html="$(http_get "$PORTAL" 2>/dev/null)" || html=""
  for key in v46ip ss5 v4ip; do
    candidate="$(read_static_string "$html" "$key")"
    if valid_ipv4 "$candidate"; then
      RUNTIME_IP_SOURCE="$key"
      printf '%s' "$candidate"
      return 0
    fi
  done

  ss3="$(read_static_string "$html" ss3)"
  candidate="$(decode_ss3_ipv4 "$ss3")"
  if valid_ipv4 "$candidate"; then
    RUNTIME_IP_SOURCE="ss3"
    printf '%s' "$candidate"
    return 0
  fi

  if valid_ipv4 "$WLAN_USER_IP"; then
    RUNTIME_IP_SOURCE="config"
    printf '%s' "$WLAN_USER_IP"
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
    000000000000|"") return 1 ;;
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
  candidate="$(printf '%s' "$1" | grep -Eo '([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{12}' | sed -n '1p')"
  if usable_mac "$candidate"; then
    normalize_mac "$candidate"
  fi
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

try_find_mac() {
  [ "$ENABLE_FIND_MAC" = "0" ] && return
  ip="$1"
  for account in "$USERNAME" "$(compose_logout_account)"; do
    body="$(http_get "$(build_find_mac_url "$account" "$ip")" 2>/dev/null)" || body=""
    mac="$(extract_mac "$body")"
    if usable_mac "$mac"; then
      printf '%s' "$mac"
      return
    fi
  done
}

build_login_url() {
  ip="$1"
  mac="$2"
  base="$(api_base)"
  printf '%s?c=Portal&a=login&callback=%s&login_method=%s&user_account=%s&user_password=%s&wlan_user_ip=%s&wlan_user_ipv6=%s&wlan_user_mac=%s&wlan_ac_ip=%s&wlan_ac_name=%s&jsVersion=%s&v=%s' \
    "$base" "$(callback)" "$(url_encode "$LOGIN_METHOD")" "$(url_encode "$(compose_login_account)")" "$(url_encode "$PASSWORD")" \
    "$(url_encode "$ip")" "$(url_encode "$WLAN_USER_IPV6")" "$(url_encode "${mac:-000000000000}")" \
    "$(url_encode "$WLAN_AC_IP")" "$(url_encode "$WLAN_AC_NAME")" "$(url_encode "$JS_VERSION")" "$(nonce)"
}

build_unbind_url() {
  ip="$1"
  mac="$2"
  base="$(api_base)"
  printf '%s?c=Portal&a=unbind_mac&callback=%s&user_account=%s&wlan_user_mac=%s&wlan_user_ip=%s&jsVersion=%s&v=%s' \
    "$base" "$(callback)" "$(url_encode "$(compose_logout_account)")" "$(url_encode "$mac")" "$(url_encode "$ip")" "$(url_encode "$JS_VERSION")" "$(nonce)"
}

build_logout_url() {
  ip="$1"
  mac="$2"
  base="$(api_base)"
  printf '%s?c=Portal&a=logout&callback=%s&login_method=%s&user_account=drcom&user_password=123&ac_logout=1&register_mode=1&wlan_user_ip=%s&wlan_user_ipv6=%s&wlan_vlan_id=&wlan_user_mac=%s&wlan_ac_ip=%s&wlan_ac_name=%s&jsVersion=%s&v=%s' \
    "$base" "$(callback)" "$(url_encode "$LOGIN_METHOD")" "$(url_encode "$ip")" "$(url_encode "$WLAN_USER_IPV6")" \
    "$(url_encode "${mac:-000000000000}")" "$(url_encode "$WLAN_AC_IP")" "$(url_encode "$WLAN_AC_NAME")" "$(url_encode "$JS_VERSION")" "$(nonce)"
}

already_online_response() {
  msg="$(extract_message "$1")"
  printf '%s %s' "$msg" "$1" | grep -Eiq '已经在线|已在线|already online|has been online|E2620'
}

login_success_response() {
  body="$1"
  result="$(extract_value "$body" result)"
  ret_code="$(extract_value "$body" ret_code)"
  case "$result" in
    1|true|success|ok) return 0 ;;
    0)
      [ "$ret_code" = "2" ] && already_online_response "$body" && return 2
      return 1
      ;;
    *) return 1 ;;
  esac
}

save_session() {
  umask 077
  {
    printf 'SESSION_IP=%s\n' "$1"
    printf 'SESSION_MAC=%s\n' "$2"
    printf 'SESSION_AT=%s\n' "$(date +%s 2>/dev/null)"
  } > "$SESSION_FILE"
}

load_session() {
  [ -r "$SESSION_FILE" ] || return 1
  . "$SESSION_FILE"
}

clear_session() {
  rm -f "$SESSION_FILE"
}

confirm_offline() {
  for delay in 1 1 2; do
    sleep "$delay"
    state="$(query_status_state)"
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

  state="$(query_status_state)"
  if [ "$state" = "online" ]; then
    log "already online; password request skipped"
    return 0
  fi

  ip="$(resolve_runtime_ip "$PORTAL")" || fail "missing portal runtime IP; password request skipped"
  mac="$(try_find_mac "$ip")"
  [ -n "$mac" ] || mac="000000000000"
  body="$(http_get "$(build_login_url "$ip" "$mac")" 2>/dev/null)" || fail "login request failed"
  login_success_response "$body"
  rc="$?"
  if [ "$rc" = "0" ]; then
    save_session "$ip" "$mac"
    log "login success: account=$(mask_account "$USERNAME") ip=$(mask_ip "$ip") mac=$(mask_mac "$mac") source=$RUNTIME_IP_SOURCE"
    return 0
  fi
  if [ "$rc" = "2" ]; then
    state="$(query_status_state)"
    if [ "$state" = "online" ]; then
      save_session "$ip" "$mac"
      log "already online confirmed: account=$(mask_account "$USERNAME") ip=$(mask_ip "$ip")"
      return 0
    fi
  fi
  fail "login failed or response is unknown"
}

cmd_status() {
  load_config
  state="$(query_status_state)"
  log "state=$state message=$STATUS_MESSAGE"
}

cmd_keepalive() {
  load_config
  state="$(query_status_state)"
  case "$state" in
    online) log "online; keepalive skipped" ;;
    offline) cmd_login ;;
    *) log "unknown; keepalive will not send password" ;;
  esac
}

cmd_logout() {
  load_config
  load_session || true
  ip="$(resolve_runtime_ip "$PORTAL" 2>/dev/null)"
  [ -n "$ip" ] || ip="$SESSION_IP"
  [ -n "$ip" ] || fail "missing logout IP"
  mac="$SESSION_MAC"
  [ -n "$mac" ] || mac="000000000000"

  if usable_mac "$mac"; then
    http_get "$(build_unbind_url "$ip" "$mac")" >/dev/null 2>&1 || true
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

  state="$(query_status_state)"
  [ "$state" = "online" ] && fail "logout not completed; session is still online"
  fail "logout request sent but offline state is not confirmed"
}

debug_json() {
  load_config
  state="$(query_status_state)"
  ip="$(resolve_runtime_ip "$PORTAL" 2>/dev/null)"
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
