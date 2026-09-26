/**
 * 前后端共用的 WebSocket 消息协议 + 视图类型。
 *
 * 设计要点：
 * 1. 客户端只发送「意图」，全部规则由服务端裁决。
 * 2. 服务端为每个玩家生成**个性化视图**（GameView），预言家只会收到自己验人的结果，
 *    狼人只会收到狼队友的座位，绝不把全局信息下发到客户端 —— 这是防作弊的根本。
 * 3. 协议是纯 JSON，小程序用 wx.connectSocket 可以 1:1 复用，无需任何 polyfill。
 */

import type { Camp, Role } from './roles.ts';

// ────────────────────────────── 阶段 ──────────────────────────────

export type Phase =
  | 'WAITING' // 房间等待
  | 'NIGHT_START' // 天黑请闭眼（过场）
  | 'NIGHT_WOLVES' // 狼人行动
  | 'NIGHT_WITCH' // 女巫行动
  | 'NIGHT_SEER' // 预言家行动
  | 'NIGHT_RESOLVE' // 夜间结算（过场）
  | 'DAY_ANNOUNCE' // 天亮公布死讯
  | 'DAY_VOTE' // 白天投票
  | 'DAY_EXILE' // 公布放逐结果
  | 'HUNTER_SHOOT' // 猎人开枪
  | 'GAME_OVER'; // 游戏结束

export const PHASE_LABEL: Record<Phase, string> = {
  WAITING: '等待开局',
  NIGHT_START: '天黑请闭眼',
  NIGHT_WOLVES: '狼人行动',
  NIGHT_WITCH: '女巫行动',
  NIGHT_SEER: '预言家查验',
  NIGHT_RESOLVE: '夜间结算',
  DAY_ANNOUNCE: '天亮了',
  DAY_VOTE: '白天投票',
  DAY_EXILE: '放逐结算',
  HUNTER_SHOOT: '猎人开枪',
  GAME_OVER: '游戏结束',
};

export type DeathCause = 'WOLF' | 'POISON' | 'VOTE' | 'SHOOT';

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
  VOTE: '被投票放逐',
  SHOOT: '被猎人开枪带走',
};

// ────────────────────────────── 客户端 → 服务端 ──────────────────────────────

/** 狼人：target 为 null 表示空刀 */
export interface WolfAction {
  kind: 'wolf';
  target: number | null;
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

export type NightAction = WolfAction | WitchAction | SeerAction;

export type ClientMsg =
  | { t: 'room.create'; nickname: string; avatar?: string }
  | { t: 'room.join'; roomId: string; nickname: string; avatar?: string }
  | { t: 'room.leave' }
  | { t: 'room.takeSeat'; seat: number }
  | { t: 'room.ready'; ready: boolean }
  | { t: 'game.start' }
  | { t: 'game.action'; action: NightAction }
  | { t: 'game.vote'; target: number | null } // null = 弃票
  | { t: 'game.hunterShoot'; target: number | null } // null = 放弃开枪
  | { t: 'game.advance' } // 房主手动跳过当前阶段
  | { t: 'game.restart' }
  | { t: 'game.revealAll' } // 结束后查看全场身份
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
  /** 仅「自己」与「狼队友」可见 */
  role?: Role;
  roleName?: string;
}

export interface RoomView {
  roomId: string;
  hostId: string;
  status: 'LOBBY' | 'PLAYING';
  seats: SeatView[];
  playerCount: number;
  canStart: boolean;
  config: RoomConfig;
  /** 分享用提示 */
  shareHint: string;
}

export interface VoteRecordView {
  voter: number;
  target: number | null;
}

export interface DeathView {
  seat: number;
  nickname: string;
  /** 死因属于隐藏信息（好人分不清是狼刀还是女巫下毒），仅在游戏结束后下发用于复盘 */
  cause?: DeathCause;
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
  /** 狼队友座位（仅狼人可见） */
  teammates?: number[];
  /** 女巫剩余药水 */
  potions?: { antidote: boolean; poison: boolean };
  /** 预言家验人历史（仅预言家可见） */
  seerHistory?: { seat: number; nickname: string; camp: Camp }[];
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
  mySubmitted: NightAction | number | null | undefined;
  /** 狼队当前投票情况（仅狼人可见，用于线上协作） */
  wolfVotes?: { seat: number; target: number | null }[];
  /** 女巫专属：今晚刀口与「是否允许使用解药」，用于渲染解药按钮的可用状态 */
  witchInfo?: { wolfTargetSeat: number | null; canSave: boolean; saveBlockedReason: string | null };
  /** 已发生的死亡（公开） */
  deaths: DeathView[];
  /** 天亮了公布的昨夜死亡座位 */
  lastNightDeaths: number[];
  /** 本轮被放逐的玩家 */
  exiled: { seat: number; nickname: string } | null;
  /** 投票明细（放逐公布时下发的公开票型） */
  voteDetail?: VoteRecordView[];
  /** 待开枪的猎人座位 */
  hunterPendingSeat: number | null;
  /** 发言顺序（白天投票阶段的建议顺序） */
  speechOrder?: number[];
  /** 已行动完成的玩家数 / 应行动数，用于进度展示 */
  progress?: { done: number; total: number };
  winner: Camp | null;
  /** 对局结果（含流局）；未结束时为 null */
  outcome: Outcome | null;
  /** 结束后（或房主开启后）的全场身份 */
  revealAll?: RevealRow[];
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
