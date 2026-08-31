"use strict";

(() => {
  const PORTAL_ORIGIN = "http://10.10.10.2";
  const MAX_PENDING_RECORDS = 20;
  const MAX_CONTROLS = 200;
  const MUTATION_DEBOUNCE_MS = 250;
  const SAFE_RESOURCE_TAGS = new Set(["AUDIO", "EMBED", "IFRAME", "IMG", "LINK", "SCRIPT", "SOURCE", "TRACK", "VIDEO"]);
  const SAFE_INITIATORS = new Set(["beacon", "css", "fetch", "iframe", "img", "link", "other", "script", "video", "xmlhttprequest"]);

  if (location.origin !== PORTAL_ORIGIN) return;

  const utils = globalThis.DrcomPortalDiagnosticsUtils;
  const pending = [];
  let flushing = false;
  let mutationTimer = 0;
  let mutationObserver = null;
  let performanceObserver = null;
  let sessionId = "";
  let stopped = false;

  void initialize();

  async function initialize() {
    try {
      const status = await send({ action: "diagnostics:status" });
      if (!status || status.enabled !== true || !utils) return;
      const started = await send({
        action: "diagnostics:start",
        page: {
          pageKind: detectPageKind(),
          title: utils.sanitizeText(document.title, 256),
          url: utils.sanitizeUrl(location.href)
        }
      });
      if (!started || !started.sessionId) return;
      sessionId = String(started.sessionId);
      bindSafeEvents();
      bindObservers();
      queueRecord({ type: "dom", pageKind: detectPageKind(), summary: buildDomSummary() });
      recordResourceEntries(performance.getEntriesByType("resource"));
    } catch (error) {
      // Diagnostics are strictly best-effort and must not disturb the portal.
    }
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message || "diagnostics message failed"));
            return;
          }
          resolve(response || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function describeTarget(target) {
    if (!target || target.nodeType !== 1 || typeof target.getAttribute !== "function") return {};
    return utils.sanitizeTarget({
      tag: target.tagName,
      id: target.id,
      name: target.getAttribute("name"),
      type: target.getAttribute("type"),
      role: target.getAttribute("role"),
      ariaLabel: target.getAttribute("aria-label")
    });
  }

  function controls() {
    return Array.from(document.querySelectorAll("form, input, select, button, a")).slice(0, MAX_CONTROLS);
  }

  function detectPageKind() {
    for (const element of controls()) {
      if (String(element.tagName || "").toUpperCase() === "INPUT" && String(element.getAttribute("type") || "").toLowerCase() === "password") return "login";
    }
    return "unknown";
  }

  function buildDomSummary() {
    const summary = JSON.stringify({
      pageKind: detectPageKind(),
      title: utils.sanitizeText(document.title, 256),
      url: utils.sanitizeUrl(location.href),
      controls: controls().map(describeTarget)
    });
    return utils.truncateUtf8(summary, 64 * 1024);
  }

  function sanitizeLocalRecord(record) {
    const clean = utils.sanitizeRecord(record);
    if (record && Number.isFinite(Number(record.duration)) && Number(record.duration) >= 0) clean.duration = Number(record.duration);
    return clean;
  }

  function queueRecord(record) {
    if (!sessionId) return Promise.resolve();
    pending.push(sanitizeLocalRecord(record));
    if (pending.length > MAX_PENDING_RECORDS) pending.shift();
    return flushPending();
  }

  async function flushPending() {
    if (flushing) return;
    flushing = true;
    try {
      while (pending.length) {
        await send({ action: "diagnostics:append", sessionId, record: pending[0] });
        pending.shift();
      }
    } catch (error) {
      // Leave the head record in the bounded queue for the next event.
    } finally {
      flushing = false;
    }
  }

  function recordEvent(type, event) {
    if (stopped) return;
    void queueRecord({ type, pageKind: detectPageKind(), target: describeTarget(event && event.target) });
  }

  function bindSafeEvents() {
    for (const type of ["click", "submit", "change", "focus"]) document.addEventListener(type, (event) => recordEvent(type, event), true);
    document.addEventListener("error", (event) => {
      const target = event && event.target;
      if (!target || !SAFE_RESOURCE_TAGS.has(String(target.tagName || "").toUpperCase())) return;
      recordEvent("resource-error", event);
    }, true);
    document.addEventListener("pagehide", () => { void stop(); }, true);
  }

  function bindObservers() {
    if (typeof MutationObserver === "function") {
      mutationObserver = new MutationObserver(() => {
        if (stopped || mutationTimer) return;
        mutationTimer = setTimeout(() => {
          mutationTimer = 0;
          if (!stopped) void queueRecord({ type: "mutation", pageKind: detectPageKind(), summary: buildDomSummary() });
        }, MUTATION_DEBOUNCE_MS);
      });
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (typeof PerformanceObserver === "function") {
      performanceObserver = new PerformanceObserver((list) => recordResourceEntries(list.getEntries()));
      performanceObserver.observe({ type: "resource", buffered: false });
    }
  }

  function recordResourceEntries(entries) {
    if (stopped || !entries) return;
    for (const entry of entries) {
      const initiator = String(entry && entry.initiatorType || "other").toLowerCase();
      void queueRecord({
        type: "resource",
        url: String(entry && entry.name || ""),
        method: SAFE_INITIATORS.has(initiator) ? initiator : "other",
        status: nonNegativeNumber(entry && entry.responseStatus),
        duration: nonNegativeNumber(entry && entry.duration)
      });
    }
  }

  function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = 0;
    if (mutationObserver) mutationObserver.disconnect();
    if (performanceObserver) performanceObserver.disconnect();
    await queueRecord({ type: "pagehide", pageKind: detectPageKind() });
    try {
      await send({ action: "diagnostics:end", sessionId });
    } catch (error) {
      // The page can unload while the extension service worker is unavailable.
    }
  }
})();
