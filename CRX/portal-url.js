(function attachPortalUrl(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DrcomPortalUrl = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  function parse(value) {
    try {
      const url = new URL(String(value || "").trim());
      return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch (error) {
      return null;
    }
  }

  function origin(value) {
    return parse(value)?.origin || "";
  }

  function sameOrigin(left, right) {
    const a = origin(left);
    return Boolean(a && a === origin(right));
  }

  /* Chrome/Firefox match patterns intentionally do not encode a port. Runtime
     sender validation must still compare URL.origin when port identity matters. */
  function matchPattern(value) {
    const url = parse(value);
    return url ? `${url.protocol}//${url.hostname}/*` : "";
  }

  function host(value, fallback = "") {
    return parse(value)?.host || fallback;
  }

  function isDefaultGateway(value, hostname = "10.10.10.2") {
    return parse(value)?.hostname === hostname;
  }

  function isInsecureCustom(value, hostname = "10.10.10.2") {
    const url = parse(value);
    return Boolean(url && url.protocol === "http:" && url.hostname !== hostname);
  }

  return { parse, origin, sameOrigin, matchPattern, host, isDefaultGateway, isInsecureCustom };
});
