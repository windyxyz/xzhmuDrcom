(function attachOptionsAccountController(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DrcomOptionsAccountController = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  function createController(deps) {
    const {
      $, getState, setState, getEditingId, setEditingId, setAccountFormDirty,
      splitAccount, suffixLabel, makeAccountLabel, naturalAccountKey,
      maskAccount, escapeHtml, t, sendMessage, renderRequestLog, loadState,
      toast, confirmDialog, setSettingsFormDirty
    } = deps;

    function renderAccounts() {
      const state = getState();
      const list = $("account-list");
      const sidebarSummary = $("sidebar-account-summary");
      const selected = state.accounts.find((account) => account.id === state.selectedAccountId) || state.accounts[0] || null;
      if (sidebarSummary) sidebarSummary.textContent = selected ? (selected.label || maskAccount(selected)) : t("no_account_saved");
      if (!state.accounts.length) {
        list.innerHTML = `<p class="empty-note">${escapeHtml(t("no_saved_accounts_long"))}</p>`;
        return;
      }
      list.innerHTML = state.accounts.map((account) => {
        const parsed = splitAccount(account.username, account.suffix);
        const accountLabel = account.label || makeAccountLabel(parsed.username, parsed.suffix);
        return '<div class="simple-account' + (account.id === state.selectedAccountId ? ' active' : '') + '">' +
          '<button type="button" class="account-row" data-edit="' + escapeHtml(account.id) + '">' +
          '<strong>' + escapeHtml(accountLabel) + '</strong>' +
          '<span>' + escapeHtml(maskAccount(account)) + '</span></button>' +
          '<button type="button" class="small-danger" title="' + escapeHtml(t("delete_account_label", [accountLabel])) + '" aria-label="' + escapeHtml(t("delete_account_label", [accountLabel])) + '" data-delete="' + escapeHtml(account.id) + '">' + escapeHtml(t("delete_short")) + '</button></div>';
      }).join("");
    }

    async function handleListClick(event) {
      const state = getState();
      const editButton = event.target.closest("[data-edit]");
      const deleteButton = event.target.closest("[data-delete]");
      if (deleteButton) return deleteAccount(deleteButton.dataset.delete);
      if (editButton) {
        fillEditor(state.accounts.find((item) => item.id === editButton.dataset.edit));
        await selectAccount(editButton.dataset.edit);
      }
    }

    function fillEditor(account) {
      const parsed = account ? splitAccount(account.username, account.suffix) : { username: "", suffix: "" };
      const editingId = account ? account.id : "";
      setEditingId(editingId);
      $("account-id").value = editingId;
      $("account-label").value = account ? account.label : "";
      $("account-suffix").value = parsed.suffix;
      $("account-username").value = parsed.username;
      $("account-password").value = account ? account.password : "";
      $("account-ip").value = account?.network?.wlanUserIp || "";
      $("account-mac").value = account?.network?.wlanUserMac || "000000000000";
      $("account-ipv6").value = account?.network?.wlanUserIpv6 || "";
      $("account-ac-ip").value = account?.network?.wlanAcIp || "";
      $("account-ac-name").value = account?.network?.wlanAcName || "";
      setAccountFormDirty(false);
    }

    function readEdited() {
      const parsed = splitAccount($("account-username").value.trim(), $("account-suffix").value.trim());
      return {
        id: getEditingId(),
        label: $("account-label").value.trim() || makeAccountLabel(parsed.username, parsed.suffix),
        username: parsed.username,
        suffix: parsed.suffix,
        password: $("account-password").value,
        network: {
          wlanUserIp: $("account-ip").value.trim(),
          wlanUserMac: $("account-mac").value.trim() || "000000000000",
          wlanUserIpv6: $("account-ipv6").value.trim(),
          wlanAcIp: $("account-ac-ip").value.trim(),
          wlanAcName: $("account-ac-name").value.trim()
        }
      };
    }

    async function saveEdited(event) {
      event.preventDefault();
      const response = await sendMessage({ action: "account:save", account: readEdited() });
      setState(response.state);
      fillEditor(response.account);
      renderAccounts();
      renderRequestLog();
      toast(t("account_saved"));
    }

    async function loginEdited() {
      const saved = await sendMessage({ action: "account:save", account: readEdited() });
      setState(saved.state);
      fillEditor(saved.account);
      renderAccounts();
      const result = await sendMessage({ action: "drcom:login", accountId: saved.account.id });
      await loadState();
      toast(result.message || t("login_request_sent"));
    }

    async function logout() {
      const result = await sendMessage({ action: "drcom:logout" });
      await loadState();
      toast(result.message || t("logout_request_sent"));
    }

    async function deleteEdited() {
      const editingId = getEditingId();
      if (editingId) await deleteAccount(editingId);
    }

    async function deleteAccount(accountId) {
      const state = getState();
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account) return;
      const accountLabel = account.label || makeAccountLabel(account.username, account.suffix);
      const confirmed = await confirmDialog.ask({
        title: t("delete_account_title"),
        message: t("delete_account_message", [accountLabel, maskAccount(account)]),
        confirmLabel: t("delete_account_confirm")
      });
      if (!confirmed) return;
      const response = await sendMessage({ action: "account:delete", accountId });
      setState(response.state);
      renderAccounts();
      renderRequestLog();
      const next = response.state.accounts.find((item) => item.id === response.state.selectedAccountId) || response.state.accounts[0] || null;
      fillEditor(next);
      toast(t("account_deleted"));
    }

    async function selectAccount(accountId) {
      const response = await sendMessage({ action: "account:select", accountId });
      setState(response.state);
      renderAccounts();
    }

    function parseCapturedUrl() {
      const raw = $("raw-url").value.trim();
      if (!raw) return toast(t("paste_capture_url_first"));
      try {
        const url = new URL(raw);
        const params = url.searchParams;
        const parsed = splitAccount(params.get("user_account") || "");
        $("api-url").value = url.origin + url.pathname;
        $("parsed-label").value = makeAccountLabel(parsed.username, parsed.suffix);
        $("parsed-username").value = parsed.username;
        $("parsed-suffix").value = parsed.suffix;
        $("parsed-password").value = params.get("user_password") || "";
        $("parsed-ip").value = params.get("wlan_user_ip") || "";
        $("parsed-mac").value = params.get("wlan_user_mac") || "000000000000";
        $("login-method").value = params.get("login_method") || $("login-method").value || "1";
        $("js-version").value = params.get("jsVersion") || $("js-version").value || "3.3.2";
        setSettingsFormDirty(true);
        const parsedSuffix = { "": "carrier_campus", "@telecom": "carrier_telecom", "@unicom": "carrier_unicom", "@cmcc": "carrier_mobile" }[parsed.suffix];
        toast(t("parse_success", [parsedSuffix ? t(parsedSuffix) : suffixLabel(parsed.suffix)]));
      } catch (error) {
        toast(t("invalid_url"));
      }
    }

    async function saveParsed() {
      const state = getState();
      const parsed = splitAccount($("parsed-username").value.trim(), $("parsed-suffix").value.trim());
      const account = {
        label: $("parsed-label").value.trim() || makeAccountLabel(parsed.username, parsed.suffix),
        username: parsed.username,
        suffix: parsed.suffix,
        password: $("parsed-password").value,
        network: {
          wlanUserIp: $("parsed-ip").value.trim(),
          wlanUserMac: $("parsed-mac").value.trim() || "000000000000"
        }
      };
      const existing = state.accounts.find((item) => naturalAccountKey(item) === naturalAccountKey(account));
      if (existing) {
        const existingLabel = existing.label || makeAccountLabel(existing.username, existing.suffix);
        const confirmed = await confirmDialog.ask({
          title: t("overwrite_import_title"),
          message: t("overwrite_import_message", [existingLabel]),
          confirmLabel: t("overwrite_import_confirm")
        });
        if (!confirmed) return;
        account.id = existing.id;
      }
      const response = await sendMessage({ action: "account:save", account });
      setState(response.state);
      fillEditor(response.account);
      renderAccounts();
      renderRequestLog();
      const savedSuffix = { "": "carrier_campus", "@telecom": "carrier_telecom", "@unicom": "carrier_unicom", "@cmcc": "carrier_mobile" }[response.account.suffix];
      toast(t("account_saved_with_provider", [savedSuffix ? t(savedSuffix) : suffixLabel(response.account.suffix)]));
    }

    return { renderAccounts, handleListClick, fillEditor, readEdited, saveEdited, loginEdited, logout, deleteEdited, deleteAccount, selectAccount, parseCapturedUrl, saveParsed };
  }

  return { createController };
});
