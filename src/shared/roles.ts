/**
 * 角色与版型定义 —— 纯数据，无任何运行时依赖。
 * 这份文件未来会被微信小程序客户端直接复用，所以不要引入 Node/DOM API。
 */

export type Role =
  | 'WOLF' // 狼人
  | 'WOLF_KING' // 白狼王
  | 'MECHANICAL_WOLF' // 机械狼
  | 'MASK' // 假面
  | 'VILLAGER' // 平民
  | 'HYBRID' // 混血儿
  | 'SEER' // 预言家
  | 'SPIRIT_SEER' // 通灵师
  | 'WITCH' // 女巫
  | 'HUNTER' // 猎人
  | 'IDIOT' // 白痴
  | 'GUARD' // 守卫
  | 'DANCER'; // 舞者

/** 阵营 */
export type Camp = 'WOLF' | 'GOOD';

export const ROLE_CAMP: Record<Role, Camp> = {
  WOLF: 'WOLF',
  WOLF_KING: 'WOLF',
  MECHANICAL_WOLF: 'WOLF',
  MASK: 'WOLF',
  VILLAGER: 'GOOD',
  HYBRID: 'GOOD',
  SEER: 'GOOD',
  SPIRIT_SEER: 'GOOD',
  WITCH: 'GOOD',
  HUNTER: 'GOOD',
  IDIOT: 'GOOD',
  GUARD: 'GOOD',
  DANCER: 'GOOD',
};

export const ROLE_NAME: Record<Role, string> = {
  WOLF: '狼人',
  WOLF_KING: '白狼王',
  MECHANICAL_WOLF: '机械狼',
  MASK: '假面',
  VILLAGER: '平民',
  HYBRID: '混血儿',
  SEER: '预言家',
  SPIRIT_SEER: '通灵师',
  WITCH: '女巫',
  HUNTER: '猎人',
  IDIOT: '白痴',
  GUARD: '守卫',
  DANCER: '舞者',
};

export const ROLE_DESC: Record<Role, string> = {
  WOLF: '每晚与狼队友共同决定刀掉一名玩家。白天伪装成好人，投票放逐好人。',
  WOLF_KING:
    '属于狼人阵营，夜里和狼人一起刀人。白天可以自爆并带走一名玩家（自爆后立刻进入黑夜，当天不再投票）。',
  MECHANICAL_WOLF:
    '不与普通狼人互认。整局可学习一名玩家的具体身份，从下一夜起继承其核心技能；学习狼人后加入狼刀，学习白狼王不继承自爆，学习女巫只继承一瓶毒药。',
  MASK:
    '不与普通狼人互认。第二夜起先查一人是否在当夜舞池，再给一名玩家戴面具；面具只会反转舞池结算阵营。普通狼人全部出局后，从下一次狼刀阶段起继承刀权。',
  VILLAGER: '没有技能。靠发言和推理找出狼人，用投票把他们放逐出局。',
  HYBRID:
    '首夜选择一名榜样但不知道其身份，个人胜负跟随榜样阵营；预言家查验始终显示为好人。',
  SEER: '每晚查验一名玩家的阵营，得知其是好人还是狼人。是好人阵营的核心信息位。',
  SPIRIT_SEER: '每晚查验一名玩家的具体身份，而不只是好人或狼人。',
  WITCH: '拥有一瓶解药和一瓶毒药，各只能使用一次。同一夜不能同时使用两瓶药。',
  HUNTER: '被狼人杀死或被投票放逐时，可以开枪带走一名玩家。被女巫毒死、被白狼王带走时不能开枪。',
  IDIOT: '被投票放逐时翻牌自证，不会死亡，但从此失去投票权。夜里被杀则正常死亡。',
  GUARD: '每晚守护一名玩家，使其免疫狼人的刀。不能连续两晚守护同一人。守护挡不住女巫的毒药。',
  DANCER:
    '第二夜起每晚选择三名从未进入过舞池的存活玩家。三人阵营为 2 比 1 时，少数阵营玩家出局；若舞者自己入池，三人当夜免疫狼刀。',
};

export const CAMP_NAME: Record<Camp, string> = {
  WOLF: '狼人阵营',
  GOOD: '好人阵营',
};

/** 配置界面上的展示顺序：先狼营，再平民，最后神职 */
export const ROLE_DISPLAY_ORDER: readonly Role[] = [
  'WOLF',
  'WOLF_KING',
  'MECHANICAL_WOLF',
  'MASK',
  'VILLAGER',
  'HYBRID',
  'SEER',
  'SPIRIT_SEER',
  'WITCH',
  'HUNTER',
  'IDIOT',
  'GUARD',
  'DANCER',
];

export const ALL_ROLES: readonly Role[] = ROLE_DISPLAY_ORDER;

/** 神职（用于「屠边」胜利判定：神全灭 或 民全灭 → 狼人胜） */
export const GOD_ROLES: readonly Role[] = ['SEER', 'SPIRIT_SEER', 'WITCH', 'HUNTER', 'IDIOT', 'GUARD', 'DANCER'];

/** 狼人阵营的角色（白狼王算狼，屠边时按狼算） */
export const WOLF_ROLES: readonly Role[] = ['WOLF', 'WOLF_KING', 'MECHANICAL_WOLF', 'MASK'];

export function isGod(role: Role): boolean {
  return GOD_ROLES.includes(role);
}

export function isWolfRole(role: Role): boolean {
  return WOLF_ROLES.includes(role);
}

/**
 * 只能有 1 个的角色（配置界面用勾选）。
 * 注意：这只是**配置界面**的限制，引擎本身不关心数量。
 */
export const SINGLE_ROLES: readonly Role[] = [
  'SEER',
  'SPIRIT_SEER',
  'WITCH',
  'HUNTER',
  'IDIOT',
  'GUARD',
  'WOLF_KING',
  'MECHANICAL_WOLF',
  'HYBRID',
  'MASK',
  'DANCER',
];

/** 可以有多个的角色（配置界面用 +/- 调数量） */
export const COUNTED_ROLES: readonly Role[] = ['WOLF', 'VILLAGER'];

// ────────────────────────── 版型配置 ──────────────────────────

export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 18;
export const DEFAULT_PLAYER_COUNT = 12;

export interface BoardConfig {
  /** 目标人数 */
  playerCount: number;
  /** 每个角色的数量 */
  roles: Record<Role, number>;
}

export function emptyRoles(): Record<Role, number> {
  const out = {} as Record<Role, number>;
  for (const role of ALL_ROLES) out[role] = 0;
  return out;
}

export function makeBoard(playerCount: number, roles: Partial<Record<Role, number>>): BoardConfig {
  return { playerCount, roles: { ...emptyRoles(), ...roles } };
}

/** 当前配置里的角色总数 */
export function boardTotal(board: BoardConfig): number {
  let sum = 0;
  for (const role of ALL_ROLES) sum += board.roles[role] ?? 0;
  return sum;
}

/** 把一个角色数量展开成完整牌堆（发给引擎发牌用） */
export function boardToDeck(board: BoardConfig): Role[] {
  const deck: Role[] = [];
  // 按展示顺序展开，保证测试与复盘时顺序稳定可预期
  for (const role of ROLE_DISPLAY_ORDER) {
    const count = board.roles[role] ?? 0;
    for (let i = 0; i < count; i++) deck.push(role);
  }
  return deck;
}

export type BoardIssueLevel = 'error' | 'warn';

export interface BoardIssue {
  level: BoardIssueLevel;
  message: string;
}

/**
 * 校验版型。error 会阻止开局，warn 只是提示。
 *
 * 最关键的一条是「角色总数必须恰好等于人数」——
 * 需求明确要求少了或多了都不能开局，并且要提示房主差多少。
 */
export function validateBoard(board: BoardConfig): BoardIssue[] {
  const issues: BoardIssue[] = [];
  const total = boardTotal(board);

  if (
    !Number.isInteger(board.playerCount) ||
    board.playerCount < MIN_PLAYERS ||
    board.playerCount > MAX_PLAYERS
  ) {
    issues.push({
      level: 'error',
      message: `人数必须是 ${MIN_PLAYERS}-${MAX_PLAYERS} 之间的整数，当前是 ${board.playerCount}`,
    });
  }

  for (const role of ALL_ROLES) {
    const count = board.roles[role] ?? 0;
    if (!Number.isInteger(count) || count < 0) {
      issues.push({ level: 'error', message: `${ROLE_NAME[role]} 的数量必须是非负整数` });
      continue;
    }
    if (SINGLE_ROLES.includes(role) && count > 1) {
      issues.push({
        level: 'error',
        message: `${ROLE_NAME[role]} 最多只能选 1 个（当前 ${count} 个）`,
      });
    }
    if (count > MAX_PLAYERS) {
      issues.push({ level: 'error', message: `${ROLE_NAME[role]} 的数量不能超过 ${MAX_PLAYERS}` });
    }
  }

  const wolves =
    (board.roles.WOLF ?? 0) +
    (board.roles.WOLF_KING ?? 0) +
    (board.roles.MECHANICAL_WOLF ?? 0) +
    (board.roles.MASK ?? 0);
  const good = total - wolves;

  if (total !== board.playerCount) {
    const diff = board.playerCount - total;
    issues.push({
      level: 'error',
      message:
        diff > 0
          ? `角色总数是 ${total} 人，比目标人数少了 ${diff} 人 —— 还需要添加 ${diff} 个角色`
          : `角色总数是 ${total} 人，比目标人数多了 ${-diff} 人 —— 需要减少 ${-diff} 个角色`,
    });
  }

  if (total > 0 && wolves === 0) {
    issues.push({ level: 'error', message: '至少要有一名狼人阵营角色' });
  }
  if (total > 0 && good === 0) {
    issues.push({ level: 'error', message: '至少要有一名好人阵营角色' });
  }

  // 平衡性建议：只提示，不阻止开局
  if (total > 0 && wolves > 0 && good > 0) {
    const ratio = wolves / total;
    if (ratio > 0.45) {
      issues.push({
        level: 'warn',
        message: `狼人占比 ${Math.round(ratio * 100)}% 偏高（${wolves} 狼 / ${good} 好人），好人会很难打`,
      });
    } else if (ratio < 0.2) {
      issues.push({
        level: 'warn',
        message: `只有 ${wolves} 名狼人（好人 ${good} 名），狼人几乎没有胜算`,
      });
    }
  }

  return issues;
}

export function boardErrors(board: BoardConfig): BoardIssue[] {
  return validateBoard(board).filter((i) => i.level === 'error');
}

export function boardWarnings(board: BoardConfig): BoardIssue[] {
  return validateBoard(board).filter((i) => i.level === 'warn');
}

/** 版型摘要文案，例如「4 狼人 · 4 平民 · 预言家 · 女巫 · 猎人 · 白痴」 */
export function boardSummary(board: BoardConfig): string {
  const parts: string[] = [];

  for (const role of COUNTED_ROLES) {
    const count = board.roles[role] ?? 0;
    if (count > 0) parts.push(`${count} ${ROLE_NAME[role]}`);
  }

  const singles = SINGLE_ROLES.filter((r) => (board.roles[r] ?? 0) > 0).map((r) => ROLE_NAME[r]);
  if (singles.length > 0) parts.push(singles.join(' · '));

  if (parts.length === 0) return '（还没有配置任何角色）';
  return parts.join(' · ');
}

// ────────────────────────── 预设版型 ──────────────────────────

export interface BoardPreset {
  id: string;
  name: string;
  note: string;
  board: BoardConfig;
}

export const BOARD_PRESETS: readonly BoardPreset[] = [
  {
    id: '12-mask-ball',
    name: '12人 · 假面舞会',
    note: '舞者组建舞池，假面暗中反转舞池阵营',
    board: makeBoard(12, {
      WOLF: 3,
      MASK: 1,
      VILLAGER: 4,
      SEER: 1,
      WITCH: 1,
      IDIOT: 1,
      DANCER: 1,
    }),
  },
  {
    id: '13-hybrid',
    name: '13人 · 预女猎白混',
    note: '标准预女猎白加入混血儿，首夜选择榜样',
    board: makeBoard(13, {
      WOLF: 4,
      VILLAGER: 4,
      HYBRID: 1,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      IDIOT: 1,
    }),
  },
  {
    id: '12-mechanical-spirit',
    name: '12人 · 机械狼通灵师',
    note: '机械狼学习身份并继承技能，通灵师查验具体身份',
    board: makeBoard(12, {
      WOLF: 3,
      MECHANICAL_WOLF: 1,
      VILLAGER: 4,
      SPIRIT_SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      GUARD: 1,
    }),
  },
  {
    id: '12-classic-white-idiot',
    name: '12人 · 预女猎白',
    note: '最经典的标准局',
    board: makeBoard(12, { WOLF: 4, VILLAGER: 4, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1 }),
  },
  {
    id: '12-guard',
    name: '12人 · 预女猎守',
    note: '用守卫替换白痴，博弈更深',
    board: makeBoard(12, { WOLF: 4, VILLAGER: 4, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1 }),
  },
  {
    id: '12-wolf-king',
    name: '12人 · 白狼王局',
    note: '狼队多一个能白天自爆带人的白狼王',
    board: makeBoard(12, {
      WOLF: 3,
      WOLF_KING: 1,
      VILLAGER: 4,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      GUARD: 1,
    }),
  },
  {
    id: '12-full-gods',
    name: '12人 · 五神全开',
    note: '预言家/女巫/猎人/白痴/守卫 对 4 狼 3 民',
    board: makeBoard(12, {
      WOLF: 4,
      VILLAGER: 3,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      IDIOT: 1,
      GUARD: 1,
    }),
  },
  {
    id: '10-standard',
    name: '10人 · 标准局',
    note: '3 狼 4 民 + 预言家 / 女巫 / 猎人',
    board: makeBoard(10, { WOLF: 3, VILLAGER: 4, SEER: 1, WITCH: 1, HUNTER: 1 }),
  },
  {
    id: '8-small',
    name: '8人 · 小局',
    note: '人少也能玩，节奏很快',
    board: makeBoard(8, { WOLF: 2, VILLAGER: 3, SEER: 1, WITCH: 1, HUNTER: 1 }),
  },
];

export function presetById(id: string): BoardPreset | undefined {
  return BOARD_PRESETS.find((p) => p.id === id);
}

/** 默认版型：12 人预女猎白 */
export function defaultBoard(): BoardConfig {
  const preset = BOARD_PRESETS.find((entry) => entry.id === '12-classic-white-idiot')!;
  return { playerCount: preset.board.playerCount, roles: { ...preset.board.roles } };
}

export function cloneBoard(board: BoardConfig): BoardConfig {
  return { playerCount: board.playerCount, roles: { ...board.roles } };
}

// ────────────────────────── 夜晚行动顺序 ──────────────────────────

/**
 * 完整特殊板的夜晚角色顺序：混血儿（仅首夜）→ 机械狼 → 舞者 → 假面 → 守卫/狼人 → 女巫 → 预言家 → 通灵师。
 *
 * 实际流程由 engine.nightSequence() 按公开板子生成；不含机械狼的旧板继续保持
 * 狼人 → 守卫 → 女巫 → 预言家的既有顺序。
 */
export const NIGHT_ORDER: readonly Role[] = [
  'HYBRID',
  'MECHANICAL_WOLF',
  'DANCER',
  'MASK',
  'GUARD',
  'WOLF',
  'WITCH',
  'SEER',
  'SPIRIT_SEER',
];
