/**
 * 角色与版型定义 —— 纯数据，无任何运行时依赖。
 * 这份文件未来会被微信小程序客户端直接复用，所以不要引入 Node/DOM API。
 */

export type Role =
  | 'WOLF' // 狼人
  | 'WOLF_KING' // 白狼王
  | 'BLACK_WOLF_KING' // 狼王（死亡后开枪，俗称黑狼王）
  | 'MECHANICAL_WOLF' // 机械狼
  | 'MASK' // 假面
  | 'WOLF_BEAUTY' // 狼美人（刀完人再独自魅惑，死后带人殉情）
  | 'DARK_LORD' // 恶灵骑士（夜间免疫死亡 + 一次性反伤）
  | 'VILLAGER' // 平民
  | 'HYBRID' // 混血儿
  | 'SEER' // 预言家
  | 'SPIRIT_SEER' // 通灵师
  | 'WITCH' // 女巫
  | 'HUNTER' // 猎人
  | 'IDIOT' // 白痴
  | 'GUARD' // 守卫
  | 'DREAMER' // 摄梦人
  | 'DANCER' // 舞者
  | 'GRAVE_KEEPER' // 守墓人
  | 'KNIGHT'; // 骑士

/** 阵营 */
export type Camp = 'WOLF' | 'GOOD';

export const ROLE_CAMP: Record<Role, Camp> = {
  WOLF: 'WOLF',
  WOLF_KING: 'WOLF',
  BLACK_WOLF_KING: 'WOLF',
  MECHANICAL_WOLF: 'WOLF',
  MASK: 'WOLF',
  WOLF_BEAUTY: 'WOLF',
  DARK_LORD: 'WOLF',
  VILLAGER: 'GOOD',
  HYBRID: 'GOOD',
  SEER: 'GOOD',
  SPIRIT_SEER: 'GOOD',
  WITCH: 'GOOD',
  HUNTER: 'GOOD',
  IDIOT: 'GOOD',
  GUARD: 'GOOD',
  DREAMER: 'GOOD',
  DANCER: 'GOOD',
  GRAVE_KEEPER: 'GOOD',
  KNIGHT: 'GOOD',
};

export const ROLE_NAME: Record<Role, string> = {
  WOLF: '狼人',
  WOLF_KING: '白狼王',
  BLACK_WOLF_KING: '狼王',
  MECHANICAL_WOLF: '机械狼',
  MASK: '假面',
  WOLF_BEAUTY: '狼美人',
  DARK_LORD: '恶灵骑士',
  VILLAGER: '平民',
  HYBRID: '混血儿',
  SEER: '预言家',
  SPIRIT_SEER: '通灵师',
  WITCH: '女巫',
  HUNTER: '猎人',
  IDIOT: '白痴',
  GUARD: '守卫',
  DREAMER: '摄梦人',
  DANCER: '舞者',
  GRAVE_KEEPER: '守墓人',
  KNIGHT: '骑士',
};

export const ROLE_DESC: Record<Role, string> = {
  WOLF:
    '每晚与狼队友共同决定刀掉一名玩家。白天伪装成好人，投票放逐好人；也可以空爆（不带人自爆，自爆后立刻进入黑夜，当天不再发言与投票）。警长竞选期间自爆会终止竞选，本局警徽流失。点开身份牌后卡内有自爆按钮。',
  WOLF_KING:
    '属于狼人阵营，夜里和狼人一起刀人。白天可以自爆并带走一名玩家（自爆后立刻进入黑夜，当天不再投票）；警长竞选期间自爆会终止竞选，本局警徽流失。点开身份牌后卡内有自爆按钮。',
  BLACK_WOLF_KING:
    '属于狼人阵营，夜里和狼人一起刀人。被投票放逐、被狼人杀死或被猎人开枪带走时，可以开枪带走一名存活玩家；被毒杀、舞池结算或白狼王带走时不能开枪。',
  MECHANICAL_WOLF:
    '不与普通狼人互认。整局可学习一名玩家的具体身份，从下一夜起继承其核心技能；学习狼人后加入狼刀，学习白狼王不继承自爆，学习女巫只继承一瓶毒药。',
  MASK:
    '不与普通狼人互认。第二夜起先查一人是否在当夜舞池，再给一名玩家戴面具；面具只会反转舞池结算阵营。普通狼人全部出局后，从下一次狼刀阶段起继承刀权。',
  WOLF_BEAUTY:
    '属于狼人阵营，与狼人互认，夜里和狼队一起睁眼参与点刀；刀完之后再独自睁眼魅惑一名玩家。她以任何方式被淘汰时（被骑士决斗而死除外），前一晚被她魅惑的玩家会殉情，且殉情者不能发动技能。不能被狼队自刀、不能自爆。',
  DARK_LORD:
    '属于狼人阵营，与狼人互认，夜里和狼队一起睁眼参与点刀。夜里不会死亡：狼刀、毒药、舞池、摄梦对他全部无效。并且拥有一次性反伤 —— 女巫毒他、预言家或通灵师查验他，对方会当场死亡；同一夜有多人对他动手时，只有先行动的那个人遭到反伤。白天被投票放逐、被白狼王带走会正常出局。不能被狼队自刀、不能自爆。',
  VILLAGER: '没有技能。靠发言和推理找出狼人，用投票把他们放逐出局。',
  HYBRID:
    '首夜选择一名榜样但不知道其身份，个人胜负跟随榜样阵营；预言家查验始终显示为好人。',
  SEER: '每晚查验一名玩家的阵营，得知其是好人还是狼人。是好人阵营的核心信息位。',
  SPIRIT_SEER: '每晚查验一名玩家的具体身份，而不只是好人或狼人。',
  WITCH: '拥有一瓶解药和一瓶毒药，各只能使用一次。同一夜不能同时使用两瓶药。',
  HUNTER: '被狼人杀死、被投票放逐或被狼王开枪带走时，可以开枪带走一名玩家。被女巫毒死、被摄梦人带走或被白狼王带走时不能开枪。',
  IDIOT: '被投票放逐时翻牌自证，不会死亡，但从此失去投票权。夜里被杀则正常死亡。',
  GUARD: '每晚守护一名玩家，使其免疫狼人的刀。不能连续两晚守护同一人。守护挡不住女巫的毒药。',
  DREAMER:
    '每晚必须选择另一名存活玩家成为梦游者。梦游者当夜免疫夜间伤害；连续两晚梦同一人，该玩家出局；摄梦人夜里死亡时，梦游者一同出局。',
  DANCER:
    '第二夜起每晚选择三名从未进入过舞池的存活玩家。三人阵营为 2 比 1 时，少数阵营玩家出局；若舞者自己入池，三人当夜免疫狼刀。',
  GRAVE_KEEPER:
    '第二夜起，每晚得知当天白天被投票放逐的那名玩家是好人还是狼人（混血儿验为好人）。白天无人被放逐时则无信息。放逐结果是公开的，但他验出的阵营只有他自己知道。',
  KNIGHT:
    '白天发言阶段可以翻牌向一名玩家发起决斗：对方是狼人则当场出局，是好人则你自己出局。整局只能发动一次；决斗出局不触发猎人、狼王的开枪，也不会引发狼美人殉情；决斗后当天的发言和投票照常进行。',
};

export const CAMP_NAME: Record<Camp, string> = {
  WOLF: '狼人阵营',
  GOOD: '好人阵营',
};

/** 配置界面上的展示顺序：先狼营，再平民，最后神职 */
export const ROLE_DISPLAY_ORDER: readonly Role[] = [
  'WOLF',
  'WOLF_KING',
  'BLACK_WOLF_KING',
  'MECHANICAL_WOLF',
  'MASK',
  'WOLF_BEAUTY',
  'DARK_LORD',
  'VILLAGER',
  'HYBRID',
  'SEER',
  'SPIRIT_SEER',
  'WITCH',
  'HUNTER',
  'IDIOT',
  'GUARD',
  'DREAMER',
  'DANCER',
  'GRAVE_KEEPER',
  'KNIGHT',
];

export const ALL_ROLES: readonly Role[] = ROLE_DISPLAY_ORDER;

/** 神职（用于「屠边」胜利判定：神全灭 或 民全灭 → 狼人胜） */
export const GOD_ROLES: readonly Role[] = [
  'SEER',
  'SPIRIT_SEER',
  'WITCH',
  'HUNTER',
  'IDIOT',
  'GUARD',
  'DREAMER',
  'DANCER',
  'GRAVE_KEEPER',
  'KNIGHT',
];

/** 狼人阵营的角色（白狼王算狼，屠边时按狼算） */
export const WOLF_ROLES: readonly Role[] = [
  'WOLF',
  'WOLF_KING',
  'BLACK_WOLF_KING',
  'MECHANICAL_WOLF',
  'MASK',
  'WOLF_BEAUTY',
  'DARK_LORD',
];

/**
 * **不能被狼刀**的狼人阵营角色。
 *
 * 狼美人和恶灵骑士官方都规定「不能自刀」—— 也就是狼队不能把刀口指向他们。
 * 这不只是礼节：狼美人的价值在于活到关键回合带人殉情，恶灵骑士的价值在于
 * 消耗好人的毒药和查验，被自己队友一刀带走就全废了。
 */
export const KNIFE_EXEMPT_ROLES: readonly Role[] = ['WOLF_BEAUTY', 'DARK_LORD'];

export function canBeKnifed(role: Role): boolean {
  return !KNIFE_EXEMPT_ROLES.includes(role);
}

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
  'BLACK_WOLF_KING',
  'MECHANICAL_WOLF',
  'HYBRID',
  'MASK',
  'DREAMER',
  'DANCER',
  'WOLF_BEAUTY',
  'DARK_LORD',
  'GRAVE_KEEPER',
  'KNIGHT',
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
  /**
   * 「唯邻是从」专属：首夜狼队要选一名**傀儡**。
   *
   * 为什么做成版型开关而不是加一个角色：傀儡没有自己的底牌 ——
   * 他是被暗中改了阵营的**好人**（预言家/女巫/猎人/守卫/平民之一），
   * 所以没法用「有个傀儡角色」来表达。这个开关才是这个板子的真正标识。
   */
  puppet?: boolean;
}

export function emptyRoles(): Record<Role, number> {
  const out = {} as Record<Role, number>;
  for (const role of ALL_ROLES) out[role] = 0;
  return out;
}

export function makeBoard(
  playerCount: number,
  roles: Partial<Record<Role, number>>,
  extra: Partial<Omit<BoardConfig, 'playerCount' | 'roles'>> = {},
): BoardConfig {
  return { playerCount, roles: { ...emptyRoles(), ...roles }, ...extra };
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

  // 遍历 WOLF_ROLES 而不是手写清单 —— 手写的那版在加了狼美人/恶灵骑士之后
  // 就会漏算，导致「狼人占比」这条平衡性提示给出错误的百分比。
  let wolves = 0;
  for (const role of WOLF_ROLES) wolves += board.roles[role] ?? 0;
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

// ────────────────────── 夜间入场顺序（唯一真相源） ──────────────────────

/**
 * 本夜需要**依次睁眼**的角色顺序。
 *
 * 这是夜间顺序的**唯一真相源**：引擎推进夜晚用它，自定义版型界面显示
 * 「入场时间」也用它。两边共用一份数据，就不可能「界面写的是第 5 个、
 * 实际跑的是第 7 个」—— 那种错在 12 人局里根本没人能当场发现。
 *
 * 三条铁律：
 *  ① 只看**公开的板子配置**和天数，绝不看任何人的死活 ——
 *     否则阶段消失/出现本身就是「那个角色死没死」的广播。
 *  ② 顺序一旦定下就固定，不能因为「该角色没行动」而跳过它的环节。
 *  ③ 改这里必须同时跑 `engine.test.ts` 里那条「顺序表与引擎实际推进一致」的测试。
 */
export function nightOrderFor(boardRoles: readonly Role[], day: number): Role[] {
  const has = (role: Role): boolean => boardRoles.includes(role);
  const out: Role[] = [];

  if (day === 1 && has('HYBRID')) out.push('HYBRID');
  if (has('MECHANICAL_WOLF')) out.push('MECHANICAL_WOLF');
  // 舞者和假面首夜都不行动，从第二夜开始固定为舞者 → 假面
  if (day >= 2 && has('DANCER')) out.push('DANCER');
  if (day >= 2 && has('MASK')) out.push('MASK');
  if (has('DREAMER')) out.push('DREAMER');

  if (has('MECHANICAL_WOLF')) {
    // 机械狼板采用「守卫 → 狼刀」的固定顺序
    if (has('GUARD')) out.push('GUARD');
    out.push('WOLF');
    // 狼美人：和狼队一起刀完，**再独自睁眼**魅惑
    if (has('WOLF_BEAUTY')) out.push('WOLF_BEAUTY');
  } else {
    // 普通板保持原来的「狼刀 → 守卫」
    out.push('WOLF');
    if (has('WOLF_BEAUTY')) out.push('WOLF_BEAUTY');
    if (has('GUARD')) out.push('GUARD');
  }

  if (has('WITCH')) out.push('WITCH');
  if (has('SEER')) out.push('SEER');
  if (has('SPIRIT_SEER')) out.push('SPIRIT_SEER');
  // 守墓人从第二夜起才睁眼（首夜还没有「昨天被放逐的人」可查），
  // 排在全部查验类之后 —— 他验的是已经公开发生的事，早晚都不影响信息本身。
  if (day >= 2 && has('GRAVE_KEEPER')) out.push('GRAVE_KEEPER');
  return out;
}

/** 某个角色在夜里的「入场方式」 */
export type NightTiming =
  | 'EVERY_NIGHT' // 每晚都睁眼
  | 'FIRST_NIGHT_ONLY' // 只在首夜睁眼
  | 'FROM_SECOND_NIGHT' // 第二夜起才睁眼
  | 'PASSIVE' // 不单独睁眼，但技能在夜间生效
  | 'NO_NIGHT_ACTION'; // 夜里完全没有戏份

export interface NightSlot {
  role: Role;
  roleName: string;
  timing: NightTiming;
  /** 第一夜里的序号（1 开始）；不在第一夜则为 null */
  firstNightSlot: number | null;
  /** 第二夜起的序号（1 开始）；不在常规夜晚则为 null */
  laterNightSlot: number | null;
  detail: string;
}

export interface NightPlan {
  /** 第一夜的完整睁眼顺序 */
  firstNight: Role[];
  /** 第二夜起的完整睁眼顺序 */
  laterNights: Role[];
  /** 按「第二夜起」的顺序排好的逐角色说明（被动/无夜间行动排在最后） */
  slots: NightSlot[];
}

/** 夜间技能生效但**不单独睁眼**的角色 */
const PASSIVE_NIGHT_ROLES: readonly Role[] = ['DARK_LORD'];

function timingDetail(role: Role, timing: NightTiming, slot: number | null): string {
  switch (timing) {
    case 'FIRST_NIGHT_ONLY':
      return `只在天黑后的第 ${slot} 个环节睁眼（仅第一夜）`;
    case 'FROM_SECOND_NIGHT':
      return `从第二夜起，第 ${slot} 个环节睁眼`;
    case 'EVERY_NIGHT':
      return `每晚第 ${slot} 个环节睁眼`;
    case 'PASSIVE':
      return '不单独睁眼，但技能整夜生效（跟着狼刀一起结算）';
    case 'NO_NIGHT_ACTION':
      return role === 'HUNTER'
        ? '夜里没有环节；只在出局时（特定死因除外）触发开枪'
        : role === 'KNIGHT'
          ? '夜里没有环节；白天发言阶段可以翻牌决斗（整局一次）'
          : '夜里没有环节';
  }
}

/**
 * 把版型翻译成「谁在第几个环节睁眼」。
 *
 * 自定义版型界面靠它显示入场时间；玩家选了「狼美人」之后应该能立刻看到
 * 「第 6 个环节，在狼刀之后睁眼」，而不是开局后靠猜。
 */
export function nightPlan(board: BoardConfig): NightPlan {
  const deck = boardToDeck(board);
  const firstNight = nightOrderFor(deck, 1);
  const laterNights = nightOrderFor(deck, 2);

  const selected = ROLE_DISPLAY_ORDER.filter((role) => (board.roles[role] ?? 0) > 0);

  const slots: NightSlot[] = selected.map((role) => {
    const inFirst = firstNight.indexOf(role);
    const inLater = laterNights.indexOf(role);
    let timing: NightTiming;
    if (inFirst >= 0 && inLater >= 0) timing = 'EVERY_NIGHT';
    else if (inFirst >= 0) timing = 'FIRST_NIGHT_ONLY';
    else if (inLater >= 0) timing = 'FROM_SECOND_NIGHT';
    else if (PASSIVE_NIGHT_ROLES.includes(role)) timing = 'PASSIVE';
    else timing = 'NO_NIGHT_ACTION';

    const slot = inLater >= 0 ? inLater + 1 : inFirst >= 0 ? inFirst + 1 : null;
    return {
      role,
      roleName: ROLE_NAME[role],
      timing,
      firstNightSlot: inFirst >= 0 ? inFirst + 1 : null,
      laterNightSlot: inLater >= 0 ? inLater + 1 : null,
      detail: timingDetail(role, timing, slot),
    };
  });

  // 排序：先按常规夜晚的环节，再按首夜独有的环节，最后是被动 / 无夜间行动
  slots.sort((a, b) => {
    const rank = (s: NightSlot): number =>
      s.laterNightSlot ?? (s.firstNightSlot !== null ? 100 + s.firstNightSlot : 200);
    return rank(a) - rank(b);
  });

  return { firstNight, laterNights, slots };
}

/** 一行文字版，方便日志和文档引用 */
export function nightPlanSummary(board: BoardConfig): string {
  const plan = nightPlan(board);
  const line = (roles: readonly Role[]): string =>
    roles.length === 0
      ? '（没有角色在夜里睁眼）'
      : roles.map((r, i) => `${i + 1}.${ROLE_NAME[r]}`).join(' → ');
  return `第一夜：${line(plan.firstNight)}\n第二夜起：${line(plan.laterNights)}`;
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
    id: '12-hybrid',
    name: '12人 · 预女猎白混',
    note: '混血儿替掉一个平民，首夜选择榜样，个人胜负跟随榜样阵营',
    board: makeBoard(12, {
      WOLF: 4,
      VILLAGER: 3,
      HYBRID: 1,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      IDIOT: 1,
    }),
  },
  /**
   * 狼美人局。
   *
   * 平衡思路：狼美人「死后必然带走一个人」，是一张**确定性的换命牌**
   *    —— 比白狼王强，因为白狼王自爆要放弃当天投票、而且必须活着才能炸。
   *   所以这条路给她 4 狼（3 普通 + 她自己），配标准预女猎白。
   * 实测如果狼队赢得太轻松，把 WOLF 降到 2（总狼数 3）即可 —— 那是最直接的一档。
   */
  {
    id: '12-wolf-beauty',
    name: '12人 · 狼美人局',
    note: '狼美人刀完人再独自魅惑，她一出局就带走被魅惑的人',
    board: makeBoard(12, {
      WOLF: 3,
      WOLF_BEAUTY: 1,
      VILLAGER: 4,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      IDIOT: 1,
    }),
  },
  /**
   * 恶灵骑士局。
   *
   * 平衡思路：恶灵骑士夜里杀不死，而且会把**女巫的毒**和**预言家的查验**
   *   反噬回去 —— 好人两个核心技能都变成了带刃的。所以给他配守卫而不是白痴：
   *   好人的信息位和毒药都被威胁了，需要一件纯防御的工具来补偿，
   *   否则好人一旦第一夜验到他，直接少一个信息位、还搭上一条命。
   */
  {
    id: '12-puppet',
    name: '12人 · 唯邻是从',
    note: '首夜狼队从与狼相邻的好人里选一名「傀儡」：他保留原底牌、不知情，但技能全部失效或反转',
    board: makeBoard(12, {
      WOLF: 2,
      BLACK_WOLF_KING: 1,
      VILLAGER: 5,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      GUARD: 1,
    }, { puppet: true }),
  },
  {
    id: '12-dark-lord',
    name: '12人 · 恶灵骑士局',
    note: '恶灵骑士夜里不会死，还会把毒药和查验反噬回去',
    board: makeBoard(12, {
      WOLF: 3,
      DARK_LORD: 1,
      VILLAGER: 4,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      GUARD: 1,
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
    id: '12-black-wolf-king',
    name: '12人 · 狼王守卫',
    note: '狼王死亡后可开枪，和猎人形成双枪博弈',
    board: makeBoard(12, {
      WOLF: 3,
      BLACK_WOLF_KING: 1,
      VILLAGER: 4,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      GUARD: 1,
    }),
  },
  {
    id: '12-wolf-king-dreamer',
    name: '12人 · 狼王摄梦人',
    note: '官方热门板型：摄梦人夜间护人，也可能连续摄梦或随死带人',
    board: makeBoard(12, {
      WOLF: 3,
      BLACK_WOLF_KING: 1,
      VILLAGER: 4,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      DREAMER: 1,
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
  /**
   * 守墓人局。
   *
   * 平衡思路：守墓人是**延迟一拍的信息位** —— 他验的是昨天放逐的人，
   * 好人第二天才知道结果，而且想查谁完全不由自己选。
   * 比预言家弱一档，所以维持 4 狼标准配置，配预女猎 + 守墓人四神。
   */
  {
    id: '12-grave-keeper',
    name: '12人 · 守墓人局',
    note: '守墓人每晚得知昨天被放逐者是好人还是狼人',
    board: makeBoard(12, {
      WOLF: 4,
      VILLAGER: 4,
      SEER: 1,
      WITCH: 1,
      HUNTER: 1,
      GRAVE_KEEPER: 1,
    }),
  },
  /**
   * 骑士局。
   *
   * 平衡思路：骑士是一次**确定性的对赌** —— 押中狼直接处决，押错自己出局，
   * 而且决斗死的人不开枪、不殉情，链路干净。上限高但只有一次，
   * 配 4 狼 + 预女骑三神，把「验-毒-决斗」三个主动点交给好人。
   */
  {
    id: '12-knight',
    name: '12人 · 骑士局',
    note: '骑士白天可翻牌决斗：对方是狼则出局，是好人则自己出局',
    board: makeBoard(12, {
      WOLF: 4,
      VILLAGER: 5,
      SEER: 1,
      WITCH: 1,
      KNIGHT: 1,
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
  return { playerCount: board.playerCount, roles: { ...board.roles }, ...(board.puppet ? { puppet: true } : {}) };
}

// ────────────────────────── 夜晚行动顺序 ──────────────────────────

/**
 * 完整特殊板的夜晚角色顺序：混血儿（仅首夜）→ 机械狼 → 舞者 → 假面 → 摄梦人 → 守卫/狼人 → 女巫 → 预言家 → 通灵师 → 守墓人（第二夜起）。
 *
 * 实际流程由 engine.nightSequence() 按公开板子生成；不含机械狼的旧板继续保持
 * 狼人 → 守卫 → 女巫 → 预言家的既有顺序。
 */
export const NIGHT_ORDER: readonly Role[] = [
  'HYBRID',
  'MECHANICAL_WOLF',
  'DANCER',
  'MASK',
  'DREAMER',
  'GUARD',
  'WOLF',
  'WITCH',
  'SEER',
  'SPIRIT_SEER',
  'GRAVE_KEEPER',
];
