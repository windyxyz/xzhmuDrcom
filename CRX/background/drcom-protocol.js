(function attachDrcomProtocol(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DrcomProtocol = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  const FAILURE_TOKENS = new Set(["0", "false", "fail", "failed", "error", "-1"]);
  const SUCCESS_TOKENS = new Set(["1", "ok", "true", "success"]);

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function tryJson(text) {
    try { return JSON.parse(text); } catch (error) { return null; }
  }

  function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function parseText(text) {
    const clean = stringValue(text).trim().replace(/^\uFEFF/, "");
    if (!clean) return {};

    const direct = tryJson(clean);
    if (isRecord(direct)) return direct;

    const openParen = clean.indexOf("(");
    const jsonpEnd = clean.endsWith(");") ? clean.length - 2 : clean.endsWith(")") ? clean.length - 1 : -1;
    if (openParen > 0 && jsonpEnd > openParen) {
      const callback = clean.slice(0, openParen);
      if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
        const parsed = tryJson(clean.slice(openParen + 1, jsonpEnd));
        if (isRecord(parsed)) return parsed;
      }
    }

    if (!clean.startsWith("{") && clean.includes("=")) return parseAnchoredPairs(clean, "&", "=");
    if (clean.startsWith("{") && clean.endsWith("}")) return parseAnchoredPairs(clean.slice(1, -1), ",", ":");
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

  function decodeMessage(value) {
    const text = stringValue(value).trim();
    if (!text) return "";
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

  function classifyFailureCode(message, data, kind = "login", fallback = "gateway_rejected") {
    const msg = decodeMessage(message);
    if (/userid error1|用户不存在|账号不存在/i.test(msg)) return "user_not_found";
    if (/userid error2|密码(?:错误|不正确|失效)|password\s*(?:fail|error|incorrect|invalid|wrong)/i.test(msg)) return "bad_credentials";
    if (/AC999|设备数量|终端数量|MAC\s*冲突/i.test(msg)) return "device_limit";
    if (/flux out|balance|欠费|流量|停机/i.test(msg)) return "account_restricted";
    if (/\b(?:ip|mac)\b.*(?:mismatch|invalid|error)|bind|绑定/i.test(msg)) return "network_parameters";
    return fallback;
  }

  function humanizeError(message, data, kind = "login") {
    const msg = decodeMessage(message);
    if (/AC999|设备数量|终端数量|MAC\s*冲突/i.test(msg)) return `设备数量超限或 MAC 冲突：${msg}`;
    if (/userid error1|用户不存在|账号不存在/i.test(msg)) return `账号不存在，请检查学号、后缀或抓包账号标识：${msg}`;
    if (/userid error2|密码(?:错误|不正确|失效)|password\s*(?:fail|error|incorrect|invalid|wrong)/i.test(msg)) return `密码错误或密钥失效：${msg}`;
    if (/flux out|balance|欠费|流量/i.test(msg)) return `流量或余额异常：${msg}`;
    if (/\b(?:ip|mac)\b.*(?:mismatch|invalid|error)|\b(?:bind|unbind)\b|绑定/i.test(msg)) {
      return `IP/MAC 参数可能不匹配，建议用设置页重新解析抓包 URL：${msg}`;
    }
    const action = kind === "logout" ? "下线" : "登录";
    return msg ? `${action}失败：${msg}` : `${action}失败：网关没有返回明确原因。`;
  }

  function normalizeResult(kind, statusCode, data) {
    const msg = decodeMessage(data?.msg || data?.msga || data?.message || data?.error || "");
    const resultValue = data?.result ?? data?.success;
    const retValue = data?.ret_code ?? data?.ret;
    const resultCode = resultValue === undefined || resultValue === null ? "" : stringValue(resultValue).trim().toLowerCase();
    const retCode = retValue === undefined || retValue === null ? "" : stringValue(retValue).trim();
    const protocolValue = resultValue ?? retValue;
    const protocolCode = protocolValue === undefined || protocolValue === null ? "" : stringValue(protocolValue).trim().toLowerCase();
    const httpOk = statusCode >= 200 && statusCode < 300;
    const diagnostic = { statusCode, protocolCode, resultCode, retCode };
    const alreadyOnline = /已经在线|已在线|has been online|already online|E2620/i.test(msg);

    if (!httpOk) {
      return { success: false, online: false, failureCode: "http_error", message: `DrCOM 接口返回 HTTP ${statusCode}，认证请求未成功。`, data, httpOk, diagnostic };
    }

    if (kind === "login" && resultCode === "0" && retCode === "2" && alreadyOnline) {
      return { success: false, online: false, requiresStatusConfirmation: true, failureCode: "", message: "网关提示账号已经在线，正在复核实际状态。", data, httpOk, diagnostic };
    }

    if (protocolCode) {
      if (FAILURE_TOKENS.has(protocolCode)) {
        return {
          success: false,
          online: false,
          requiresStatusConfirmation: false,
          failureCode: classifyFailureCode(msg, data, kind, "gateway_rejected"),
          message: humanizeError(msg || protocolCode, data, kind),
          data,
          httpOk,
          diagnostic
        };
      }
      if (SUCCESS_TOKENS.has(protocolCode)) {
        return {
          success: true,
          online: kind !== "logout",
          failureCode: "",
          message: kind === "logout" ? "下线成功。" : alreadyOnline ? "账号已经在线，无需重复登录。" : "登录成功。",
          data,
          httpOk,
          diagnostic
        };
      }
      return {
        success: false,
        online: false,
        failureCode: "protocol_unknown",
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
        failureCode: logoutOk ? "" : classifyFailureCode(msg, data, kind, logoutFailure ? "gateway_rejected" : "protocol_unknown"),
        message: logoutOk ? "下线成功。" : logoutFailure ? humanizeError(msg, data, kind) : "下线失败：网关返回未识别结果。",
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
      failureCode: explicitStatusSuccess && !explicitStatusFailure
        ? ""
        : classifyFailureCode(msg, data, kind, explicitStatusFailure ? "gateway_rejected" : "protocol_unknown"),
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

  return {
    parseText,
    normalizeResult,
    classifyFailureCode,
    humanizeError,
    decodeMessage,
    parseAnchoredPairs,
    splitQuotedPairs,
    findUnquotedCharacter,
    stripMatchingQuotes
  };
});
