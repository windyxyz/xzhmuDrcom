"use strict";

var accountUtils = globalThis.DrcomAccountUtils;

function sanitizeAccount(input) {
  input = input && typeof input === "object" ? input : {};
  const parsed = accountUtils.parse(input.username, input.suffix);
  const updatedAt = normalizeTimestamp(input.updatedAt);
  return {
    id: stringValue(input.id) || createId(),
    label: stringValue(input.label).trim() || accountUtils.label(parsed.username, parsed.suffix),
    username: parsed.username,
    suffix: parsed.suffix,
    password: stringValue(input.password),
    network: {
      wlanUserIp: stringValue(input.network && input.network.wlanUserIp).trim(),
      wlanUserIpv6: stringValue(input.network && input.network.wlanUserIpv6).trim(),
      wlanUserMac: accountUtils.normalizeMac(input.network && input.network.wlanUserMac),
      wlanAcIp: stringValue(input.network && input.network.wlanAcIp).trim(),
      wlanAcName: stringValue(input.network && input.network.wlanAcName).trim()
    },
    updatedAt
  };
}

function deduplicateAccounts(inputs, selectedAccountId = "") {
  const groups = new Map();
  for (const raw of inputs) {
    const account = sanitizeAccount(raw);
    if (!account.username || !account.password) continue;
    const key = accountUtils.naturalKey(account);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ raw: raw || {}, account });
  }

  const remappedIds = new Map();
  const accounts = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (
      Date.parse(left.account.updatedAt) - Date.parse(right.account.updatedAt)
    ));
    const selected = group.find((entry) => entry.account.id === selectedAccountId);
    const keeper = selected || ordered[ordered.length - 1];
    const merged = {
      ...keeper.raw,
      id: keeper.account.id,
      label: "",
      username: keeper.account.username,
      suffix: keeper.account.suffix,
      password: "",
      network: {},
      updatedAt: ordered[ordered.length - 1].account.updatedAt
    };

    for (const entry of ordered) {
      const raw = entry.raw && typeof entry.raw === "object" ? entry.raw : {};
      const label = stringValue(raw.label).trim();
      const password = stringValue(raw.password);
      if (label) merged.label = label;
      if (password) merged.password = password;
      for (const field of ["wlanUserIp", "wlanUserIpv6", "wlanUserMac", "wlanAcIp", "wlanAcName"]) {
        const value = stringValue(raw.network && raw.network[field]).trim();
        if (value) merged.network[field] = value;
      }
      remappedIds.set(entry.account.id, keeper.account.id);
    }

    accounts.push(sanitizeAccount(merged));
  }

  return {
    accounts,
    selectedAccountId: remappedIds.get(selectedAccountId) || selectedAccountId
  };
}

async function saveAccount(input) {
  const mutation = await mutateState((state) => {
    const account = sanitizeAccount({
      ...input,
      updatedAt: new Date().toISOString()
    });

    if (!account.username || !account.password) {
      throw new Error("账号和密码不能为空");
    }

    const idIndex = stringValue(input && input.id)
      ? state.accounts.findIndex((item) => item.id === account.id)
      : -1;
    const naturalKey = accountUtils.naturalKey(account);
    const naturalKeyIndex = state.accounts.findIndex((item) => accountUtils.naturalKey(item) === naturalKey);
    const index = idIndex >= 0 ? idIndex : naturalKeyIndex;
    if (index >= 0) {
      account.id = state.accounts[index].id;
      state.accounts[index] = account;
    }
    else state.accounts.unshift(account);
    state.selectedAccountId = account.id;
    return account.id;
  });
  const state = mutation.state;
  const account = state.accounts.find((item) => item.id === mutation.value);
  return { ok: true, state, account };
}

async function deleteAccount(accountId) {
  const { state } = await mutateState((draft) => {
    draft.accounts = draft.accounts.filter((account) => account.id !== accountId);
    if (draft.selectedAccountId === accountId) {
      draft.selectedAccountId = draft.accounts[0] ? draft.accounts[0].id : "";
    }
  });
  return { ok: true, state };
}

async function selectAccount(accountId) {
  const { state } = await mutateState((draft) => {
    if (accountId && !draft.accounts.some((account) => account.id === accountId)) {
      throw new Error("找不到这个账号");
    }
    draft.selectedAccountId = accountId;
  });
  return { ok: true, state };
}

async function updateAccountNetwork(userAccount, patch) {
  const parsed = accountUtils.parse(userAccount);
  const mutation = await mutateState((state) => {
    const selected = state.accounts.find((account) => account.id === state.selectedAccountId) || null;
    const matched = state.accounts.find((item) => {
      const current = accountUtils.parse(item.username, item.suffix);
      if (!parsed.username || current.username !== parsed.username) return false;
      return parsed.suffix ? current.suffix === parsed.suffix : true;
    }) || null;
    const account = parsed.username ? matched : selected;
    if (!account) return STATE_UNCHANGED;

    account.network = account.network || {};
    const networkPatch = {
      wlanUserIp: stringValue(patch.wlanUserIp).trim(),
      wlanUserIpv6: stringValue(patch.wlanUserIpv6).trim(),
      wlanUserMac: accountUtils.normalizeMac(patch.wlanUserMac),
      wlanAcIp: stringValue(patch.wlanAcIp).trim(),
      wlanAcName: stringValue(patch.wlanAcName).trim()
    };
    for (const [key, value] of Object.entries(networkPatch)) {
      if (value) account.network[key] = value;
    }
    account.updatedAt = new Date().toISOString();
    return account.id;
  });
  if (!mutation.value) {
    return { ok: false, state: mutation.state, message: parsed.username ? "未找到抓包对应的账号，未修改当前账号" : "没有可更新的账号" };
  }
  const account = mutation.state.accounts.find((item) => item.id === mutation.value);
  return { ok: true, state: mutation.state, account };
}
