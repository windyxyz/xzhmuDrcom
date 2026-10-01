(function attachOptionsGateway(root, factory) {
  "use strict";
  const api = factory(root?.DrcomPortalUrl);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DrcomOptionsGateway = api;
})(typeof globalThis === "object" ? globalThis : this, (portalUrl) => {
  "use strict";

  if (!portalUrl) throw new Error("门户 URL 工具未加载");
  const BUILT_IN_ORIGINS = new Set(["http://10.10.10.2/*", "https://10.10.10.2/*"]);

  function originPattern(value) {
    return portalUrl.matchPattern(value);
  }

  function host(value, fallback = "") {
    return portalUrl.host(value, fallback);
  }

  function customOrigins(config) {
    return Array.from(new Set([
      originPattern(config?.portalUrl),
      originPattern(config?.apiUrl)
    ].filter((origin) => origin && !BUILT_IN_ORIGINS.has(origin))));
  }

  async function requestAccess(config, { chromeApi = globalThis.chrome, permissionError = "需要网关访问权限" } = {}) {
    if (!chromeApi?.permissions?.request) return true;
    const origins = customOrigins(config);
    if (!origins.length) return true;
    const request = { origins };
    if (config?.ui?.modernizePortal !== false) request.permissions = ["scripting"];
    const granted = await chromeApi.permissions.request(request);
    if (!granted) throw new Error(permissionError);
    return true;
  }

  async function revokeUnusedAccess(previousConfig, nextConfig, {
    chromeApi = globalThis.chrome,
    retainedOrigins = []
  } = {}) {
    if (!chromeApi?.permissions?.remove) return false;
    const previous = new Set(customOrigins(previousConfig));
    const keep = new Set(customOrigins(nextConfig));
    for (const origin of retainedOrigins) keep.add(origin);
    const stale = Array.from(previous).filter((origin) => !keep.has(origin));
    if (!stale.length) return false;
    return chromeApi.permissions.remove({ origins: stale });
  }

  function securityWarning(previous, next, message = "") {
    const previousUrls = [previous?.portalUrl, previous?.apiUrl].map((value) => String(value || "").trim());
    const nextUrls = [next?.portalUrl, next?.apiUrl].map((value) => String(value || "").trim());
    if (previousUrls.every((value, index) => value === nextUrls[index])) return "";
    return nextUrls.some((value) => portalUrl.isInsecureCustom(value)) ? message : "";
  }

  return { BUILT_IN_ORIGINS, originPattern, host, customOrigins, requestAccess, revokeUnusedAccess, securityWarning };
});
