'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const test = require('node:test');

const portalSessionPath = join(__dirname, '..', 'CRX', 'portal-session.js');

test('门户会话摘要会换算学校的时间、流量和余额字段', () => {
  const { normalizeSession } = require(portalSessionPath);

  const session = normalizeSession({
    result: 1,
    uid: '202513010318@telecom',
    time: '125',
    flow: '1234567',
    flow_in: '500000',
    flow_out: '734567',
    fee: '123456',
    login_time: '1769990400',
    xip: '202.202.202.202',
    wlan_user_ip: '10.10.10.3',
    wlan_user_ipv6: '2001:db8::1',
    wlan_user_mac: 'AA-BB-CC-DD-EE-FF',
    wlan_vlan_id: '123',
    wlan_ac_ip: '10.10.10.2',
    wlan_ac_name: 'campus-ac',
    unknown_school_field: 'do-not-copy'
  });

  assert.deepEqual(session, {
    account: '20***18',
    usedMinutes: 125,
    totalKilobytes: 1234567,
    uploadKilobytes: 500000,
    downloadKilobytes: 734567,
    balanceYuan: 12.34,
    loginAt: 1769990400000,
    externalIp: '202.***.***.202',
    network: {
      ipv4: '10.***.***.3',
      ipv6: '2001:***::***:1',
      mac: 'AA:BB:CC:**:**:**',
      vlan: '123',
      acIp: '10.***.***.2',
      acName: 'campus-ac'
    }
  });
});

test('门户会话格式化保持学校口径并使用易读单位', () => {
  const api = require(portalSessionPath);

  assert.equal(api.formatMinutes(125), '125 分钟');
  assert.equal(api.formatKilobytes(512), '512 KB');
  assert.equal(api.formatKilobytes(1536), '1.50 MB');
  assert.equal(api.formatKilobytes(1234567), '1.18 GB');
  assert.equal(api.formatBalance(123456), '¥12.34');
  assert.equal(api.formatTimestamp(1769990400000), '2026/2/2 08:00');
});

test('离线或无效会话不会生成摘要，异常字段会被丢弃', () => {
  const { normalizeSession } = require(portalSessionPath);

  assert.equal(normalizeSession({ result: 0, uid: 'student' }), null);
  assert.deepEqual(normalizeSession({
    result: 1,
    uid: '',
    time: '-1',
    flow: 'not-a-number',
    fee: 'Infinity',
    login_time: 'not-a-number',
    wlan_user_ip: 'not-an-ip',
    wlan_user_mac: '000000000000',
    wlan_vlan_id: '',
    wlan_ac_name: '   '
  }), {});
});

test('完整敏感标识不会进入门户会话摘要', () => {
  const { normalizeSession } = require(portalSessionPath);
  const serialized = JSON.stringify(normalizeSession({
    result: 1,
    uid: '202513010318@telecom',
    xip: '202.202.202.202',
    wlan_user_ip: '10.10.10.3',
    wlan_user_ipv6: '2001:db8:1234:5678:9abc:def0:1234:5678',
    wlan_user_mac: 'AA-BB-CC-DD-EE-FF'
  }));

  assert.doesNotMatch(serialized, /202513010318|202\.202\.202\.202|10\.10\.10\.3|AA-BB-CC-DD-EE-FF|AABBCCDDEEFF/);
});
