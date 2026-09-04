"use strict";

var portalSession = globalThis.DrcomPortalSession;

var accountUtils = globalThis.DrcomAccountUtils;
const DRCOM_RESPONSE_LIMIT_BYTES = 64 * 1024;

async function fetchDrcom(request, kind) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(request.url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      redirect: "manual",
      headers: {
        "Accept": "application/javascript, application/json, text/plain, */*",
        "Cache-Control": "no-cache"
      },
      signal: controller.signal
    });
    const text = await readLimitedResponse(response, DRCOM_RESPONSE_LIMIT_BYTES, controller);
    const parsed = parseDrcomText(text);
    const result = normalizeDrcomResult(kind, response.status, parsed, text);
    const payload = {
      ok: response.ok || result.success,
      statusCode: response.status,
      url: request.redactedUrl,
      raw: trimRaw(redactSensitiveText(text)),
      ...result
    };

    if (kind === "login" || kind === "logout") {
      await addRequestRecord({ kind, ...payload });
    }
    return payload;
  } catch (error) {
    const payload = {
      ok: false,
      success: false,
      online: false,
      message: error && error.name === "AbortError" ? "DrCOM 接口超时，请确认校园网网关可访问。" : `请求失败：${error.message || error}`,
      statusCode: 0,
      url: request.redactedUrl,
      raw: ""
    };
    if (kind === "login" || kind === "logout") {
      await addRequestRecord({ kind, ...payload });
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function buildStatusRequest(config) {
  const portalOrigin = new URL(config.portalUrl).origin;
  const url = new URL("/drcom/chkstatus", `${portalOrigin}/`);
  url.searchParams.set("callback", `${config.login.callbackPrefix || "dr"}1001`);
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: url.toString() };
}

async function queryPortalSessionStatus(config) {
  const request = buildStatusRequest(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(request.url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers: { "Accept": "application/javascript, application/json, text/plain, */*" },
      signal: controller.signal
    });
    const parsed = parseDrcomText(await readLimitedResponse(response, DRCOM_RESPONSE_LIMIT_BYTES, controller));
    const resultCode = parsed.result === undefined || parsed.result === null
      ? ""
      : stringValue(parsed.result).trim();
    const state = response.ok && resultCode === "1"
      ? "online"
      : response.ok && resultCode === "0"
        ? "offline"
        : "unknown";
    return {
      ok: response.ok && state !== "unknown",
      success: state === "online",
      online: state === "online",
      state,
      session: state === "online" && portalSession
        ? portalSession.normalizeSession(parsed)
        : null,
      statusCode: response.status,
      message: state === "online"
        ? "当前校园网会话在线。"
        : state === "offline"
          ? "当前需要登录校园网。"
          : "校园网会话状态不明确。",
      diagnostic: { statusCode: response.status, resultCode },
      url: request.redactedUrl,
      raw: ""
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      online: false,
      state: "unknown",
      statusCode: 0,
      message: error && error.name === "AbortError"
        ? "校园网状态检查超时。"
        : "无法确认校园网会话状态。",
      diagnostic: { statusCode: 0, resultCode: "" },
      url: request.redactedUrl,
      raw: ""
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildLoginRequest(account, config, networkOverride = null) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  const network = networkOverride || { ...config.network, ...account.network };

  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "login");
  url.searchParams.set("callback", `${config.login.callbackPrefix}${ts}`);
  url.searchParams.set("login_method", config.login.loginMethod || "1");
  url.searchParams.set("user_account", composeUserAccount(account, config));
  url.searchParams.set("user_password", account.password);
  url.searchParams.set("wlan_user_ip", network.wlanUserIp || "");
  url.searchParams.set("wlan_user_ipv6", network.wlanUserIpv6 || "");
  url.searchParams.set("wlan_user_mac", accountUtils.normalizeMac(network.wlanUserMac) || "000000000000");
  url.searchParams.set("wlan_ac_ip", network.wlanAcIp || "");
  url.searchParams.set("wlan_ac_name", network.wlanAcName || "");
  url.searchParams.set("jsVersion", config.login.jsVersion || "3.3.2");
  url.searchParams.set("v", createNonce());

  return { url: url.toString(), redactedUrl: redactSensitiveUrl(url.toString()) };
}

function buildFindMacRequest(account, config, options = {}) {
  const normalizedOptions = typeof options === "boolean" ? { includeSuffix: options } : options || {};
  const includeSuffix = normalizedOptions.includeSuffix === true;
  const url = new URL(config.apiUrl);
  const network = normalizedOptions.networkOverride || { ...config.network, ...account.network };
  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "find_mac");
  url.searchParams.set("callback", "dr1004");
  url.searchParams.set("user_account", includeSuffix ? composeLogoutUserAccount(account) : plainStudentId(account.username));
  url.searchParams.set("login_method", config.login.loginMethod || "1");
  url.searchParams.set("find_mac", "0");
  url.searchParams.set("wlan_user_ip", network.wlanUserIp || "");
  url.searchParams.set("jsVersion", config.login.jsVersion || "3.3.2");
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: url.toString() };
}

function buildUnbindRequest(account, config, networkOverride = null) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  const network = networkOverride || { ...config.network, ...account.network };

  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "unbind_mac");
  url.searchParams.set("callback", `${config.login.callbackPrefix}${ts}`);
  url.searchParams.set("user_account", composeLogoutUserAccount(account));
  url.searchParams.set("wlan_user_mac", accountUtils.normalizeMac(network.wlanUserMac) || "000000000000");
  url.searchParams.set("wlan_user_ip", network.wlanUserIp || "");
  url.searchParams.set("jsVersion", config.login.jsVersion || "3.3.2");
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: redactSensitiveUrl(url.toString()) };
}

function buildPortalLogoutRequest(config, networkOverride = null) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  const network = networkOverride || config.network || {};
  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "logout");
  url.searchParams.set("callback", `${config.login.callbackPrefix}${ts}`);
  url.searchParams.set("login_method", config.login.loginMethod || "1");
  url.searchParams.set("user_account", "drcom");
  url.searchParams.set("user_password", "123");
  url.searchParams.set("ac_logout", "1");
  url.searchParams.set("register_mode", "1");
  url.searchParams.set("wlan_user_ip", network.wlanUserIp || "");
  url.searchParams.set("wlan_user_ipv6", network.wlanUserIpv6 || "");
  url.searchParams.set("wlan_vlan_id", "");
  url.searchParams.set("wlan_user_mac", accountUtils.normalizeMac(network.wlanUserMac) || "000000000000");
  url.searchParams.set("wlan_ac_ip", network.wlanAcIp || "");
  url.searchParams.set("wlan_ac_name", network.wlanAcName || "");
  url.searchParams.set("jsVersion", config.login.jsVersion || "3.3.2");
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: redactSensitiveUrl(url.toString()) };
}

function plainStudentId(value) {
  return accountUtils.parse(value).username;
}

function composeUserAccount(account, config) {
  const parsed = accountUtils.parse(account.username, account.suffix);
  const prefix = stringValue(config.login.accountPrefix) || ",0,";
  return `${prefix}${parsed.username}${parsed.suffix}`;
}

function composeLogoutUserAccount(account) {
  const parsed = accountUtils.parse(account.username, account.suffix);
  return `${parsed.username}${parsed.suffix}`;
}

function parseDrcomText(text) {
  const clean = stringValue(text).trim().replace(/^\uFEFF/, "");
  if (!clean) {
    return {};
  }

  const direct = tryJson(clean);
  if (direct && !Array.isArray(direct)) {
    return direct;
  }

  const openParen = clean.indexOf("(");
  const jsonpEnd = clean.endsWith(");") ? clean.length - 2 : clean.endsWith(")") ? clean.length - 1 : -1;
  if (openParen > 0 && jsonpEnd > openParen) {
    const callback = clean.slice(0, openParen);
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
      const parsed = tryJson(clean.slice(openParen + 1, jsonpEnd));
      if (parsed && !Array.isArray(parsed)) return parsed;
    }
  }

  if (!clean.startsWith("{") && clean.includes("=")) return parseAnchoredPairs(clean, "&", "=");
  if (clean.startsWith("{") && clean.endsWith("}")) {
    return parseAnchoredPairs(clean.slice(1, -1), ",", ":");
  }
  return {};
}

function parseAnchoredPairs(source, separator, assignment) {
  const parts = splitQuotedPairs(source, separator);
  if (!parts.length) return {};
  const result = {};
  for (const part of parts) {
    const index = findUnquotedCharacter(part, assignment);
    if (index <= 0) return {};
    const rawKey = part.slice(0, index).trim();
    const key = stripMatchingQuotes(rawKey);
    if (!/^[A-Za-z][\w-]*$/.test(key)) return {};
    let value = stripMatchingQuotes(part.slice(index + 1).trim());
    if (separator === "&") {
      try { value = decodeURIComponent(value.replace(/\+/g, " ")); } catch (error) { return {}; }
    }
    result[key] = value;
  }
  return result;
}

function splitQuotedPairs(source, separator) {
  const parts = [];
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote && char === "\\") { escaped = true; continue; }
    if (char === "\"" || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = "";
      continue;
    }
    if (!quote && char === separator) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || escaped) return [];
  parts.push(source.slice(start).trim());
  return parts.every(Boolean) ? parts : [];
}

function findUnquotedCharacter(source, target) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote && char === "\\") { escaped = true; continue; }
    if (char === "\"" || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = "";
    } else if (!quote && char === target) return index;
  }
  return -1;
}

function stripMatchingQuotes(value) {
  if (value.length >= 2 && ((value[0] === "\"" && value.at(-1) === "\"") || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeDrcomResult(kind, statusCode, data, rawText) {
  const msg = decodeMessage(data.msg || data.msga || data.message || data.error || "");
  const resultValue = data.result ?? data.success;
  const retValue = data.ret_code ?? data.ret;
  const resultCode = resultValue === undefined || resultValue === null
    ? ""
    : stringValue(resultValue).trim().toLowerCase();
  const retCode = retValue === undefined || retValue === null ? "" : stringValue(retValue).trim();
  const protocolValue = resultValue ?? retValue;
  const protocolCode = protocolValue === undefined || protocolValue === null
    ? ""
    : stringValue(protocolValue).trim().toLowerCase();
  const httpOk = statusCode >= 200 && statusCode < 300;
  const diagnostic = { statusCode, protocolCode, resultCode, retCode };
  const failureTokens = new Set(["0", "false", "fail", "failed", "error", "-1"]);
  const successTokens = new Set(["1", "ok", "true", "success"]);
  const alreadyOnline = /已经在线|已在线|has been online|already online|E2620/i.test(msg);

  if (!httpOk) {
    return {
      success: false,
      online: false,
      message: `DrCOM 接口返回 HTTP ${statusCode}，认证请求未成功。`,
      data,
      httpOk,
      diagnostic
    };
  }

  if (kind === "login" && resultCode === "0" && retCode === "2" && alreadyOnline) {
    return {
      success: false,
      online: false,
      requiresStatusConfirmation: true,
      message: "网关提示账号已经在线，正在复核实际状态。",
      data,
      httpOk,
      diagnostic
    };
  }

  if (protocolCode) {
    if (failureTokens.has(protocolCode)) {
      return {
        success: false,
        online: false,
        requiresStatusConfirmation: false,
        message: humanizeError(msg || protocolCode, data, kind),
        data,
        httpOk,
        diagnostic
      };
    }
    if (successTokens.has(protocolCode)) {
      return {
        success: true,
        online: kind !== "logout",
        message: kind === "logout" ? "下线成功。" : alreadyOnline ? "账号已经在线，无需重复登录。" : "登录成功。",
        data,
        httpOk,
        diagnostic
      };
    }
    return {
      success: false,
      online: false,
      message: `${kind === "logout" ? "下线" : "登录"}失败：网关返回未识别协议代码 ${protocolCode}。`,
      data,
      httpOk,
      diagnostic
    };
  }

  if (kind === "logout") {
    const logoutFailure = /logout\s*(?:fail|error)|unbind_mac\s*(?:fail|error)|注销失败|下线失败|解绑失败|拒绝/i.test(msg);
    const logoutMessage = /注销成功|下线成功|解绑成功|解除绑定成功|(?:logout|unbind_mac)\s*(?:success|ok)|\boffline\b/i.test(msg);
    const logoutOk = !logoutFailure && logoutMessage;
    return {
      success: logoutOk,
      online: false,
      message: logoutOk ? "下线成功。" : logoutFailure
        ? humanizeError(msg, data, kind)
        : "下线失败：网关返回未识别结果。",
      data,
      httpOk,
      diagnostic
    };
  }

  const explicitStatusSuccess = alreadyOnline || /登录成功|认证成功|(?:login|authentication)\s*(?:success|ok)/i.test(msg);
  const explicitStatusFailure = /登录失败|认证失败|password\s*(?:fail|error)|userid\s*error|拒绝/i.test(msg);
  return {
    success: explicitStatusSuccess && !explicitStatusFailure,
    online: explicitStatusSuccess && !explicitStatusFailure,
    message: explicitStatusSuccess && !explicitStatusFailure
      ? alreadyOnline ? "账号已经在线，无需重复登录。" : "登录成功。"
      : explicitStatusFailure
        ? humanizeError(msg, data, kind)
        : "登录失败：网关返回未识别结果。",
    data,
    httpOk,
    diagnostic
  };
}

function parsePortalStatus(statusCode, text, url) {
  const raw = stringValue(text);
  const httpOk = statusCode >= 200 && statusCode < 400;
  const onlineMarker = /name=["']logout["']|data-localize=["'][^"']*logout|注销成功|下线成功|已连接|当前在线/i.test(raw);
  const loginForm = /name=["']DDDDD["']|name=["']upass["']|name=["']user_account["'][\s\S]{0,2000}name=["']user_password["']/i.test(raw);
  const state = httpOk && onlineMarker ? "online" : httpOk && loginForm ? "offline" : "unknown";

  return {
    ok: httpOk && state !== "unknown",
    success: state === "online",
    online: state === "online",
    state,
    statusCode,
    url,
    message: state === "online" ? "当前页面显示已在线。" : state === "offline" ? "当前需要登录。" : "已访问认证页，但状态不明确。",
    raw: ""
  };
}

function humanizeError(message, data, kind = "login") {
  const msg = decodeMessage(message);

  if (/AC999|设备数量|终端数量|MAC\s*冲突/i.test(msg)) {
    return `设备数量超限或 MAC 冲突：${msg}`;
  }
  if (/userid error1|用户不存在|账号不存在/i.test(msg)) {
    return `账号不存在，请检查学号、后缀或抓包账号标识：${msg}`;
  }
  if (/userid error2|密码|password/i.test(msg)) {
    return `密码错误或密钥失效：${msg}`;
  }
  if (/flux out|balance|欠费|流量/i.test(msg)) {
    return `流量或余额异常：${msg}`;
  }
  if (/ip|mac|bind|绑定/i.test(msg)) {
    return `IP/MAC 参数可能不匹配，建议用设置页重新解析抓包 URL：${msg}`;
  }
  const action = kind === "logout" ? "下线" : "登录";
  return msg ? `${action}失败：${msg}` : `${action}失败：网关没有返回明确原因。`;
}

function decodeMessage(value) {
  const text = stringValue(value).trim();
  if (!text) {
    return "";
  }

  try {
    if (/^[a-zA-Z0-9+/]+={0,2}$/.test(text) && !/[\u4e00-\u9fa5]/.test(text) && text.length % 4 === 0) {
      const binary = atob(text);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch (error) {
    return text;
  }
  return text;
}

function redactSensitiveUrl(value) {
  const raw = stringValue(value).trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    for (const key of ["user_password", "password", "upass", "0MKKey"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "******");
      }
    }
    for (const key of ["wlan_user_ip", "wlanuserip", "userip", "wlan_user_ipv6", "wlan_user_mac", "wlan_ac_ip", "wlan_ac_name"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "******");
      }
    }
    if (url.searchParams.has("user_account")) {
      const current = url.searchParams.get("user_account") || "";
      const parsed = accountUtils.parse(current);
      const hasPrefix = accountUtils.decode(current).trim().startsWith(",0,");
      url.searchParams.set("user_account", `${hasPrefix ? ",0," : ""}${accountUtils.mask(parsed.username)}${parsed.suffix}`);
    }
    return url.toString();
  } catch (error) {
    return redactNetworkIdentifiers(raw.replace(/(user_password|password|upass|0MKKey)=([^&\s]+)/gi, "$1=******"));
  }
}

function redactSensitiveText(value) {
  const raw = stringValue(value);
  if (!raw) {
    return "";
  }

  const quotedPasswordPattern = /(["']?(?:user_password|password|upass|0MKKey)["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi;
  const quotedAccountPattern = /(["']?user_account["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi;
  const passwordPattern = /(["']?(?:user_password|password|upass|0MKKey)["']?\s*[:=]\s*)([^"'&,;\s}]+)/gi;
  const accountPattern = /(["']?user_account["']?\s*[:=]\s*)([^"'&;\s}]+)/gi;
  const sanitized = raw
    .replace(quotedPasswordPattern, (match, prefix, quote) => `${prefix}${quote}******${quote}`)
    .replace(quotedAccountPattern, (match, prefix, quote, accountValue) => {
      const normalized = accountUtils.decode(accountValue).trim();
      const parsed = accountUtils.parse(normalized);
      const hasPrefix = normalized.startsWith(",0,");
      return `${prefix}${quote}${hasPrefix ? ",0," : ""}${accountUtils.mask(parsed.username)}${parsed.suffix}${quote}`;
    })
    .replace(passwordPattern, "$1******")
    .replace(accountPattern, (match, prefix, accountValue) => {
      const normalized = accountUtils.decode(accountValue).trim();
      const parsed = accountUtils.parse(normalized);
      const hasPrefix = normalized.startsWith(",0,");
      return `${prefix}${hasPrefix ? ",0," : ""}${accountUtils.mask(parsed.username)}${parsed.suffix}`;
    });
  return redactNetworkIdentifiers(sanitized);
}

function redactNetworkIdentifiers(value) {
  return stringValue(value)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, "[redacted-mac]")
    .replace(/(?<![0-9a-f-])[0-9a-f]{12}(?![0-9a-f-])/gi, "[redacted-mac]")
    .replace(/\[?[0-9a-f:]{2,}\]?/gi, (candidate) => {
      const literal = candidate.replace(/^\[|\]$/g, "");
      if (!literal.includes(":")) return candidate;
      try {
        const parsed = new URL(`http://[${literal}]/`);
        return parsed.hostname.includes(":") ? "[redacted-ip]" : candidate;
      } catch (error) {
        return candidate;
      }
    });
}

function isUsableMac(value) {
  const mac = accountUtils.normalizeMac(value);
  return /^[0-9A-F]{12}$/.test(mac) && mac !== "000000000000";
}

function extractMacFromResponse(data, raw) {
  const candidates = [];
  if (data && typeof data === "object") {
    for (const key of ["mac", "user_mac", "wlan_user_mac", "wlanUserMac", "online_user_mac", "onlineUserMac"]) {
      if (data[key]) candidates.push(data[key]);
    }
  }
  candidates.push(raw);

  for (const candidate of candidates) {
    const text = stringValue(candidate);
    const direct = accountUtils.normalizeMac(text);
    if (isUsableMac(direct)) return direct;
    const match = text.match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|\b[0-9a-f]{12}\b/i);
    if (match && isUsableMac(match[0])) return accountUtils.normalizeMac(match[0]);
  }
  return "";
}
