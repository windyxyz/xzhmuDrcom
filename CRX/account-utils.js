(function attachAccountUtils(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DrcomAccountUtils = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  function decode(value) {
    let text = String(value || "");
    for (let index = 0; index < 2; index += 1) {
      if (!/%[0-9a-f]{2}/i.test(text)) break;
      try {
        const decoded = decodeURIComponent(text);
        if (decoded === text) break;
        text = decoded;
      } catch (error) {
        break;
      }
    }
    return text;
  }

  function normalizeSuffix(value) {
    const raw = decode(value).trim().toLowerCase();
    if (!raw || raw === "校园网" || raw === "campus" || raw === "none") return "";
    const aliases = {
      telecom: "@telecom",
      "@telecom": "@telecom",
      "电信": "@telecom",
      unicom: "@unicom",
      "@unicom": "@unicom",
      "联通": "@unicom",
      cmcc: "@cmcc",
      "@cmcc": "@cmcc",
      mobile: "@cmcc",
      "移动": "@cmcc"
    };
    if (aliases[raw]) return aliases[raw];
    return /^@[a-z0-9._-]+$/i.test(raw) ? raw : "";
  }

  function parse(value, fallbackSuffix = "") {
    let raw = decode(value).trim().replace(/^\s*0+\s*$/, "");
    if (raw.startsWith(",0,")) raw = raw.slice(3);
    const match = raw.match(/@(telecom|unicom|cmcc)$/i);
    const suffixFromRaw = match ? `@${match[1].toLowerCase()}` : "";
    const suffix = suffixFromRaw || normalizeSuffix(fallbackSuffix);
    const username = suffixFromRaw ? raw.slice(0, -suffixFromRaw.length) : raw;
    return { username: username.trim(), suffix };
  }

  function naturalKey(input, fallbackSuffix = "") {
    const account = input && typeof input === "object"
      ? parse(input.username, input.suffix)
      : parse(input, fallbackSuffix);
    return account.username ? `${account.username}\u0000${account.suffix.toLowerCase()}` : "";
  }

  function suffixLabel(value) {
    const suffix = normalizeSuffix(value);
    return { "": "校园网", "@telecom": "电信", "@unicom": "联通", "@cmcc": "移动" }[suffix]
      || suffix
      || "校园网";
  }

  function label(username, suffix) {
    const name = String(username || "").trim() || "未命名账号";
    return `${name} ${suffixLabel(suffix)}`;
  }

  function mask(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text.length <= 4) return "****";
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
  }

  function normalizeMac(value) {
    return String(value || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  }

  return { decode, normalizeSuffix, parse, naturalKey, suffixLabel, label, mask, normalizeMac };
});
