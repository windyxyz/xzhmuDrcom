"use strict";

(() => {
  const encoder = new TextEncoder();
  const allowedRecordTypes = new Set([
    "session", "dom", "mutation", "click", "submit", "change",
    "focus", "resource", "resource-error", "navigation", "pagehide"
  ]);
  const safeProtocolActions = new Set(["login", "logout", "unbind_mac"]);
  const fixedPortalHost = "10.10.10.2";

  function utf8Bytes(value) {
    return encoder.encode(String(value ?? "")).byteLength;
  }

  function truncateUtf8(value, maxBytes) {
    const text = String(value ?? "");
    if (utf8Bytes(text) <= maxBytes) return text;
    let bytes = 0;
    const result = [];
    for (const codePoint of text) {
      const code = codePoint.codePointAt(0);
      const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes + size > maxBytes) break;
      result.push(codePoint);
      bytes += size;
    }
    return result.join("");
  }

  function sanitizeUrl(value) {
    try {
      const url = new URL(String(value ?? ""));
      if (!["http:", "https:"].includes(url.protocol)) return "";
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const isFixedHost = hostname === fixedPortalHost;
      const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
      const isIpv6 = hostname.includes(":");
      const host = isFixedHost || (!isIpv4 && !isIpv6) ? url.host : "[redacted-ip]";
      const path = url.pathname.split("/").map((segment) => {
        try { segment = decodeURIComponent(segment); } catch (error) { /* keep encoded segment */ }
        return sanitizeText(segment, 256).replace(/[/?#]/g, "");
      }).join("/");
      const query = [];
      for (const [key, queryValue] of url.searchParams) {
        const safeValue = (key === "a" || key === "action") && safeProtocolActions.has(queryValue)
          ? queryValue
          : "[redacted]";
        query.push(`${encodeURIComponent(key)}=${encodeURIComponent(safeValue)}`);
      }
      return `${url.protocol}//${host}${path}${query.length ? `?${query.join("&")}` : ""}`;
    } catch (error) {
      return "";
    }
  }

  function sanitizeText(value, maxBytes = 4096) {
    const text = String(value ?? "")
      .replace(/\b(password|passwd|pwd|token|secret|authorization|cookie)\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^&\r\n]*)/gi, "$1=[redacted]")
      .replace(/\b(uid|user(?:name|_account)?|account)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
      .replace(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, "[redacted-mac]")
      .replace(/(?<![0-9a-f-])[0-9a-f]{12}(?![0-9a-f-])/gi, (candidate) => /^\d{12}$/.test(candidate) ? "[redacted-id]" : "[redacted-mac]")
      .replace(/\[?[0-9A-Fa-f:]{2,}\]?/g, (candidate) => {
        const literal = candidate.replace(/^\[|\]$/g, "");
        if (!literal.includes(":")) return candidate;
        try {
          const parsed = new URL(`http://[${literal}]/`);
          return parsed.hostname.includes(":") ? "[redacted-ip]" : candidate;
        } catch (error) {
          return candidate;
        }
      })
      .replace(/\b(?:\+?86[ -]?)?1[3-9]\d{9}\b/g, "[redacted-phone]")
      .replace(/[\w.%+-]{1,64}@[\w.-]{1,255}\.[A-Za-z]{2,}/g, "[redacted-email]")
      .replace(/\b\d{8,18}\b/g, "[redacted-id]")
      .replace(/@(telecom|unicom|cmcc)\b/gi, "[redacted-suffix]")
      .replace(/(?:电信|联通|移动)/g, "[redacted-suffix]")
      .replace(/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{20,}(?![A-Za-z0-9+/_=-])/g, (candidate) => {
        const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(candidate)).length;
        if (classes < 3) return candidate;
        const uniqueRatio = new Set(candidate).size / candidate.length;
        return uniqueRatio >= 0.55 ? "[redacted-secret]" : candidate;
      })
      .replace(/\s+/g, " ")
      .trim();
    return truncateUtf8(text, maxBytes);
  }

  function cleanDescriptor(value, maxBytes = 160) {
    return sanitizeText(value, maxBytes).replace(/[^\p{L}\p{N}_:.@#\- ]/gu, "");
  }

  function sanitizeTarget(input = {}) {
    input = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return {
      tag: cleanDescriptor(input.tag, 32).toLowerCase(),
      id: cleanDescriptor(input.id, 128),
      name: cleanDescriptor(input.name, 128),
      type: cleanDescriptor(input.type, 64).toLowerCase(),
      role: cleanDescriptor(input.role, 64).toLowerCase(),
      ariaLabel: sanitizeText(input.ariaLabel, 256)
    };
  }

  function sanitizeRecord(input = {}) {
    input = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const type = allowedRecordTypes.has(input.type) ? input.type : "navigation";
    const record = {
      type,
      at: Math.max(0, Number(input.at) || Date.now()),
      pageKind: ["pending", "login", "online", "failure", "success", "unknown"].includes(input.pageKind)
        ? input.pageKind
        : "unknown"
    };
    if (input.url) record.url = sanitizeUrl(input.url);
    if (input.target) record.target = sanitizeTarget(input.target);
    if (input.method) record.method = cleanDescriptor(input.method, 16).toUpperCase();
    if (input.status) record.status = Math.max(0, Number(input.status) || 0);
    if (input.summary) record.summary = sanitizeText(input.summary, 64 * 1024);
    if (input.message) record.message = sanitizeText(input.message, 1024);
    return record;
  }

  const api = Object.freeze({
    sanitizeRecord,
    sanitizeTarget,
    sanitizeText,
    sanitizeUrl,
    truncateUtf8,
    utf8Bytes
  });
  globalThis.DrcomPortalDiagnosticsUtils = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
