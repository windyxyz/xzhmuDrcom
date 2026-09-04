"use strict";

const PORTAL_DIAGNOSTICS_KEY = "drcomPortalDiagnostics";
const PORTAL_DIAGNOSTICS_VERSION = 1;
const PORTAL_DIAGNOSTICS_LIMIT_BYTES = 1024 * 1024;
const PORTAL_DIAGNOSTICS_MAX_SESSIONS = 10;
const PORTAL_DIAGNOSTICS_MAX_DOM_BYTES = 64 * 1024;
const PORTAL_DIAGNOSTICS_MAX_URL_BYTES = 4096;
const PORTAL_DIAGNOSTICS_STORAGE_SOFT_LIMIT = (10 * 1024 * 1024) - (512 * 1024);
const PORTAL_DIAGNOSTICS_PAGE_KINDS = new Set(["pending", "login", "online", "failure", "success", "unknown"]);
const PORTAL_DIAGNOSTICS_REDACTION_NOTICE = "输入值、凭据、Cookie、存储内容、完整账号、IP 和 MAC 已排除或脱敏。";
const PORTAL_DIAGNOSTICS_COMPLETENESS_NOTICE = "诊断为尽力记录；关闭、暂停、淘汰、存储受限、页面卸载或后台不可用时可能不完整。";
var portalDiagnosticsMutationQueue = Promise.resolve();
var portalDiagnosticsUtils = globalThis.DrcomPortalDiagnosticsUtils;

function portalDiagnosticsDefaults() {
  return {
    version: PORTAL_DIAGNOSTICS_VERSION,
    enabled: false,
    updatedAt: 0,
    droppedRecords: 0,
    paused: false,
    sessions: []
  };
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

function sanitizePortalDiagnosticsSessionId(value) {
  const id = String(value || "");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const legacyFallback = /^\d{10,16}-[0-9a-f]{1,32}$/i;
  if (uuid.test(id) || legacyFallback.test(id)) return id;
  return portalDiagnosticsUtils.sanitizeText(id, 256);
}

function sanitizePortalDiagnosticsSession(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    id: sanitizePortalDiagnosticsSessionId(source.id),
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
    droppedRecords: Math.floor(portalDiagnosticsNonNegativeFinite(source.droppedRecords)),
    paused: source.paused === true,
    sessions: Array.isArray(source.sessions)
      ? source.sessions.map(sanitizePortalDiagnosticsSession)
      : []
  };
}

function countPortalDiagnosticRecords(sessions) {
  return sessions.reduce((total, session) => total + session.records.length, 0);
}

function prunePortalDiagnosticsStore(input) {
  const store = normalizePortalDiagnosticsStore(input);
  store.sessions.sort((left, right) => left.startedAt - right.startedAt);
  if (store.sessions.length > PORTAL_DIAGNOSTICS_MAX_SESSIONS) {
    const removed = store.sessions.splice(0, store.sessions.length - PORTAL_DIAGNOSTICS_MAX_SESSIONS);
    store.droppedRecords += countPortalDiagnosticRecords(removed);
  }

  const sessionSizes = store.sessions.map(createPortalDiagnosticsSessionSize);
  let totalBytes = portalDiagnosticsStoreBytes(store, sessionSizes);

  while (totalBytes > PORTAL_DIAGNOSTICS_LIMIT_BYTES && store.sessions.length > 1) {
    const removed = store.sessions.shift();
    sessionSizes.shift();
    store.droppedRecords += countPortalDiagnosticRecords([removed]);
    totalBytes = portalDiagnosticsStoreBytes(store, sessionSizes);
  }

  const current = store.sessions[0];
  const currentSize = sessionSizes[0];
  if (current && currentSize && totalBytes > PORTAL_DIAGNOSTICS_LIMIT_BYTES && current.records.length) {
    const records = current.records;
    let firstKeptIndex = records.length;
    for (let index = 0; index <= records.length; index += 1) {
      currentSize.bytes = currentSize.bytesFor(index, true);
      totalBytes = portalDiagnosticsStoreBytes(store, sessionSizes);
      if (totalBytes <= PORTAL_DIAGNOSTICS_LIMIT_BYTES) {
        firstKeptIndex = index;
        break;
      }
    }
    current.records = records.slice(firstKeptIndex);
    current.truncated = true;
    store.droppedRecords += firstKeptIndex;
    currentSize.bytes = currentSize.bytesFor(firstKeptIndex, true);
  }

  if (portalDiagnosticsSerializedBytes(store) > PORTAL_DIAGNOSTICS_LIMIT_BYTES && current && current.records.length) {
    store.droppedRecords += current.records.length;
    current.records = [];
    current.truncated = true;
  }
  return store;
}

function createPortalDiagnosticsSessionSize(session) {
  const records = Array.isArray(session.records) ? session.records : [];
  const falseEmptyBytes = portalDiagnosticsSerializedBytes({ ...session, records: [] });
  const trueEmptyBytes = portalDiagnosticsSerializedBytes({ ...session, records: [], truncated: true });
  const recordBytes = records.map((record) => portalDiagnosticsSerializedBytes(record));
  const suffixBytes = Array.from({ length: records.length + 1 }, () => 0);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    suffixBytes[index] = suffixBytes[index + 1] + recordBytes[index] + (index < records.length - 1 ? 1 : 0);
  }

  return {
    bytes: sessionBytes(falseEmptyBytes, trueEmptyBytes, suffixBytes, 0, session.truncated),
    bytesFor(firstKeptIndex, truncated) {
      return sessionBytes(falseEmptyBytes, trueEmptyBytes, suffixBytes, firstKeptIndex, truncated);
    }
  };
}

function sessionBytes(falseEmptyBytes, trueEmptyBytes, suffixBytes, firstKeptIndex, truncated) {
  return (truncated ? trueEmptyBytes : falseEmptyBytes) + suffixBytes[firstKeptIndex];
}

function portalDiagnosticsStoreBytes(store, sessionSizes) {
  return portalDiagnosticsSerializedBytes({ ...store, sessions: [] })
    + sessionSizes.reduce((total, session) => total + session.bytes, 0)
    + Math.max(0, sessionSizes.length - 1);
}

function portalDiagnosticsKeyBytes(value) {
  return portalDiagnosticsSerializedBytes({ [PORTAL_DIAGNOSTICS_KEY]: value });
}

async function portalDiagnosticsWithinQuota(nextValue) {
  if (!chrome.storage.local || typeof chrome.storage.local.getBytesInUse !== "function") return true;
  const totalBytes = await chrome.storage.local.getBytesInUse(null);
  if (totalBytes >= PORTAL_DIAGNOSTICS_STORAGE_SOFT_LIMIT) return false;
  const previousKeyBytes = await chrome.storage.local.getBytesInUse([PORTAL_DIAGNOSTICS_KEY]);
  const projectedTotal = Math.max(0, totalBytes - previousKeyBytes) + portalDiagnosticsKeyBytes(nextValue);
  return projectedTotal < PORTAL_DIAGNOSTICS_STORAGE_SOFT_LIMIT;
}

function mutatePortalDiagnostics(mutator, options = {}) {
  const operation = portalDiagnosticsMutationQueue.then(async () => {
    const stored = await chrome.storage.local.get([PORTAL_DIAGNOSTICS_KEY]);
    const draft = normalizePortalDiagnosticsStore(stored[PORTAL_DIAGNOSTICS_KEY]);
    const value = await mutator(draft);
    draft.updatedAt = Date.now();
    const store = prunePortalDiagnosticsStore(draft);
    if (options.enforceQuota && !await portalDiagnosticsWithinQuota(store)) {
      const rejected = normalizePortalDiagnosticsStore(stored[PORTAL_DIAGNOSTICS_KEY]);
      rejected.updatedAt = Date.now();
      rejected.paused = true;
      rejected.droppedRecords += Math.max(0, Number(options.droppedRecordsOnReject) || 0);
      const pausedStore = prunePortalDiagnosticsStore(rejected);
      await chrome.storage.local.set({ [PORTAL_DIAGNOSTICS_KEY]: pausedStore });
      return { store: pausedStore, value, quotaExceeded: true };
    }
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
  const { store } = await mutatePortalDiagnostics((draft) => {
    draft.enabled = enabled === true;
    draft.paused = false;
  });
  return portalDiagnosticsPublicStatus(store);
}

async function startPortalDiagnosticsSession(page, sender) {
  page = page && typeof page === "object" && !Array.isArray(page) ? page : {};
  const senderUrl = new URL(sender.url);
  const sessionId = portalDiagnosticsId();
  const startedAt = Date.now();
  let started = false;
  const result = await mutatePortalDiagnostics((draft) => {
    if (!draft.enabled || draft.paused) return;
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
    started = true;
  }, { enforceQuota: true });
  if (result.quotaExceeded || result.store.paused) {
    return { ok: false, paused: true, error: "本地存储接近上限，诊断记录已暂停" };
  }
  const { store } = result;
  return store.enabled && started
    ? { ok: true, enabled: true, sessionId }
    : { ok: true, enabled: false, sessionId: "" };
}

async function appendPortalDiagnosticRecord(sessionId, record) {
  const cleanId = String(sessionId || "");
  if (!cleanId) return { ok: false, error: "诊断会话无效" };
  const cleanRecord = sanitizePortalDiagnosticRecord(record);
  let stored = false;
  let rejected = false;
  const result = await mutatePortalDiagnostics((draft) => {
    if (!draft.enabled || draft.paused) return;
    const session = draft.sessions.find((item) => item.id === cleanId);
    if (!session || session.endedAt) {
      draft.droppedRecords += 1;
      draft.paused = true;
      rejected = true;
      return;
    }
    session.records.push(cleanRecord);
    stored = true;
  }, { enforceQuota: true, droppedRecordsOnReject: 1 });
  if (result.quotaExceeded || result.store.paused || rejected) {
    return {
      ok: false,
      stored: false,
      paused: true,
      error: result.quotaExceeded
        ? "本地存储接近上限，诊断记录已暂停"
        : "诊断会话不可写，诊断记录已暂停"
    };
  }
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
    droppedRecords: store.droppedRecords,
    paused: store.paused,
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
      redactionNotice: PORTAL_DIAGNOSTICS_REDACTION_NOTICE,
      completenessNotice: PORTAL_DIAGNOSTICS_COMPLETENESS_NOTICE,
      diagnostics: {
        enabled: diagnostics.enabled,
        bytes: diagnostics.bytes,
        droppedRecords: diagnostics.droppedRecords,
        paused: diagnostics.paused,
        limits: diagnostics.limits,
        sessions: diagnostics.sessions
      }
    }
  };
}

async function clearPortalDiagnostics() {
  const { store } = await mutatePortalDiagnostics((draft) => {
    draft.sessions = [];
    draft.droppedRecords = 0;
    draft.paused = false;
  });
  return {
    ok: true,
    enabled: store.enabled,
    bytes: portalDiagnosticsSerializedBytes(store),
    sessionCount: 0,
    droppedRecords: 0,
    paused: false,
    limits: portalDiagnosticsLimits()
  };
}
