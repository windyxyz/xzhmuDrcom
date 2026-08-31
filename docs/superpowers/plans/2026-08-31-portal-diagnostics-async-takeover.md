# Portal Diagnostics and Async Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-preserving, opt-in local portal diagnostics recorder with hard cache limits, then fix the portal modernizer so it takes over login and logout pages that the school portal renders asynchronously after `DOMContentLoaded`.

**Architecture:** A shared pure sanitizer (`DrcomPortalDiagnosticsUtils`) is loaded in both the portal isolated world and the classic MV3 service worker. The content recorder observes only safe structural/event metadata and sends already-redacted records; an independent background diagnostics service redacts again, serializes writes, and enforces the 1 MiB/10-session/64 KiB limits. The existing modernizer gets a separate readiness observer and a one-way “restore original page” guard so asynchronous school templates mount once but a user restore is never undone.

**Tech Stack:** Manifest V3 classic service worker, browser content scripts, native JavaScript/HTML/CSS, `chrome.storage.local`, Node.js 20+ built-in `node:test`, VM harnesses, headless Chrome/Edge via DevTools Protocol, deterministic dependency-free ZIP packaging.

**Spec:** `docs/superpowers/specs/2026-08-31-portal-diagnostics-design.md`

## Global Constraints

- Keep diagnostics disabled by default and store it only under `chrome.storage.local.drcomPortalDiagnostics`.
- Never read or persist input values, passwords, cookies, authorization data, `localStorage`, complete account identifiers, IP addresses, or MAC addresses.
- Apply redaction in the content script and again in the background service. Treat unknown fields as unsafe; exported JSON must be the already-sanitized stored representation.
- Enforce all three hard limits after every mutation: at most 1 MiB serialized diagnostics data, at most 10 sessions, and at most 64 KiB for one DOM sample. Keep a 512 KiB reserve below the browser's 10 MiB local-storage quota.
- Accept portal-side diagnostics messages only from the extension's own ID, top frame, exact `http://10.10.10.2` origin, and a tab that still points to that origin. Do not extend diagnostics to custom gateways or HTTPS in this phase.
- Add no permissions and do not put diagnostics in dynamically registered custom-gateway content scripts.
- A user choosing “恢复原始页面” is final for that document. Later mutations must not remount the modern interface.
- Do not automatically click the live portal's logout button. Real logout capture remains an explicit user-driven manual checkpoint because it interrupts connectivity.
- Keep version `2.5.3` during this feature branch. Do not create a remote, push, publish, retag, or perform GitHub operations.
- Use `apply_patch` for edits, preserve unrelated work, run the focused test before each production change, and run `npm run verify` before the final documentation commit.

---

### Task 1: Build the shared diagnostics sanitizer

**Files:**

- Create: `CRX/portal-diagnostics-utils.js`
- Create: `tests/portal-diagnostics-utils.test.js`
- Modify: `package.json`

- [ ] Write failing sanitizer tests for URL stripping, text redaction, safe target descriptors, record allowlisting, and UTF-8 truncation.

```js
test("诊断 URL 只保留来源和路径", () => {
  assert.equal(
    utils.sanitizeUrl("http://10.10.10.2/drcom/chkstatus?uid=202600000001&token=fake#result"),
    "http://10.10.10.2/drcom/chkstatus"
  );
});

test("诊断文本删除账号、IP、MAC 和凭据", () => {
  const result = utils.sanitizeText(
    "uid=202600000001 ip=192.0.2.15 mac=00:11:22:33:44:55 password=fake-secret"
  );
  assert.doesNotMatch(result, /202600000001|192\.0\.2\.15|00:11:22:33:44:55|fake-secret/);
});

test("控件描述保留结构但忽略 value", () => {
  assert.deepEqual(utils.sanitizeTarget({
    tag: "INPUT",
    id: "username",
    name: "user_account",
    type: "text",
    role: "textbox",
    ariaLabel: "校园网账号",
    value: "202600000001"
  }), {
    tag: "input",
    id: "username",
    name: "user_account",
    type: "text",
    role: "textbox",
    ariaLabel: "校园网账号"
  });
});
```

- [ ] Run the focused test and confirm the expected module-not-found failure.

Run: `node --test tests/portal-diagnostics-utils.test.js`

Expected: FAIL because `CRX/portal-diagnostics-utils.js` does not exist.

- [ ] Add an IIFE-based global/CommonJS utility module so classic scripts do not leak top-level lexical declarations.

```js
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
```

- [ ] Expand tests with malformed URLs, Unicode truncation, unknown record fields, query strings embedded in messages, and values just above/below the byte boundary.

- [ ] Run the focused test until it passes, then add `node --check CRX/portal-diagnostics-utils.js` to `check:stable`.

Run: `node --test tests/portal-diagnostics-utils.test.js && npm run check:stable`

Expected: PASS.

- [ ] Commit the sanitizer as an isolated change.

```powershell
git add CRX/portal-diagnostics-utils.js tests/portal-diagnostics-utils.test.js package.json
git commit -m "feat: add portal diagnostics sanitizer"
```

---

### Task 2: Add the independent capped diagnostics store and message boundary

**Files:**

- Create: `CRX/background/diagnostics-service.js`
- Modify: `CRX/background.js`
- Modify: `CRX/background/state-store.js`
- Modify: `CRX/background/message-router.js`
- Modify: `tests/background.test.js`
- Modify: `package.json`

- [ ] Extend the background VM harness before writing production code: load the new modules, expose a configurable `getBytesInUse`, and add the diagnostics module to the thin-entry assertion.

```js
getBytesInUse: async (keys) => {
  if (typeof options.bytesInUse === "function") {
    return options.bytesInUse(keys, localStore);
  }
  if (Number.isFinite(options.bytesInUse)) return options.bytesInUse;
  const selected = keys
    ? Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .filter((key) => key in localStore)
      .map((key) => [key, localStore[key]]))
    : localStore;
  return new TextEncoder().encode(JSON.stringify(selected)).byteLength;
}
```

- [ ] Write failing background tests for the default-off state, start/append/end flow, double redaction, 10-session pruning, 1 MiB pruning, 64 KiB DOM truncation, quota reserve, clearing, and extension-only read/export/set actions.

```js
test("门户诊断默认关闭且网页只能读取安全状态", async () => {
  const background = loadBackground();
  const result = await background.handleMessage(
    { action: "diagnostics:status" },
    portalSender()
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    enabled: false,
    limits: { maxBytes: 1048576, maxSessions: 10, maxDomBytes: 65536 }
  });
  assert.doesNotMatch(JSON.stringify(result), /sessions|records/);
});

test("自定义网关和 iframe 不能写门户诊断", async () => {
  const background = loadBackground();
  await assert.rejects(
    background.handleMessage(
      { action: "diagnostics:start", page: { pageKind: "login" } },
      portalSender({ origin: "http://gateway.example", url: "http://gateway.example/" })
    ),
    /默认校园网认证页/
  );
  await assert.rejects(
    background.handleMessage(
      { action: "diagnostics:start", page: { pageKind: "login" } },
      portalSender({ frameId: 1 })
    ),
    /顶层页面/
  );
});
```

- [ ] Run the focused background tests and confirm they fail on unknown diagnostics actions/missing modules.

Run: `node --test tests/background.test.js`

Expected: FAIL on the new diagnostics assertions.

- [ ] Create `diagnostics-service.js` with unique `portalDiagnostics*` names, its own mutation queue, deterministic pruning, and no dependency on mutable main-state helpers.

```js
"use strict";

const PORTAL_DIAGNOSTICS_KEY = "drcomPortalDiagnostics";
const PORTAL_DIAGNOSTICS_VERSION = 1;
const PORTAL_DIAGNOSTICS_LIMIT_BYTES = 1024 * 1024;
const PORTAL_DIAGNOSTICS_MAX_SESSIONS = 10;
const PORTAL_DIAGNOSTICS_MAX_DOM_BYTES = 64 * 1024;
const PORTAL_DIAGNOSTICS_STORAGE_SOFT_LIMIT = (10 * 1024 * 1024) - (512 * 1024);
var portalDiagnosticsMutationQueue = Promise.resolve();
var portalDiagnosticsUtils = globalThis.DrcomPortalDiagnosticsUtils;

function portalDiagnosticsDefaults() {
  return { version: PORTAL_DIAGNOSTICS_VERSION, enabled: false, updatedAt: 0, sessions: [] };
}

function portalDiagnosticsSerializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizePortalDiagnosticsStore(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    version: PORTAL_DIAGNOSTICS_VERSION,
    enabled: source.enabled === true,
    updatedAt: Math.max(0, Number(source.updatedAt) || 0),
    sessions: Array.isArray(source.sessions) ? source.sessions.slice(-PORTAL_DIAGNOSTICS_MAX_SESSIONS) : []
  };
}

function prunePortalDiagnosticsStore(input) {
  const store = normalizePortalDiagnosticsStore(input);
  store.sessions.sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
  while (store.sessions.length > PORTAL_DIAGNOSTICS_MAX_SESSIONS) store.sessions.shift();
  while (portalDiagnosticsSerializedBytes(store) > PORTAL_DIAGNOSTICS_LIMIT_BYTES && store.sessions.length > 1) {
    store.sessions.shift();
  }
  const current = store.sessions[0];
  while (current && portalDiagnosticsSerializedBytes(store) > PORTAL_DIAGNOSTICS_LIMIT_BYTES && current.records.length) {
    current.records.shift();
    current.truncated = true;
  }
  return store;
}

function mutatePortalDiagnostics(mutator) {
  const operation = portalDiagnosticsMutationQueue.then(async () => {
    const stored = await chrome.storage.local.get([PORTAL_DIAGNOSTICS_KEY]);
    const draft = normalizePortalDiagnosticsStore(stored[PORTAL_DIAGNOSTICS_KEY]);
    const value = await mutator(draft);
    const next = prunePortalDiagnosticsStore(draft);
    next.updatedAt = Date.now();
    await chrome.storage.local.set({ [PORTAL_DIAGNOSTICS_KEY]: next });
    return { store: next, value };
  });
  portalDiagnosticsMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
```

- [ ] Complete the service API with exact, directly testable bodies:

```js
function portalDiagnosticsId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function portalDiagnosticsLimits() {
  return {
    maxBytes: PORTAL_DIAGNOSTICS_LIMIT_BYTES,
    maxSessions: PORTAL_DIAGNOSTICS_MAX_SESSIONS,
    maxDomBytes: PORTAL_DIAGNOSTICS_MAX_DOM_BYTES
  };
}

function portalDiagnosticsPublicStatus(store) {
  return { ok: true, enabled: store.enabled, limits: portalDiagnosticsLimits() };
}

async function getPortalDiagnosticsStatus() {
  const stored = await chrome.storage.local.get([PORTAL_DIAGNOSTICS_KEY]);
  const store = normalizePortalDiagnosticsStore(stored[PORTAL_DIAGNOSTICS_KEY]);
  return portalDiagnosticsPublicStatus(store);
}

async function setPortalDiagnosticsEnabled(enabled) {
  const { store } = await mutatePortalDiagnostics((draft) => {
    draft.enabled = enabled === true;
  });
  return portalDiagnosticsPublicStatus(store);
}

async function portalDiagnosticsHasQuota() {
  if (!chrome.storage.local || typeof chrome.storage.local.getBytesInUse !== "function") return true;
  return await chrome.storage.local.getBytesInUse(null) < PORTAL_DIAGNOSTICS_STORAGE_SOFT_LIMIT;
}

async function startPortalDiagnosticsSession(page, sender) {
  if (!await portalDiagnosticsHasQuota()) {
    return { ok: false, error: "本地存储接近上限，诊断记录已暂停" };
  }
  const senderUrl = new URL(sender.url);
  const sessionId = portalDiagnosticsId();
  const startedAt = Date.now();
  const { store } = await mutatePortalDiagnostics((draft) => {
    if (!draft.enabled) return;
    draft.sessions.push({
      id: sessionId,
      startedAt,
      endedAt: 0,
      origin: senderUrl.origin,
      pageKind: ["pending", "login", "online", "failure", "success"].includes(page.pageKind)
        ? page.pageKind
        : "unknown",
      title: portalDiagnosticsUtils.sanitizeText(page.title, 256),
      url: portalDiagnosticsUtils.sanitizeUrl(sender.url),
      records: [],
      truncated: false
    });
  });
  return store.enabled
    ? { ok: true, enabled: true, sessionId }
    : { ok: true, enabled: false, sessionId: "" };
}

async function appendPortalDiagnosticRecord(sessionId, record) {
  if (!await portalDiagnosticsHasQuota()) {
    return { ok: false, error: "本地存储接近上限，诊断记录已暂停" };
  }
  const cleanId = String(sessionId || "");
  if (!cleanId) return { ok: false, error: "诊断会话无效" };
  const cleanRecord = portalDiagnosticsUtils.sanitizeRecord(record);
  if (cleanRecord.summary) {
    cleanRecord.summary = portalDiagnosticsUtils.truncateUtf8(
      cleanRecord.summary,
      PORTAL_DIAGNOSTICS_MAX_DOM_BYTES
    );
  }
  let stored = false;
  const { store } = await mutatePortalDiagnostics((draft) => {
    if (!draft.enabled) return;
    const session = draft.sessions.find((item) => item.id === cleanId);
    if (!session || session.endedAt) return;
    session.records.push(cleanRecord);
    stored = true;
  });
  return {
    ok: true,
    enabled: store.enabled,
    stored,
    bytes: portalDiagnosticsSerializedBytes(store)
  };
}

async function endPortalDiagnosticsSession(sessionId) {
  const cleanId = String(sessionId || "");
  let ended = false;
  await mutatePortalDiagnostics((draft) => {
    const session = draft.sessions.find((item) => item.id === cleanId);
    if (!session || session.endedAt) return;
    session.endedAt = Date.now();
    ended = true;
  });
  return { ok: true, ended };
}

async function readPortalDiagnostics() {
  const stored = await chrome.storage.local.get([PORTAL_DIAGNOSTICS_KEY]);
  const store = prunePortalDiagnosticsStore(stored[PORTAL_DIAGNOSTICS_KEY]);
  return {
    ok: true,
    enabled: store.enabled,
    bytes: portalDiagnosticsSerializedBytes(store),
    sessionCount: store.sessions.length,
    limits: portalDiagnosticsLimits(),
    sessions: store.sessions
  };
}

async function exportPortalDiagnostics() {
  const diagnostics = await readPortalDiagnostics();
  return {
    ok: true,
    export: {
      exportVersion: 1,
      createdAt: new Date().toISOString(),
      diagnostics: {
        enabled: diagnostics.enabled,
        bytes: diagnostics.bytes,
        limits: diagnostics.limits,
        sessions: diagnostics.sessions
      }
    }
  };
}

async function clearPortalDiagnostics() {
  const { store } = await mutatePortalDiagnostics((draft) => {
    draft.sessions = [];
  });
  return {
    ok: true,
    enabled: store.enabled,
    bytes: portalDiagnosticsSerializedBytes(store),
    sessionCount: 0,
    limits: portalDiagnosticsLimits()
  };
}
```

`normalizePortalDiagnosticsStore` must also sanitize every persisted session field and every persisted record before returning it; do this with an allowlist, `portalDiagnosticsUtils.sanitizeText`, `sanitizeUrl`, and `sanitizeRecord`. This ensures a manually corrupted or older store is redacted before read or export. `clearPortalDiagnostics` deliberately skips the quota guard so cleanup always remains possible.

- [ ] Add only the four safe web actions to `WEB_PAGE_ACTIONS`.

```js
const PORTAL_DIAGNOSTIC_WEB_ACTIONS = new Set([
  "diagnostics:status",
  "diagnostics:start",
  "diagnostics:append",
  "diagnostics:end"
]);

for (const action of PORTAL_DIAGNOSTIC_WEB_ACTIONS) WEB_PAGE_ACTIONS.add(action);
```

- [ ] Add an exact-default-portal validator and route messages. Keep set/get/export/clear out of `WEB_PAGE_ACTIONS` so extension pages alone can call them.

```js
async function validateDefaultPortalDiagnosticsSender(sender) {
  const senderUrl = new URL(sender.url || "");
  const tabUrl = new URL(sender.tab && sender.tab.url || "");
  if (sender.frameId !== 0) throw new Error("门户诊断只接受顶层页面");
  if (senderUrl.origin !== "http://10.10.10.2" || tabUrl.origin !== "http://10.10.10.2") {
    throw new Error("门户诊断只允许默认校园网认证页");
  }
}

case "diagnostics:status":
  return getPortalDiagnosticsStatus();
case "diagnostics:start":
  return startPortalDiagnosticsSession(message.page || {}, sender);
case "diagnostics:append":
  return appendPortalDiagnosticRecord(message.sessionId || "", message.record || {});
case "diagnostics:end":
  return endPortalDiagnosticsSession(message.sessionId || "");
case "diagnostics:set":
  return setPortalDiagnosticsEnabled(message.enabled === true);
case "diagnostics:get":
  return readPortalDiagnostics();
case "diagnostics:export":
  return exportPortalDiagnostics();
case "diagnostics:clear":
  return clearPortalDiagnostics();
```

- [ ] Load `portal-diagnostics-utils.js` before `state-store.js`, then load `background/diagnostics-service.js` after `state-store.js`. Add both files to `check:stable`.

- [ ] Run the background test suite and static checks until all new authorization, privacy, cap, and concurrency cases pass.

Run: `node --test tests/background.test.js && npm run check:stable`

Expected: PASS.

- [ ] Commit the background service and message boundary.

```powershell
git add CRX/background.js CRX/background/state-store.js CRX/background/diagnostics-service.js CRX/background/message-router.js tests/background.test.js package.json
git commit -m "feat: store capped portal diagnostics locally"
```

---

### Task 3: Record safe portal structure and events in the isolated world

**Files:**

- Create: `CRX/portal-diagnostics.js`
- Create: `tests/portal-diagnostics.test.js`
- Modify: `package.json`

- [ ] Build a VM test harness with fake `document`, `MutationObserver`, `PerformanceObserver`, and `chrome.runtime.sendMessage`; keep element `.value` getters instrumented so a read fails the test.

```js
Object.defineProperty(passwordInput, "value", {
  get() { throw new Error("诊断脚本不得读取 input.value"); }
});
```

- [ ] Write failing tests for default-off behavior, an enabled session, click/submit/change/focus descriptors, debounced mutations, resource URL sanitization, resource errors, pagehide, and offline message failures.

```js
test("诊断关闭时不创建观察器也不记录事件", async () => {
  const harness = createHarness({ enabled: false });
  await loadDiagnostics(harness);
  assert.deepEqual(harness.sent.map((item) => item.action), ["diagnostics:status"]);
  assert.equal(harness.mutationObservers.length, 0);
});

test("诊断只记录密码框结构且从不读取值", async () => {
  const harness = createHarness({ enabled: true });
  await loadDiagnostics(harness);
  await harness.emit("focus", harness.passwordInput);
  const append = harness.sent.find((item) => item.action === "diagnostics:append" && item.record.type === "focus");
  assert.equal(append.record.target.type, "password");
  assert.equal("value" in append.record.target, false);
});
```

- [ ] Run the focused tests and confirm the new file is missing.

Run: `node --test tests/portal-diagnostics.test.js`

Expected: FAIL because `CRX/portal-diagnostics.js` does not exist.

- [ ] Implement an origin-gated, default-off recorder with a 20-record in-memory retry queue and no main-world patching.

```js
"use strict";

(() => {
  if (location.origin !== "http://10.10.10.2") return;
  const utils = globalThis.DrcomPortalDiagnosticsUtils;
  const pending = [];
  const MAX_PENDING_RECORDS = 20;
  const MUTATION_DEBOUNCE_MS = 250;
  let sessionId = "";
  let mutationTimer = 0;
  let stopped = false;

  void initialize();

  async function initialize() {
    try {
      const status = await send({ action: "diagnostics:status" });
      if (!status.enabled || !utils) return;
      const started = await send({
        action: "diagnostics:start",
        page: { pageKind: detectPageKind(), url: location.href, title: document.title }
      });
      sessionId = started.sessionId;
      bindSafeEvents();
      bindObservers();
      queueRecord({ type: "dom", pageKind: detectPageKind(), summary: buildDomSummary() });
    } catch (error) {}
  }

  function describeTarget(target) {
    if (!target || target.nodeType !== 1) return {};
    return utils.sanitizeTarget({
      tag: target.tagName,
      id: target.id,
      name: target.getAttribute("name"),
      type: target.getAttribute("type"),
      role: target.getAttribute("role"),
      ariaLabel: target.getAttribute("aria-label")
    });
  }

  function buildDomSummary() {
    const controls = Array.from(document.querySelectorAll("form, input, select, button, a"), (element) => describeTarget(element));
    const summary = JSON.stringify({
      pageKind: detectPageKind(),
      title: utils.sanitizeText(document.title, 256),
      url: utils.sanitizeUrl(location.href),
      controls
    });
    return utils.truncateUtf8(summary, 64 * 1024);
  }
})();
```

- [ ] Complete the recorder with these behaviors:

  - Register capturing listeners for `click`, `submit`, `change`, and `focus`; record only `describeTarget(event.target)` and never `value`, `checked`, `selectedIndex`, or form data.
  - Observe `document.documentElement` with `{ childList: true, subtree: true }`; coalesce changes for 250 ms and append a `mutation` record containing a fresh bounded DOM summary.
  - Read `performance.getEntriesByType("resource")` once and observe later resource entries when `PerformanceObserver` exists; send only `utils.sanitizeUrl(entry.name)`, safe initiator type, and numeric status/duration fields.
  - Capture resource-element `error` events and describe the element without reading content.
  - On `pagehide`, flush one `pagehide` record and send `diagnostics:end`; make cleanup idempotent.
  - `queueRecord` must sanitize locally, keep at most 20 pending records, retry in order after the next successful append, and swallow messaging failures so an offline portal still works normally.

- [ ] Add adversarial tests with fake account/IP/MAC/password text in titles, URLs, attributes, and page text; assert no raw fixture secret appears in any sent message.

- [ ] Run focused tests and static checks.

Run: `node --test tests/portal-diagnostics.test.js tests/portal-diagnostics-utils.test.js && npm run check:stable`

Expected: PASS.

- [ ] Commit the isolated-world recorder.

```powershell
git add CRX/portal-diagnostics.js tests/portal-diagnostics.test.js package.json
git commit -m "feat: capture privacy-safe portal diagnostics"
```

---

### Task 4: Add settings controls, export, and destructive clear confirmation

**Files:**

- Modify: `CRX/options.html`
- Modify: `CRX/options.css`
- Modify: `CRX/options.js`
- Modify: `tests/options-ui.test.js`
- Modify: `tests/ui-contract.test.js`

- [ ] Write failing UI-contract tests that require the diagnostics toggle, warning, size/session status, export button, and clear button inside `#advanced-settings`.

```js
for (const id of [
  "portal-diagnostics-enabled",
  "portal-diagnostics-status",
  "portal-diagnostics-storage",
  "portal-diagnostics-sessions",
  "export-portal-diagnostics",
  "clear-portal-diagnostics"
]) {
  assert.ok(advanced.has(id), `${id} 必须位于高级设置`);
}
```

- [ ] Write failing options VM tests for loading status, enabling/disabling, export filename/Blob contents, clear cancellation, clear confirmation, and refresh after each mutation.

```js
test("清空诊断记录需要统一确认且取消时不发送删除消息", async () => {
  const harness = createOptionsHarness({ confirmResult: false });
  await harness.context.clearPortalDiagnostics();
  assert.equal(harness.messages.some((item) => item.action === "diagnostics:clear"), false);
});
```

- [ ] Run the focused tests and confirm they fail because the controls/functions do not exist.

Run: `node --test tests/options-ui.test.js tests/ui-contract.test.js`

Expected: FAIL on the new diagnostics requirements.

- [ ] Add a compact diagnostics card immediately after the existing “登录页体验” block in advanced settings.

```html
<section class="diagnostics-card" aria-labelledby="portal-diagnostics-title">
  <div class="setting-row">
    <div>
      <h4 id="portal-diagnostics-title">门户诊断模式</h4>
      <p>仅在本机记录脱敏后的页面结构和操作类型；不会记录输入值、密码、账号、IP 或 MAC。</p>
    </div>
    <label class="switch">
      <input id="portal-diagnostics-enabled" type="checkbox">
      <span aria-hidden="true"></span>
      <span class="sr-only">启用门户诊断模式</span>
    </label>
  </div>
  <p id="portal-diagnostics-status" role="status" aria-live="polite">诊断模式已关闭</p>
  <dl class="diagnostics-stats">
    <div><dt>本地占用</dt><dd id="portal-diagnostics-storage">0 B / 1 MiB</dd></div>
    <div><dt>会话</dt><dd id="portal-diagnostics-sessions">0 / 10</dd></div>
  </dl>
  <div class="diagnostics-actions">
    <button id="export-portal-diagnostics" type="button">导出诊断 JSON</button>
    <button id="clear-portal-diagnostics" class="danger-secondary" type="button">清空诊断记录</button>
  </div>
</section>
```

- [ ] Add options logic with pure formatting helpers so VM tests do not require a real browser download.

```js
async function loadPortalDiagnostics() {
  const result = await sendMessage({ action: "diagnostics:get" });
  renderPortalDiagnostics(result);
  return result;
}

function portalDiagnosticsExportFilename(now = new Date()) {
  return `drcom-portal-diagnostics-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

async function exportPortalDiagnostics() {
  const result = await sendMessage({ action: "diagnostics:export" });
  const blob = new Blob([`${JSON.stringify(result.export, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = portalDiagnosticsExportFilename();
  link.click();
  URL.revokeObjectURL(url);
}

async function clearPortalDiagnostics() {
  const confirmed = await DrcomConfirm.confirm({
    title: "清空门户诊断记录？",
    message: "将删除本机保存的全部门户诊断会话，诊断开关保持不变。此操作无法撤销。",
    confirmText: "清空记录",
    danger: true
  });
  if (!confirmed) return false;
  await sendMessage({ action: "diagnostics:clear" });
  await loadPortalDiagnostics();
  return true;
}
```

- [ ] Bind toggle/export/clear events, call `loadPortalDiagnostics()` during settings initialization, disable only the active control during requests, and show actionable errors without changing the displayed enabled state optimistically.

- [ ] Add responsive styling using existing tokens; maintain 44 px minimum hit targets and visible keyboard focus.

- [ ] Run focused UI tests and static checks.

Run: `node --test tests/options-ui.test.js tests/ui-contract.test.js && npm run check:stable`

Expected: PASS.

- [ ] Commit the settings surface.

```powershell
git add CRX/options.html CRX/options.css CRX/options.js tests/options-ui.test.js tests/ui-contract.test.js
git commit -m "feat: manage portal diagnostics in settings"
```

---

### Task 5: Fix asynchronous portal takeover without overriding user restore

**Files:**

- Modify: `CRX/portal-modernizer.js`
- Modify: `tests/portal-modernizer.test.js`

- [ ] Upgrade the modernizer harness to support mutable `pending`/`login`/`online` page state and controllable mutation observers.

```js
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    observers.push(this);
  }
  observe() { this.connected = true; }
  disconnect() { this.connected = false; }
  trigger(records = [{ addedNodes: [] }]) {
    if (this.connected) this.callback(records);
  }
}
```

- [ ] Write three failing regressions: pending-to-login mounts, pending-to-online mounts, and restore prevents later remount.

```js
test("学校脚本异步渲染登录表单后会接管页面", async () => {
  const harness = createHarness({ pageState: "pending" });
  await loadModernizer(harness);
  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
  harness.setPageState("login");
  harness.triggerMutation();
  await harness.flush();
  assert.ok(harness.document.getElementById("drcom-modern-root"));
});

test("用户恢复原始页后后续 DOM 变化不会再次接管", async () => {
  const harness = createHarness({ pageState: "login" });
  await loadModernizer(harness);
  await harness.document.getElementById("drcom-restore-original").emit("click");
  harness.triggerMutation();
  await harness.flush();
  assert.equal(harness.document.getElementById("drcom-modern-root"), null);
});
```

- [ ] Run the focused tests and confirm the pending-page cases fail with the current one-shot `DOMContentLoaded` recognition.

Run: `node --test tests/portal-modernizer.test.js`

Expected: FAIL on asynchronous takeover.

- [ ] Separate internal cleanup from the user restore action and add readiness-observer state.

```js
let portalReadinessObserver = null;
let recognitionQueued = false;
let userRestoredOriginal = false;

function removeModernPortal() {
  document.documentElement.classList.remove("drcom-modern-active");
  document.getElementById("drcom-modern-root")?.remove();
  document.getElementById("drcom-private-appearance")?.remove();
}

function restoreOriginalPortal() {
  userRestoredOriginal = true;
  stopPortalReadinessObserver();
  removeModernPortal();
}
```

- [ ] Replace the one-shot mount function with config loading plus observer-first recognition.

```js
async function boot() {
  try {
    if (!ui) throw new Error("门户界面模块未加载");
    installOriginalLoginCapture();
    activePortalConfig = await loadPortalConfig();
    startPortalReadinessObserver();
    schedulePortalRecognition();
  } catch (error) {
    removeModernPortal();
  }
}

async function loadPortalConfig() {
  const response = await sendMessage({ action: "portal:config:get" });
  const config = response.portal || {};
  const appearanceResponse = await sendMessage({ action: "portal:appearance:get" });
  config.appearance = appearanceResponse.appearance || config.appearance || {};
  return config;
}

function startPortalReadinessObserver() {
  if (portalReadinessObserver || userRestoredOriginal) return;
  portalReadinessObserver = new MutationObserver(() => schedulePortalRecognition());
  portalReadinessObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopPortalReadinessObserver() {
  portalReadinessObserver?.disconnect();
  portalReadinessObserver = null;
}

function schedulePortalRecognition() {
  if (recognitionQueued || userRestoredOriginal) return;
  recognitionQueued = true;
  queueMicrotask(() => {
    recognitionQueued = false;
    tryMountRecognizedPortal();
  });
}

function tryMountRecognizedPortal() {
  if (userRestoredOriginal || !activePortalConfig) return false;
  const online = isOnlinePage();
  const hasPasswordField = Boolean(document.querySelector('input[type="password"]'));
  if (!ui.shouldTakeOver({
    enabled: activePortalConfig.enabled === true,
    online,
    hasPasswordField
  })) return false;
  stopPortalReadinessObserver();
  mountPortal(activePortalConfig, online);
  return true;
}
```

- [ ] Change `mountPortal` to call `removeModernPortal()` rather than `restoreOriginalPortal()`, and bind the restore button to the user-marking `restoreOriginalPortal()` function.

- [ ] Ensure successful login/logout can still re-render by calling `mountPortal` directly, while failed logout keeps the online UI. Confirm the existing background-image privacy test still passes.

- [ ] Run the complete modernizer test file.

Run: `node --test tests/portal-modernizer.test.js`

Expected: PASS for existing and three new regressions.

- [ ] Commit the race fix separately.

```powershell
git add CRX/portal-modernizer.js tests/portal-modernizer.test.js
git commit -m "fix: wait for asynchronous portal templates"
```

---

### Task 6: Wire runtime entry points, packaging, and a real-browser async fixture

**Files:**

- Modify: `CRX/manifest.json`
- Create: `tests/fixtures/portal-async.html`
- Modify: `tests/welcome-layout.test.js`
- Modify: `tests/ui-contract.test.js`
- Modify: `scripts/package-extension.js`
- Modify: `tests/package-extension.test.js`
- Modify: `package.json`

- [ ] Add failing manifest-order and release-whitelist assertions before changing runtime wiring.

```js
assert.deepEqual(portalScript.js, [
  "account-utils.js",
  "appearance.js",
  "portal-ui.js",
  "portal-diagnostics-utils.js",
  "portal-diagnostics.js",
  "portal-modernizer.js"
]);
```

Also assert that `RELEASE_FILES` includes these exact archive paths in dependency order:

```js
[
  "portal-diagnostics-utils.js",
  "background/diagnostics-service.js",
  "portal-diagnostics.js"
]
```

- [ ] Run the focused integration tests and confirm they fail on missing manifest/package entries.

Run: `node --test tests/ui-contract.test.js tests/package-extension.test.js`

Expected: FAIL.

- [ ] Add `portal-diagnostics-utils.js` then `portal-diagnostics.js` immediately before `portal-modernizer.js` in the default content script. Do not alter matches or permissions.

- [ ] Add all three runtime files to `RELEASE_FILES` in dependency order and ensure `check:stable` covers both new JavaScript modules plus the recorder.

- [ ] Create a non-release browser fixture that starts with an empty body, stubs safe extension responses, and renders either a password form or logout marker 100 ms after `DOMContentLoaded`.

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="../../CRX/design-tokens.css">
  <link rel="stylesheet" href="../../CRX/portal.css">
</head>
<body>
  <script>
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          if (message.action === "portal:config:get") {
            callback({ ok: true, portal: { enabled: true, title: "徐医校园网", appearance: {} } });
            return;
          }
          if (message.action === "portal:appearance:get") {
            callback({ ok: true, appearance: { theme: "system", accent: "#007aff", background: "fresh" } });
            return;
          }
          callback({ ok: true });
        }
      }
    };
    setTimeout(() => {
      const online = new URLSearchParams(location.search).get("mode") === "online";
      const original = document.createElement("main");
      original.id = "school-portal-fixture";
      original.innerHTML = online
        ? '<button name="logout" type="button">注销</button>'
        : '<form><input name="user_account"><input type="password" name="user_password"></form>';
      document.body.append(original);
    }, 100);
  </script>
  <script src="../../CRX/account-utils.js"></script>
  <script src="../../CRX/appearance.js"></script>
  <script src="../../CRX/portal-ui.js"></script>
  <script src="../../CRX/portal-modernizer.js"></script>
</body>
</html>
```

- [ ] Add two real-browser tests using the existing `findBrowser`, `waitForDebugger`, `waitForPage`, `evaluateAtViewport`, and `cleanupBrowserProfile` helpers: one opens the fixture normally and waits for `#drcom-login-form`; the other opens `?mode=online` and waits for `#drcom-logout` plus “已经连接校园网”.

- [ ] Confirm the fixture remains excluded from `RELEASE_FILES` and the ZIP test still excludes `tests/`.

- [ ] Run integration, browser, and packaging tests.

Run: `node --test tests/ui-contract.test.js tests/package-extension.test.js`

Run: `node --test tests/welcome-layout.test.js`

Run: `npm run verify:package`

Expected: all PASS; browser tests may only SKIP when no supported browser or built-in WebSocket is present.

- [ ] Commit runtime wiring and end-to-end regression coverage.

```powershell
git add CRX/manifest.json tests/fixtures/portal-async.html tests/welcome-layout.test.js tests/ui-contract.test.js scripts/package-extension.js tests/package-extension.test.js package.json
git commit -m "test: verify async portal takeover in browser"
```

---

### Task 7: Document, verify, and prepare the user-driven live capture

**Files:**

- Modify: `README.md`
- Modify: `docs/development-guide.md`
- Modify: `docs/product-design.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

- [ ] Update README with a short “门户诊断模式” section: default off, local-only, exact 1 MiB/10-session/64 KiB limits, export/clear path, and the warning that exports should still be reviewed before sharing.

- [ ] Update the development guide with the full data flow and message matrix.

```text
portal-diagnostics.js (isolated world)
  -> diagnostics:status/start/append/end
message-router.js (strict sender validation)
  -> diagnostics-service.js (second redaction + serialized mutation + pruning)
  -> chrome.storage.local.drcomPortalDiagnostics
options.js
  -> diagnostics:set/get/export/clear (extension pages only)
```

Document the store schema, pruning order, quota reserve, session lifecycle, retry queue, async takeover state machine, observer cleanup, test locations, and how to import an exported JSON/MHTML fixture into future parity work without committing private captures.

- [ ] Update product design with the user-facing diagnostics card, default-off state, privacy copy, 44 px controls, export/clear behavior, and destructive confirmation behavior.

- [ ] Update SECURITY with explicit exclusions (values, credentials, cookies, storage, account/IP/MAC), double redaction, local threat boundary, and responsible handling of exported JSON/MHTML.

- [ ] Add an Unreleased CHANGELOG entry for the asynchronous login/logout takeover fix and optional capped diagnostics mode. Do not change version numbers or the existing `v2.5.3` tag.

- [ ] Scan for placeholders and accidental secrets before verification.

Run: `rg -n "TODO|FIXME|placeholder|fake-secret|202600000001|192\.0\.2\.15|00:11:22:33:44:55" CRX README.md docs SECURITY.md CHANGELOG.md --glob "!docs/superpowers/plans/**" --glob "!docs/superpowers/specs/**"`

Expected: no production placeholder/fixture secret matches; test fixtures may match only where the assertion proves redaction.

- [ ] Run every focused diagnostics and takeover test once more.

Run: `node --test tests/portal-diagnostics-utils.test.js tests/portal-diagnostics.test.js tests/portal-modernizer.test.js tests/background.test.js tests/options-ui.test.js tests/ui-contract.test.js`

Expected: PASS.

- [ ] Run the complete project gate.

Run: `npm run verify`

Expected: static checks, all unit tests, all browser tests, and both deterministic package tests PASS; no Chrome/Edge process is left behind.

- [ ] Inspect the built artifact and worktree without publishing it.

```powershell
git status --short
git diff --check
Get-FileHash -Algorithm SHA256 dist\drcom-xuzhou-medical-2.5.3.zip
Get-Content dist\drcom-xuzhou-medical-2.5.3.sha256
```

Expected: hashes match and only the intended documentation changes remain unstaged before the final commit.

- [ ] Commit documentation after the full gate is green.

```powershell
git add README.md docs/development-guide.md docs/product-design.md SECURITY.md CHANGELOG.md
git commit -m "docs: explain portal diagnostics and async takeover"
```

- [ ] Re-run `git status --short` and `npm run verify` after the commit; record the final test counts and commit IDs in the handoff.

- [ ] Open the completed settings page for the user, but do not toggle or operate the live portal on their behalf. Ask the user to reload the unpacked extension, enable “门户诊断模式”, revisit the current logout page, and exercise all safe visible controls. Only after they explicitly say the collector is active should they click logout to capture the offline login page.

- [ ] After the user returns connectivity and supplies the exported diagnostics JSON plus MHTML, validate that the files contain no raw password/account/IP/MAC values, keep them out of Git, and use them as inputs to separate plans for core portal parity and external account-service parity.

## Completion Criteria

- Diagnostics is off by default, exact-origin-only, local-only, double-redacted, exportable, clearable with confirmation, and bounded to 1 MiB/10 sessions/64 KiB.
- The current asynchronously rendered logout page and the later asynchronously rendered login page both trigger modern takeover in unit and real-browser tests.
- Restoring the school's original page prevents all later remounts in the same document.
- No permission, version, remote, tag, or GitHub change occurs.
- `npm run verify` is green, deterministic ZIP verification is green, the worktree is clean, and live logout remains user initiated.
