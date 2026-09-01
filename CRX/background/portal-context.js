"use strict";

const PORTAL_IP_QUERY_KEYS = [
  "ip",
  "wlanuserip",
  "wlan_user_ip",
  "userip",
  "user-ip",
  "UserIP",
  "uip",
  "station_ip"
];

function parsePortalRuntimeContext(html, pageUrl) {
  const source = String(html || "");
  const candidates = [];

  try {
    const url = new URL(String(pageUrl || ""));
    for (const key of PORTAL_IP_QUERY_KEYS) {
      candidates.push({ value: url.searchParams.get(key), source: `url:${key}` });
    }
  } catch (error) {}

  for (const name of ["v46ip", "ss5", "v4ip"]) {
    candidates.push({ value: readStaticPortalString(source, name), source: name });
  }

  const encodedIp = readStaticPortalString(source, "ss3");
  candidates.push({ value: decodeHexIpv4(encodedIp), source: "ss3" });

  const selected = candidates.find((candidate) => isValidPortalIpv4(candidate.value));
  const wlanUserIp = selected ? String(selected.value).trim() : "";
  return {
    ok: Boolean(wlanUserIp),
    network: {
      wlanUserIp,
      wlanUserIpv6: "",
      wlanUserMac: "",
      wlanAcIp: "",
      wlanAcName: ""
    },
    ipSource: selected ? selected.source : ""
  };
}

async function resolvePortalRuntimeContext(config, pageUrl) {
  const portalUrl = String(config && config.portalUrl || "").trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(portalUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      signal: controller.signal
    });
    const html = await response.text();
    const parsed = parsePortalRuntimeContext(html, pageUrl || response.url || portalUrl);
    if (parsed.ok) {
      return {
        ...parsed,
        statusCode: response.status,
        diagnostic: { statusCode: response.status, ipSource: parsed.ipSource }
      };
    }
    return portalContextFallback(config, response.status);
  } catch (error) {
    const parsed = parsePortalRuntimeContext("", pageUrl || portalUrl);
    if (parsed.ok) {
      return {
        ...parsed,
        statusCode: 0,
        diagnostic: { statusCode: 0, ipSource: parsed.ipSource }
      };
    }
    const fallback = portalContextFallback(config, 0);
    if (fallback.ok) return fallback;
    return {
      ...fallback,
      failureCode: "portal_context_unreachable",
      message: error && error.name === "AbortError"
        ? "访问校园网门户超时，尚未发送认证密码。"
        : "无法访问校园网门户，尚未发送认证密码。"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function portalContextFallback(config, statusCode) {
  const configuredIp = config && config.network && config.network.wlanUserIp;
  if (isValidPortalIpv4(configuredIp)) {
    return {
      ok: true,
      network: {
        wlanUserIp: String(configuredIp).trim(),
        wlanUserIpv6: "",
        wlanUserMac: "",
        wlanAcIp: "",
        wlanAcName: ""
      },
      ipSource: "config",
      statusCode,
      diagnostic: { statusCode, ipSource: "config" }
    };
  }
  return {
    ok: false,
    network: {
      wlanUserIp: "",
      wlanUserIpv6: "",
      wlanUserMac: "",
      wlanAcIp: "",
      wlanAcName: ""
    },
    ipSource: "",
    statusCode,
    failureCode: "portal_context_missing",
    message: "未取得当前校园网 IP，认证密码尚未发送。",
    diagnostic: { statusCode, ipSource: "" }
  };
}

function readStaticPortalString(source, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[;\\s])(?:var\\s+|let\\s+|const\\s+)?${escapedName}\\s*=\\s*(["'])([^"'\\r\\n]*)\\1`, "m");
  const match = String(source || "").match(pattern);
  if (!match) return "";
  return decodeStaticPortalString(match[2]);
}

function decodeStaticPortalString(value) {
  return String(value || "")
    .replace(/\\x([0-9a-f]{2})/gi, (match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([\\/"'])/g, "$1");
}

function decodeHexIpv4(value) {
  const hex = String(value || "").trim();
  if (!/^[0-9a-f]{8}$/i.test(hex)) return "";
  return [0, 2, 4, 6]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    .join(".");
}

function isValidPortalIpv4(value) {
  const text = String(value || "").trim();
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0")) || Number(part) > 255)) {
    return false;
  }
  return text !== "0.0.0.0";
}
