/**
 * 角色与板子定义 —— 纯数据，无任何运行时依赖。
 * 这份文件未来会被微信小程序客户端直接复用，所以不要引入 Node/DOM API。
 */

export type Role = 'WOLF' | 'VILLAGER' | 'SEER' | 'WITCH' | 'HUNTER' | 'IDIOT';

/** 阵营 */
export type Camp = 'WOLF' | 'GOOD';

export const ROLE_CAMP: Record<Role, Camp> = {
  WOLF: 'WOLF',
  VILLAGER: 'GOOD',
  SEER: 'GOOD',
  WITCH: 'GOOD',
  HUNTER: 'GOOD',
  IDIOT: 'GOOD',
};

export const ROLE_NAME: Record<Role, string> = {
  WOLF: '狼人',
  VILLAGER: '平民',
  SEER: '预言家',
  WITCH: '女巫',
  HUNTER: '猎人',
  IDIOT: '白痴',
};

export const ROLE_DESC: Record<Role, string> = {
  WOLF: '每晚与狼队友共同决定刀掉一名玩家。白天伪装成好人，投票放逐好人。',
  VILLAGER: '没有技能。靠发言和推理找出狼人，用投票把他们放逐出局。',
  SEER: '每晚查验一名玩家的阵营，得知其是好人还是狼人。是好人阵营的核心信息位。',
  WITCH: '拥有一瓶解药和一瓶毒药，各只能使用一次。同一夜不能同时使用两瓶药。',
  HUNTER: '被狼人杀死或被投票放逐时，可以开枪带走一名玩家。被女巫毒死时无法开枪。',
  IDIOT: '被投票放逐时翻牌自证，不会死亡，但从此失去投票权。夜里被杀则正常死亡。',
};

export const CAMP_NAME: Record<Camp, string> = {
  WOLF: '狼人阵营',
  GOOD: '好人阵营',
};

/** 神职（用于「屠边」胜利判定：神全死 或 民全死 → 狼人胜） */
export const GOD_ROLES: readonly Role[] = ['SEER', 'WITCH', 'HUNTER', 'IDIOT'];

export function isGod(role: Role): boolean {
  return GOD_ROLES.includes(role);
}

export const PLAYER_COUNT = 12;

/** 12 人标准板子：4 狼 + 4 民 + 预言家/女巫/猎人/白痴 */
export const BOARD_12: readonly Role[] = [
  'WOLF',
  'WOLF',
  'WOLF',
  'WOLF',
  'VILLAGER',
  'VILLAGER',
  'VILLAGER',
  'VILLAGER',
  'SEER',
  'WITCH',
  'HUNTER',
  'IDIOT',
];

export const BOARD_12_NAME = '预女猎白';

export const BOARD_12_SUMMARY = '4 狼人 · 4 平民 · 预言家 · 女巫 · 猎人 · 白痴';

/** 夜晚行动顺序（按需求：狼人 → 女巫 → 预言家） */
export const NIGHT_ORDER: readonly Role[] = ['WOLF', 'WITCH', 'SEER'];
