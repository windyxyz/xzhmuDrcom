"use strict";

var accountUtils = globalThis.DrcomAccountUtils;

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
    const text = await response.text();
    const parsed = parseDrcomText(text);
    const result = normalizeDrcomResult(kind, response.status, parsed, text);
    const payload = {
      ok: response.ok || result.success,
      statusCode: response.status,
      url: request.redactedUrl,
      raw: trimRaw(text),
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

function buildLoginRequest(account, config) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  const network = { ...config.network, ...account.network };

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

function buildFindMacRequest(account, config, includeSuffix = false) {
  const url = new URL(config.apiUrl);
  const network = { ...config.network, ...account.network };
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

function buildLogoutRequest(account, config, networkOverride = null) {
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

function buildLegacyLogoutRequest(config) {
  const ts = createTimestamp();
  const url = new URL(config.apiUrl);
  url.search = "";
  url.searchParams.set("c", "Portal");
  url.searchParams.set("a", "logout");
  url.searchParams.set("callback", `${config.login.callbackPrefix}${ts}`);
  url.searchParams.set("login_method", config.login.loginMethod || "1");
  url.searchParams.set("v", createNonce());
  return { url: url.toString(), redactedUrl: url.toString() };
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
  if (direct) {
    return direct;
  }

  const jsonp = clean.match(/^[\w$.]+\(([\s\S]*)\)\s*;?$/);
  if (jsonp) {
    return tryJson(jsonp[1]) || {};
  }

  const loose = {};
  for (const match of clean.matchAll(/["']?([a-zA-Z][\w-]*)["']?\s*[:=]\s*["']?([^"',;}\n\r]+)/g)) {
    loose[match[1]] = match[2].trim();
  }
  return loose;
}

function normalizeDrcomResult(kind, statusCode, data, rawText) {
  const raw = stringValue(rawText);
  const msg = decodeMessage(data.msg || data.msga || data.message || data.error || data.result || raw);
  const result = stringValue(data.result ?? data.ret_code ?? data.ret ?? data.success).toLowerCase();
  const alreadyOnline = /已经在线|已在线|has been online|already online|E2620/i.test(`${msg} ${raw}`);
  const explicitFailure = ["0", "false", "fail", "failed", "error", "-1"].includes(result);
  const explicitSuccess = ["1", "ok", "true", "success"].includes(result);
  const successMessage = /登录成功|认证成功|(?:^|\s)(?:success|ok)(?:$|[\s,.!])/i.test(msg);
  const success = alreadyOnline || (!explicitFailure && (explicitSuccess || successMessage));

  if (kind === "logout") {
    const logoutFailure = explicitFailure || /logout\s*(?:fail|error)|unbind_mac\s*(?:fail|error)|注销失败|下线失败|解绑失败|拒绝/i.test(`${msg} ${raw}`);
    const logoutMessage = /注销成功|下线成功|解绑成功|解除绑定成功|(?:logout|unbind_mac)\s*(?:success|ok)|\boffline\b/i.test(`${msg} ${raw}`);
    const logoutOk = !logoutFailure && (success || logoutMessage);
    return {
      success: logoutOk,
      online: false,
      message: logoutOk ? "下线成功。" : humanizeError(msg, data),
      data
    };
  }

  return {
    success,
    online: success,
    message: success ? (alreadyOnline ? "账号已经在线，无需重复登录。" : "登录成功。") : humanizeError(msg, data),
    data,
    httpOk: statusCode >= 200 && statusCode < 400
  };
}

function parsePortalStatus(statusCode, text, url) {
  const raw = stringValue(text);
  const online = /name=["']logout["']|data-localize=["'][^"']*logout|注销|下线|已连接|在线/i.test(raw);
  const loginPage = /name=["']DDDDD["']|name=["']upass["']|user_account|登录|认证/i.test(raw);

  return {
    ok: statusCode >= 200 && statusCode < 400,
    success: online,
    online,
    statusCode,
    url,
    message: online ? "当前页面显示已在线。" : loginPage ? "当前需要登录。" : "已访问认证页，但状态不明确。",
    raw: trimRaw(raw)
  };
}

function humanizeError(message, data) {
  const msg = decodeMessage(message);
  const retCode = stringValue(data.ret_code || data.ret);

  if (/AC999/i.test(msg) || retCode === "2" || retCode === "3") {
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
  return msg ? `登录失败：${msg}` : "登录失败：网关没有返回明确原因。";
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
    if (url.searchParams.has("user_account")) {
      const current = url.searchParams.get("user_account") || "";
      const parsed = accountUtils.parse(current);
      const hasPrefix = accountUtils.decode(current).trim().startsWith(",0,");
      url.searchParams.set("user_account", `${hasPrefix ? ",0," : ""}${accountUtils.mask(parsed.username)}${parsed.suffix}`);
    }
    return url.toString();
  } catch (error) {
    return raw.replace(/(user_password|password|upass|0MKKey)=([^&\s]+)/gi, "$1=******");
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
  return raw
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

