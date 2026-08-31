"use strict";

(() => {
  const encoder = new TextEncoder();
  const allowedRecordTypes = new Set([
    "session", "dom", "mutation", "click", "submit", "change",
    "focus", "resource", "resource-error", "navigation", "pagehide"
  ]);

  function utf8Bytes(value) {
    return encoder.encode(String(value ?? "")).byteLength;
  }

  function truncateUtf8(value, maxBytes) {
    let text = String(value ?? "");
    if (utf8Bytes(text) <= maxBytes) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (utf8Bytes(text.slice(0, middle)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    return text.slice(0, low);
  }

  function sanitizeUrl(value) {
    try {
      const url = new URL(String(value ?? ""));
      return `${url.origin}${url.pathname}`;
    } catch (error) {
      return "";
    }
  }

  function sanitizeText(value, maxBytes = 4096) {
    const text = String(value ?? "")
      .replace(/\b(password|passwd|pwd|token|secret|authorization|cookie)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
      .replace(/\b(uid|user(?:name|_account)?|account)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
      .replace(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi, "[redacted-mac]")
      .replace(/\b\d{8,18}\b/g, "[redacted-id]")
      .replace(/\s+/g, " ")
      .trim();
    return truncateUtf8(text, maxBytes);
  }

  function cleanDescriptor(value, maxBytes = 160) {
    return sanitizeText(value, maxBytes).replace(/[^\p{L}\p{N}_:.@#\- ]/gu, "");
  }

  function sanitizeTarget(input = {}) {
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
