"use strict";

const PORTAL_DIAGNOSTICS_KEY = "drcomPortalDiagnostics";
const PORTAL_DIAGNOSTICS_VERSION = 1;
const PORTAL_DIAGNOSTICS_LIMIT_BYTES = 1024 * 1024;
const PORTAL_DIAGNOSTICS_MAX_SESSIONS = 10;
const PORTAL_DIAGNOSTICS_MAX_DOM_BYTES = 64 * 1024;
const PORTAL_DIAGNOSTICS_MAX_URL_BYTES = 4096;
const PORTAL_DIAGNOSTICS_STORAGE_SOFT_LIMIT = (10 * 1024 * 1024) - (512 * 1024);
const PORTAL_DIAGNOSTICS_PAGE_KINDS = new Set(["pending", "login", "online", "failure", "success", "unknown"]);
var portalDiagnosticsMutationQueue = Promise.resolve();
var portalDiagnosticsUtils = globalThis.DrcomPortalDiagnosticsUtils;

function portalDiagnosticsDefaults() {
  return { version: PORTAL_DIAGNOSTICS_VERSION, enabled: false, updatedAt: 0, sessions: [] };
}

function portalDiagnosticsSerializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function portalDiagnosticsNonNegativeFinite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function sanitizePortalDiagnosticsUrl(value) {
  return portalDiagnosticsUtils.truncateUtf8(
    portalDiagnosticsUtils.sanitizeUrl(value),
    PORTAL_DIAGNOSTICS_MAX_URL_BYTES
  );
}

function sanitizePortalDiagnosticsSession(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    id: portalDiagnosticsUtils.sanitizeText(source.id, 256),
    startedAt: portalDiagnosticsNonNegativeFinite(source.startedAt),
    endedAt: portalDiagnosticsNonNegativeFinite(source.endedAt),
    origin: sanitizePortalDiagnosticsUrl(source.origin),
    pageKind: PORTAL_DIAGNOSTICS_PAGE_KINDS.has(source.pageKind) ? source.pageKind : "unknown",
    title: portalDiagnosticsUtils.sanitizeText(source.title, 256),
    url: sanitizePortalDiagnosticsUrl(source.url),
    records: Array.isArray(source.records) ? source.records.map(sanitizePortalDiagnosticRecord) : [],
    truncated: source.truncated === true
  };
}

function sanitizePortalDiagnosticRecord(input) {
  const record = portalDiagnosticsUtils.sanitizeRecord(input);
  if (record.url) record.url = sanitizePortalDiagnosticsUrl(record.url);
  record.at = portalDiagnosticsNonNegativeFinite(record.at, Date.now());
  if (record.summary) {
    record.summary = portalDiagnosticsUtils.truncateUtf8(record.summary, PORTAL_DIAGNOSTICS_MAX_DOM_BYTES);
  }
  return record;
}

function normalizePortalDiagnosticsStore(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    version: PORTAL_DIAGNOSTICS_VERSION,
    enabled: source.enabled === true,
    updatedAt: portalDiagnosticsNonNegativeFinite(source.updatedAt),
    sessions: Array.isArray(source.sessions)
      ? source.sessions.map(sanitizePortalDiagnosticsSession)
      : []
  };
}

function prunePortalDiagnosticsStore(input) {
  const store = normalizePortalDiagnosticsStore(input);
  store.sessions.sort((left, right) => left.startedAt - right.startedAt);
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
    draft.updatedAt = Date.now();
    const store = prunePortalDiagnosticsStore(draft);
    await chrome.storage.local.set({ [PORTAL_DIAGNOSTICS_KEY]: store });
    return { store, value };
  });
  portalDiagnosticsMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function portalDiagnosticsId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
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
  return portalDiagnosticsPublicStatus(normalizePortalDiagnosticsStore(stored[PORTAL_DIAGNOSTICS_KEY]));
}

async function setPortalDiagnosticsEnabled(enabled) {
  const { store } = await mutatePortalDiagnostics((draft) => { draft.enabled = enabled === true; });
  return portalDiagnosticsPublicStatus(store);
}

async function portalDiagnosticsHasQuota() {
  if (!chrome.storage.local || typeof chrome.storage.local.getBytesInUse !== "function") return true;
  return await chrome.storage.local.getBytesInUse(null) < PORTAL_DIAGNOSTICS_STORAGE_SOFT_LIMIT;
}

async function startPortalDiagnosticsSession(page, sender) {
  if (!await portalDiagnosticsHasQuota()) return { ok: false, error: "本地存储接近上限，诊断记录已暂停" };
  page = page && typeof page === "object" && !Array.isArray(page) ? page : {};
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
      pageKind: PORTAL_DIAGNOSTICS_PAGE_KINDS.has(page.pageKind) ? page.pageKind : "unknown",
      title: portalDiagnosticsUtils.sanitizeText(page.title, 256),
      url: sanitizePortalDiagnosticsUrl(page.url || sender.url),
      records: [],
      truncated: false
    });
  });
  return store.enabled ? { ok: true, enabled: true, sessionId } : { ok: true, enabled: false, sessionId: "" };
}

async function appendPortalDiagnosticRecord(sessionId, record) {
  if (!await portalDiagnosticsHasQuota()) return { ok: false, error: "本地存储接近上限，诊断记录已暂停" };
  const cleanId = String(sessionId || "");
  if (!cleanId) return { ok: false, error: "诊断会话无效" };
  const cleanRecord = sanitizePortalDiagnosticRecord(record);
  let stored = false;
  const result = await mutatePortalDiagnostics((draft) => {
    if (!draft.enabled) return;
    const session = draft.sessions.find((item) => item.id === cleanId);
    if (!session || session.endedAt) return;
    session.records.push(cleanRecord);
    stored = true;
  });
  return { ok: true, enabled: result.store.enabled, stored, bytes: portalDiagnosticsSerializedBytes(result.store) };
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
  const { store } = await mutatePortalDiagnostics((draft) => { draft.sessions = []; });
  return { ok: true, enabled: store.enabled, bytes: portalDiagnosticsSerializedBytes(store), sessionCount: 0, limits: portalDiagnosticsLimits() };
}
