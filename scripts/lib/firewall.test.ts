/**
 * 防火墙判定逻辑的单元测试。
 *
 * 运行：npm run test:doctor
 *
 * 这里用的 netsh 输出片段是从真实机器上抓下来的（包括本机那两条
 * 「Node.js JavaScript Runtime」规则），不是编造的样例 ——
 * 因为这段逻辑的结论直接决定用户「今晚能不能用手机连上」，不能靠猜。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateInboundAccess,
  parseActiveProfile,
  parseFirewallOn,
  parseNetshRules,
  profileCovers,
} from './firewall.ts';

/** 本机真实存在的规则（从 netsh 抓下来的原文格式） */
const REAL_NODE_RULES = `
Rule Name:                            Node.js JavaScript Runtime
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             UDP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       Defer to user
Action:                               Allow

Rule Name:                            Node.js JavaScript Runtime
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       Defer to user
Action:                               Allow
`;

const PORT_RULE = `
Rule Name:                            狼人杀 5180
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Any
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            5180
RemotePort:                           Any
Edge traversal:                       Defer to user
Action:                               Allow
`;

const DISABLED_PORT_RULE = `
Rule Name:                            狼人杀 5180 (旧)
----------------------------------------------------------------------
Enabled:                              No
Direction:                            In
Profiles:                             Any
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            5180
RemotePort:                           Any
Edge traversal:                       Defer to user
Action:                               Allow
`;

const OUTBOUND_RULE = `
Rule Name:                            Node.js JavaScript Runtime
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            Out
Profiles:                             Any
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       Defer to user
Action:                               Allow
`;

/** 别的程序的程序级规则（LocalPort = Any），不该被算成放行我们 */
const UNRELATED_PROGRAM_RULE = `
Rule Name:                            Spotify
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Any
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       Defer to user
Action:                               Allow
`;

const REAL_ACTIVE_PROFILE = `
Public Profile:
----------------------------------------------------------------------
tj123 4
Ok.
`;

const REAL_STATES = `
Domain Profile Settings:
----------------------------------------------------------------------
State                                 ON

Private Profile Settings:
----------------------------------------------------------------------
State                                 ON

Public Profile Settings:
----------------------------------------------------------------------
State                                 ON
`;

describe('netsh 规则解析', () => {
  it('能解析出规则名/方向/配置/协议/端口/操作', () => {
    const rules = parseNetshRules(REAL_NODE_RULES);
    assert.equal(rules.length, 2, '应解析出 2 条规则');
    const tcp = rules.find((r) => r.protocol === 'TCP');
    assert.ok(tcp, '应有 TCP 规则');
    assert.equal(tcp.name, 'Node.js JavaScript Runtime');
    assert.equal(tcp.enabled, true);
    assert.equal(tcp.direction, 'In');
    assert.equal(tcp.profiles, 'Public');
    assert.equal(tcp.localPort, 'Any');
    assert.equal(tcp.action, 'Allow');
  });

  it('分隔线和 Ok. 这类噪音行不会产生假规则', () => {
    const rules = parseNetshRules(REAL_NODE_RULES + '\nOk.\n');
    assert.equal(rules.length, 2);
  });

  it('配置覆盖判断支持 Any / 逗号分隔 / 大小写', () => {
    assert.equal(profileCovers('Public', 'Public'), true);
    assert.equal(profileCovers('public', 'Public'), true);
    assert.equal(profileCovers('Any', 'Private'), true);
    assert.equal(profileCovers('Domain,Private', 'Private'), true);
    assert.equal(profileCovers('Domain,Private', 'Public'), false);
    assert.equal(profileCovers('Public', 'Private'), false);
  });
});

describe('入站放行判定', () => {
  it('当前配置 Public + Node 程序级规则 → 放行（这是本机的真实情况）', () => {
    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(REAL_NODE_RULES),
      activeProfile: 'Public',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, true, verdict.reason);
    assert.equal(verdict.fix, null);
    assert.ok(verdict.matchedRules.includes('Node.js JavaScript Runtime'));
    // 必须说明命中依据是规则名，而不是端口 —— netsh 非 verbose 输出不含程序路径
    assert.match(verdict.reason, /规则名/);
  });

  it('换成 Private 配置 → 不放行，并给出修复命令', () => {
    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(REAL_NODE_RULES),
      activeProfile: 'Private',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, false, 'Public 的规则不该对 Private 生效');
    assert.ok(verdict.fix, '应给出修复命令');
    assert.match(verdict.fix!, /New-NetFirewallRule/);
    assert.match(verdict.fix!, /5180/);
    assert.match(verdict.reason, /Private/);
  });

  it('端口级规则可以放行任意配置', () => {
    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(PORT_RULE),
      activeProfile: 'Private',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, true, verdict.reason);
  });

  it('已禁用的规则不算数', () => {
    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(DISABLED_PORT_RULE),
      activeProfile: 'Any',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, false);
  });

  it('出站规则不算数（方向必须是 In）', () => {
    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(OUTBOUND_RULE),
      activeProfile: 'Public',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, false);
  });

  it('别的程序的程序级规则（LocalPort=Any）不会被误判为放行我们', () => {
    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(UNRELATED_PROGRAM_RULE),
      activeProfile: 'Public',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, false, 'Spotify 的规则不该被当成放行 Node');
  });

  it('防火墙关闭时直接放行，不需要修复命令', () => {
    const verdict = evaluateInboundAccess({
      rules: [],
      activeProfile: 'Public',
      port: 5180,
      firewallOn: false,
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.fix, null);
  });

  it('空规则 + 防火墙开启 → 不放行（这就是最危险的情况）', () => {
    const verdict = evaluateInboundAccess({
      rules: [],
      activeProfile: 'Public',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.fix);
    assert.match(verdict.reason, /静默丢弃/);
  });

  it('只放行了别的端口 → 不算放行（即使规则名里带「狼人杀」）', () => {
    // 这是一条真实会踩的坑：用户给 8080 建了条名字带「狼人杀」的规则，
    // 早期实现把名字里含「狼人杀」当成命中，于是误报「能连上」。
    // 假阳性比漏报危险得多 —— 它会让用户以为今晚能测，结果手机连不上。
    const otherPort = PORT_RULE.replace('LocalPort:                            5180', 'LocalPort:                            8080');
    assert.match(otherPort, /LocalPort:\s+8080/, '夹具应已改成 8080');
    assert.match(otherPort, /狼人杀 5180/, '规则名保持带「狼人杀」以复现误报场景');

    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(otherPort),
      activeProfile: 'Any',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, false, '只放行 8080 不该被判成放行了 5180');
  });

  it('自定名字的端口级规则，只要是 5180 就能识别', () => {
    const renamed = PORT_RULE.replace('狼人杀 5180', '我的服务');
    const verdict = evaluateInboundAccess({
      rules: parseNetshRules(renamed),
      activeProfile: 'Private',
      port: 5180,
      firewallOn: true,
    });
    assert.equal(verdict.allowed, true, verdict.reason);
    assert.equal(verdict.matchedRules.includes('我的服务'), true);
  });
});

describe('netsh 其它输出解析', () => {
  it('解析当前生效配置', () => {
    assert.equal(parseActiveProfile(REAL_ACTIVE_PROFILE), 'Public');
    assert.equal(parseActiveProfile('Private Profile:\n---\nMyWifi'), 'Private');
    assert.equal(parseActiveProfile('Domain Profile:\n---\ncorp'), 'Domain');
    assert.equal(parseActiveProfile('乱码'), null);
  });

  it('解析指定配置的防火墙开关', () => {
    assert.equal(parseFirewallOn(REAL_STATES, 'Public'), true);
    assert.equal(parseFirewallOn(REAL_STATES, 'Private'), true);
    assert.equal(parseFirewallOn(REAL_STATES, 'Domain'), true);
    const off = REAL_STATES.replace(
      /Public Profile Settings:[\s\S]*?State\s+ON/,
      'Public Profile Settings:\n---\nState                                 OFF',
    );
    assert.equal(parseFirewallOn(off, 'Public'), false);
    assert.equal(parseFirewallOn(off, 'Private'), true, '只关了 Public，不该影响 Private');
  });
});
