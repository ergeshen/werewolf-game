/**
 * 前后端共用的 WebSocket 消息协议 + 视图类型。
 *
 * 设计要点：
 * 1. 客户端只发送「意图」，全部规则由服务端裁决。
 * 2. 服务端为每个玩家生成**个性化视图**（GameView），预言家只会收到自己验人的结果，
 *    狼人只会收到狼队友的座位，绝不把全局信息下发到客户端 —— 这是防作弊的根本。
 * 3. 协议是纯 JSON，小程序用 wx.connectSocket 可以 1:1 复用，无需任何 polyfill。
 */

import type { BoardConfig, Camp, Role } from './roles.ts';
import type { VoiceCue } from './voice-clips.ts';

export type GameMode = 'STANDARD' | 'HEX_CHAOS';

export const GAME_MODE_LABEL: Record<GameMode, string> = {
  STANDARD: '普通模式',
  HEX_CHAOS: '海克斯大乱斗',
};

// ────────────────────────────── 阶段 ──────────────────────────────

export type Phase =
  | 'WAITING' // 房间等待
  | 'ROLE_REVEAL' // 发牌后查看身份牌、等全员确认（房主按「天黑请闭眼」才进夜晚）
  | 'NIGHT_START' // 天黑请闭眼（过场）
  | 'NIGHT_HYBRID' // 首夜混血儿选择榜样
  | 'NIGHT_MECHANICAL' // 机械狼学习身份
  | 'NIGHT_DANCER' // 舞者选择舞池
  | 'NIGHT_MASK' // 假面查验舞池并戴面具
  | 'NIGHT_DREAMER' // 摄梦人选择梦游者
  | 'NIGHT_WOLVES' // 狼人行动
  | 'NIGHT_BEAUTY_CHARM' // 狼美人：和狼队刀完人之后，独自睁眼魅惑一人
  | 'NIGHT_GUARD' // 守卫守护
  | 'NIGHT_WITCH' // 女巫行动
  | 'NIGHT_SEER' // 预言家行动
  | 'NIGHT_SPIRIT_SEER' // 通灵师查验具体身份
  | 'NIGHT_GRAVE_KEEPER' // 守墓人查看当天被放逐者的阵营（第二夜起）
  | 'NIGHT_RESOLVE' // 夜间结算（过场）
  | 'DAY_ANNOUNCE' // 天亮公布死讯
  | 'SHERIFF_SIGNUP' // 第一天上警报名
  | 'SHERIFF_CAMPAIGN' // 警上竞选发言、退水
  | 'SHERIFF_VOTE' // 警下投票
  | 'SHERIFF_PK' // 警长竞选平票 PK 发言
  | 'SHERIFF_REVOTE' // PK 后重新投票
  | 'DAY_SPEECH' // 警长选择发言方向、全员发言
  | 'DAY_VOTE' // 白天投票
  | 'DAY_EXILE' // 公布放逐结果
  | 'SHERIFF_TRANSFER' // 警长出局后移交或撕毁警徽
  | 'HUNTER_SHOOT' // 猎人开枪
  | 'WOLF_KING_BOOM' // 白狼王自爆后指定要带走的玩家
  | 'GAME_OVER'; // 游戏结束

export const PHASE_LABEL: Record<Phase, string> = {
  WAITING: '等待开局',
  ROLE_REVEAL: '查看身份牌',
  NIGHT_START: '天黑请闭眼',
  NIGHT_HYBRID: '混血儿选择榜样',
  NIGHT_MECHANICAL: '机械狼学习身份',
  NIGHT_DANCER: '舞者选择舞池',
  NIGHT_MASK: '假面行动',
  NIGHT_DREAMER: '摄梦人行动',
  NIGHT_WOLVES: '狼人行动',
  NIGHT_BEAUTY_CHARM: '狼美人魅惑',
  NIGHT_GUARD: '守卫守护',
  NIGHT_WITCH: '女巫行动',
  NIGHT_SEER: '预言家查验',
  NIGHT_SPIRIT_SEER: '通灵师查验',
  NIGHT_GRAVE_KEEPER: '守墓人查看放逐结果',
  NIGHT_RESOLVE: '夜间结算',
  DAY_ANNOUNCE: '天亮了',
  SHERIFF_SIGNUP: '上警报名',
  SHERIFF_CAMPAIGN: '警上竞选发言',
  SHERIFF_VOTE: '警下投票',
  SHERIFF_PK: '警长竞选 PK',
  SHERIFF_REVOTE: 'PK 重新投票',
  DAY_SPEECH: '白天发言',
  DAY_VOTE: '白天投票',
  DAY_EXILE: '放逐结算',
  SHERIFF_TRANSFER: '移交警徽',
  HUNTER_SHOOT: '死亡开枪',
  WOLF_KING_BOOM: '白狼王自爆',
  GAME_OVER: '游戏结束',
};

/**
 * 夜间「角色 → 阶段」的映射。
 *
 * 完整的夜间流程 = `roles.ts` 的 `nightOrderFor()`（角色顺序）
 *                + 这张表（角色翻成引擎阶段名）。
 * 两份数据合起来才是真相，所以都只写一处 —— 引擎推进夜晚和
 * 自定义版型界面显示「入场时间」用的是同一套。
 */
export const NIGHT_PHASE_BY_ROLE: Partial<Record<Role, Phase>> = {
  HYBRID: 'NIGHT_HYBRID',
  MECHANICAL_WOLF: 'NIGHT_MECHANICAL',
  DANCER: 'NIGHT_DANCER',
  MASK: 'NIGHT_MASK',
  DREAMER: 'NIGHT_DREAMER',
  GUARD: 'NIGHT_GUARD',
  WOLF: 'NIGHT_WOLVES',
  WOLF_BEAUTY: 'NIGHT_BEAUTY_CHARM',
  WITCH: 'NIGHT_WITCH',
  SEER: 'NIGHT_SEER',
  SPIRIT_SEER: 'NIGHT_SPIRIT_SEER',
  GRAVE_KEEPER: 'NIGHT_GRAVE_KEEPER',
};

/**
 * 夜间**决定顺序**的这些阶段（不含 NIGHT_START / NIGHT_RESOLVE 两个过场）。
 * 服务端用它判断「哪些阶段要留固定时长 + 倒数」。
 */
export const NIGHT_ROLE_PHASE_LIST: readonly Phase[] = [
  'NIGHT_HYBRID',
  'NIGHT_MECHANICAL',
  'NIGHT_DANCER',
  'NIGHT_MASK',
  'NIGHT_DREAMER',
  'NIGHT_WOLVES',
  'NIGHT_BEAUTY_CHARM',
  'NIGHT_GUARD',
  'NIGHT_WITCH',
  'NIGHT_SEER',
  'NIGHT_SPIRIT_SEER',
  'NIGHT_GRAVE_KEEPER',
];

export type DeathCause =
  | 'WOLF'
  | 'POISON'
  | 'DANCE'
  | 'DREAM'
  | 'VOTE'
  | 'SHOOT'
  | 'EXPLODE'
  | 'BLAST'
  | 'LOVE' // 殉情：被狼美人带走
  | 'REFLECT' // 反伤：毒/验恶灵骑士被反弹
  | 'DUEL'; // 决斗：骑士决斗中出局（目标被处决，或骑士决斗失败自尽）

// ────────────────────────────── 狼队战术标签 ──────────────────────────────

/**
 * 狼队战术分工。只有狼人之间能看到彼此的标签，好人一律看不到。
 *
 * 分三类：
 *  ① **全队唯一**（EXCLUSIVE_WOLF_TAGS）：悍跳位 / 深水 / 倒钩 / 冲锋狼 ——
 *     这些位置一队只可能有一个，第二个人再挂就是配合出岔子，所以直接拒绝。
 *  ② **自由**：上警 —— 想竞选警长的狼可以有好几个。
 *  ③ **两人配对**：狼踩狼 —— 必须两个狼互相指认才成立（见 WolfTagPair）。
 */
export type WolfTag = 'FAKE_SEER' | 'DEEP_WATER' | 'SHERIFF' | 'HOOK' | 'WOLF_VS_WOLF' | 'CHARGER';

export const WOLF_TAG_LABEL: Record<WolfTag, string> = {
  FAKE_SEER: '悍跳位',
  DEEP_WATER: '深水',
  SHERIFF: '上警',
  HOOK: '倒钩',
  WOLF_VS_WOLF: '狼踩狼',
  CHARGER: '冲锋狼',
};

export const WOLF_TAG_DESC: Record<WolfTag, string> = {
  FAKE_SEER: '跳预言家骗好人 —— 全队只能有一个人占这个位置',
  DEEP_WATER: '沉到水底，发言低调不站边，让好人想不起你 —— 全队只能有一个人占',
  SHERIFF: '参与警长竞选（想上警的狼可以不止一个）',
  HOOK: '站边好人、跟着好人投票，藏好自己 —— 全队只能有一个人占',
  WOLF_VS_WOLF: '和一个狼队友互指：一般是悍跳狼去踩另一只狼，用队友的命换自己的身份',
  CHARGER: '强势发言带节奏，冲在最前面 —— 全队只能有一个人占',
};

/** 只能有一个人占的标签（其余标签可以多人同时选） */
export const EXCLUSIVE_WOLF_TAGS: readonly WolfTag[] = [
  'FAKE_SEER',
  'DEEP_WATER',
  'HOOK',
  'CHARGER',
];

/**
 * 需要**两个狼互指**才成立的标签。
 *
 * 用法：1 号挂「狼踩狼」并选 2 号，2 号也挂「狼踩狼」并选 1 号。
 * 两边都填完才算成立，显示为「1 狼踩狼 2」；只有一边填了就标成「2 号还没确认」。
 * 方向可以反过来（2 踩 1 同样成立），而且可以同时存在多组。
 */
export const PAIRED_WOLF_TAGS: readonly WolfTag[] = ['WOLF_VS_WOLF'];

export function isPairedWolfTag(tag: WolfTag): boolean {
  return PAIRED_WOLF_TAGS.includes(tag);
}

export const ALL_WOLF_TAGS: readonly WolfTag[] = [
  'FAKE_SEER',
  'DEEP_WATER',
  'SHERIFF',
  'HOOK',
  'WOLF_VS_WOLF',
  'CHARGER',
];

export function isExclusiveWolfTag(tag: WolfTag): boolean {
  return EXCLUSIVE_WOLF_TAGS.includes(tag);
}

/** 对局结果：DRAW 表示流局（超过最大天数仍未分出胜负的安全阀） */
export type Outcome = 'WOLF' | 'GOOD' | 'DRAW';

export const OUTCOME_LABEL: Record<Outcome, string> = {
  WOLF: '狼人阵营胜利',
  GOOD: '好人阵营胜利',
  DRAW: '流局（本局无人获胜）',
};

export const DEATH_CAUSE_LABEL: Record<DeathCause, string> = {
  WOLF: '被狼人杀害',
  POISON: '被女巫毒杀',
  DANCE: '在舞池中出局',
  DREAM: '被摄梦人带走',
  VOTE: '被投票放逐',
  SHOOT: '被猎人开枪带走',
  EXPLODE: '白狼王自爆',
  BLAST: '被白狼王带走',
  LOVE: '为狼美人殉情',
  REFLECT: '遭恶灵骑士反伤',
  DUEL: '在骑士决斗中出局',
};

/**
 * 一晚的完整复盘快照。
 *
 * 这份数据只会在场次结束（或房主提前结束）后写入数据库并展示，进行中的
 * 对局不会下发，避免刀口、守护、药水和验人结果泄露。
 */
export interface MatchReplayNight {
  day: number;
  wolfVotes: Array<{ voter: number; target: number | null }>;
  wolfTarget: number | null;
  guardTarget: number | null;
  mechanicalGuardTarget: number | null;
  witchActed: boolean;
  witchSave: boolean;
  witchPoison: number | null;
  mechanicalPoison: number | null;
  seerTarget: number | null;
  seerCamp: Camp | null;
  mechanicalSeerTarget: number | null;
  mechanicalSeerCamp: Camp | null;
  spiritTarget: number | null;
  spiritRole: Role | null;
  mechanicalSpiritTarget: number | null;
  mechanicalSpiritRole: Role | null;
  dancerTargets: number[];
  maskInspectTarget: number | null;
  maskInspectResult: boolean | null;
  maskTarget: number | null;
  dreamerTarget: number | null;
  /** 狼美人本夜魅惑了谁（旧场次没有该字段） */
  beautyCharmTarget?: number | null;
  /** 守墓人本夜的查验结果（旧场次没有该字段；null 表示守墓人未睁眼或不在板中） */
  graveCheck?: { seat: number | null; isWolf: boolean } | null;
  deaths: Array<{ seat: number; cause: DeathCause }>;
}

export interface MatchReplay {
  version: 1;
  nights: MatchReplayNight[];
  /** 正式的白天放逐票；不包含警长竞选票。旧场次可能没有该字段。 */
  dayVotes?: Array<{ day: number; votes: VoteRecordView[] }>;
  /** 对局内所有公开播报；用于补足白天投票、警徽与开枪等过程。 */
  publicEvents: string[];
  /** 仅在整场结束后可见的裁判日志，用于解释保护、药水和特殊结算。 */
  secretEvents: string[];
}

// ────────────────────────────── 客户端 → 服务端 ──────────────────────────────

/**
 * 狼人：target 为 null 表示空刀。
 *
 * `puppet` 只在「唯邻是从」板子的**首夜**出现：狼队除了刀人，还要
 * 从「与狼相邻的好人」里选一名成为**傀儡**。和刀口一样走多数决
 * （狼队意见不一致时取票数最多的那个）。
 */
export interface WolfAction {
  kind: 'wolf';
  target: number | null;
  puppet?: number;
}
/** 守卫：守护一名玩家（可以守自己），不能连续两晚守同一人 */
export interface GuardAction {
  kind: 'guard';
  target: number;
}
/** 女巫：save 表示用解药；poison 为毒杀座位，null 表示不毒。同一夜不能两者都用 */
export interface WitchAction {
  kind: 'witch';
  save: boolean;
  poison: number | null;
}
export interface SeerAction {
  kind: 'seer';
  target: number;
}

export interface HybridAction {
  kind: 'hybrid';
  target: number;
}

export interface MechanicalLearnAction {
  kind: 'mechanicalLearn';
  target: number;
}

export interface SpiritSeerAction {
  kind: 'spiritSeer';
  target: number;
}

export interface MechanicalSkillAction {
  kind: 'mechanicalSkill';
  skill: 'guard' | 'poison' | 'seer' | 'spiritSeer';
  target: number | null;
}

export interface DancerAction {
  kind: 'dancer';
  targets: number[];
}

export interface MaskInspectAction {
  kind: 'maskInspect';
  target: number;
}

export interface MaskAction {
  kind: 'mask';
  target: number;
}

export interface DreamerAction {
  kind: 'dreamer';
  target: number;
}

/**
 * 狼美人：魅惑一名玩家。
 *
 * 她**不能**魅惑自己（自刀都禁止，魅惑自己更没有意义）。
 * 被她魅惑的人在**她的下一个死亡时刻**殉情 —— 注意是「前一晚」那个，
 * 也就是说今晚刚被魅惑的人不会因为今晚她死了就陪葬。
 */
export interface BeautyCharmAction {
  kind: 'beautyCharm';
  target: number;
}

/**
 * 守墓人：确认查看昨天的放逐结果。
 *
 * 没有目标可选 —— 结果在阶段开始时就已经告诉他了，这个提交只是
 * 「我已知晓」的确认，让阶段可以正常收束（不点则由超时兜底）。
 */
export interface GraveKeeperAction {
  kind: 'graveKeeper';
}

export type NightAction =
  | WolfAction
  | GuardAction
  | WitchAction
  | SeerAction
  | HybridAction
  | MechanicalLearnAction
  | SpiritSeerAction
  | MechanicalSkillAction
  | DancerAction
  | MaskInspectAction
  | MaskAction
  | DreamerAction
  | BeautyCharmAction
  | GraveKeeperAction;
export type SheriffDirection = 'FORWARD' | 'REVERSE';

export type ClientMsg =
  | { t: 'room.create'; nickname: string; avatar?: string }
  | { t: 'hall.open'; roomId: string } // 厅主重新开启已持久化的历史大厅
  | { t: 'room.join'; roomId: string; nickname: string; avatar?: string }
  | { t: 'room.leave' }
  | { t: 'room.takeSeat'; seat: number }
  | { t: 'room.ready'; ready: boolean }
  | { t: 'room.board'; board: BoardConfig } // 房主改版型
  | { t: 'room.mode'; mode: GameMode } // 房主切换普通模式 / 海克斯大乱斗
  | { t: 'room.roleWish'; role: Role | null } // 连败玩家私下选择愿望角色
  | { t: 'room.hexChoose'; role: Role } // 海克斯候选牌三选一
  | { t: 'room.hexSkip' } // 房主结束海克斯选择倒计时
  | { t: 'game.start' }
  | { t: 'game.confirmRole' } // 玩家表示「我已看清我的身份牌」
  | { t: 'game.beginNight' } // 房主按下「天黑请闭眼」，第一夜正式开始（硬门槛：在线的人必须全部确认）
  | { t: 'game.action'; action: NightAction }
  | { t: 'game.sheriffSignup'; candidate: boolean }
  | { t: 'game.sheriffWithdraw' }
  | { t: 'game.sheriffVote'; target: number | null }
  | { t: 'game.sheriffTransfer'; target: number | null } // null = 撕毁警徽
  | { t: 'game.speechDirection'; direction: SheriffDirection }
  | { t: 'game.vote'; target: number | null } // null = 弃票
  | { t: 'game.hunterShoot'; target: number | null } // 猎人/狼王死亡开枪；null = 放弃
  | { t: 'game.selfDestruct' } // 白狼王自爆（白天可用）
  | { t: 'game.boomTarget'; target: number | null } // 自爆后指定带走谁，null = 不带人
  | { t: 'game.knightDuel'; target: number } // 骑士翻牌决斗（白天发言阶段，整局一次）
  | { t: 'game.wolfTag'; tag: WolfTag | null; target?: number | null } // 狼人给自己挂战术标签，null = 取消；狼踩狼还要带上「踩谁」
  | { t: 'game.skipCountdown' } // 提前结束本回合的倒数
  | { t: 'game.advance' } // 房主手动跳过当前阶段
  | { t: 'game.restart' } // 当前第 N 场作废并立即重新发牌，场次号不变
  | { t: 'game.revealAll' } // 结束后查看全场身份（房主）
  | { t: 'game.godView'; active: boolean } // 主动进入/退出上帝视角（个人，不影响别人）
  | { t: 'room.closeMatch' } // 保存当前结果（未分胜负则记提前结束）并返回本大厅
  | { t: 'chat'; text: string }
  | { t: 'ping'; ts: number };

// ────────────────────────────── 服务端 → 客户端 ──────────────────────────────

export interface RoomConfig {
  /** 女巫首夜/任意夜是否允许自救 */
  witchCanSelfSave: boolean;
  /** 是否启用阶段超时自动推进 */
  autoTimeout: boolean;
  /** 超时倍率，1 = 标准时长 */
  timeoutScale: number;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  witchCanSelfSave: false,
  autoTimeout: true,
  timeoutScale: 1,
};

export interface SeatView {
  seat: number; // 1..12
  occupied: boolean;
  nickname: string;
  avatar: string;
  online: boolean;
  ready: boolean;
  isHost: boolean;
  isMe: boolean;
  /** 开局后公开的生死状态 */
  alive?: boolean;
  /** 白痴翻牌状态（公开） */
  idiotRevealed?: boolean;
  /** 是否持有警徽（公开） */
  isSheriff?: boolean;
  /** 仅「自己」与「狼队友」可见 */
  role?: Role;
  roleName?: string;
}

export interface RoomView {
  roomId: string;
  hostId: string;
  /** 当前/下一场在本大厅中的显示序号。 */
  matchNumber: number;
  /** 当前操作者是否为掉线后临时接管的房主。 */
  hostTemporary: boolean;
  /** 当前用户是不是大厅创建者。 */
  isHallOwner: boolean;
  status: 'LOBBY' | 'PLAYING';
  mode: GameMode;
  seats: SeatView[];
  playerCount: number;
  canStart: boolean;
  config: RoomConfig;
  /** 当前版型（房主可改，其他人只读） */
  board: BoardConfig;
  /** 版型摘要文案，客户端直接显示 */
  boardSummary: string;
  /** 阻止开局的错误（为空才允许开始） */
  boardErrors: string[];
  /** 提示性的平衡性建议（不阻止开局） */
  boardWarnings: string[];
  /** 普通模式的连败愿望；只包含当前用户自己的状态。 */
  roleWish: {
    lossStreak: number;
    eligible: boolean;
    selected: Role | null;
    options: Role[];
    /** 海克斯模式冻结普通模式连败，不触发也不重置。 */
    paused: boolean;
  };
  /** 海克斯选牌阶段；options 只会下发给当前用户。 */
  hexDraft: null | {
    options: Role[];
    selected: Role | null;
    submitted: number;
    total: number;
    deadline: number;
  };
  /** 还差几个座位才满 */
  seatsNeeded: number;
  /** 还没点就绪的玩家座位号（不含房主） */
  notReadySeats: number[];
  /** 分享用提示 */
  shareHint: string;
}

export interface VoteRecordView {
  voter: number;
  target: number | null;
  /** 普通票为 1，警长放逐票为 1.5 */
  weight?: number;
}

export interface DeathView {
  seat: number;
  nickname: string;
  /** 死因属于隐藏信息，仅在游戏结束后下发用于复盘 */
  cause?: DeathCause;
  /** 第几天出局的，同样只在游戏结束后下发（复盘用） */
  day?: number;
}

export interface RevealRow {
  seat: number;
  nickname: string;
  role: Role;
  roleName: string;
  camp: Camp;
  alive: boolean;
}

export interface MeView {
  seat: number;
  role: Role;
  roleName: string;
  roleDesc: string;
  camp: Camp;
  alive: boolean;
  idiotRevealed: boolean;
  /** 是否拥有投票权（死亡或白痴翻牌后失去） */
  canVote: boolean;
  /** 狼队友座位（仅狼人可见，白狼王也算狼） */
  teammates?: number[];
  /** 女巫剩余药水 */
  potions?: { antidote: boolean; poison: boolean };
  /** 预言家验人历史（仅预言家可见） */
  seerHistory?: { seat: number; nickname: string; camp: Camp }[];
  /** 通灵师验人历史（仅通灵师本人可见） */
  spiritHistory?: { seat: number; nickname: string; role: Role; roleName: string }[];
  /** 混血儿选择的榜样座位；不会透露榜样阵营 */
  hybridModelSeat?: number | null;
  /** 机械狼已经学习到的身份；null 表示尚未学习 */
  mechanicalLearnedRole?: Role | null;
  mechanicalLearnedRoleName?: string | null;
  mechanicalSkillActive?: boolean;
  mechanicalPoisonAvailable?: boolean;
  /** 舞者本人可见的舞池历史；不会透露阵营和死亡原因。 */
  danceHistory?: { day: number; seats: number[] }[];
  /** 假面本人可见的查舞池与戴面具历史。 */
  maskHistory?: { day: number; inspectSeat: number; inDance: boolean; maskSeat: number | null }[];
  /** 假面当前夜已经获得的查验结果。 */
  maskInspect?: { seat: number; inDance: boolean } | null;
  /** 已完成查验，当前还需要选择戴面具目标。 */
  maskNeedsDisguise?: boolean;
  /** 摄梦人本人可见的每夜梦游者记录；目标本人不会收到。 */
  dreamHistory?: { day: number; seat: number; nickname: string }[];
  /** 上一夜梦过的座位，本夜再次选择会令其出局。 */
  lastDreamedSeat?: number | null;
  /**
   * 狼美人专属：**上一夜**被她魅惑的座位。
   * 她死的时候，殉情的就是这个人 —— 界面必须让她自己心里有数。
   */
  lastCharmedSeat?: number | null;
  /** 守卫专属：上一夜守了谁（不能连续两晚守同一人） */
  lastGuardedSeat?: number | null;
  /** 守墓人本人可见的每夜放逐查验记录。seat 为 null 表示那天无人被放逐。 */
  graveHistory?: { day: number; seat: number | null; nickname: string | null; isWolf: boolean }[];
  /** 骑士专属：决斗是否已经用过（无论输赢都算用过） */
  knightUsed?: boolean;
  /** 骑士专属：当前能否发起决斗（存活 + 白天发言阶段 + 未用过） */
  canDuel?: boolean;
  /** 狼人专属（白狼王可带人 / 普通狼空爆）：白天是否能自爆（存活 + 处在可自爆阶段） */
  canSelfDestruct?: boolean;
  /** 我自己挂的狼队战术标签（仅狼人） */
  myWolfTag?: WolfTag | null;
  /** 我挂「狼踩狼」时填的被踩对象（仅狼人） */
  myWolfTagTarget?: number | null;
  /** 我挂「狼踩狼」时可以选谁（仅狼人，且当我挂的就是这个标签时才有意义） */
  myWolfTagTargets?: number[];
  /** 我能不能改标签（存活 + 游戏进行中） */
  canEditWolfTag?: boolean;
}

export interface GameView {
  phase: Phase;
  phaseTitle: string;
  phaseHint: string;
  day: number; // 第几天，从 1 开始
  deadline: number | null; // epoch ms，null 表示不超时
  /**
   * 发牌后的「查看身份牌」阶段：谁已经看过牌并确认了。
   *
   * 只在这一阶段下发。故意**不带任何计时器** —— 身份确认是唯一一个
   * 完全由真人节奏决定的阶段，一旦引入倒计时，「为什么这次天黑得特别慢」
   * 就变成了可被观察、可被反推的信息。
   *
   * 为什么把「谁还没确认」也下发：真实牌桌上房主本来就会喊「谁还没好？」，
   * 这本来就是公开信息，搬到屏幕上不新增任何通道。
   */
  roleReveal?: {
    /** 已确认的座位号 */
    confirmedSeats: number[];
    /** 还没确认的座位号（房主要照着这个喊人） */
    pendingSeats: number[];
    /** 需要确认的总人数（= 本局玩家人数） */
    total: number;
    /** 我自己确认了没 */
    iConfirmed: boolean;
    /** 我是不是房主（客户端据此决定是否显示「天黑请闭眼」按钮） */
    iAmHost: boolean;
    /**
     * 硬门槛是否已经满足（在线的人全部确认）。
     * 掉线的人不阻塞 —— 他根本点不了，不该把全场锁死。
     */
    canBeginNight: boolean;
  };
  me: MeView | null;
  /** 当前阶段是否轮到我行动 */
  myTurn: boolean;
  /** 我可以选择的座位号 */
  myOptions: number[];
  /** 我已提交的内容回显（用于刷新/重连后恢复界面） */
  mySubmitted: NightAction | number | boolean | null | undefined;
  /** 当前警长；null 表示尚未产生或警徽已撕毁 */
  sheriffSeat: number | null;
  /** 当前仍在竞选的玩家 */
  sheriffCandidates: number[];
  /** 已退水的玩家 */
  sheriffWithdrawn: number[];
  /** 0=未竞选，1=首轮，2=PK 轮 */
  sheriffElectionRound: 0 | 1 | 2;
  /** 第一天警长竞选是否已经结束 */
  sheriffElectionFinished: boolean;
  /** 警长指定的发言方向 */
  speechDirection: SheriffDirection | null;
  /** 狼队当前投票情况（仅狼人可见，用于线上协作） */
  wolfVotes?: { seat: number; target: number | null }[];
  /**
   * 「唯邻是从」专用，**仅狼人可见**：
   * 首夜能选谁当傀儡（与狼相邻的好人），以及队友当前投了谁。
   *
   * 好人（包括傀儡本人）永远拿不到这两个字段 —— 一旦下发，
   * 傀儡看一眼就露馅了。所以它们在服务端按「是不是狼队」条件拼装。
   */
  puppetInfo?: {
    /** 候选人座位（首夜才有；定下之后为空） */
    candidates: number[];
    /** 队友各自的投票：座位 → 目标座位 */
    votes: { seat: number; target: number }[];
    /** 已经定下的傀儡是谁（三狼自己选的，得让他们记住） */
    chosen: number | null;
  };
  /** 女巫专属：今晚刀口与「是否允许使用解药」，用于渲染解药按钮的可用状态 */
  witchInfo?: { wolfTargetSeat: number | null; canSave: boolean; saveBlockedReason: string | null };
  /** 守卫专属：上一夜守了谁，用于在界面上标出「本夜不能重复守」 */
  guardBlockedSeat?: number | null;
  /**
   * 本回合的 5-4-3-2-1 倒数（当前该念/显示的数字，5..1）。
   * null 表示当前不在倒数中。
   *
   * 为什么需要它：夜间各角色阶段如果一提交就立刻推进，
   * 机器人瞬间出牌会让四个阶段在几十毫秒内跑完，语音根本来不及播报。
   * 所以每个回合在行动完成后会留出倒数窗口，既让播报说完，
   * 也给真人一点仪式感和反应时间。
   */
  countdown: number | null;
  /** 倒数窗口的结束时刻（epoch ms），客户端据此平滑显示进度 */
  countdownEndsAt: number | null;
  /** 狼队战术标签（仅狼人可见，好人拿不到） */
  wolfTags?: {
    seat: number;
    nickname: string;
    tag: WolfTag | null;
    /** 狼踩狼：这个座位填的「踩谁」 */
    target?: number | null;
    /**
     * 狼踩狼这个配对是否已经**双方互指**完成。
     * false 表示只有一边填了，另一方还没确认 —— 必须在界面上标出来，
     * 否则挂的人会以为配合好了，实际对方根本不知道。
     */
    paired?: boolean;
  }[];
  /** 已发生的死亡（公开） */
  deaths: DeathView[];
  /** 天亮了公布的昨夜死亡座位 */
  lastNightDeaths: number[];
  /** 本轮被放逐的玩家 */
  exiled: { seat: number; nickname: string } | null;
  /** 白狼王自爆后正在指定要带走的玩家 */
  boomPendingSeat: number | null;
  /** 投票明细（放逐公布时下发的公开票型） */
  voteDetail?: VoteRecordView[];
  /** 待开枪的玩家座位（猎人、狼王或继承猎人技能的机械狼） */
  hunterPendingSeat: number | null;
  /** 待开枪玩家公开展示的身份名；仅在开枪阶段存在。 */
  shooterRoleName: string | null;
  /** 发言顺序（白天投票阶段的建议顺序） */
  speechOrder?: number[];
  /** 已行动完成的玩家数 / 应行动数；夜间仅下发给有权看到该回合进度的角色。 */
  progress?: { done: number; total: number };
  winner: Camp | null;
  /** 对局结果（含流局）；未结束时为 null */
  outcome: Outcome | null;
  /** 结束后（或进入上帝视角后）的全场身份 */
  revealAll?: RevealRow[];
  /** 现在能不能主动进入上帝视角（游戏进行中、且已经死过人） */
  godViewAvailable?: boolean;
  /** 我当前是否已经在上帝视角里 */
  godViewActive?: boolean;
  /**
   * 当前阶段该朗读出来的台词（当法官用）。
   *
   * 只包含**公开信息** —— 例如「女巫请睁眼」而不含刀口。
   * 客户端在玩家开启语音播报时朗读这一句。服务端生成文案，
   * 这样小程序端复用时不用重写一遍话术。
   */
  voiceLine: string;
  /**
   * 当前阶段的**语音包片段序列**（录音版）。
   *
   * 和 `voiceLine` 说同样的话，但拆成了「固定片段 + 数字 + 停顿」——
   * 录音只有这样拼才能听起来像真法官（句间有停顿、座位号分开念）。
   * 前端装到了语音包就播它；装不到就退回用 TTS 念 `voiceLine`。
   */
  voiceCues: VoiceCue[];
  /** 公开事件流，客户端直接滚动展示 */
  log: string[];
}

export type ServerMsg =
  | { t: 'error'; code: string; message: string }
  | { t: 'welcome'; playerId: string; resumeToken: string }
  | { t: 'room'; room: RoomView | null }
  | { t: 'game'; game: GameView | null }
  | { t: 'toast'; text: string; level: 'info' | 'warn' | 'error' }
  | { t: 'pong'; ts: number };

// ────────────────────────────── 错误码 ──────────────────────────────

export const ERR = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_PLAYING: 'ROOM_PLAYING',
  NOT_HOST: 'NOT_HOST',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_READY: 'NOT_READY',
  BAD_PHASE: 'BAD_PHASE',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_TARGET: 'INVALID_TARGET',
  ALREADY_DONE: 'ALREADY_DONE',
  DEAD: 'DEAD',
  PLAYER_COUNT: 'PLAYER_COUNT',
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const RECONNECT: RetryConfig = {
  maxRetries: 20,
  baseDelayMs: 800,
  maxDelayMs: 6000,
};
