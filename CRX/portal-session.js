(function attachPortalSession(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DrcomPortalSession = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function positiveNumber(value) {
    const raw = text(value);
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  function integerNumber(value) {
    const parsed = positiveNumber(value);
    return parsed === undefined ? undefined : Math.trunc(parsed);
  }

  function firstDefined(data, keys) {
    for (const key of keys) {
      if (data[key] !== undefined && data[key] !== null && text(data[key])) return data[key];
    }
    return undefined;
  }

  function maskAccount(value) {
    const account = text(value)
      .replace(/^,0,/, '')
      .replace(/@(telecom|unicom|cmcc)$/i, '');
    if (!account) return undefined;
    if (account.length <= 4) return '****';
    return `${account.slice(0, 2)}***${account.slice(-2)}`;
  }

  function maskIpv4(value) {
    const parts = text(value).split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
      return undefined;
    }
    return `${parts[0]}.***.***.${parts[3]}`;
  }

  function maskIpv6(value) {
    const address = text(value).toLowerCase();
    if (!/^[0-9a-f:]+$/.test(address) || !address.includes(':') || address.length > 45) {
      return undefined;
    }
    const groups = address.split(':').filter(Boolean);
    if (groups.length < 2) return undefined;
    return `${groups[0]}:***::***:${groups[groups.length - 1]}`;
  }

  function maskMac(value) {
    const mac = text(value).replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (mac.length !== 12 || /^(0|1){12}$/.test(mac)) return undefined;
    return `${mac.slice(0, 2)}:${mac.slice(2, 4)}:${mac.slice(4, 6)}:**:**:**`;
  }

  function normalizeTimestamp(value) {
    const secondsOrMilliseconds = positiveNumber(value);
    if (secondsOrMilliseconds === undefined) return undefined;
    const milliseconds = secondsOrMilliseconds < 1_000_000_000_000
      ? secondsOrMilliseconds * 1000
      : secondsOrMilliseconds;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.getTime() : undefined;
  }

  function normalizeSession(data) {
    const source = data && typeof data === 'object' ? data : {};
    if (text(source.result) !== '1') return null;

    const session = {};
    const account = maskAccount(firstDefined(source, ['uid', 'user_name', 'account']));
    if (account) session.account = account;

    const usedMinutes = integerNumber(source.time);
    if (usedMinutes !== undefined) session.usedMinutes = usedMinutes;

    const totalKilobytes = positiveNumber(firstDefined(source, ['flow', 'flux']));
    if (totalKilobytes !== undefined) session.totalKilobytes = totalKilobytes;

    const uploadKilobytes = positiveNumber(firstDefined(source, ['flow_in', 'upflow', 'upload']));
    if (uploadKilobytes !== undefined) session.uploadKilobytes = uploadKilobytes;

    const downloadKilobytes = positiveNumber(firstDefined(source, ['flow_out', 'downflow', 'download']));
    if (downloadKilobytes !== undefined) session.downloadKilobytes = downloadKilobytes;

    const fee = positiveNumber(source.fee);
    if (fee !== undefined) session.balanceYuan = Number((Math.floor(fee / 100) / 100).toFixed(2));

    const loginAt = normalizeTimestamp(firstDefined(source, ['login_time', 'loginTime', 'online_time']));
    if (loginAt !== undefined) session.loginAt = loginAt;

    const externalIp = maskIpv4(firstDefined(source, ['xip', 'external_ip', 'online_ip']));
    if (externalIp) session.externalIp = externalIp;

    const networkSource = source.network && typeof source.network === 'object' ? source.network : source;
    const network = {};
    const ipv4 = maskIpv4(firstDefined(networkSource, ['wlan_user_ip', 'user_ip', 'ipv4']));
    if (ipv4) network.ipv4 = ipv4;
    const ipv6 = maskIpv6(firstDefined(networkSource, ['wlan_user_ipv6', 'user_ipv6', 'ipv6']));
    if (ipv6) network.ipv6 = ipv6;
    const mac = maskMac(firstDefined(networkSource, ['wlan_user_mac', 'user_mac', 'mac', 'ss4']));
    if (mac) network.mac = mac;
    const vlan = text(firstDefined(networkSource, ['wlan_vlan_id', 'vlanid', 'vlan']));
    if (vlan) network.vlan = vlan;
    const acIp = maskIpv4(firstDefined(networkSource, ['wlan_ac_ip', 'acip']));
    if (acIp) network.acIp = acIp;
    const acName = text(firstDefined(networkSource, ['wlan_ac_name', 'acname']));
    if (acName) network.acName = acName;
    if (Object.keys(network).length) session.network = network;

    return session;
  }

  function formatMinutes(value) {
    const minutes = integerNumber(value);
    return minutes === undefined ? '' : `${minutes} 分钟`;
  }

  function formatKilobytes(value) {
    const kilobytes = positiveNumber(value);
    if (kilobytes === undefined) return '';
    if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
    if (kilobytes < 1024 * 1024) return `${(kilobytes / 1024).toFixed(2)} MB`;
    return `${(kilobytes / (1024 * 1024)).toFixed(2)} GB`;
  }

  function formatBalance(value) {
    const fee = positiveNumber(value);
    if (fee === undefined) return '';
    return `¥${(Math.floor(fee / 100) / 100).toFixed(2)}`;
  }

  function formatTimestamp(value) {
    const milliseconds = normalizeTimestamp(value);
    if (milliseconds === undefined) return '';
    const date = new Date(milliseconds);
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hour}:${minute}`;
  }

  return {
    normalizeSession,
    formatMinutes,
    formatKilobytes,
    formatBalance,
    formatTimestamp
  };
});
