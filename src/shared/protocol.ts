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

// ────────────────────────────── 阶段 ──────────────────────────────

export type Phase =
  | 'WAITING' // 房间等待
  | 'NIGHT_START' // 天黑请闭眼（过场）
  | 'NIGHT_HYBRID' // 首夜混血儿选择榜样
  | 'NIGHT_MECHANICAL' // 机械狼学习身份
  | 'NIGHT_DANCER' // 舞者选择舞池
  | 'NIGHT_MASK' // 假面查验舞池并戴面具
  | 'NIGHT_WOLVES' // 狼人行动
  | 'NIGHT_GUARD' // 守卫守护
  | 'NIGHT_WITCH' // 女巫行动
  | 'NIGHT_SEER' // 预言家行动
  | 'NIGHT_SPIRIT_SEER' // 通灵师查验具体身份
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
  NIGHT_START: '天黑请闭眼',
  NIGHT_HYBRID: '混血儿选择榜样',
  NIGHT_MECHANICAL: '机械狼学习身份',
  NIGHT_DANCER: '舞者选择舞池',
  NIGHT_MASK: '假面行动',
  NIGHT_WOLVES: '狼人行动',
  NIGHT_GUARD: '守卫守护',
  NIGHT_WITCH: '女巫行动',
  NIGHT_SEER: '预言家查验',
  NIGHT_SPIRIT_SEER: '通灵师查验',
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
  HUNTER_SHOOT: '猎人开枪',
  WOLF_KING_BOOM: '白狼王自爆',
  GAME_OVER: '游戏结束',
};

export type DeathCause = 'WOLF' | 'POISON' | 'DANCE' | 'VOTE' | 'SHOOT' | 'EXPLODE' | 'BLAST';

// ────────────────────────────── 狼队战术标签 ──────────────────────────────

/** 狼队战术分工。只有狼人之间能看到彼此的标签，好人一律看不到。 */
export type WolfTag = 'FAKE_SEER' | 'SHERIFF' | 'HOOK' | 'WOLF_VS_WOLF' | 'CHARGER';

export const WOLF_TAG_LABEL: Record<WolfTag, string> = {
  FAKE_SEER: '悍跳位',
  SHERIFF: '上警',
  HOOK: '倒钩',
  WOLF_VS_WOLF: '狼踩狼',
  CHARGER: '冲锋狼',
};

export const WOLF_TAG_DESC: Record<WolfTag, string> = {
  FAKE_SEER: '跳预言家骗好人 —— 全队只能有一个人占这个位置',
  SHERIFF: '参与警长竞选',
  HOOK: '站边好人、跟着好人投票，藏好自己',
  WOLF_VS_WOLF: '投票时踩狼队友，把队友的命换成自己的身份',
  CHARGER: '强势发言带节奏，冲在最前面',
};

/** 只能有一个人占的标签（其余标签可以多人同时选） */
export const EXCLUSIVE_WOLF_TAGS: readonly WolfTag[] = ['FAKE_SEER'];

export const ALL_WOLF_TAGS: readonly WolfTag[] = [
  'FAKE_SEER',
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
  VOTE: '被投票放逐',
  SHOOT: '被猎人开枪带走',
  EXPLODE: '白狼王自爆',
  BLAST: '被白狼王带走',
};

// ────────────────────────────── 客户端 → 服务端 ──────────────────────────────

/** 狼人：target 为 null 表示空刀 */
export interface WolfAction {
  kind: 'wolf';
  target: number | null;
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
  | MaskAction;
export type SheriffDirection = 'FORWARD' | 'REVERSE';

export type ClientMsg =
  | { t: 'room.create'; nickname: string; avatar?: string }
  | { t: 'room.join'; roomId: string; nickname: string; avatar?: string }
  | { t: 'room.leave' }
  | { t: 'room.takeSeat'; seat: number }
  | { t: 'room.ready'; ready: boolean }
  | { t: 'room.board'; board: BoardConfig } // 房主改版型
  | { t: 'game.start' }
  | { t: 'game.action'; action: NightAction }
  | { t: 'game.sheriffSignup'; candidate: boolean }
  | { t: 'game.sheriffWithdraw' }
  | { t: 'game.sheriffVote'; target: number | null }
  | { t: 'game.sheriffTransfer'; target: number | null } // null = 撕毁警徽
  | { t: 'game.speechDirection'; direction: SheriffDirection }
  | { t: 'game.vote'; target: number | null } // null = 弃票
  | { t: 'game.hunterShoot'; target: number | null } // null = 放弃开枪
  | { t: 'game.selfDestruct' } // 白狼王自爆（白天可用）
  | { t: 'game.boomTarget'; target: number | null } // 自爆后指定带走谁，null = 不带人
  | { t: 'game.wolfTag'; tag: WolfTag | null } // 狼人给自己挂战术标签，null = 取消
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
  /** 守卫专属：上一夜守了谁（不能连续两晚守同一人） */
  lastGuardedSeat?: number | null;
  /** 白狼王专属：白天是否能自爆（存活 + 处在可自爆阶段） */
  canSelfDestruct?: boolean;
  /** 我自己挂的狼队战术标签（仅狼人） */
  myWolfTag?: WolfTag | null;
  /** 我能不能改标签（存活 + 游戏进行中） */
  canEditWolfTag?: boolean;
}

export interface GameView {
  phase: Phase;
  phaseTitle: string;
  phaseHint: string;
  day: number; // 第几天，从 1 开始
  deadline: number | null; // epoch ms，null 表示不超时
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
  wolfTags?: { seat: number; nickname: string; tag: WolfTag | null }[];
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
  /** 待开枪的猎人座位 */
  hunterPendingSeat: number | null;
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
