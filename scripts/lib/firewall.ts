/**
 * 纯函数部分：解析 netsh 防火墙规则输出，并判断「手机能不能连上」。
 *
 * 之所以把这部分单独抽出来，是因为真正跑 netsh 需要 spawn 子进程
 * （在受管环境里可能被拦），而**判定逻辑本身**必须可靠 ——
 * 它会直接告诉用户「今晚能不能测」，猜错就是浪费一晚上。
 * 所以这里不依赖任何外部命令，可以用真实的 netsh 输出做单元测试。
 */

export interface FirewallRule {
  name: string;
  enabled: boolean;
  direction: string;
  profiles: string;
  protocol: string;
  localPort: string;
  remotePort: string;
  action: string;
}

export interface AccessVerdict {
  /** 入站是否应该放行 */
  allowed: boolean;
  /** 人话解释 */
  reason: string;
  /** 需要修复时给出的命令（不需要则为 null） */
  fix: string | null;
  /** 命中的规则名 */
  matchedRules: string[];
}

/** netsh 的字段名在中文系统上会是中文，统一成小写英文键 */
const KEY_ALIASES: Record<string, string> = {
  '规则名称': 'rulename',
  '已启用': 'enabled',
  '方向': 'direction',
  '配置文件': 'profiles',
  '协议': 'protocol',
  '本地端口': 'localport',
  '远程端口': 'remoteport',
  '操作': 'action',
};

function normalizeKey(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '');
  return KEY_ALIASES[raw.trim()] ?? key;
}

function isAffirmative(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'yes' || v === '是' || v === 'true';
}

function isInbound(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'in' || v === '入' || v === 'inbound';
}

function isAllow(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'allow' || v === '允许';
}

/**
 * 解析 `netsh advfirewall firewall show rule name=all dir=in` 的输出。
 * 规则之间用空行分隔，每条规则内是「键: 值」。
 */
export function parseNetshRules(raw: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (const block of raw.split(/\r?\n\s*\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^\s*([^:]{1,40}?):\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const key = normalizeKey(match[1] ?? '');
      const value = match[2] ?? '';
      if (key && value) fields.set(key, value);
    }
    const name = fields.get('rulename');
    if (!name) continue;
    rules.push({
      name,
      enabled: isAffirmative(fields.get('enabled') ?? ''),
      direction: fields.get('direction') ?? '',
      profiles: fields.get('profiles') ?? '',
      protocol: fields.get('protocol') ?? '',
      localPort: fields.get('localport') ?? '',
      remotePort: fields.get('remoteport') ?? '',
      action: fields.get('action') ?? '',
    });
  }
  return rules;
}

/** 这条规则的适用配置里是否包含当前生效的配置 */
export function profileCovers(ruleProfiles: string, activeProfile: string): boolean {
  const list = ruleProfiles
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true; // netsh 偶尔留空，按「不限制」处理
  if (list.includes('any') || list.includes('所有')) return true;
  return list.includes(activeProfile.trim().toLowerCase());
}

/** 端口字段是否覆盖目标端口（'Any' 表示任意端口） */
function portCovers(localPort: string, port: number): { covers: boolean; explicit: boolean } {
  const value = localPort.trim().toLowerCase();
  if (value === 'any' || value === '任意') return { covers: true, explicit: false };
  const parts = value.split(',').map((p) => p.trim());
  for (const part of parts) {
    if (part === String(port)) return { covers: true, explicit: true };
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (port >= from && port <= to) return { covers: true, explicit: true };
    }
  }
  return { covers: false, explicit: false };
}

/**
 * 判断「别的设备能不能连上本机的这个端口」。
 *
 * 命中条件（全部满足）：
 *   已启用 + 入站 + 允许 + 规则配置覆盖当前生效配置 + （规则名像 Node 程序规则 或 显式放行该端口）
 *
 * 注意 netsh 的非 verbose 输出里没有 Program 字段，所以程序级规则只能靠规则名判断。
 * 这里对「靠名字命中」的情况会在 reason 里说明，不做过度断言。
 */
export function evaluateInboundAccess(options: {
  rules: FirewallRule[];
  activeProfile: string;
  port: number;
  firewallOn: boolean;
}): AccessVerdict {
  const { rules, activeProfile, port, firewallOn } = options;

  const fix = `New-NetFirewallRule -DisplayName "狼人杀 ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Any`;

  if (!firewallOn) {
    return {
      allowed: true,
      reason: 'Windows 防火墙已关闭，入站不会被拦',
      fix: null,
      matchedRules: [],
    };
  }

  const matched: string[] = [];
  let matchedByName = false;
  let matchedByPort = false;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!isInbound(rule.direction)) continue;
    if (!isAllow(rule.action)) continue;
    if (!profileCovers(rule.profiles, activeProfile)) continue;

    const portResult = portCovers(rule.localPort, port);

    // 程序级规则的 LocalPort 是 Any，只能靠规则名识别。
    // 这里**只认 Node 相关的名字** —— Windows 为 node 可执行文件自动创建的规则
    // 固定叫 "Node.js JavaScript Runtime"。
    //
    // 刻意不匹配「狼人杀 / werewolf」这类自定名字：用户自己建的规则多半是端口级规则，
    // 已经由端口匹配覆盖；把它也算作名称命中会产生**假阳性** ——
    // 比如一条给 8080 端口、名字里带「狼人杀」的规则会被误判成放行了 5180，
    // 从而告诉用户「能连上」但实际连不上。宁可漏报，不可误报。
    const nameIsNode = /^node(\.js)?\b/i.test(rule.name) || /node\.js\s+javascript\s+runtime/i.test(rule.name);
    const relevant = nameIsNode || (portResult.covers && portResult.explicit);
    if (!relevant) continue;

    matched.push(rule.name);
    if (nameIsNode) matchedByName = true;
    if (portResult.covers && portResult.explicit) matchedByPort = true;
  }

  if (matched.length > 0) {
    const how = matchedByName && matchedByPort
      ? '既有程序级规则也有端口级规则'
      : matchedByName
        ? '命中程序级规则（按规则名判断，netsh 非 verbose 输出不含程序路径）'
        : '命中端口级规则';
    return {
      allowed: true,
      reason: `已有 ${matched.length} 条放行规则覆盖「${activeProfile}」配置：${[...new Set(matched)].join('、')}（${how}）`,
      fix: null,
      matchedRules: [...new Set(matched)],
    };
  }

  return {
    allowed: false,
    reason:
      `防火墙对「${activeProfile}」配置生效，但没有任何已启用、覆盖该配置、且放行 ${port} 端口（或 Node 程序）的入站规则。` +
      `手机连接时会被静默丢弃，表现为浏览器一直转圈或「无法访问此网站」。` +
      `（注意：netsh 的非 verbose 输出不含程序路径，所以自己命名的程序级规则可能识别不到 —— 如果你确认已经放行过，以实际能否连上为准。）`,
    fix,
    matchedRules: [],
  };
}

/** 把 netsh monitor show currentprofile 的输出解析成配置名（Domain / Private / Public） */
export function parseActiveProfile(raw: string): string | null {
  const match = /(domain|private|public)\s+profile/i.exec(raw);
  if (match && match[1]) {
    const name = match[1].toLowerCase();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const cn = /(域|专用|公用|专用网络|公用网络)/.exec(raw);
  const cnLabel = cn?.[1];
  if (cnLabel !== undefined) {
    if (cnLabel === '域') return 'Domain';
    if (cnLabel.startsWith('专用')) return 'Private';
    return 'Public';
  }
  return null;
}

/** 解析 `netsh advfirewall show allprofiles state` 中生效配置的开关 */
export function parseFirewallOn(raw: string, activeProfile: string): boolean | null {
  // 输出形如:  "Public Profile Settings:\nState   ON"
  const sections = raw.split(/(?=(?:Domain|Private|Public)\s+Profile\s+Settings)/i);
  for (const section of sections) {
    const profileMatch = /(Domain|Private|Public)\s+Profile\s+Settings/i.exec(section);
    if (!profileMatch || !profileMatch[1]) continue;
    if (profileMatch[1].toLowerCase() !== activeProfile.toLowerCase()) continue;
    const stateMatch = /State\s+(\w+)/i.exec(section);
    if (stateMatch && stateMatch[1]) return stateMatch[1].toUpperCase() === 'ON';
  }
  return null;
}
