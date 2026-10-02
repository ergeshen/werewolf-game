/**
 * 狼人杀规则引擎（服务端权威）
 *
 * 设计原则：
 * - 纯逻辑，不依赖 Node / DOM / 网络 / 时钟。阶段推进由外部（服务端定时器）驱动，
 *   这样引擎可以在单元测试里用「零时间」跑完一整局。
 * - 所有信息过滤发生在 gameViewFor()：预言家只拿得到自己的验人结果，狼人只拿得到
 *   狼队友座位。客户端永远拿不到可以作弊的全局状态。
 * - **版型由外部传入**（一个角色数组），引擎不写死 12 人预女猎白。
 *
 * 已实现的角色与规则：
 * - 狼人 / 白狼王：夜里共同点刀，多数票生效。
 * - 白狼王：白天可以自爆并带走一名玩家，自爆后直接进入黑夜（当天不再投票）。
 * - 普通狼人：白天可以空爆（不带人），警长竞选期间自爆会终止竞选并使警徽流失。
 * - 守卫：每晚守护一人免疫狼刀；不能连续两晚守同一人；**同守同救时该玩家依然死亡**。
 * - 女巫：解药 / 毒药各 1 瓶，全局一次；同一夜不能双药；默认不可自救。
 * - 预言家：每晚查验一人阵营。
 * - 猎人：被狼刀、放逐或狼王开枪带走时可开枪；被毒、摄梦或白狼王带走不能开枪。
 * - 摄梦人：每夜梦一名其他玩家；梦游者免疫夜间伤害，连梦两夜或摄梦人夜死会被带走。
 * - 白痴：被投票放逐时翻牌免死，永久失去投票权。
 * - 平民：无技能。
 *
 * 胜负（屠边）：狼人全部出局 → 好人胜；**开局时确实存在的那一类**（神职 / 平民）全灭 → 狼人胜。
 * 「确实存在」很重要：如果版型里根本没有平民，就不能因为「平民数 = 0」判狼人胜。
 */

import {
  CAMP_NAME,
  ROLE_DESC,
  ROLE_NAME,
  isGod,
  isWolfRole,
  type Camp,
  type Role,
} from './roles.ts';
import { canBeKnifed, nightOrderFor } from './roles.ts';
import { SENTENCE_GAP_MS, seatsCues, type VoiceCue } from './voice-clips.ts';
import {
  DEFAULT_ROOM_CONFIG,
  DEATH_CAUSE_LABEL,
  PHASE_LABEL,
  WOLF_TAG_LABEL,
  NIGHT_PHASE_BY_ROLE,
  isExclusiveWolfTag,
  isPairedWolfTag,
  type DeathCause,
  type DeathView,
  type GameView,
  type NightAction,
  type MatchReplay,
  type MatchReplayNight,
  type Phase,
  type SheriffDirection,
  type RevealRow,
  type RoomConfig,
  type SeatView,
  type VoteRecordView,
  type WitchAction,
  type WolfAction,
  type SeerAction,
  type GuardAction,
  type WolfTag,
  type Outcome,
} from './protocol.ts';

// ────────────────────────────── 工具 ──────────────────────────────

/**
 * 带状态外露的 mulberry32。
 *
 * 引擎的随机流必须可以**存档续传**：服务端重启恢复对局后，随机数序列
 * 要从断点继续，否则同一局里重启前后的随机行为会不可复现。
 * 闭包版的 mulberry32 拿不到内部状态，所以换成这个类。
 */
export class SeededRng {
  private a: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
  }

  /** 从快照保存的内部状态续流 */
  static resume(state: number): SeededRng {
    const rng = new SeededRng(0);
    rng.a = state >>> 0;
    return rng;
  }

  /** 内部状态：存进快照，恢复后随机流从断点继续 */
  get state(): number {
    return this.a;
  }

  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** 可复现的伪随机数生成器（用于测试固定牌序） */
export function mulberry32(seed: number): () => number {
  const rng = new SeededRng(seed);
  return () => rng.next();
}

function shuffle<T>(input: readonly T[], rng: () => number): T[] {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

export interface ActResult {
  ok: boolean;
  code?: string;
  message?: string;
}

const OK: ActResult = { ok: true };
function fail(code: string, message: string): ActResult {
  return { ok: false, code, message };
}

/**
 * 各阶段的标准时长（毫秒）。服务端据此设定 deadline，引擎本身不感知时间。
 *
 * 夜间角色回合的时长 = **该角色的战术安排时间**。
 * 这段时间里引擎被服务端按住（holdAdvance），不会因为「都提交完了」就提前关闭 ——
 * 狼队真的需要 1 分半来商量刀谁、怎么发言。
 * 最后 5 秒由服务端倒数提醒，只有房主可以提前结束当前阶段。
 */
export const PHASE_TIMEOUT_MS: Record<Phase, number> = {
  WAITING: Number.POSITIVE_INFINITY,
  // 身份确认**故意没有任何计时器**。这是全场唯一一个完全由真人节奏决定的阶段：
  // 有人要读长描述、狼要找队友、女巫要弄明白两瓶药。
  // 一旦给它倒计时，「为什么这次天黑得特别慢」就变成了可被观察、可被反推的信息。
  ROLE_REVEAL: Number.POSITIVE_INFINITY,
  NIGHT_START: 5_000,
  NIGHT_HYBRID: 30_000,
  NIGHT_MECHANICAL: 40_000,
  NIGHT_DANCER: 60_000,
  NIGHT_MASK: 60_000,
  NIGHT_DREAMER: 45_000,
  NIGHT_WOLVES: 90_000, // 1 分半战术安排
  // 狼美人是「狼队刀完之后独自睁眼」，不需要再留战术时间：
  // 她只有一个人、只有一个选择，30 秒足够。
  NIGHT_BEAUTY_CHARM: 30_000,
  NIGHT_GUARD: 30_000,
  NIGHT_WITCH: 40_000,
  NIGHT_SEER: 30_000,
  NIGHT_SPIRIT_SEER: 30_000,
  // 守墓人只有一个「我已知晓」要按，而且结果在阶段开始时就已经给他了
  NIGHT_GRAVE_KEEPER: 20_000,
  NIGHT_RESOLVE: 2_500,
  // 面杀的白天由真人发言和操作，不能让服务器倒计时擅自推进。
  // 有玩家操作的阶段仍会在所有人提交后正常结算；其余阶段由房主手动跳过。
  DAY_ANNOUNCE: Number.POSITIVE_INFINITY,
  SHERIFF_SIGNUP: Number.POSITIVE_INFINITY,
  SHERIFF_CAMPAIGN: Number.POSITIVE_INFINITY,
  SHERIFF_VOTE: Number.POSITIVE_INFINITY,
  SHERIFF_PK: Number.POSITIVE_INFINITY,
  SHERIFF_REVOTE: Number.POSITIVE_INFINITY,
  DAY_SPEECH: Number.POSITIVE_INFINITY,
  DAY_VOTE: Number.POSITIVE_INFINITY,
  DAY_EXILE: Number.POSITIVE_INFINITY,
  SHERIFF_TRANSFER: Number.POSITIVE_INFINITY,
  HUNTER_SHOOT: Number.POSITIVE_INFINITY,
  WOLF_KING_BOOM: Number.POSITIVE_INFINITY,
  GAME_OVER: Number.POSITIVE_INFINITY,
};

/** 超过这个天数仍未分出胜负即判定流局 —— 保证状态机一定会在有限步内终止 */
export const MAX_DAYS = 20;

/** 这些阶段只由定时器 / 房主手动推进，给玩家留出阅读时间 */
const PAUSE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'WAITING',
  'ROLE_REVEAL',
  'NIGHT_START',
  'NIGHT_RESOLVE',
  'DAY_ANNOUNCE',
  'SHERIFF_CAMPAIGN',
  'SHERIFF_PK',
  'DAY_SPEECH',
  'DAY_EXILE',
  'GAME_OVER',
]);

/**
 * 夜间每个角色阶段的「睁眼」台词。
 *
 * 为什么要把睁眼和闭眼都念出来：玩家听到的语音顺序是全场唯一的公开时间线。
 * 如果某个阶段干脆不播报，或者播报内容随该角色死活变化，
 * 那语音本身就变成了情报 —— 「今晚没听到女巫请睁眼」= 女巫已经死了。
 */
const NIGHT_OPEN_LINE: Partial<Record<Phase, string>> = {
  NIGHT_HYBRID: '混血儿请睁眼，请选择一名玩家作为榜样。',
  NIGHT_MECHANICAL: '机械狼请睁眼，请选择要学习身份的玩家。',
  NIGHT_DANCER: '舞者请睁眼，请选择三名玩家进入舞池。',
  NIGHT_MASK: '假面请睁眼，请先查验舞池，再选择一名玩家戴上面具。',
  NIGHT_DREAMER: '摄梦人请睁眼，请选择今晚的梦游者。',
  NIGHT_WOLVES: '狼人请睁眼，请确认今晚的战术，选择要击杀的玩家。',
  NIGHT_BEAUTY_CHARM: '狼美人请睁眼，请选择今晚要魅惑的玩家。',
  NIGHT_GUARD: '守卫请睁眼，请选择今晚要守护的玩家。',
  NIGHT_WITCH: '女巫请睁眼。',
  NIGHT_SEER: '预言家请睁眼，请选择今晚要查验的玩家。',
  NIGHT_SPIRIT_SEER: '通灵师请睁眼，请选择今晚要查验具体身份的玩家。',
  // 注意：守墓人台词绝不能带出查验结果 —— 全场听到的一模一样
  NIGHT_GRAVE_KEEPER: '守墓人请睁眼。',
};

/** 对应的「闭眼」台词，会拼在下一个阶段的开头 */
const NIGHT_CLOSE_LINE: Partial<Record<Phase, string>> = {
  NIGHT_HYBRID: '混血儿请闭眼。',
  NIGHT_MECHANICAL: '机械狼请闭眼。',
  NIGHT_DANCER: '舞者请闭眼。',
  NIGHT_MASK: '假面请闭眼。',
  NIGHT_DREAMER: '摄梦人请闭眼。',
  NIGHT_WOLVES: '狼人请闭眼。',
  NIGHT_BEAUTY_CHARM: '狼美人请闭眼。',
  NIGHT_GUARD: '守卫请闭眼。',
  NIGHT_WITCH: '女巫请闭眼。',
  NIGHT_SEER: '预言家请闭眼。',
  NIGHT_SPIRIT_SEER: '通灵师请闭眼。',
  NIGHT_GRAVE_KEEPER: '守墓人请闭眼。',
};

/**
 * 同一段台词在**录音语音包**里对应的片段 id。
 *
 * 为什么要两张表：文字版（上面那两张）给浏览器 TTS 兜底，
 * 片段 id 给录音包用。录音可以把「闭眼」和「睁眼」分成两段、中间留停顿，
 * 听起来像一个真法官；而 TTS 只能把整句一口气念完。
 * 两者的**用词必须一致** —— engine.test.ts 里有一条测试逐阶段比对。
 */
const OPEN_CLIP: Partial<Record<Phase, string>> = {
  NIGHT_HYBRID: 'open.hybrid',
  NIGHT_MECHANICAL: 'open.mechanical',
  NIGHT_DANCER: 'open.dancer',
  NIGHT_MASK: 'open.mask',
  NIGHT_DREAMER: 'open.dreamer',
  NIGHT_WOLVES: 'open.wolves',
  NIGHT_BEAUTY_CHARM: 'open.beauty',
  NIGHT_GUARD: 'open.guard',
  NIGHT_WITCH: 'open.witch',
  NIGHT_SEER: 'open.seer',
  NIGHT_SPIRIT_SEER: 'open.spirit',
  NIGHT_GRAVE_KEEPER: 'open.gravekeeper',
};

const CLOSE_CLIP: Partial<Record<Phase, string>> = {
  NIGHT_HYBRID: 'close.hybrid',
  NIGHT_MECHANICAL: 'close.mechanical',
  NIGHT_DANCER: 'close.dancer',
  NIGHT_MASK: 'close.mask',
  NIGHT_DREAMER: 'close.dreamer',
  NIGHT_WOLVES: 'close.wolves',
  NIGHT_BEAUTY_CHARM: 'close.beauty',
  NIGHT_GUARD: 'close.guard',
  NIGHT_WITCH: 'close.witch',
  NIGHT_SEER: 'close.seer',
  NIGHT_SPIRIT_SEER: 'close.spirit',
  NIGHT_GRAVE_KEEPER: 'close.gravekeeper',
};

// ────────────────────────────── 状态 ──────────────────────────────
export interface PlayerSeed {
  id: string;
  seat: number;
  nickname: string;
  avatar?: string;
  isHost?: boolean;
}

interface PlayerState {
  id: string;
  seat: number;
  nickname: string;
  avatar: string;
  isHost: boolean;
  role: Role;
  alive: boolean;
  /** 白痴已翻牌（公开信息），此后失去投票权且不再是投票目标 */
  idiotRevealed: boolean;
}

interface DeathRecord {
  seat: number;
  cause: DeathCause;
  day: number;
  night: boolean;
}

interface NightState {
  hybridTarget: number | null;
  hybridActed: boolean;
  mechanicalLearnTarget: number | null;
  mechanicalLearnActed: boolean;
  dancerTargets: number[];
  dancerActed: boolean;
  maskInspectTarget: number | null;
  maskInspectResult: boolean | null;
  maskInspectActed: boolean;
  maskTarget: number | null;
  maskActed: boolean;
  dreamerTarget: number | null;
  dreamerActed: boolean;
  /** 狼美人本夜魅惑了谁 */
  beautyCharmTarget: number | null;
  beautyCharmActed: boolean;
  /**
   * 恶灵骑士本夜反伤了谁。
   *
   * 记录「谁」而不是「有没有反伤」是关键：同一夜可能既有人毒他、又有人验他，
   * 而按官方规则**只有先行动的那个人**吃反伤。夜间行动顺序 = 阶段顺序
   * （女巫在预言家之前），所以「谁先提交」天然就是「谁先行动」——
   * 这里只认第一个写进来的。
   */
  darkLordReflectVictim: number | null;
  /** 狼人各自的选择：座位 → 目标座位（null = 空刀） */
  wolfPicks: Map<number, number | null>;
  /** 多数决出的刀口 */
  wolfTarget: number | null;
  /**
   * 首夜狼队各自选的**傀儡**：座位 → 目标座位。
   * 只在「唯邻是从」板子的第一夜有值，之后永远是空的。
   */
  puppetPicks: Map<number, number>;
  /** 多数决出的傀儡（首夜定下）。真正生效的是 engine 上的 `puppetSeat`。 */
  puppetTarget: number | null;
  /** 守卫守护的座位 */
  guardTarget: number | null;
  guardActed: boolean;
  mechanicalGuardTarget: number | null;
  mechanicalGuardActed: boolean;
  witchSave: boolean;
  witchPoison: number | null;
  witchActed: boolean;
  mechanicalPoison: number | null;
  mechanicalPoisonActed: boolean;
  seerTarget: number | null;
  seerCamp: Camp | null;
  seerActed: boolean;
  mechanicalSeerTarget: number | null;
  mechanicalSeerCamp: Camp | null;
  mechanicalSeerActed: boolean;
  spiritTarget: number | null;
  spiritRole: Role | null;
  spiritActed: boolean;
  mechanicalSpiritTarget: number | null;
  mechanicalSpiritRole: Role | null;
  mechanicalSpiritActed: boolean;
  /** 守墓人本夜的查验结果；null 表示本夜没有守墓人环节（首夜）或无人需要查验 */
  graveCheck: { seat: number | null; isWolf: boolean } | null;
  graveKeeperActed: boolean;
}

export interface GameOptions {
  /** 牌堆内容：每个元素是一张角色牌。长度必须等于玩家数。 */
  roles: Role[];
  /** 是否洗牌。房间开局传 true；单元测试传 false 以便按座位断言。 */
  shuffle?: boolean;
  config?: Partial<RoomConfig>;
  seed?: number;
  /**
   * 「唯邻是从」：首夜狼队要选一名傀儡。
   *
   * 必须由**版型**传进来，不能只看「首夜有没有狼」——
   * 否则每一个版型都会变成唯邻是从。
   */
  puppet?: boolean;
}

/**
 * 快照格式版本。**任何会让旧快照语义变化的改动都必须 bump**：
 * 加字段可以不 bump（restore 对缺省字段有兜底），但改语义 / 删字段 / 改结构必须。
 * 版本不符的快照会被直接丢弃 —— 宁可丢一局，不能加载出规则错乱的局。
 */
export const GAME_SNAPSHOT_VERSION = 1;

/** 全部合法阶段名。快照恢复时用它拦截损坏数据。 */
const PHASE_NAMES: ReadonlySet<string> = new Set([
  'WAITING', 'ROLE_REVEAL',
  'NIGHT_START', 'NIGHT_HYBRID', 'NIGHT_MECHANICAL', 'NIGHT_DANCER', 'NIGHT_MASK',
  'NIGHT_DREAMER', 'NIGHT_WOLVES', 'NIGHT_BEAUTY_CHARM', 'NIGHT_GUARD', 'NIGHT_WITCH',
  'NIGHT_SEER', 'NIGHT_SPIRIT_SEER', 'NIGHT_GRAVE_KEEPER', 'NIGHT_RESOLVE',
  'DAY_ANNOUNCE', 'SHERIFF_SIGNUP', 'SHERIFF_CAMPAIGN', 'SHERIFF_VOTE', 'SHERIFF_PK',
  'SHERIFF_REVOTE', 'DAY_SPEECH', 'DAY_VOTE', 'DAY_EXILE', 'SHERIFF_TRANSFER',
  'HUNTER_SHOOT', 'WOLF_KING_BOOM', 'GAME_OVER',
] satisfies Phase[] as string[]);

/**
 * 一局游戏的完整存档（纯 JSON 数据）。
 *
 * Map / Set 一律存 entries 数组；`sheriffTransferChoice` / `hunterChoice` / `boomChoice`
 * 是三态（undefined / null / 数字），JSON 会丢掉 undefined 的键，恢复时读不到即为
 * undefined，语义正好保住。
 */
export interface GameSnapshot {
  v: number;
  roomId: string;
  config: RoomConfig;
  phase: Phase;
  day: number;
  deadline: number | null;
  countdown: number | null;
  countdownEndsAt: number | null;
  holdAdvance: boolean;
  hostPlayerId: string | null;
  roleRevealConfirmed: string[];
  lastCharmedSeat: number | null;
  darkLordReflectUsed: boolean;
  players: Array<{
    id: string;
    seat: number;
    nickname: string;
    avatar: string;
    isHost: boolean;
    role: Role;
    alive: boolean;
    idiotRevealed: boolean;
  }>;
  night: Omit<NightState, 'wolfPicks' | 'puppetPicks'> & {
    wolfPicks: [number, number | null][];
    puppetPicks: [number, number][];
  };
  witchPotions: { antidote: boolean; poison: boolean };
  seerHistory: [number, { seat: number; camp: Camp }[]][];
  spiritHistory: [number, { seat: number; role: Role }[]][];
  hybridModelSeat: number | null;
  mechanicalLearnedRole: Role | null;
  mechanicalLearnedDay: number | null;
  mechanicalPoisonAvailable: boolean;
  mechanicalLastGuardedSeat: number | null;
  danceUsedSeats: number[];
  danceHistory: { day: number; seats: number[] }[];
  maskHistory: { day: number; inspectSeat: number; inDance: boolean; maskSeat: number | null }[];
  lastMaskInspectSeat: number | null;
  lastMaskTargetSeat: number | null;
  lastDreamedSeat: number | null;
  dreamHistory: { day: number; seat: number }[];
  lastDayExiledSeat: number | null;
  graveHistory: { day: number; seat: number | null; isWolf: boolean }[];
  knightUsed: boolean;
  votes: [number, number | null][];
  sheriffSeat: number | null;
  sheriffElectionFinished: boolean;
  sheriffSignup: [number, boolean][];
  sheriffCandidates: number[];
  sheriffWithdrawn: number[];
  sheriffVotes: [number, number | null][];
  sheriffTieCandidates: number[];
  sheriffSpeechOrder: number[];
  sheriffElectionRound: number;
  sheriffTransferChoice: number | null | undefined;
  sheriffTransferFrom: number | null;
  sheriffTransferReturn: 'ANNOUNCE' | 'EXILE' | 'HUNTER' | 'BOOM' | 'SPEECH';
  speechDirection: SheriffDirection | null;
  deaths: DeathRecord[];
  lastNightDeaths: number[];
  exiled: { seat: number; nickname: string } | null;
  voteDetail: VoteRecordView[];
  hunterPendingSeat: number | null;
  hunterQueue: number[];
  hunterChoice: number | null | undefined;
  hunterReturnPhase: Phase;
  boomPendingSeat: number | null;
  boomChoice: number | null | undefined;
  lastGuardedSeat: number | null;
  puppetSeat: number | null;
  wolfTags: [number, WolfTag][];
  wolfTagTargets: [number, number][];
  winner: Camp | null;
  draw: boolean;
  log: string[];
  secretLog: string[];
  /** 本阶段要全场播报的自爆/空爆座位（公开信息，见 boomAnnouncements） */
  boomAnnouncements: number[];
  replayNights: MatchReplayNight[];
  replayDayVotes: Array<{ day: number; votes: VoteRecordView[] }>;
  revealAllRequested: string[];
  speechStartSeat: number | null;
  rngState: number;
  boardRoles: Role[];
  puppetEnabled: boolean;
}

export class Game {
  readonly roomId: string;
  config: RoomConfig;
  phase: Phase = 'WAITING';
  day = 0;
  /** 由服务端写入的当前阶段截止时间（epoch ms），引擎不读系统时钟 */
  deadline: number | null = null;
  /**
   * 由服务端驱动的「回合倒数」（5..1）。null 表示当前不在倒数中。
   *
   * 引擎自己不管时间，但需要把倒数状态带进视图 —— 客户端据此显示数字并念出来。
   */
  countdown: number | null = null;
  countdownEndsAt: number | null = null;
  /**
   * 由服务端设置：true 时**暂缓自动推进**。
   *
   * 为什么需要它：夜间各角色回合如果「行动一提交就推进」，
   * 机器人瞬间出牌会让四个回合在几十毫秒内跑完，语音根本来不及播报。
   * 但引擎自己不读时钟，没法自己等 —— 所以由服务端在播报窗口和倒数期间
   * 把它置为 true，等窗口走完再放开。
   *
   * 注意：`forceAdvance()` 不受它影响（超时 / 房主跳过必须仍然有效）。
   */
  holdAdvance = false;

  /**
   * 由服务端设置：当前**在线**的座位号。
   *
   * 引擎本身不碰网络，但「身份确认的硬门槛」需要知道谁在线才能决定
   * 「必须等谁」。所以把它做成和 holdAdvance 一样的服务端输入：
   * 服务端在连接变化时更新它，引擎只读。
   *
   * 唯一的用途是 `canBeginNight()` —— 掉线的人点不了确认按钮，
   * 不该把全场锁死。集合为空时退化成最严格（要求全员确认）。
   */
  onlineSeats = new Set<number>();

  /**
   * 由服务端设置：当前**有效房主**的玩家 id。
   *
   * 为什么不能直接读 PlayerState.isHost：那是发牌那一刻定死的
   * （`isHost: token === this.hostToken`）。房主掉线后服务端会把操作权临时
   * 移交给别人，而引擎里的 isHost 标记不会跟着变 —— 结果就是临时房主
   * 在自己界面上看不到「天黑请闭眼」按钮，全场继续锁死。
   * 所以把它也做成服务端输入的字段，由服务端在移交/收回时同步。
   */
  hostPlayerId: string | null = null;

  /** 身份确认阶段已经点过「我已看清我的身份牌」的玩家 id */
  private roleRevealConfirmed = new Set<string>();

  /**
   * 狼美人**上一夜**魅惑的座位。
   * 她出局时殉情的就是这个人 —— 必须是「上一夜」而不是「本夜」：
   * 本夜刚魅惑完就死，那个人不该陪葬。
   */
  private lastCharmedSeat: number | null = null;

  /**
   * 恶灵骑士的反伤是不是已经用过了。
   * 官方的「一次性反伤」：整局只反一次，用掉之后他依然夜里杀不死，
   * 但剩下的毒药和查验都可以放心用了。
   */
  private darkLordReflectUsed = false;

  private players: PlayerState[] = [];
  private night: NightState = emptyNight();
  private witchPotions = { antidote: true, poison: true };
  private seerHistory = new Map<number, { seat: number; camp: Camp }[]>();
  private spiritHistory = new Map<number, { seat: number; role: Role }[]>();
  private hybridModelSeat: number | null = null;
  private mechanicalLearnedRole: Role | null = null;
  private mechanicalLearnedDay: number | null = null;
  private mechanicalPoisonAvailable = true;
  private mechanicalLastGuardedSeat: number | null = null;
  /** 每名玩家整局最多进入一次舞池。 */
  private danceUsedSeats = new Set<number>();
  private danceHistory: { day: number; seats: number[] }[] = [];
  private maskHistory: { day: number; inspectSeat: number; inDance: boolean; maskSeat: number | null }[] = [];
  private lastMaskInspectSeat: number | null = null;
  private lastMaskTargetSeat: number | null = null;
  private lastDreamedSeat: number | null = null;
  private dreamHistory: { day: number; seat: number }[] = [];
  /**
   * 上一白天被投票放逐的座位（无人被放逐则为 null）。
   *
   * 在进入下一夜的 NIGHT_START 时从 `exiled` 抄一份过来 —— 那之后
   * `exiled` 会被清空，而守墓人在本夜里要查的正是「昨天放逐了谁」。
   */
  private lastDayExiledSeat: number | null = null;
  /** 守墓人本人可见的逐夜查验记录；seat 为 null 表示那天无人被放逐。 */
  private graveHistory: { day: number; seat: number | null; isWolf: boolean }[] = [];
  /** 骑士的决斗是否已经用过（无论决斗输赢都算用过） */
  private knightUsed = false;
  private votes = new Map<number, number | null>();
  private sheriffSeat: number | null = null;
  private sheriffElectionFinished = false;
  private sheriffSignup = new Map<number, boolean>();
  private sheriffCandidates = new Set<number>();
  private sheriffWithdrawn = new Set<number>();
  private sheriffVotes = new Map<number, number | null>();
  private sheriffTieCandidates: number[] = [];
  private sheriffSpeechOrder: number[] = [];
  private sheriffElectionRound: 0 | 1 | 2 = 0;
  private sheriffTransferChoice: number | null | undefined = undefined;
  private sheriffTransferFrom: number | null = null;
  private sheriffTransferReturn: 'ANNOUNCE' | 'EXILE' | 'HUNTER' | 'BOOM' | 'SPEECH' = 'ANNOUNCE';
  private speechDirection: SheriffDirection | null = null;
  private deaths: DeathRecord[] = [];
  private lastNightDeaths: number[] = [];
  private exiled: { seat: number; nickname: string } | null = null;
  private voteDetail: VoteRecordView[] = [];
  private hunterPendingSeat: number | null = null;
  private hunterQueue: number[] = [];
  private hunterChoice: number | null | undefined = undefined;
  private hunterReturnPhase: Phase = 'DAY_VOTE';
  /** 白狼王自爆后等待指定带走目标的座位 */
  private boomPendingSeat: number | null = null;
  private boomChoice: number | null | undefined = undefined;
  /** 守卫上一夜守了谁（不能连续两晚守同一人） */
  private lastGuardedSeat: number | null = null;
  /**
   * 「唯邻是从」的灵魂：**傀儡**的座位。
   *
   * 他保留原底牌、照常按原身份操作、**不知道自己已经变成狼人阵营** ——
   * 但他的技能全部失效或反转，而且真预言家验他会显示【狼人】。
   *
   * 这是玩家级状态而不是角色：傀儡没有新底牌，只是阵营被暗中改了。
   * 别处一律通过 `truthCamp()` 读取，不要直接看这个字段。
   */
  private puppetSeat: number | null = null;
  /** 狼队战术标签：座位 → 标签。只有狼人之间能看到。 */
  private wolfTags = new Map<number, WolfTag>();
  /** 狼踩狼：座位 → 这个座位填的「踩谁」。只有互指配对成功才算数。 */
  private wolfTagTargets = new Map<number, number>();
  private winner: Camp | null = null;
  /** 流局标记：达到 MAX_DAYS 仍无胜者 */
  private draw = false;
  /** 公开事件流：所有玩家都能看到，只包含公开信息 */
  private log: string[] = [];
  /**
   * 本阶段需要全场播报的自爆/空爆座位（公开信息）。
   *
   * 自爆发生在白天，播报却挂在紧随其后的 NIGHT_START 语音里 ——
   * 天黑语音是全场同时念的，把「X 号自爆了」拼进去，所有人同一时刻听到同一句。
   * 每个 NIGHT_START 入场时清空（读走即消费）。
   */
  private boomAnnouncements: number[] = [];
  /** 私有事件流：仅服务端可见，用于运营排查，绝不下发给客户端 */
  private secretLog: string[] = [];
  /** 已完成夜晚的结构化回顾；只在整场结束后由服务端持久化。 */
  private replayNights: MatchReplayNight[] = [];
  private replayDayVotes: Array<{ day: number; votes: VoteRecordView[] }> = [];
  private revealAllRequested = new Set<string>();
  private speechStartSeat: number | null = null;
  private rng: SeededRng;
  /** 开局时各阵营类别的数量，用于「屠边」判定（不存在的类别不参与判定） */
  private readonly initialGods: number;
  private readonly initialVillagers: number;
  private readonly deckSize: number;
  /**
   * 本局板子的角色清单（不含具体谁是什么）。
   * 夜间阶段是否要走、语音怎么念，都只看这份**公开**清单，
   * 绝不看「那个角色死没死」—— 否则阶段时长就成了情报。
   */
  private readonly boardRoles: readonly Role[];
  /** 本局是不是「唯邻是从」（首夜狼队要选傀儡） */
  private readonly puppetEnabled: boolean;

  constructor(roomId: string, seeds: PlayerSeed[], options: GameOptions) {
    this.roomId = roomId;
    this.config = { ...DEFAULT_ROOM_CONFIG, ...(options.config ?? {}) };
    this.rng = new SeededRng(options.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.deckSize = options.roles.length;
    this.boardRoles = options.roles.slice();
    this.puppetEnabled = options.puppet === true;

    const deck = options.shuffle ? shuffle(options.roles, () => this.rng.next()) : options.roles.slice();

    this.players = seeds
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((s, i) => ({
        id: s.id,
        seat: s.seat,
        nickname: s.nickname,
        avatar: s.avatar ?? '',
        isHost: s.isHost ?? false,
        // 牌堆比玩家少时用平民兜底，避免出现 undefined；正常流程由版型校验拦住
        role: deck[i] ?? 'VILLAGER',
        alive: true,
        idiotRevealed: false,
      }));

    this.initialGods = this.players.filter((p) => isGod(p.role)).length;
    this.initialVillagers = this.players.filter((p) => p.role === 'VILLAGER' || p.role === 'HYBRID').length;
    // 默认房主 = 发牌时的房主；服务端之后可以因为临时接管而改写它
    this.hostPlayerId = this.players.find((p) => p.isHost)?.id ?? this.players[0]?.id ?? null;
  }

  // ─────────────────── 快照与恢复（进行中对局持久化） ───────────────────

  /** 仅供单元测试：不经过技能链直接让一名玩家出局（毒杀死因，压住猎人/狼王开枪）。 */
  killForTest(seat: number): void {
    const p = this.bySeat(seat);
    if (p) this.kill(p, 'POISON');
  }

  /**
   * 把整局游戏状态导出成**纯 JSON 数据**（服务端重启后据此恢复）。
   *
   * 纪律：
   * - 快照是上帝视角（含所有隐藏身份），只允许落库，绝不能发给任何客户端。
   * - `onlineSeats` 不进快照 —— 它是「此刻谁连着」的瞬时事实，恢复后由服务端重算
   *   （没人连着时为空集，引擎会退化成最严格判定，正是恢复瞬间该有的语义）。
   * - 每加一个 Game 的字段，这里和 `restore()` 必须**同步**补上；
   *   `engine.test.ts` 的「快照回环」用例会在漏字段时失败（恢复后再快照对不上）。
   */
  snapshot(): GameSnapshot {
    return {
      v: GAME_SNAPSHOT_VERSION,
      roomId: this.roomId,
      config: { ...this.config },
      phase: this.phase,
      day: this.day,
      deadline: this.deadline,
      countdown: this.countdown,
      countdownEndsAt: this.countdownEndsAt,
      holdAdvance: this.holdAdvance,
      hostPlayerId: this.hostPlayerId,
      roleRevealConfirmed: [...this.roleRevealConfirmed],
      lastCharmedSeat: this.lastCharmedSeat,
      darkLordReflectUsed: this.darkLordReflectUsed,
      players: this.players.map((p) => ({ ...p })),
      night: {
        ...this.night,
        wolfPicks: [...this.night.wolfPicks.entries()],
        puppetPicks: [...this.night.puppetPicks.entries()],
      },
      witchPotions: { ...this.witchPotions },
      seerHistory: [...this.seerHistory.entries()],
      spiritHistory: [...this.spiritHistory.entries()],
      hybridModelSeat: this.hybridModelSeat,
      mechanicalLearnedRole: this.mechanicalLearnedRole,
      mechanicalLearnedDay: this.mechanicalLearnedDay,
      mechanicalPoisonAvailable: this.mechanicalPoisonAvailable,
      mechanicalLastGuardedSeat: this.mechanicalLastGuardedSeat,
      danceUsedSeats: [...this.danceUsedSeats],
      danceHistory: this.danceHistory.map((e) => ({ ...e })),
      maskHistory: this.maskHistory.map((e) => ({ ...e })),
      lastMaskInspectSeat: this.lastMaskInspectSeat,
      lastMaskTargetSeat: this.lastMaskTargetSeat,
      lastDreamedSeat: this.lastDreamedSeat,
      dreamHistory: this.dreamHistory.map((e) => ({ ...e })),
      lastDayExiledSeat: this.lastDayExiledSeat,
      graveHistory: this.graveHistory.map((e) => ({ ...e })),
      knightUsed: this.knightUsed,
      votes: [...this.votes.entries()],
      sheriffSeat: this.sheriffSeat,
      sheriffElectionFinished: this.sheriffElectionFinished,
      sheriffSignup: [...this.sheriffSignup.entries()],
      sheriffCandidates: [...this.sheriffCandidates],
      sheriffWithdrawn: [...this.sheriffWithdrawn],
      sheriffVotes: [...this.sheriffVotes.entries()],
      sheriffTieCandidates: [...this.sheriffTieCandidates],
      sheriffSpeechOrder: [...this.sheriffSpeechOrder],
      sheriffElectionRound: this.sheriffElectionRound,
      // 三态字段（undefined = 还没决定 / null = 决定放弃 / 数字 = 选了人）：
      // JSON 序列化天然保留这个语义 —— undefined 的键会被丢掉，恢复时读不到就是 undefined。
      sheriffTransferChoice: this.sheriffTransferChoice,
      sheriffTransferFrom: this.sheriffTransferFrom,
      sheriffTransferReturn: this.sheriffTransferReturn,
      speechDirection: this.speechDirection,
      deaths: this.deaths.map((d) => ({ ...d })),
      lastNightDeaths: [...this.lastNightDeaths],
      exiled: this.exiled ? { ...this.exiled } : null,
      voteDetail: this.voteDetail.map((v) => ({ ...v })),
      hunterPendingSeat: this.hunterPendingSeat,
      hunterQueue: [...this.hunterQueue],
      hunterChoice: this.hunterChoice,
      hunterReturnPhase: this.hunterReturnPhase,
      boomPendingSeat: this.boomPendingSeat,
      boomChoice: this.boomChoice,
      lastGuardedSeat: this.lastGuardedSeat,
      puppetSeat: this.puppetSeat,
      wolfTags: [...this.wolfTags.entries()],
      wolfTagTargets: [...this.wolfTagTargets.entries()],
      winner: this.winner,
      draw: this.draw,
      log: [...this.log],
      secretLog: [...this.secretLog],
      boomAnnouncements: [...this.boomAnnouncements],
      replayNights: this.replayNights.map((n) => structuredClone(n)),
      replayDayVotes: this.replayDayVotes.map((v) => ({ ...v, votes: v.votes.map((x) => ({ ...x })) })),
      revealAllRequested: [...this.revealAllRequested],
      speechStartSeat: this.speechStartSeat,
      rngState: this.rng.state,
      boardRoles: [...this.boardRoles],
      puppetEnabled: this.puppetEnabled,
    };
  }

  /**
   * 从快照重建一局游戏。**不走构造函数**：构造函数会发牌、重置历史，
   * 而恢复要的是「原样继续」。
   *
   * 版本不符或结构明显损坏时返回 null —— 调用方（hub）应丢弃这份快照，
   * 宁可丢一局也不要加载出一个规则错乱的局。
   */
  static restore(input: unknown): Game | null {
    if (typeof input !== 'object' || input === null) return null;
    const snap = input as Partial<GameSnapshot>;
    if (snap.v !== GAME_SNAPSHOT_VERSION) return null;
    if (!Array.isArray(snap.players) || snap.players.length === 0) return null;
    if (typeof snap.phase !== 'string' || !PHASE_NAMES.has(snap.phase)) return null;
    if (typeof snap.roomId !== 'string') return null;
    if (!Array.isArray(snap.boardRoles)) return null;
    if (typeof snap.rngState !== 'number') return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- readonly 字段只能绕过类型系统一次性写入
      const g: any = Object.create(Game.prototype);
      g.roomId = snap.roomId;
      g.config = { ...DEFAULT_ROOM_CONFIG, ...(snap.config ?? {}) };
      g.phase = snap.phase;
      g.day = snap.day ?? 0;
      g.deadline = snap.deadline ?? null;
      g.countdown = snap.countdown ?? null;
      g.countdownEndsAt = snap.countdownEndsAt ?? null;
      g.holdAdvance = snap.holdAdvance === true;
      g.onlineSeats = new Set<number>();
      g.hostPlayerId = snap.hostPlayerId ?? null;
      g.roleRevealConfirmed = new Set(snap.roleRevealConfirmed ?? []);
      g.lastCharmedSeat = snap.lastCharmedSeat ?? null;
      g.darkLordReflectUsed = snap.darkLordReflectUsed === true;
      g.players = snap.players.map((p) => ({ ...p }));
      const night = snap.night;
      g.night = night
        ? {
          ...night,
          wolfPicks: new Map(night.wolfPicks ?? []),
          puppetPicks: new Map(night.puppetPicks ?? []),
        }
        : emptyNight();
      g.witchPotions = snap.witchPotions ?? { antidote: true, poison: true };
      g.seerHistory = new Map(snap.seerHistory ?? []);
      g.spiritHistory = new Map(snap.spiritHistory ?? []);
      g.hybridModelSeat = snap.hybridModelSeat ?? null;
      g.mechanicalLearnedRole = snap.mechanicalLearnedRole ?? null;
      g.mechanicalLearnedDay = snap.mechanicalLearnedDay ?? null;
      g.mechanicalPoisonAvailable = snap.mechanicalPoisonAvailable !== false;
      g.mechanicalLastGuardedSeat = snap.mechanicalLastGuardedSeat ?? null;
      g.danceUsedSeats = new Set(snap.danceUsedSeats ?? []);
      g.danceHistory = snap.danceHistory ?? [];
      g.maskHistory = snap.maskHistory ?? [];
      g.lastMaskInspectSeat = snap.lastMaskInspectSeat ?? null;
      g.lastMaskTargetSeat = snap.lastMaskTargetSeat ?? null;
      g.lastDreamedSeat = snap.lastDreamedSeat ?? null;
      g.dreamHistory = snap.dreamHistory ?? [];
      g.lastDayExiledSeat = snap.lastDayExiledSeat ?? null;
      g.graveHistory = snap.graveHistory ?? [];
      g.knightUsed = snap.knightUsed === true;
      g.votes = new Map(snap.votes ?? []);
      g.sheriffSeat = snap.sheriffSeat ?? null;
      g.sheriffElectionFinished = snap.sheriffElectionFinished === true;
      g.sheriffSignup = new Map(snap.sheriffSignup ?? []);
      g.sheriffCandidates = new Set(snap.sheriffCandidates ?? []);
      g.sheriffWithdrawn = new Set(snap.sheriffWithdrawn ?? []);
      g.sheriffVotes = new Map(snap.sheriffVotes ?? []);
      g.sheriffTieCandidates = snap.sheriffTieCandidates ?? [];
      g.sheriffSpeechOrder = snap.sheriffSpeechOrder ?? [];
      g.sheriffElectionRound = snap.sheriffElectionRound ?? 0;
      g.sheriffTransferChoice = snap.sheriffTransferChoice;
      g.sheriffTransferFrom = snap.sheriffTransferFrom ?? null;
      g.sheriffTransferReturn = snap.sheriffTransferReturn ?? 'ANNOUNCE';
      g.speechDirection = snap.speechDirection ?? null;
      g.deaths = snap.deaths ?? [];
      g.lastNightDeaths = snap.lastNightDeaths ?? [];
      g.exiled = snap.exiled ?? null;
      g.voteDetail = snap.voteDetail ?? [];
      g.hunterPendingSeat = snap.hunterPendingSeat ?? null;
      g.hunterQueue = snap.hunterQueue ?? [];
      g.hunterChoice = snap.hunterChoice;
      g.hunterReturnPhase = snap.hunterReturnPhase ?? 'DAY_VOTE';
      g.boomPendingSeat = snap.boomPendingSeat ?? null;
      g.boomChoice = snap.boomChoice;
      g.lastGuardedSeat = snap.lastGuardedSeat ?? null;
      g.puppetSeat = snap.puppetSeat ?? null;
      g.wolfTags = new Map(snap.wolfTags ?? []);
      g.wolfTagTargets = new Map(snap.wolfTagTargets ?? []);
      g.winner = snap.winner ?? null;
      g.draw = snap.draw === true;
      g.log = snap.log ?? [];
      g.secretLog = snap.secretLog ?? [];
      g.boomAnnouncements = snap.boomAnnouncements ?? [];
      g.replayNights = snap.replayNights ?? [];
      g.replayDayVotes = snap.replayDayVotes ?? [];
      g.revealAllRequested = new Set(snap.revealAllRequested ?? []);
      g.speechStartSeat = snap.speechStartSeat ?? null;
      g.rng = SeededRng.resume(snap.rngState);
      // 下面几个构造期派生值从恢复后的牌面重算 —— 角色整局不变，重算结果与开局一致
      g.initialGods = (g.players as PlayerState[]).filter((p) => isGod(p.role)).length;
      g.initialVillagers = (g.players as PlayerState[]).filter(
        (p) => p.role === 'VILLAGER' || p.role === 'HYBRID',
      ).length;
      g.deckSize = snap.boardRoles.length;
      g.boardRoles = [...snap.boardRoles];
      g.puppetEnabled = snap.puppetEnabled === true;
      return g as Game;
    } catch {
      return null;
    }
  }

  // ─────────────────── 查询辅助 ───────────────────

  get playerCount(): number {
    return this.players.length;
  }

  private byId(id: string): PlayerState | undefined {
    return this.players.find((p) => p.id === id);
  }

  private bySeat(seat: number): PlayerState | undefined {
    return this.players.find((p) => p.seat === seat);
  }

  private alivePlayers(): PlayerState[] {
    return this.players.filter((p) => p.alive);
  }

  private aliveSeats(): number[] {
    return this.alivePlayers().map((p) => p.seat);
  }

  /**
   * 玩家的**真实阵营**。
   *
   * 为什么要和「角色阵营」分开：傀儡保留原底牌（预言家/女巫/猎人/守卫/平民），
   * 但他已经**属于狼人阵营**了 —— 他本人却不知道。
   *
   * 所以全项目分成两套：
   *   - **真实阵营**（这个函数）→ 胜负判定、真预言家查验、守墓人、骑士决斗
   *   - **角色阵营**（`isWolfRole(role)`）→ 傀儡自己看到的阵营、狼队互认
   *
   * 第二套必须是角色阵营：一旦让傀儡看到「阵营：狼人」，他立刻就知道自己中招，
   * 这个板子唯一的设计目的（信息污染）就没了。同理，狼队互认也必须用角色阵营，
   * 否则傀儡会看到三个狼队友。
   */
  private truthCamp(player: PlayerState): Camp {
    if (player.seat === this.puppetSeat) return 'WOLF';
    return isWolfRole(player.role) ? 'WOLF' : 'GOOD';
  }

  /** 某个座位的真实阵营（给只有座位号的地方用） */
  private truthCampOfSeat(seat: number): Camp {
    const player = this.bySeat(seat);
    return player ? this.truthCamp(player) : 'GOOD';
  }

  /**
   * 预言家（或机械狼复制的查验）**看到的**阵营。
   *
   * 傀儡的查验结果是**反的**：验真狼显示【好人】、验好人显示【狼人】。
   * 这比「技能失效」狠得多 —— 他会拿着完全错误的结论，非常认真地帮倒忙。
   *
   * 注意：返回的是「他该看到什么」，调用方要把它同时写进
   * `night.seerCamp` 和 `seerHistory`，两边必须一致。
   */
  private seerCampAsSeenBy(seer: PlayerState, target: PlayerState): Camp {
    const truth = this.truthCamp(target);
    if (seer.seat !== this.puppetSeat) return truth;
    return truth === 'WOLF' ? 'GOOD' : 'WOLF';
  }

  /**
   * 活着的**狼人阵营成员**（含傀儡）。
   *
   * 傀儡算进来是刻意的：他已经是狼人阵营，好人必须把他处理掉才能满足胜利条件
   * （官方规则：即使三狼全部死亡，傀儡也不能接刀，但好人仍要清掉他）。
   */
  private aliveWolves(): PlayerState[] {
    return this.players.filter((p) => p.alive && this.truthCamp(p) === 'WOLF');
  }

  /** 真正参与当夜狼刀的玩家；机械狼只有学习狼人身份后的下一夜才加入。 */
  /**
   * 参与狼刀的成员：普通狼 / 白狼王 / 狼王，加上与狼互认的狼美人和恶灵骑士
   * （官方规则：她们夜里和狼队一起睁眼点刀；她们自己不能被刀——见 KNIFE_EXEMPT_ROLES）。
   */
  private aliveKnifeWolves(): PlayerState[] {
    return this.players.filter((p) => {
      if (!p.alive) return false;
      if (p.role === 'WOLF' || p.role === 'WOLF_KING' || p.role === 'BLACK_WOLF_KING' ||
        p.role === 'WOLF_BEAUTY' || p.role === 'DARK_LORD') return true;
      if (p.role === 'MASK') return this.maskHasKnife();
      return p.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() &&
        (this.mechanicalLearnedRole === 'WOLF' ||
          this.mechanicalLearnedRole === 'WOLF_KING' ||
          this.mechanicalLearnedRole === 'BLACK_WOLF_KING');
    });
  }

  /**
   * 普通狼（含尚未隔离的狼系角色）全部出局后，假面从下一次狼刀阶段起接刀。
   *
   * 傀儡不算「普通狼」：他不能刀人、也永远不会接刀。
   */
  private maskHasKnife(): boolean {
    const mask = this.aliveSole('MASK');
    if (!mask) return false;
    return !this.players.some(
      (p) => p.alive && p.role !== 'MASK' && p.seat !== this.puppetSeat && isWolfRole(p.role),
    );
  }

  private dancerCandidates(): number[] {
    return this.aliveSeats().filter((seat) => !this.danceUsedSeats.has(seat));
  }

  private maskInspectCandidates(): number[] {
    return this.aliveSeats().filter((seat) => seat !== this.lastMaskInspectSeat);
  }

  private maskTargetCandidates(): number[] {
    return this.aliveSeats().filter((seat) => seat !== this.lastMaskTargetSeat);
  }

  private wolfSeats(): number[] {
    return this.players
      .filter((p) => p.role === 'WOLF' || p.role === 'WOLF_KING' || p.role === 'BLACK_WOLF_KING' ||
        p.role === 'WOLF_BEAUTY' || p.role === 'DARK_LORD' ||
        (p.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() &&
          (this.mechanicalLearnedRole === 'WOLF' ||
            this.mechanicalLearnedRole === 'WOLF_KING' ||
            this.mechanicalLearnedRole === 'BLACK_WOLF_KING')))
      .map((p) => p.seat);
  }

  private mechanicalSkillActive(): boolean {
    return this.mechanicalLearnedRole !== null && this.mechanicalLearnedDay !== null && this.day > this.mechanicalLearnedDay;
  }

  private mechanical(): PlayerState | undefined {
    return this.soleOf('MECHANICAL_WOLF');
  }

  /**
   * 「认识狼队」的判定：普通狼 / 白狼王 / 狼王互认；
   * 狼美人和恶灵骑士按官方规则**与狼人互认**（夜里一起睁眼、一起参与点刀）。
   * 唯一的例外是**假面**——她与普通狼不互认（暗狼设计，见她的角色说明），
   * 只有普通狼全灭后接过刀权时才入队。机械狼学过狼系身份并生效后才入队。
   */
  private knowsWolfPack(player: PlayerState): boolean {
    return player.role === 'WOLF' || player.role === 'WOLF_KING' || player.role === 'BLACK_WOLF_KING' ||
      player.role === 'WOLF_BEAUTY' || player.role === 'DARK_LORD' ||
      (player.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() &&
        (this.mechanicalLearnedRole === 'WOLF' ||
          this.mechanicalLearnedRole === 'WOLF_KING' ||
          this.mechanicalLearnedRole === 'BLACK_WOLF_KING'));
  }

  private soleOf(role: Role): PlayerState | undefined {
    return this.players.find((p) => p.role === role);
  }

  /** 活着的某个唯一角色（守卫 / 预言家 / 女巫 / 猎人） */
  private aliveSole(role: Role): PlayerState | undefined {
    const p = this.soleOf(role);
    return p && p.alive ? p : undefined;
  }

  /** 拥有投票权的玩家：存活且未翻牌的白痴 */
  private aliveVoters(): PlayerState[] {
    return this.players.filter((p) => p.alive && !p.idiotRevealed);
  }

  /** 可被投票放逐的目标：存活，且不是已翻牌的白痴 */
  private voteTargets(excludeSeat?: number): number[] {
    return this.players
      .filter((p) => p.alive && !p.idiotRevealed && p.seat !== excludeSeat)
      .map((p) => p.seat);
  }

  isDeadSeat(seat: number): boolean {
    const p = this.bySeat(seat);
    return p ? !p.alive : true;
  }

  /**
   * 守卫本夜可以守谁：所有存活玩家，但排除上一夜守过的那一个。
   * 排除之后没人可守时返回空数组（例如场上只剩两人且另一人刚好是上一夜守过的）。
   */
  private guardCandidates(): number[] {
    return this.aliveSeats().filter((s) => s !== this.lastGuardedSeat);
  }

  /** 守卫本夜是否需要做决定 */
  private guardHasDecision(): boolean {
    if (!this.aliveSole('GUARD')) return false;
    return this.guardCandidates().length > 0;
  }

  // ─────────────────── 开局 ───────────────────

  start(): ActResult {
    if (this.phase !== 'WAITING') return fail('BAD_PHASE', '游戏已经开始');
    if (this.players.length !== this.deckSize) {
      return fail(
        'PLAYER_COUNT',
        `牌堆有 ${this.deckSize} 张牌，但有 ${this.players.length} 名玩家 —— 两者必须相等`,
      );
    }
    this.day = 1;
    // 发牌之后**不直接进夜晚**，先给所有人时间看清自己的身份牌。
    //
    // 为什么必须这样：第一夜第一个行动的角色是混血儿（首夜选榜样，不可逆），
    // 他的能力说明光读就要十几秒。原来的流程是「房主点开始 → 立刻天黑 → 5 秒后
    // 混血儿开始 30 秒倒计时」，等于逼人在没看懂规则的情况下做一个不可逆决定。
    // 更普遍的危害是：同样 90 秒的狼人时间，对熟悉规则的人和不熟的人不等价 ——
    // 时间在这里又一次决定了信息优势，只不过方向变成了「谁读得快谁占便宜」。
    this.pushLog(
      `【第 1 天】本局共 ${this.players.length} 人：${this.boardSummaryText()}。请查看你的身份牌，全员确认后由房主开始第一夜。`,
    );
    this.enter('ROLE_REVEAL');
    return OK;
  }

  // ─────────────────── 身份确认（发牌之后、天黑之前） ───────────────────

  /**
   * 玩家表示「我已看清我的身份牌」。
   *
   * 服务端只能确认「这个人点过按钮」，无法确认他真的看了牌 ——
   * 这是刻意的：想糊弄的人本来就会糊弄，加校验只是给自己找麻烦。
   * 这个阶段真正的价值是**给时间**，不是**做审查**。
   */
  confirmRole(playerId: string): ActResult {
    if (this.phase !== 'ROLE_REVEAL') return fail('BAD_PHASE', '现在不是查看身份牌阶段');
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (this.roleRevealConfirmed.has(playerId)) return fail('ALREADY_DONE', '你已经确认过了');
    this.roleRevealConfirmed.add(playerId);
    const left = this.pendingRoleRevealSeats().length;
    if (left === 0) {
      this.pushLog('所有人都已确认身份。等房主按下「天黑请闭眼」。');
    }
    return OK;
  }

  /** 还没确认的座位（按座位号升序，房主照着这个喊人） */
  pendingRoleRevealSeats(): number[] {
    return this.players
      .filter((p) => !this.roleRevealConfirmed.has(p.id))
      .map((p) => p.seat)
      .sort((a, b) => a - b);
  }

  /** 已确认的座位 */
  confirmedRoleRevealSeats(): number[] {
    return this.players
      .filter((p) => this.roleRevealConfirmed.has(p.id))
      .map((p) => p.seat)
      .sort((a, b) => a - b);
  }

  /**
   * 硬门槛是否满足：**在线的人一个都不能少**。
   *
   * 为什么要给掉线的人豁免：门槛的本意是「不能有人在没看牌的情况下被推进夜晚」，
   * 而掉线的人根本点不了按钮。如果把他算进门槛，12 人局里只要有一台手机没电，
   * 全场就永久锁死 —— 房主唯一的出路变成踢人，那比放他过去糟糕得多。
   * 他回来之后仍然能看牌、仍然能确认（只要还没天黑）。
   */
  canBeginNight(): boolean {
    if (this.phase !== 'ROLE_REVEAL') return false;
    // 拿不到在线信息时（测试、异常情况）退化成最严格：要求全员确认
    const required =
      this.onlineSeats.size > 0
        ? this.players.filter((p) => this.onlineSeats.has(p.seat))
        : this.players;
    return required.every((p) => this.roleRevealConfirmed.has(p.id));
  }

  /** 房主按下「天黑请闭眼」—— 第一夜正式开始 */
  beginNight(): ActResult {
    if (this.phase !== 'ROLE_REVEAL') return fail('BAD_PHASE', '现在不是查看身份牌阶段');
    if (!this.canBeginNight()) {
      const pending = this.pendingRoleRevealSeats();
      return fail('NOT_READY', `还有 ${pending.length} 人没确认身份：${pending.join('、')} 号`);
    }
    this.pushLog(`【第 1 天】天黑请闭眼，游戏开始。`);
    this.enter('NIGHT_START');
    return OK;
  }

  private boardSummaryText(): string {
    const counts = new Map<Role, number>();
    for (const p of this.players) counts.set(p.role, (counts.get(p.role) ?? 0) + 1);
    const parts: string[] = [];
    for (const [role, count] of counts) parts.push(`${count} ${ROLE_NAME[role]}`);
    return parts.join(' / ');
  }

  // ─────────────────── 玩家行动 ───────────────────

  submitNightAction(playerId: string, action: NightAction): ActResult {
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');

    switch (action.kind) {
      case 'dancer': {
        if (this.phase !== 'NIGHT_DANCER') return fail('BAD_PHASE', '现在不是舞者行动阶段');
        if (me.role !== 'DANCER' || !me.alive) return fail('NOT_YOUR_TURN', '你不是存活的舞者');
        if (this.night.dancerActed) return fail('ALREADY_DONE', '你本夜已经选择过舞池');
        const targets = [...new Set(action.targets)];
        if (targets.length !== 3 || action.targets.length !== 3) {
          return fail('INVALID_TARGET', '舞池必须恰好选择三名不同的玩家');
        }
        const legal = new Set(this.dancerCandidates());
        if (targets.some((seat) => !legal.has(seat))) {
          return fail('INVALID_TARGET', '目标已出局或本局已经进入过舞池');
        }
        this.night.dancerTargets = targets.slice();
        this.night.dancerActed = true;
        for (const seat of targets) this.danceUsedSeats.add(seat);
        this.danceHistory.push({ day: this.day, seats: targets.slice() });
        this.pushSecret(`舞者选择舞池：${targets.join('、')} 号`);
        this.settle();
        return OK;
      }
      case 'maskInspect': {
        if (this.phase !== 'NIGHT_MASK') return fail('BAD_PHASE', '现在不是假面行动阶段');
        if (me.role !== 'MASK' || !me.alive) return fail('NOT_YOUR_TURN', '你不是存活的假面');
        if (this.night.maskInspectActed) return fail('ALREADY_DONE', '你本夜已经查验过舞池');
        if (!this.maskInspectCandidates().includes(action.target)) {
          return fail('INVALID_TARGET', '查验目标已出局，或与上一夜查验目标相同');
        }
        this.night.maskInspectTarget = action.target;
        this.night.maskInspectResult = this.night.dancerTargets.includes(action.target);
        this.night.maskInspectActed = true;
        this.settle();
        return OK;
      }
      case 'mask': {
        if (this.phase !== 'NIGHT_MASK') return fail('BAD_PHASE', '现在不是假面行动阶段');
        if (me.role !== 'MASK' || !me.alive) return fail('NOT_YOUR_TURN', '你不是存活的假面');
        if (!this.night.maskInspectActed) return fail('NOT_YOUR_TURN', '请先查验一名玩家是否在舞池');
        if (this.night.maskActed) return fail('ALREADY_DONE', '你本夜已经给过面具');
        if (!this.maskTargetCandidates().includes(action.target)) {
          return fail('INVALID_TARGET', '面具目标已出局，或与上一夜面具目标相同');
        }
        this.night.maskTarget = action.target;
        this.night.maskActed = true;
        this.lastMaskInspectSeat = this.night.maskInspectTarget;
        this.lastMaskTargetSeat = action.target;
        this.maskHistory.push({
          day: this.day,
          inspectSeat: this.night.maskInspectTarget!,
          inDance: this.night.maskInspectResult === true,
          maskSeat: action.target,
        });
        this.pushSecret(`假面查验 ${this.night.maskInspectTarget} 号，并给 ${action.target} 号戴面具`);
        this.settle();
        return OK;
      }
      case 'dreamer': {
        if (this.phase !== 'NIGHT_DREAMER') return fail('BAD_PHASE', '现在不是摄梦人行动阶段');
        if (me.role !== 'DREAMER' || !me.alive) return fail('NOT_YOUR_TURN', '你不是存活的摄梦人');
        if (this.night.dreamerActed) return fail('ALREADY_DONE', '你本夜已经选择过梦游者');
        if (action.target === me.seat || !this.aliveSeats().includes(action.target)) {
          return fail('INVALID_TARGET', '请选择另一名存活玩家作为梦游者');
        }
        this.night.dreamerTarget = action.target;
        this.night.dreamerActed = true;
        this.dreamHistory.push({ day: this.day, seat: action.target });
        this.pushSecret(`摄梦人（${me.seat} 号）选择 ${action.target} 号成为梦游者`);
        this.settle();
        return OK;
      }
      case 'wolf': {
        if (this.phase !== 'NIGHT_WOLVES') return fail('BAD_PHASE', '现在不是狼人行动阶段');
        if (!this.aliveKnifeWolves().some((wolf) => wolf.id === me.id)) {
          return fail('NOT_YOUR_TURN', '你当前没有狼刀权');
        }
        if (action.target !== null && !this.aliveSeats().includes(action.target)) {
          return fail('INVALID_TARGET', '目标不是存活玩家');
        }
        // 狼美人和恶灵骑士「不能自刀」：狼队不能把刀口指向他们。
        // 在服务端拦住而不是只在界面上藏起来 —— 界面上藏是纸糊的。
        if (action.target !== null && !this.knifeCandidates().includes(action.target)) {
          const blocked = this.bySeat(action.target);
          return fail(
            'INVALID_TARGET',
            `${action.target} 号（${blocked ? ROLE_NAME[blocked.role] : '?'}）不能自刀`,
          );
        }
        this.night.wolfPicks.set(me.seat, action.target);
        /**
         * 「唯邻是从」：首夜狼队在刀人的同时还要选一名**傀儡**。
         *
         * 首夜必须选（`puppet === undefined` 直接拒绝），因为不选就没法开局 ——
         * 这个板子的全部玩法建立在那一次转化上。
         * 选人范围由服务端校验（`puppetCandidates()`），界面上藏起来是没用的。
         */
        if (this.puppetCandidates().length > 0) {
          const puppet = action.puppet;
          if (puppet === undefined || puppet === null) {
            return fail('INVALID_TARGET', '首夜必须选择一名傀儡（只能从与狼相邻的好人里选）');
          }
          if (!this.puppetCandidates().includes(puppet)) {
            const blocked = this.bySeat(puppet);
            return fail(
              'INVALID_TARGET',
              `${puppet} 号（${blocked ? ROLE_NAME[blocked.role] : '?'}）不能成为傀儡：只能选与狼相邻的好人`,
            );
          }
          this.night.puppetPicks.set(me.seat, puppet);
        }
        this.settle();
        return OK;
      }
      case 'guard': {
        if (this.phase !== 'NIGHT_GUARD') return fail('BAD_PHASE', '现在不是守卫行动阶段');
        const guard = this.soleOf('GUARD');
        if (!guard || guard.id !== me.id) return fail('NOT_YOUR_TURN', '你不是守卫');
        if (!guard.alive) return fail('DEAD', '你已经出局');
        if (this.night.guardActed) return fail('ALREADY_DONE', '你本夜已经守护过了');
        if (!this.aliveSeats().includes(action.target)) {
          return fail('INVALID_TARGET', '目标不是存活玩家');
        }
        if (action.target === this.lastGuardedSeat) {
          return fail(
            'INVALID_TARGET',
            `不能连续两晚守护同一名玩家（${action.target} 号是你上一夜守过的人）`,
          );
        }
        this.night.guardTarget = action.target;
        this.night.guardActed = true;
        this.settle();
        return OK;
      }
      case 'witch': {
        if (this.phase !== 'NIGHT_WITCH') return fail('BAD_PHASE', '现在不是女巫行动阶段');
        const witch = this.soleOf('WITCH');
        if (!witch || witch.id !== me.id) return fail('NOT_YOUR_TURN', '你不是女巫');
        if (this.night.witchActed) return fail('ALREADY_DONE', '你本夜已经行动过了');
        if (action.save && action.poison !== null) {
          return fail('INVALID_TARGET', '同一夜不能同时使用解药和毒药');
        }
        if (action.save) {
          if (!this.witchPotions.antidote) return fail('INVALID_TARGET', '解药已经用过了');
          if (this.night.wolfTarget === null) return fail('INVALID_TARGET', '今晚没有人被狼人杀害');
          if (this.night.wolfTarget === witch.seat && !this.config.witchCanSelfSave) {
            return fail('INVALID_TARGET', '本局规则不允许女巫自救');
          }
        }
        if (action.poison !== null) {
          if (!this.witchPotions.poison) return fail('INVALID_TARGET', '毒药已经用过了');
          if (action.poison === witch.seat) return fail('INVALID_TARGET', '不能毒自己');
          if (!this.aliveSeats().includes(action.poison)) {
            return fail('INVALID_TARGET', '目标不是存活玩家');
          }
        }
        this.night.witchSave = action.save;
        this.night.witchPoison = action.poison;
        this.night.witchActed = true;
        // 毒恶灵骑士会反噬自己 —— 女巫是夜间最先行动的，所以她一定吃这一下
        if (action.poison !== null && this.bySeat(action.poison)?.role === 'DARK_LORD') {
          this.noteDarkLordReflect(witch);
        }
        this.settle();
        return OK;
      }
      case 'seer': {
        if (this.phase !== 'NIGHT_SEER') return fail('BAD_PHASE', '现在不是预言家查验阶段');
        const seer = this.soleOf('SEER');
        if (!seer || seer.id !== me.id) return fail('NOT_YOUR_TURN', '你不是预言家');
        if (!seer.alive) return fail('DEAD', '你已经出局');
        if (this.night.seerActed) return fail('ALREADY_DONE', '你本夜已经查验过了');
        if (action.target === seer.seat) return fail('INVALID_TARGET', '不能查验自己');
        const target = this.bySeat(action.target);
        if (!target || !target.alive) return fail('INVALID_TARGET', '目标不是存活玩家');

        this.night.seerTarget = target.seat;
        // 傀儡预言家的验人结果**相反**（这是「唯邻是从」的核心污染手段），
        // 所以先算真实阵营，再决定要不要反转。写入 seerHistory 的必须是
        // **反转后**的结果 —— 否则他按住身份牌翻历史，一对就发现自己是傀儡了。
        this.night.seerCamp = this.seerCampAsSeenBy(me, target);
        this.night.seerActed = true;
        const history = this.seerHistory.get(seer.seat) ?? [];
        history.push({ seat: target.seat, camp: this.night.seerCamp });
        this.seerHistory.set(seer.seat, history);
        // 查验恶灵骑士会被反伤 —— 而且结果是「狼」，等于用命换一条情报
        if (target.role === 'DARK_LORD') this.noteDarkLordReflect(seer);
        this.settle();
        return OK;
      }
      case 'hybrid': {
        if (this.phase !== 'NIGHT_HYBRID') return fail('BAD_PHASE', '现在不是混血儿选择榜样阶段');
        if (me.role !== 'HYBRID' || !me.alive) return fail('NOT_YOUR_TURN', '你不是存活的混血儿');
        if (this.night.hybridActed || this.hybridModelSeat !== null) return fail('ALREADY_DONE', '你已经选择过榜样');
        if (action.target === me.seat || !this.aliveSeats().includes(action.target)) {
          return fail('INVALID_TARGET', '请选择另一名存活玩家作为榜样');
        }
        this.night.hybridTarget = action.target;
        this.night.hybridActed = true;
        this.hybridModelSeat = action.target;
        this.pushSecret(`混血儿（${me.seat} 号）选择 ${action.target} 号为榜样`);
        this.settle();
        return OK;
      }
      case 'mechanicalLearn': {
        if (this.phase !== 'NIGHT_MECHANICAL') return fail('BAD_PHASE', '现在不是机械狼学习阶段');
        if (me.role !== 'MECHANICAL_WOLF' || !me.alive) return fail('NOT_YOUR_TURN', '你不是存活的机械狼');
        if (this.mechanicalLearnedRole !== null || this.night.mechanicalLearnActed) return fail('ALREADY_DONE', '你已经学习过身份');
        const target = this.bySeat(action.target);
        if (!target || !target.alive || target.seat === me.seat) return fail('INVALID_TARGET', '请选择另一名存活玩家');
        this.night.mechanicalLearnTarget = target.seat;
        this.night.mechanicalLearnActed = true;
        this.mechanicalLearnedRole = target.role;
        this.mechanicalLearnedDay = this.day;
        this.pushSecret(`机械狼（${me.seat} 号）学习了 ${target.seat} 号的【${ROLE_NAME[target.role]}】`);
        this.settle();
        return OK;
      }
      case 'beautyCharm': {
        if (this.phase !== 'NIGHT_BEAUTY_CHARM') {
          return fail('BAD_PHASE', '现在不是狼美人魅惑阶段');
        }
        const beauty = this.soleOf('WOLF_BEAUTY');
        if (!beauty || beauty.id !== me.id) return fail('NOT_YOUR_TURN', '你不是狼美人');
        if (!beauty.alive) return fail('DEAD', '你已经出局');
        if (this.night.beautyCharmActed) return fail('ALREADY_DONE', '你本夜已经魅惑过了');
        if (action.target === beauty.seat) return fail('INVALID_TARGET', '不能魅惑自己');
        const charmTarget = this.bySeat(action.target);
        if (!charmTarget || !charmTarget.alive) return fail('INVALID_TARGET', '目标不是存活玩家');

        this.night.beautyCharmTarget = charmTarget.seat;
        this.night.beautyCharmActed = true;
        this.pushSecret(`狼美人（${beauty.seat} 号）魅惑了 ${charmTarget.seat} 号`);
        this.settle();
        return OK;
      }
      case 'spiritSeer': {
        if (this.phase !== 'NIGHT_SPIRIT_SEER') return fail('BAD_PHASE', '现在不是通灵师查验阶段');
        if (me.role !== 'SPIRIT_SEER' || !me.alive) return fail('NOT_YOUR_TURN', '你不是存活的通灵师');
        if (this.night.spiritActed) return fail('ALREADY_DONE', '你本夜已经查验过了');
        const target = this.bySeat(action.target);
        if (!target || !target.alive || target.seat === me.seat) return fail('INVALID_TARGET', '请选择另一名存活玩家');
        this.night.spiritTarget = target.seat;
        this.night.spiritRole = target.role;
        this.night.spiritActed = true;
        const history = this.spiritHistory.get(me.seat) ?? [];
        history.push({ seat: target.seat, role: target.role });
        this.spiritHistory.set(me.seat, history);
        if (target.role === 'DARK_LORD') this.noteDarkLordReflect(me);
        this.settle();
        return OK;
      }
      case 'mechanicalSkill': {
        if (me.role !== 'MECHANICAL_WOLF' || !me.alive || !this.mechanicalSkillActive()) {
          return fail('NOT_YOUR_TURN', '机械狼复制技能尚未生效');
        }
        if (action.skill === 'guard') {
          if (this.phase !== 'NIGHT_GUARD' || this.mechanicalLearnedRole !== 'GUARD') return fail('BAD_PHASE', '当前不能使用复制守护');
          if (this.night.mechanicalGuardActed) return fail('ALREADY_DONE', '你本夜已经守护过了');
          if (action.target === null || !this.aliveSeats().includes(action.target) || action.target === this.mechanicalLastGuardedSeat) {
            return fail('INVALID_TARGET', '守护目标无效或与上一夜相同');
          }
          this.night.mechanicalGuardTarget = action.target;
          this.night.mechanicalGuardActed = true;
        } else if (action.skill === 'poison') {
          if (this.phase !== 'NIGHT_WITCH' || this.mechanicalLearnedRole !== 'WITCH') return fail('BAD_PHASE', '当前不能使用复制毒药');
          if (this.night.mechanicalPoisonActed) return fail('ALREADY_DONE', '你本夜已经决定过了');
          if (action.target !== null && (!this.mechanicalPoisonAvailable || action.target === me.seat || !this.aliveSeats().includes(action.target))) {
            return fail('INVALID_TARGET', '毒杀目标无效或复制毒药已经用过');
          }
          this.night.mechanicalPoison = action.target;
          this.night.mechanicalPoisonActed = true;
        } else if (action.skill === 'seer') {
          if (this.phase !== 'NIGHT_SEER' || this.mechanicalLearnedRole !== 'SEER') return fail('BAD_PHASE', '当前不能使用复制查验');
          if (this.night.mechanicalSeerActed) return fail('ALREADY_DONE', '你本夜已经查验过了');
          const target = action.target === null ? undefined : this.bySeat(action.target);
          if (!target || !target.alive || target.seat === me.seat) return fail('INVALID_TARGET', '查验目标无效');
          this.night.mechanicalSeerTarget = target.seat;
          this.night.mechanicalSeerCamp = this.seerCampAsSeenBy(me, target);
          this.night.mechanicalSeerActed = true;
          const history = this.seerHistory.get(me.seat) ?? [];
          history.push({ seat: target.seat, camp: this.night.mechanicalSeerCamp });
          this.seerHistory.set(me.seat, history);
        } else {
          if (this.phase !== 'NIGHT_SPIRIT_SEER' || this.mechanicalLearnedRole !== 'SPIRIT_SEER') return fail('BAD_PHASE', '当前不能使用复制通灵查验');
          if (this.night.mechanicalSpiritActed) return fail('ALREADY_DONE', '你本夜已经查验过了');
          const target = action.target === null ? undefined : this.bySeat(action.target);
          if (!target || !target.alive || target.seat === me.seat) return fail('INVALID_TARGET', '查验目标无效');
          this.night.mechanicalSpiritTarget = target.seat;
          this.night.mechanicalSpiritRole = target.role;
          this.night.mechanicalSpiritActed = true;
          const history = this.spiritHistory.get(me.seat) ?? [];
          history.push({ seat: target.seat, role: target.role });
          this.spiritHistory.set(me.seat, history);
        }
        this.settle();
        return OK;
      }
      case 'graveKeeper': {
        if (this.phase !== 'NIGHT_GRAVE_KEEPER') return fail('BAD_PHASE', '现在不是守墓人行动阶段');
        const keeper = this.soleOf('GRAVE_KEEPER');
        if (!keeper || keeper.id !== me.id) return fail('NOT_YOUR_TURN', '你不是守墓人');
        if (!keeper.alive) return fail('DEAD', '你已经出局');
        if (this.night.graveKeeperActed) return fail('ALREADY_DONE', '你本夜已经确认过了');
        this.night.graveKeeperActed = true;
        // 结果在进入阶段时就已经写入 graveHistory，这里只是收束确认
        this.settle();
        return OK;
      }
      default:
        return fail('BAD_MESSAGE', '未知的行动类型');
    }
  }

  submitVote(playerId: string, target: number | null): ActResult {
    if (this.phase !== 'DAY_VOTE') return fail('BAD_PHASE', '现在不是投票阶段');
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (!me.alive) return fail('DEAD', '你已经出局，无法投票');
    if (me.idiotRevealed) return fail('NOT_YOUR_TURN', '白痴翻牌后失去投票权');
    if (this.votes.has(me.seat)) return fail('ALREADY_DONE', '你已经投过票了');
    if (target !== null) {
      if (!this.voteTargets(me.seat).includes(target)) {
        return fail('INVALID_TARGET', '该目标不能被投票');
      }
    }
    this.votes.set(me.seat, target);
    this.settle();
    return OK;
  }

  /** 第一天所有存活玩家同时选择上警或留在警下。 */
  submitSheriffSignup(playerId: string, candidate: boolean): ActResult {
    if (this.phase !== 'SHERIFF_SIGNUP') return fail('BAD_PHASE', '现在不是上警报名阶段');
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (!me.alive) return fail('DEAD', '你已经出局，不能参与警长竞选');
    if (this.sheriffSignup.has(me.seat)) return fail('ALREADY_DONE', '你已经提交上警选择');
    this.sheriffSignup.set(me.seat, candidate);
    if (candidate) this.sheriffCandidates.add(me.seat);
    this.settle();
    return OK;
  }

  /** 候选人在警上发言或 PK 发言阶段可以退水。 */
  withdrawSheriff(playerId: string): ActResult {
    if (this.phase !== 'SHERIFF_CAMPAIGN' && this.phase !== 'SHERIFF_PK') {
      return fail('BAD_PHASE', '现在不能退水');
    }
    const me = this.byId(playerId);
    if (!me || !this.sheriffCandidates.has(me.seat)) return fail('NOT_YOUR_TURN', '你不是当前候选人');
    this.sheriffCandidates.delete(me.seat);
    this.sheriffWithdrawn.add(me.seat);
    this.pushLog(`${me.seat} 号（${me.nickname}）退出警长竞选。`);
    return OK;
  }

  /** 警下投票；候选人没有投票权，PK 轮仅能投给平票候选人。 */
  submitSheriffVote(playerId: string, target: number | null): ActResult {
    if (this.phase !== 'SHERIFF_VOTE' && this.phase !== 'SHERIFF_REVOTE') {
      return fail('BAD_PHASE', '现在不是警长投票阶段');
    }
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (!me.alive) return fail('DEAD', '你已经出局，不能投票');
    if (!this.sheriffVoterSeats().includes(me.seat)) return fail('NOT_YOUR_TURN', '候选人没有警长投票权');
    if (this.sheriffVotes.has(me.seat)) return fail('ALREADY_DONE', '你已经投过票了');
    if (target !== null && !this.currentSheriffCandidates().includes(target)) {
      return fail('INVALID_TARGET', '只能投给当前警长候选人');
    }
    this.sheriffVotes.set(me.seat, target);
    this.settle();
    return OK;
  }

  /** 死亡警长移交警徽；null 表示撕毁。 */
  submitSheriffTransfer(playerId: string, target: number | null): ActResult {
    if (this.phase !== 'SHERIFF_TRANSFER') return fail('BAD_PHASE', '现在不是移交警徽阶段');
    const me = this.byId(playerId);
    const deadSheriff = this.sheriffTransferFrom;
    if (!me || deadSheriff === null || me.seat !== deadSheriff) return fail('NOT_YOUR_TURN', '只有出局警长能处理警徽');
    if (this.sheriffTransferChoice !== undefined) return fail('ALREADY_DONE', '你已经处理过警徽');
    if (target !== null && !this.aliveSeats().includes(target)) return fail('INVALID_TARGET', '只能把警徽移交给存活玩家');
    this.sheriffTransferChoice = target;
    if (target === null) {
      this.pushLog(`${me.seat} 号警长选择撕毁警徽，本局不再有警长。`);
    } else {
      this.sheriffSeat = target;
      this.pushLog(`${me.seat} 号警长将警徽移交给 ${target} 号（${this.bySeat(target)?.nickname ?? '?'}）。`);
    }
    this.settle();
    return OK;
  }

  /** 白天发言前由警长指定从左侧或右侧开始。 */
  setSpeechDirection(playerId: string, direction: SheriffDirection): ActResult {
    if (this.phase !== 'DAY_SPEECH') return fail('BAD_PHASE', '现在不是白天发言阶段');
    const me = this.byId(playerId);
    if (!me || me.seat !== this.sheriffSeat || !me.alive) return fail('NOT_YOUR_TURN', '只有存活警长能指定发言方向');
    if (this.speechDirection !== null) return fail('ALREADY_DONE', '发言方向已经确定');
    this.speechDirection = direction;
    this.computeSpeechOrder();
    this.pushLog(`警长选择${direction === 'FORWARD' ? '顺时针' : '逆时针'}发言，警长最后归票。`);
    return OK;
  }

  submitHunterShoot(playerId: string, target: number | null): ActResult {
    if (this.phase !== 'HUNTER_SHOOT') return fail('BAD_PHASE', '现在不是死亡开枪阶段');
    const shooter = this.byId(playerId);
    if (!shooter || !this.hasDeathShotAbility(shooter)) return fail('NOT_YOUR_TURN', '你没有死亡开枪能力');
    if (this.hunterPendingSeat !== shooter.seat) return fail('NOT_YOUR_TURN', '你当前不能开枪');
    if (this.hunterChoice !== undefined) return fail('ALREADY_DONE', '你已经决定过了');
    if (target !== null && !this.aliveSeats().includes(target)) {
      return fail('INVALID_TARGET', '目标不是存活玩家');
    }
    this.hunterChoice = target;
    if (target !== null) {
      const tp = this.bySeat(target)!;
      if (this.isPuppet(shooter)) {
        /**
         * 傀儡猎人的枪是**哑的**：他能正常选人、开枪阶段照常走满，
         * 但不会有人死。
         *
         * 为什么还要让他走完流程：直接跳过 `HUNTER_SHOOT` 阶段，全场立刻就知道
         * 「这个猎人没枪 = 他是傀儡」。而「阶段永远走满、时长不携带信息」是这个项目的铁律，
         * 让他照常演一遍，至少时序上不泄露；同时**他自己**会在这一刻发现枪是假的 ——
         * 这正是这个板子要的体验。
         *
         * 公开日志里刻意**不写「带走了谁」**：那会留下一条"宣称杀了人却没死"的记录，
         * 看起来像 bug。玩家从「开枪阶段出现了、但没人死」自然能推出真相。
         */
        this.pushSecret(`傀儡猎人 ${shooter.seat} 号开枪指向 ${target} 号，但枪是哑的`);
      } else {
        this.kill(tp, 'SHOOT');
        this.pushLog(`${this.deathShooterName(shooter)}开枪带走了 ${target} 号（${tp.nickname}）。`);
      }
    } else {
      this.pushLog(`${this.deathShooterName(shooter)}选择放弃开枪。`);
    }
    this.checkWinner();
    this.settle();
    return OK;
  }

  /**
   * 狼人自爆（白天可用）：自爆后立刻进入黑夜，当天不再发言与投票。
   *
   * - 白狼王：爆后进入带人阶段，可指定带走一名玩家（也可不带）
   * - 普通狼人：空爆，不带人，爆完直接结算进黑夜
   *
   * 两者共同的规则：自爆发生在**警长竞选期间**时，竞选终止、本局警徽流失
   * （官方规则）；警长已经选出后自爆不撕警徽，走正常的移交/撕毁流程。
   */
  selfDestruct(playerId: string): ActResult {
    const daytime = new Set<Phase>([
      'SHERIFF_SIGNUP', 'SHERIFF_CAMPAIGN', 'SHERIFF_VOTE', 'SHERIFF_PK',
      'SHERIFF_REVOTE', 'DAY_SPEECH', 'DAY_VOTE',
    ]);
    if (!daytime.has(this.phase)) {
      return fail('BAD_PHASE', '只有在白天发言或投票阶段才能自爆');
    }
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (me.role !== 'WOLF_KING' && me.role !== 'WOLF') {
      return fail('NOT_YOUR_TURN', '只有狼人可以自爆');
    }
    if (!me.alive) return fail('DEAD', '你已经出局');
    if (this.boomPendingSeat !== null) return fail('ALREADY_DONE', '自爆已经发生过了');

    if (!this.sheriffElectionFinished) {
      this.sheriffElectionFinished = true;
      this.sheriffCandidates.clear();
      this.pushLog('警长竞选因狼人自爆中止，本局警徽流失。');
    }
    this.kill(me, 'EXPLODE');

    if (me.role === 'WOLF_KING') {
      this.pushLog(`${me.seat} 号（${me.nickname}）亮出【白狼王】，自爆！`);
      this.boomPendingSeat = me.seat;
      this.pushSecret(`白狼王（${me.seat} 号）自爆，进入指定带走目标阶段`);
      // 有意不在这里判定胜负：白狼王先带人，带完之后再判 ——
      // 这样「自爆带走最后一名平民 → 狼人胜」这类边缘情况才符合常规规则。
      this.enter('WOLF_KING_BOOM');
      this.settle();
      return OK;
    }

    // 普通狼空爆：没有带人阶段，结算顺序与白狼王带完人之后完全一致。
    // 空爆没有专属阶段可挂语音，写进公开播报队列，随紧随其后的天黑语音全场念出。
    this.pushLog(`${me.seat} 号（${me.nickname}）亮出【狼人】身份，自爆！今天不再发言与投票。`);
    this.pushSecret(`普通狼（${me.seat} 号）空爆，直接进入黑夜`);
    this.boomAnnouncements.push(me.seat);
    this.checkWinner();
    if (this.isOver) this.enter('GAME_OVER');
    else if (this.sheriffTransferFrom !== null) this.beginSheriffTransfer('BOOM');
    else this.nextNight();
    return OK;
  }

  /** 白狼王指定要带走的玩家（target 为 null 表示不带人） */
  submitBoomTarget(playerId: string, target: number | null): ActResult {    if (this.phase !== 'WOLF_KING_BOOM') return fail('BAD_PHASE', '现在不是白狼王带人阶段');
    const boomSeat = this.boomPendingSeat;
    if (boomSeat === null) return fail('NOT_YOUR_TURN', '当前没有待处理的自爆');
    const me = this.byId(playerId);
    if (!me || me.seat !== boomSeat) return fail('NOT_YOUR_TURN', '你不是自爆的白狼王');
    if (this.boomChoice !== undefined) return fail('ALREADY_DONE', '你已经决定过了');
    if (target !== null && !this.aliveSeats().includes(target)) {
      return fail('INVALID_TARGET', '目标不是存活玩家');
    }

    this.boomChoice = target;
    if (target !== null) {
      const tp = this.bySeat(target)!;
      this.kill(tp, 'BLAST');
      this.pushLog(`白狼王带走了 ${target} 号（${tp.nickname}）。`);
    } else {
      this.pushLog('白狼王没有带走任何人。');
    }
    this.settle();
    return OK;
  }

  /**
   * 骑士决斗（白天发言阶段，整局一次）。
   *
   * 规则：翻牌向一名玩家发起决斗 —— 对方是狼人则当场出局，是好人则骑士自己出局。
   * 无论输赢技能都算用过。决斗出局不触发猎人/狼王开枪（DUEL 不在
   * canTriggerDeathShot 的死因里），也不会引发狼美人殉情（见 kill()）。
   *
   * 为什么只在 DAY_SPEECH：投票阶段插进一场死亡会作废已经在飞的票，
   * 警长竞选阶段死人会让刚生成的发言顺序当场作废 —— 发言阶段是
   * 「听完发言、还没投票」的自然决斗时机，官方流程也是这么演的。
   */
  knightDuel(playerId: string, target: number): ActResult {
    if (this.phase !== 'DAY_SPEECH') return fail('BAD_PHASE', '只有在白天发言阶段才能发起决斗');
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (me.role !== 'KNIGHT') return fail('NOT_YOUR_TURN', '你不是骑士');
    if (!me.alive) return fail('DEAD', '你已经出局');
    if (this.knightUsed) return fail('ALREADY_DONE', '你的决斗已经用过了');
    if (target === me.seat) return fail('INVALID_TARGET', '不能和自己决斗');
    const tp = this.bySeat(target);
    if (!tp || !tp.alive) return fail('INVALID_TARGET', '目标不是存活玩家');

    this.knightUsed = true;
    const targetIsWolf = this.truthCamp(tp) === 'WOLF';
    this.pushLog(`${me.seat} 号（${me.nickname}）亮出【骑士】，向 ${target} 号（${tp.nickname}）发起决斗！`);

    if (targetIsWolf) {
      this.kill(tp, 'DUEL');
      this.pushLog(`决斗结果：${target} 号是狼人，被当场处决。当天的发言与投票继续。`);
    } else {
      this.kill(me, 'DUEL');
      this.pushLog(`决斗结果：${target} 号是好人，骑士 ${me.seat} 号决斗失败，自己出局。当天的发言与投票继续。`);
    }

    this.checkWinner();
    if (this.isOver) {
      this.enter('GAME_OVER');
    } else if (this.sheriffTransferFrom !== null) {
      // 死的是警长（或骑士自己就是警长）：先移交警徽，再回到发言阶段。
      // 重新 enter(DAY_SPEECH) 会让新警长重新指定发言方向，这正是想要的。
      this.beginSheriffTransfer('SPEECH');
    }
    // 其余情况：阶段不变，当天照常发言、投票。
    this.settle();
    return OK;
  }

  /**
   * 给自己挂一个狼队战术标签（传 null 取消）。
   *
   * 三类标签的规则不一样：
   *
   *  - **全队唯一**（悍跳位 / 深水 / 倒钩 / 冲锋狼）：别人占着就**拒绝**，
   *    而不是静默把对方的标签抢走 —— 抢走会让对方以为自己还挂着，配合直接出岔子。
   *  - **自由**（上警）：想竞选警长的狼可以有好几个，不做限制。
   *  - **两人配对**（狼踩狼）：还要带上「踩谁」，而且**对方也得反过来指你**，
   *    配对才算成立。只有一边填就标成「待对方确认」——
   *    否则挂的人会以为说好了，实际对方压根不知道。
   */
  setWolfTag(playerId: string, tag: WolfTag | null, target: number | null = null): ActResult {
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (!this.knowsWolfPack(me)) {
      return fail('NOT_YOUR_TURN', '只有狼人或已经进入狼队的机械狼才能挂战术标签');
    }
    if (this.phase === 'WAITING') return fail('BAD_PHASE', '游戏还没有开始');
    if (this.phase === 'GAME_OVER') return fail('BAD_PHASE', '本局已经结束了');
    // 标签是「天黑之后」才存在的东西：身份确认阶段没有标签面板。
    // 这同时保证了「谁是狼」不会在发牌那一刻就从界面上漏出去。
    if (!this.phase.startsWith('NIGHT_')) {
      return fail('BAD_PHASE', '狼队战术只能在夜间调整');
    }

    // 走到这里阶段一定是 NIGHT_*，所以「是不是第一夜」只看天数就够了。
    //
    // 悍跳位牵着战绩里的 +1 分，所以必须有人**在第一夜结束前**把它占住：
    //   - 第一夜之内：随便点、随便取消、随便换人 —— 狼队本来就要在夜里来回商量谁去悍跳
    //   - 第一夜之后：锁死，不能再挂（否则可以等狼队快赢了再挂上去白拿 +1 分）
    // 别的标签没有这个时间约束，只受「全队唯一」或「两人互指」限制。
    const firstNight = this.day === 1;

    if (tag === 'FAKE_SEER' && !firstNight) {
      return fail('BAD_PHASE', '悍跳位必须在第一夜结束前确定');
    }
    if (!firstNight && tag !== 'FAKE_SEER' && this.wolfTags.get(me.seat) === 'FAKE_SEER') {
      return fail('ALREADY_DONE', '第一夜已经过去，悍跳位不能再改');
    }

    if (tag === null) {
      this.wolfTags.delete(me.seat);
      this.wolfTagTargets.delete(me.seat);
      return OK;
    }

    if (isExclusiveWolfTag(tag)) {
      const holder = [...this.wolfTags.entries()].find(([seat, t]) => t === tag && seat !== me.seat);
      if (holder) {
        const other = this.bySeat(holder[0]);
        return fail(
          'INVALID_TARGET',
          `「${WOLF_TAG_LABEL[tag]}」已经由 ${holder[0]} 号（${other?.nickname ?? '?'}）占了，一队只能有一个人`,
        );
      }
    }

    if (isPairedWolfTag(tag)) {
      const candidates = this.wolfTagTargetCandidates(me.seat);
      if (target === null || !candidates.includes(target)) {
        return fail(
          'INVALID_TARGET',
          candidates.length > 0
            ? `「狼踩狼」必须再选一名存活的狼队友，可选：${candidates.join('、')} 号`
            : '「狼踩狼」需要一名存活的狼队友，现在没有可选对象',
        );
      }
      this.wolfTags.set(me.seat, tag);
      this.wolfTagTargets.set(me.seat, target);
      return OK;
    }

    this.wolfTags.set(me.seat, tag);
    this.wolfTagTargets.delete(me.seat);
    return OK;
  }

  /** 挂「狼踩狼」时可以踩谁：存活的狼队友（不含自己） */
  private wolfTagTargetCandidates(mySeat: number): number[] {
    return this.wolfSeats()
      .filter((seat) => seat !== mySeat)
      .filter((seat) => this.bySeat(seat)?.alive === true)
      .sort((a, b) => a - b);
  }

  /**
   * 狼踩狼的配对是否已经**双方互指**完成。
   *
   * 只有一边填了不算 —— 那正是「我以为说好了，其实对方不知道」的情况，
   * 比不挂标签还危险，所以必须能被界面标出来。
   */
  wolfVsWolfPaired(seat: number): boolean {
    const target = this.wolfTagTargets.get(seat);
    if (target === undefined) return false;
    return this.wolfTagTargets.get(target) === seat;
  }

  /** 仅供测试：读某个座位在「狼踩狼」里填的踩谁 */
  wolfTagTargetAt(seat: number): number | null {
    return this.wolfTagTargets.get(seat) ?? null;
  }

  /** 仅供测试：读某个座位的狼队标签 */
  wolfTagAt(seat: number): WolfTag | null {
    return this.wolfTags.get(seat) ?? null;
  }

  // ─────────────────── 阶段推进 ───────────────────

  /**
   * 推进所有「条件已满足」的阶段。每次玩家行动后都必须调用一次，
   * 它是让状态机自动往前走（跳过已死角色、自动结算）的唯一入口。
   */
  settle(): void {
    let guard = 0;
    while (guard++ < 64) {
      // 注意：这里只能按「阶段」判断，不能按 isOver 提前 return，
      // 否则已经分出胜负时会卡在 HUNTER_SHOOT / DAY_EXILE 里推进不下去。
      if (this.phase === 'GAME_OVER') return;
      if (PAUSE_PHASES.has(this.phase)) return;
      if (!this.canAutoAdvance()) return;
      this.advance();
    }
  }

  /**
   * 当前阶段「该行动的人是否都提交完了」。
   *
   * 服务端需要这个来判断什么时候该开始回合倒数。
   * 刻意**不看 holdAdvance** —— 否则服务端会被自己设的暂缓挡住，
   * 永远等不到「行动齐了」，倒数也就永远开始不了。
   */
  actionsComplete(): boolean {
    return this.actionsDone();
  }

  private canAutoAdvance(): boolean {
    if (this.holdAdvance) return false;
    return this.actionsDone();
  }

  /** 行动是否真的齐了（不看 holdAdvance） */
  private actionsDone(): boolean {
    switch (this.phase) {
      case 'NIGHT_WOLVES': {
        const wolves = this.aliveKnifeWolves();
        /**
         * 狼队全灭时**必须算「已完成」**，否则这个阶段永远结算不了，整局冻死在夜里。
         *
         * 「唯邻是从」让这个边界第一次真的出现：三只真狼都出局了，
         * 但傀儡还活着 —— 胜负没定、游戏继续，可已经没人能刀人了。
         * 此前所有版型都不会走到这里（狼全死＝好人立刻获胜，不会再有下一夜），所以藏了很久。
         *
         * 注意这不影响「阶段照常走满时长」那条铁律：阶段该走多久还是多久，
         * 只是没人能行动时不必干等所有人提交。
         */
        return wolves.length === 0 || wolves.every((w) => this.night.wolfPicks.has(w.seat));
      }
      case 'NIGHT_HYBRID':
        return this.night.hybridActed;
      case 'NIGHT_MECHANICAL':
        return this.night.mechanicalLearnActed;
      case 'NIGHT_DANCER':
        return this.night.dancerActed;
      case 'NIGHT_MASK':
        return this.night.maskInspectActed && this.night.maskActed;
      case 'NIGHT_DREAMER':
        return this.night.dreamerActed;
      case 'NIGHT_BEAUTY_CHARM':
        return this.night.beautyCharmActed;
      case 'NIGHT_GUARD': {
        const normal = !!this.aliveSole('GUARD');
        const copied = !!this.mechanical()?.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'GUARD';
        return normal || copied
          ? (!normal || this.night.guardActed) && (!copied || this.night.mechanicalGuardActed)
          : this.night.guardActed && this.night.mechanicalGuardActed;
      }
      case 'NIGHT_WITCH': {
        const normal = !!this.aliveSole('WITCH');
        const copied = !!this.mechanical()?.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'WITCH';
        return normal || copied
          ? (!normal || this.night.witchActed) && (!copied || this.night.mechanicalPoisonActed)
          : this.night.witchActed && this.night.mechanicalPoisonActed;
      }
      case 'NIGHT_SEER': {
        const normal = !!this.aliveSole('SEER');
        const copied = !!this.mechanical()?.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'SEER';
        return normal || copied
          ? (!normal || this.night.seerActed) && (!copied || this.night.mechanicalSeerActed)
          : this.night.seerActed && this.night.mechanicalSeerActed;
      }
      case 'NIGHT_SPIRIT_SEER': {
        const normal = !!this.aliveSole('SPIRIT_SEER');
        const copied = !!this.mechanical()?.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'SPIRIT_SEER';
        return normal || copied
          ? (!normal || this.night.spiritActed) && (!copied || this.night.mechanicalSpiritActed)
          : this.night.spiritActed && this.night.mechanicalSpiritActed;
      }
      case 'NIGHT_GRAVE_KEEPER':
        // 守墓人死了也一样等超时收束 —— 阶段空转满时长是「时间不泄密」的防火墙
        return this.night.graveKeeperActed;
      case 'SHERIFF_SIGNUP': {
        const alive = this.alivePlayers();
        return alive.every((p) => this.sheriffSignup.has(p.seat));
      }
      case 'SHERIFF_VOTE':
      case 'SHERIFF_REVOTE': {
        const voters = this.sheriffVoterSeats();
        return voters.every((seat) => this.sheriffVotes.has(seat));
      }
      case 'DAY_VOTE': {
        const voters = this.aliveVoters();
        if (voters.length === 0) return true;
        return voters.every((v) => this.votes.has(v.seat));
      }
      case 'HUNTER_SHOOT':
        return this.hunterChoice !== undefined;
      case 'WOLF_KING_BOOM':
        return this.boomChoice !== undefined;
      case 'SHERIFF_TRANSFER':
        return this.sheriffTransferChoice !== undefined;
      default:
        return false;
    }
  }

  /** 超时或房主手动跳过：把当前阶段剩余未提交的行动按「放弃」处理，然后推进。 */
  forceAdvance(byHost = false): void {
    if (this.phase === 'GAME_OVER' || this.phase === 'WAITING') return;

    // 身份确认阶段**不允许被「跳过阶段」绕过**。
    // 硬门槛的意义就是「不许有人在没看牌的情况下被打进夜晚」，
    // 如果房主能用「跳过阶段」直接天黑，这个门槛等于不存在。
    // 房主要开始夜晚只有一条路：等在线的人都确认，然后按「天黑请闭眼」。
    if (this.phase === 'ROLE_REVEAL') return;

    if (byHost) this.pushLog(`房主跳过了【${PHASE_LABEL[this.phase]}】阶段。`);

    // 强制推进必须无视服务端设的「暂缓」。
    // 否则会出现死锁：服务端为了留播报时间把 holdAdvance 设成 true，
    // 阶段超时后调 forceAdvance()，而它内部依赖 settle() 推进 ——
    // settle() 又会因为 holdAdvance 拒绝推进，于是整局永久冻结在夜里。
    this.holdAdvance = false;

    // 过场阶段只推进一步，把「阅读时间」留给下一个阶段的定时器
    if (PAUSE_PHASES.has(this.phase)) {
      this.advance();
      this.settle();
      return;
    }

    switch (this.phase) {
      case 'NIGHT_WOLVES': {
        const wolves = this.aliveKnifeWolves();
        const any = [...this.night.wolfPicks.values()];
        // 超时未提交的狼人按「跟随当前多数」处理，避免因为掉线导致空刀
        const fallback = any.length > 0 ? plurality(any) : null;
        for (const w of wolves) {
          if (!this.night.wolfPicks.has(w.seat)) this.night.wolfPicks.set(w.seat, fallback);
        }
        /**
         * 傀儡同理：超时没选的话不能让这个板子的核心机制凭空消失。
         * 优先跟随已有票数，全都没选就从候选人里随机取一个。
         */
        const candidates = this.puppetCandidates();
        if (candidates.length > 0) {
          const puppetVotes = [...this.night.puppetPicks.values()];
          const puppetFallback =
            puppetVotes.length > 0 ? plurality(puppetVotes) : candidates[Math.floor(this.rng.next() * candidates.length)]!;
          if (puppetFallback !== null) {
            for (const w of wolves) {
              if (!this.night.puppetPicks.has(w.seat)) this.night.puppetPicks.set(w.seat, puppetFallback);
            }
            this.pushSecret(`狼队超时未选傀儡，系统替他们选了 ${puppetFallback} 号`);
          }
        }
        break;
      }
      case 'NIGHT_HYBRID': {
        if (!this.night.hybridActed) {
          const hybrid = this.aliveSole('HYBRID');
          const options = hybrid ? this.aliveSeats().filter((seat) => seat !== hybrid.seat) : [];
          const target = options.length > 0 ? options[Math.floor(this.rng.next() * options.length)]! : null;
          this.night.hybridTarget = target;
          this.night.hybridActed = true;
          if (target !== null) this.hybridModelSeat = target;
          this.pushSecret(target === null ? '混血儿阶段无人行动' : `混血儿超时，系统随机选择 ${target} 号为榜样`);
        }
        break;
      }
      case 'NIGHT_MECHANICAL': {
        if (!this.night.mechanicalLearnActed) {
          const mechanical = this.aliveSole('MECHANICAL_WOLF');
          this.night.mechanicalLearnActed = true;
          if (this.mechanicalLearnedRole !== null || !mechanical) {
            this.pushSecret('机械狼阶段无人需要学习新身份');
            break;
          }
          const options = this.aliveSeats().filter((seat) => seat !== mechanical.seat);
          const targetSeat = options.length > 0 ? options[Math.floor(this.rng.next() * options.length)]! : null;
          this.night.mechanicalLearnTarget = targetSeat;
          if (targetSeat !== null) {
            this.mechanicalLearnedRole = this.bySeat(targetSeat)?.role ?? null;
            this.mechanicalLearnedDay = this.day;
          }
          this.pushSecret(targetSeat === null ? '机械狼阶段无人行动' : `机械狼超时，系统随机学习 ${targetSeat} 号`);
        }
        break;
      }
      case 'NIGHT_DANCER': {
        if (!this.night.dancerActed) {
          const options = shuffle(this.dancerCandidates(), () => this.rng.next());
          const targets = options.length >= 3 && this.aliveSole('DANCER') ? options.slice(0, 3) : [];
          this.night.dancerTargets = targets;
          this.night.dancerActed = true;
          if (targets.length === 3) {
            for (const seat of targets) this.danceUsedSeats.add(seat);
            this.danceHistory.push({ day: this.day, seats: targets.slice() });
            this.pushSecret(`舞者阶段超时，系统随机选择：${targets.join('、')} 号`);
          } else {
            this.pushSecret('舞者阶段没有足够的合法目标');
          }
        }
        break;
      }
      case 'NIGHT_MASK': {
        const mask = this.aliveSole('MASK');
        if (!this.night.maskInspectActed) {
          const options = this.maskInspectCandidates();
          const target = mask && options.length > 0 ? options[Math.floor(this.rng.next() * options.length)]! : null;
          this.night.maskInspectTarget = target;
          this.night.maskInspectResult = target !== null && this.night.dancerTargets.includes(target);
          this.night.maskInspectActed = true;
        }
        if (!this.night.maskActed) {
          const options = this.maskTargetCandidates();
          this.night.maskTarget = mask && options.length > 0 ? options[Math.floor(this.rng.next() * options.length)]! : null;
          this.night.maskActed = true;
        }
        if (this.night.maskInspectTarget !== null && !this.maskHistory.some((entry) => entry.day === this.day)) {
          this.lastMaskInspectSeat = this.night.maskInspectTarget;
          this.lastMaskTargetSeat = this.night.maskTarget;
          this.maskHistory.push({
            day: this.day,
            inspectSeat: this.night.maskInspectTarget,
            inDance: this.night.maskInspectResult === true,
            maskSeat: this.night.maskTarget,
          });
        }
        this.pushSecret('假面阶段超时，系统已随机完成剩余行动');
        break;
      }
      case 'NIGHT_DREAMER': {
        if (!this.night.dreamerActed) {
          const dreamer = this.aliveSole('DREAMER');
          const options = dreamer
            ? this.aliveSeats().filter((seat) => seat !== dreamer.seat)
            : [];
          const target = options.length > 0 ? options[Math.floor(this.rng.next() * options.length)]! : null;
          this.night.dreamerTarget = target;
          this.night.dreamerActed = true;
          if (target !== null) {
            this.dreamHistory.push({ day: this.day, seat: target });
            this.pushSecret(`摄梦人超时，系统随机选择 ${target} 号成为梦游者`);
          } else {
            this.pushSecret('摄梦人阶段无人可行动');
          }
        }
        break;
      }
      case 'NIGHT_BEAUTY_CHARM':
        // 超时未魅惑 = 本夜不魅惑。**不能**随机选一个 ——
        // 那会让她在不知情的情况下把队友变成殉情对象。
        if (!this.night.beautyCharmActed) {
          this.night.beautyCharmActed = true;
          this.pushSecret('狼美人超时未魅惑，本夜不魅惑任何人');
        }
        break;
      case 'NIGHT_GUARD':
        if (!this.night.guardActed) {
          this.night.guardActed = true;
          this.pushSecret('守卫超时未守护');
        }
        if (!this.night.mechanicalGuardActed) this.night.mechanicalGuardActed = true;
        break;
      case 'NIGHT_WITCH':
        if (!this.night.witchActed) {
          this.night.witchActed = true;
          this.pushSecret('女巫超时未行动，本夜未使用药水');
        }
        if (!this.night.mechanicalPoisonActed) this.night.mechanicalPoisonActed = true;
        break;
      case 'NIGHT_SEER':
        if (!this.night.seerActed) {
          this.night.seerActed = true;
          this.pushSecret('预言家超时未查验');
        }
        if (!this.night.mechanicalSeerActed) this.night.mechanicalSeerActed = true;
        break;
      case 'NIGHT_SPIRIT_SEER':
        if (!this.night.spiritActed) this.night.spiritActed = true;
        if (!this.night.mechanicalSpiritActed) this.night.mechanicalSpiritActed = true;
        break;
      case 'NIGHT_GRAVE_KEEPER':
        // 超时只补「确认」：结果在进入阶段时已写入 graveHistory，挂机不丢信息
        if (!this.night.graveKeeperActed) this.night.graveKeeperActed = true;
        break;
      case 'SHERIFF_SIGNUP':
        for (const p of this.alivePlayers()) {
          if (!this.sheriffSignup.has(p.seat)) this.sheriffSignup.set(p.seat, false);
        }
        break;
      case 'SHERIFF_VOTE':
      case 'SHERIFF_REVOTE':
        for (const seat of this.sheriffVoterSeats()) {
          if (!this.sheriffVotes.has(seat)) this.sheriffVotes.set(seat, null);
        }
        break;
      case 'DAY_VOTE':
        for (const v of this.aliveVoters()) {
          if (!this.votes.has(v.seat)) this.votes.set(v.seat, null);
        }
        break;
      case 'HUNTER_SHOOT':
        if (this.hunterChoice === undefined) {
          this.hunterChoice = null;
          const shooter = this.hunterPendingSeat === null ? undefined : this.bySeat(this.hunterPendingSeat);
          this.pushLog(`${shooter ? this.deathShooterName(shooter) : '持枪玩家'}超时未开枪。`);
        }
        break;
      case 'WOLF_KING_BOOM':
        if (this.boomChoice === undefined) {
          this.boomChoice = null;
          this.pushLog('白狼王超时未选择，没有带走任何人。');
        }
        break;
      case 'SHERIFF_TRANSFER':
        if (this.sheriffTransferChoice === undefined) {
          this.sheriffTransferChoice = null;
          this.pushLog('警长超时未移交，警徽自动撕毁。');
        }
        break;
      default:
        break;
    }
    this.settle();
  }

  private advance(): void {
    switch (this.phase) {
      case 'WAITING':
        return;
      case 'ROLE_REVEAL':
        // 只可能由房主按下「天黑请闭眼」走到这里（见 beginNight）。
        // 不在 PAUSE_PHASES 之外的任何自动路径上 —— 身份确认永远不会自己结束。
        this.enter('NIGHT_START');
        return;
      case 'NIGHT_START':
        this.enter(this.nextNightPhase('NIGHT_START'));
        return;
      case 'NIGHT_HYBRID':
        this.enter(this.nextNightPhase('NIGHT_HYBRID'));
        return;
      case 'NIGHT_MECHANICAL':
        this.enter(this.nextNightPhase('NIGHT_MECHANICAL'));
        return;
      case 'NIGHT_DANCER':
        this.enter(this.nextNightPhase('NIGHT_DANCER'));
        return;
      case 'NIGHT_MASK':
        this.enter(this.nextNightPhase('NIGHT_MASK'));
        return;
      case 'NIGHT_DREAMER':
        this.enter(this.nextNightPhase('NIGHT_DREAMER'));
        return;
      case 'NIGHT_WOLVES':
        this.resolveWolfVotes();
        // 狼人阶段一结束就把傀儡定下来（立刻生效）：
        // 排在他后面的预言家当夜验他，看到的就该是【狼人】
        this.applyPuppetVote();
        this.enter(this.nextNightPhase('NIGHT_WOLVES'));
        return;
      case 'NIGHT_BEAUTY_CHARM':
        // 狼美人在狼刀之后独自睁眼 —— 她要先知道刀口才决定魅惑谁
        this.enter(this.nextNightPhase('NIGHT_BEAUTY_CHARM'));
        return;
      case 'NIGHT_GUARD':
        this.enter(this.nextNightPhase('NIGHT_GUARD'));
        return;
      case 'NIGHT_WITCH':
        this.enter(this.nextNightPhase('NIGHT_WITCH'));
        return;
      case 'NIGHT_SEER':
        this.enter(this.nextNightPhase('NIGHT_SEER'));
        return;
      case 'NIGHT_SPIRIT_SEER':
        this.enter(this.nextNightPhase('NIGHT_SPIRIT_SEER'));
        return;
      case 'NIGHT_GRAVE_KEEPER':
        this.enter(this.nextNightPhase('NIGHT_GRAVE_KEEPER'));
        return;
      case 'NIGHT_RESOLVE':
        this.enter('DAY_ANNOUNCE');
        return;
      case 'DAY_ANNOUNCE':
        this.continueAfterAnnounce();
        return;
      case 'SHERIFF_SIGNUP':
        this.finishSheriffSignup();
        return;
      case 'SHERIFF_CAMPAIGN':
        this.beginSheriffVote(false);
        return;
      case 'SHERIFF_VOTE':
        this.resolveSheriffVote(false);
        return;
      case 'SHERIFF_PK':
        this.beginSheriffVote(true);
        return;
      case 'SHERIFF_REVOTE':
        this.resolveSheriffVote(true);
        return;
      case 'DAY_SPEECH':
        this.enter('DAY_VOTE');
        return;
      case 'DAY_VOTE':
        this.enter('DAY_EXILE');
        return;
      case 'DAY_EXILE':
        this.continueAfterExile();
        return;
      case 'HUNTER_SHOOT':
        // 关键：开枪机会只能消耗一次。忘记清空会导致猎人无限重复开枪。
        this.hunterQueue.shift();
        this.hunterPendingSeat = this.hunterQueue[0] ?? null;
        if (this.hunterPendingSeat !== null) {
          this.enter('HUNTER_SHOOT');
          return;
        }
        this.continueAfterHunter();
        return;
      case 'WOLF_KING_BOOM': {
        this.boomPendingSeat = null;
        this.checkWinner();
        if (this.isOver) this.enter('GAME_OVER');
        else if (this.sheriffTransferFrom !== null) this.beginSheriffTransfer('BOOM');
        else this.nextNight();
        return;
      }
      case 'SHERIFF_TRANSFER': {
        const returnTo = this.sheriffTransferReturn;
        this.sheriffTransferFrom = null;
        this.sheriffTransferChoice = undefined;
        if (returnTo === 'ANNOUNCE') this.continueAfterAnnounce();
        else if (returnTo === 'EXILE') this.continueAfterExile();
        else if (returnTo === 'HUNTER') this.continueAfterHunter();
        else if (returnTo === 'SPEECH') this.enter('DAY_SPEECH');
        else this.nextNight();
        return;
      }
      case 'GAME_OVER':
        return;
    }
  }

  private continueAfterAnnounce(): void {
    if (this.sheriffTransferFrom !== null) return this.beginSheriffTransfer('ANNOUNCE');
    if (this.hunterPendingSeat !== null) {
      this.hunterReturnPhase = 'DAY_ANNOUNCE';
      return void this.enter('HUNTER_SHOOT');
    }
    if (this.isOver) return void this.enter('GAME_OVER');
    if (this.day === 1 && !this.sheriffElectionFinished) return void this.enter('SHERIFF_SIGNUP');
    this.enter('DAY_SPEECH');
  }

  /** 是否拥有死亡开枪技能；具体死因是否允许开枪由 canTriggerDeathShot 判断。 */
  private hasDeathShotAbility(player: PlayerState): boolean {
    return player.role === 'HUNTER' ||
      player.role === 'BLACK_WOLF_KING' ||
      (player.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'HUNTER');
  }

  /**
   * 恶灵骑士的反伤登记。
   *
   * 女巫毒他、预言家或通灵师查验他 → **对方**在天亮时死亡。
   * 这里只登记「谁吃了这一下」，真正的死亡交给 `resolveNightDeaths()` 统一处理 ——
   * 因为死讯必须出现在天亮公告里，而在提交阶段直接杀的死人不在公告名单上。
   *
   * 两个约束：
   *  - **整局只反一次**（官方的「一次性反伤」）。用掉之后他依然夜里杀不死，
   *    但剩下的毒药和查验都能放心用了。
   *  - 「同一夜多人对他动手，只有**先行动**的那个人吃反伤」是靠**阶段顺序**
   *    天然实现的：女巫阶段在预言家阶段之前，所以女巫先登记，后面的查验不再覆盖。
   */
  private noteDarkLordReflect(actor: PlayerState): void {
    if (this.darkLordReflectUsed) return;
    if (this.night.darkLordReflectVictim !== null) return;
    this.night.darkLordReflectVictim = actor.seat;
    this.pushSecret(`${actor.seat} 号对恶灵骑士动手，将在天亮时遭到反伤`);
  }

  /**
   * 可以下刀的目标：存活、且不是「不能自刀」的狼（狼美人 / 恶灵骑士）。
   *
   * 官方规定这两个角色不能自刀 —— 不是礼节，是他们的价值全在活着：
   * 狼美人要活到关键回合带人殉情，恶灵骑士要活着消耗好人的毒药和查验。
   * 被自己队友一刀带走就全废了。
   */
  private knifeCandidates(): number[] {
    return this.aliveSeats().filter((seat) => {
      const p = this.bySeat(seat);
      return p ? canBeKnifed(p.role) : false;
    });
  }

  /**
   * 狼美人的殉情结算：返回应该陪葬的座位。
   *
   * 只有**前一晚**被魅惑的人会殉情（这是官方规则，也是「今晚刚魅惑完就死、
   * 那个人不该陪葬」的原因）。取走之后就清空 —— 同一次出局只带一个人。
   */
  private takeLovePactVictim(): number | null {
    const charmed = this.lastCharmedSeat;
    this.lastCharmedSeat = null;
    if (charmed === null) return null;
    const victim = this.bySeat(charmed);
    if (!victim || !victim.alive) return null;
    return charmed;
  }

  private canTriggerDeathShot(player: PlayerState, cause: DeathCause): boolean {    if (!this.hasDeathShotAbility(player)) return false;
    if (player.role === 'BLACK_WOLF_KING') {
      return cause === 'WOLF' || cause === 'VOTE' || cause === 'SHOOT';
    }
    // 官方狼王摄梦人规则：猎人被狼王的死亡开枪带走时仍可开枪，形成枪链。
    // 摄梦、毒杀、舞池结算和白狼王自爆带人仍然压枪。
    return cause === 'WOLF' || cause === 'VOTE' || cause === 'SHOOT';
  }

  private deathShooterName(player: PlayerState): string {
    if (player.role === 'BLACK_WOLF_KING') return '狼王';
    if (player.role === 'MECHANICAL_WOLF') return '继承猎人技能的机械狼';
    return '猎人';
  }

  /** 白痴本体，或已经激活白痴技能的机械狼，均可在被放逐时翻牌免死。 */
  private canFlipAsIdiot(player: PlayerState): boolean {
    return player.role === 'IDIOT' ||
      (player.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'IDIOT');
  }

  private queueHunter(seat: number): void {
    if (!this.hunterQueue.includes(seat)) this.hunterQueue.push(seat);
    this.hunterPendingSeat = this.hunterQueue[0] ?? null;
  }

  private continueAfterExile(): void {
    if (this.sheriffTransferFrom !== null) return this.beginSheriffTransfer('EXILE');
    if (this.hunterPendingSeat !== null) {
      this.hunterReturnPhase = 'NIGHT_START';
      return void this.enter('HUNTER_SHOOT');
    }
    if (this.isOver) return void this.enter('GAME_OVER');
    this.nextNight();
  }

  private continueAfterHunter(): void {
    if (this.isOver) return void this.enter('GAME_OVER');
    if (this.sheriffTransferFrom !== null) return this.beginSheriffTransfer('HUNTER');
    if (this.hunterReturnPhase === 'NIGHT_START') this.nextNight();
    else this.continueAfterAnnounce();
  }

  private beginSheriffTransfer(returnTo: 'ANNOUNCE' | 'EXILE' | 'HUNTER' | 'BOOM' | 'SPEECH'): void {
    this.sheriffTransferReturn = returnTo;
    this.enter('SHERIFF_TRANSFER');
  }

  private finishSheriffSignup(): void {
    this.sheriffCandidates = new Set(
      [...this.sheriffSignup.entries()]
        .filter(([, candidate]) => candidate)
        .map(([seat]) => seat)
        .filter((seat) => this.bySeat(seat)?.alive),
    );
    const seats = this.currentSheriffCandidates();
    if (seats.length === 0) return this.finishSheriffElection(null, '无人上警，警徽流失。');
    if (seats.length === 1) return this.finishSheriffElection(seats[0]!, '只有一人上警，自动当选警长。');
    const start = Math.floor(this.rng.next() * seats.length);
    const rotated = [...seats.slice(start), ...seats.slice(0, start)];
    this.sheriffSpeechOrder = this.rng.next() < 0.5 ? rotated : rotated.reverse();
    this.enter('SHERIFF_CAMPAIGN');
  }

  private beginSheriffVote(revote: boolean): void {
    const seats = this.currentSheriffCandidates();
    if (seats.length === 0) return this.finishSheriffElection(null, '所有候选人均已退水，警徽流失。');
    if (seats.length === 1) return this.finishSheriffElection(seats[0]!, `${seats[0]} 号成为唯一候选人，当选警长。`);
    this.sheriffElectionRound = revote ? 2 : 1;
    this.sheriffVotes = new Map();
    this.voteDetail = [];
    this.enter(revote ? 'SHERIFF_REVOTE' : 'SHERIFF_VOTE');
  }

  private resolveSheriffVote(revote: boolean): void {
    this.voteDetail = [...this.sheriffVotes.entries()]
      .map(([voter, target]) => ({ voter, target, weight: 1 }))
      .sort((a, b) => a.voter - b.voter);
    const counts = new Map<number, number>();
    for (const target of this.sheriffVotes.values()) {
      if (target !== null) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    if (counts.size === 0) return this.finishSheriffElection(null, '警下无人投出有效票，警徽流失。');
    const max = Math.max(...counts.values());
    const top = [...counts.entries()].filter(([, n]) => n === max).map(([seat]) => seat).sort((a, b) => a - b);
    if (top.length === 1) return this.finishSheriffElection(top[0]!, `${top[0]} 号当选警长。`);
    if (revote) return this.finishSheriffElection(null, `PK 重新投票仍为平票（${top.join('、')} 号），警徽流失。`);
    this.sheriffTieCandidates = top;
    this.sheriffCandidates = new Set(top);
    this.pushLog(`警长投票出现平票：${top.join('、')} 号进入 PK 发言。`);
    this.enter('SHERIFF_PK');
  }

  private finishSheriffElection(seat: number | null, message: string): void {
    this.sheriffSeat = seat;
    this.sheriffElectionFinished = true;
    this.sheriffCandidates.clear();
    this.pushLog(message);
    this.enter('DAY_SPEECH');
  }

  private currentSheriffCandidates(): number[] {
    return [...this.sheriffCandidates].filter((seat) => this.bySeat(seat)?.alive).sort((a, b) => a - b);
  }

  private currentSheriffSpeechOrder(): number[] {
    const active = new Set(this.currentSheriffCandidates());
    const ordered = this.sheriffSpeechOrder.filter((seat) => active.has(seat));
    for (const seat of active) if (!ordered.includes(seat)) ordered.push(seat);
    return ordered;
  }

  private sheriffVoterSeats(): number[] {
    const candidates = new Set(this.currentSheriffCandidates());
    return this.aliveVoters().filter((p) => !candidates.has(p.seat)).map((p) => p.seat);
  }

  /** 进入下一夜：天数递增，重新开始夜晚流程 */
  private nextNight(): void {
    this.day += 1;
    this.enter('NIGHT_START');
  }

  /**
   * 本局夜晚需要走的角色阶段序列。
   *
   * 顺序**不再写在这里** —— 它由 `roles.ts` 的 `nightOrderFor()` 决定，
   * 再用 `NIGHT_PHASE_BY_ROLE` 翻成阶段名。
   *
   * 为什么要把顺序挪出去：自定义版型界面必须告诉玩家「狼美人在第几个环节睁眼」，
   * 而那个说明如果和引擎各写一份，早晚会对不上 —— 而顺序错了整个板子就废了，
   * 12 人局当场根本没人能发现。现在两边共用同一份数据，只有一种可能：一致。
   */
  private nightSequence(): Phase[] {
    const seq: Phase[] = [];
    for (const role of nightOrderFor(this.boardRoles, this.day)) {
      const phase = NIGHT_PHASE_BY_ROLE[role];
      if (phase) seq.push(phase);
    }
    return seq;
  }

  /**
   * 夜晚阶段顺序推进。
   *
   * ★ 这里以前是按「角色还活着且有事可做」来跳过的，那是一个真实的信息漏洞：
   *   女巫用完两瓶药 → 女巫阶段消失 → 全场从**阶段时长**就能推断出女巫没药了；
   *   守卫出局 → 守卫阶段消失 → 等于广播「守卫已经死了」。
   *
   * 现在改成：**只要板子里有这个角色，这一阶段就一定完整走完固定时长。**
   * 角色出局后该阶段没人能行动，阶段照样空转满时长 —— 空转本身就是防火墙。
   * 唯一的例外是狼全死，但那时游戏已经结束，属于公开信息。
   */
  private nextNightPhase(after: Phase): Phase {
    const seq = this.nightSequence();
    const startIdx = after === 'NIGHT_START' ? 0 : seq.indexOf(after) + 1;

    for (let i = Math.max(0, startIdx); i < seq.length; i++) {
      const phase = seq[i]!;
      return phase;
    }
    return 'NIGHT_RESOLVE';
  }

  private witchHasDecision(): boolean {
    const witch = this.aliveSole('WITCH');
    if (!witch) return false;
    const canSave =
      this.witchPotions.antidote &&
      this.night.wolfTarget !== null &&
      (this.night.wolfTarget !== witch.seat || this.config.witchCanSelfSave);
    const canPoison = this.witchPotions.poison && this.aliveSeats().some((s) => s !== witch.seat);
    return canSave || canPoison;
  }

  private resolveWolfVotes(): void {
    if (this.night.wolfTarget !== null) return;
    const picks = [...this.night.wolfPicks.values()];
    if (picks.length === 0) {
      this.night.wolfTarget = null;
      return;
    }
    this.night.wolfTarget = plurality(picks);
  }

  // ────────────────── 傀儡（「唯邻是从」） ──────────────────

  /**
   * 首夜狼队能选谁当傀儡：**与任意一只狼相邻的好人**。
   *
   * 这就是板子名字「唯邻是从」的来历 —— 不能全场随便点一个人，
   * 只能从狼的邻居里挑。相邻按**环形**算（1 号和 12 号是邻居），
   * 因为面杀是围坐一圈。
   *
   * 只做一次：傀儡定下之后就不再产生候选人（`puppetSeat` 一锁，这里返回空）。
   */
  private puppetCandidates(): number[] {
    if (!this.puppetEnabled) return [];
    if (this.puppetSeat !== null) return [];
    if (this.day !== 1) return [];
    const seats = this.players.map((p) => p.seat).sort((a, b) => a - b);
    if (seats.length === 0) return [];
    const min = seats[0]!;
    const max = seats[seats.length - 1]!;
    const neighbours = (seat: number): number[] => [
      seat === min ? max : seat - 1,
      seat === max ? min : seat + 1,
    ];

    const out = new Set<number>();
    for (const wolf of this.aliveKnifeWolves()) {
      for (const seat of neighbours(wolf.seat)) {
        const player = this.bySeat(seat);
        if (!player || !player.alive) continue;
        // 只能选好人：狼的邻居如果还是狼，没有意义
        if (this.truthCamp(player) === 'WOLF') continue;
        out.add(seat);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /**
   * 首夜狼队投出的傀儡 → 真正生效。
   *
   * **立刻生效**（而不是等天亮）：这样当夜排在狼人之后的预言家验他，
   * 看到的就是【狼人】；如果傀儡是守卫/女巫/预言家，他当夜的技能也已经异常了。
   */
  private applyPuppetVote(): void {
    if (this.puppetSeat !== null) return;
    const picks = [...this.night.puppetPicks.values()];
    if (picks.length === 0) return;
    const chosen = plurality(picks);
    if (chosen === null) return;
    if (!this.puppetCandidates().includes(chosen)) return;
    this.puppetSeat = chosen;
    this.night.puppetTarget = chosen;
    const player = this.bySeat(chosen);
    // 只进私有日志：这是全场最不能泄露的一条信息
    this.pushSecret(
      `首夜狼队选中 ${chosen} 号（${player ? ROLE_NAME[player.role] : '?'}）作为傀儡，` +
        `他本人不知情，技能已暗中失效/反转`,
    );
  }

  /** 傀儡的某个技能是否已经不可信（失效或反转） */
  private isPuppet(player: PlayerState): boolean {
    return player.seat === this.puppetSeat;
  }

  /** 进入新阶段并执行该阶段的入场结算 */
  private enter(phase: Phase): void {
    this.phase = phase;

    switch (phase) {
      case 'NIGHT_START': {
        this.night = emptyNight();
        this.votes = new Map();
        // 抄一份「昨天放逐了谁」再清空 —— 守墓人在本夜要查它
        this.lastDayExiledSeat = this.exiled?.seat ?? null;
        this.exiled = null;
        this.voteDetail = [];
        this.hunterChoice = undefined;
        this.boomChoice = undefined;
        this.pushLog(`【第 ${this.day} 天】天黑请闭眼。`);
        break;
      }
      case 'NIGHT_DANCER': {
        this.pushLog('舞者请睁眼，请选择三名玩家进入舞池。');
        break;
      }
      case 'NIGHT_MASK': {
        this.pushLog('假面请睁眼，请先查验舞池，再选择一名玩家戴上面具。');
        break;
      }
      case 'NIGHT_DREAMER': {
        this.pushLog('摄梦人请睁眼，请选择今晚的梦游者。');
        break;
      }
      case 'NIGHT_WOLVES': {
        this.pushLog('狼人请睁眼，请选择今晚要击杀的目标。');
        this.pushSecret(`存活狼人 ${this.aliveWolves().length} 名`);
        break;
      }
      case 'NIGHT_GUARD': {
        this.pushLog('守卫请睁眼，请选择今晚要守护的玩家。');
        this.pushSecret(
          this.lastGuardedSeat === null
            ? '守卫上一夜没有守护任何人'
            : `守卫上一夜守了 ${this.lastGuardedSeat} 号（本夜不能重复）`,
        );
        break;
      }
      case 'NIGHT_WITCH': {
        const who = this.night.wolfTarget;
        this.pushLog('女巫请睁眼。');
        this.pushSecret(who === null ? '今晚无人被狼人杀害' : `今晚 ${who} 号被狼人杀害`);
        break;
      }
      case 'NIGHT_SEER': {
        this.pushLog('预言家请睁眼，请选择今晚要查验的玩家。');
        break;
      }
      case 'NIGHT_SPIRIT_SEER': {
        this.pushLog('通灵师请睁眼，请选择今晚要查验具体身份的玩家。');
        break;
      }
      case 'NIGHT_GRAVE_KEEPER': {
        this.pushLog('守墓人请睁眼。');
        // 结果在阶段开始时就告诉他 —— 不依赖他点「我已知晓」，
        // 这样挂机超时也不会丢信息；提交只是让阶段正常收束的确认。
        // 已出局的守墓人不补录：死人不再获得新情报（阶段照常空转满时长）。
        const seat = this.lastDayExiledSeat;
        const target = seat === null ? undefined : this.bySeat(seat);
        const check: { seat: number | null; isWolf: boolean } = {
          seat,
          // 用真实阵营：傀儡被放逐时，守墓人查到的应该是【狼人】。
          // （混血儿对查验类技能一律显示好人 —— isWolfRole(HYBRID) = false）
          isWolf: target ? this.truthCamp(target) === 'WOLF' : false,
        };
        this.night.graveCheck = check;
        const keeper = this.aliveSole('GRAVE_KEEPER');
        if (keeper) {
          this.graveHistory.push({ day: this.day, seat, isWolf: check.isWolf });
          this.pushSecret(
            seat === null
              ? '守墓人：昨天没有人被投票放逐'
              : `守墓人查验昨日放逐者 ${seat} 号：${check.isWolf ? '狼人' : '好人'}`,
          );
        }
        break;
      }
      case 'NIGHT_RESOLVE': {
        this.resolveNightDeaths();
        break;
      }
      case 'DAY_ANNOUNCE': {
        // 上一夜的「X 号自爆」播报已经随 NIGHT_START 语音念完了，白天开始前清掉，
        // 下一轮自爆重新积累（写入在 selfDestruct → nextNight 之前）。
        this.boomAnnouncements = [];
        if (this.lastNightDeaths.length === 0) {
          this.pushLog(`【第 ${this.day} 天】天亮了。昨晚是平安夜，无人死亡。`);
        } else {
          const names = this.lastNightDeaths
            .map((s) => `${s} 号（${this.bySeat(s)?.nickname ?? '?'}）`)
            .join('、');
          this.pushLog(`【第 ${this.day} 天】天亮了。昨晚死亡的是：${names}。`);
        }
        // 开枪机会已经在 kill() 中按角色和死因入队；天亮只记录提示，不重复入队。
        for (const seat of this.lastNightDeaths) {
          const p = this.bySeat(seat);
          if (!p) continue;
          const cause = this.deathCauseOf(seat);
          if (cause && this.canTriggerDeathShot(p, cause)) {
            this.pushSecret(`${this.deathShooterName(p)}（${seat} 号）在夜里出局，可获得开枪机会`);
          }
        }
        this.checkWinner();
        break;
      }
      case 'SHERIFF_SIGNUP': {
        this.sheriffSignup = new Map();
        this.sheriffCandidates.clear();
        this.sheriffWithdrawn.clear();
        this.sheriffVotes = new Map();
        this.sheriffSpeechOrder = [];
        this.voteDetail = [];
        this.sheriffElectionRound = 0;
        this.pushLog('第一天警长竞选开始，所有存活玩家请选择上警或不上警。');
        break;
      }
      case 'SHERIFF_CAMPAIGN': {
        this.pushLog(`上警玩家：${this.currentSheriffCandidates().join('、')} 号。发言顺序：${this.currentSheriffSpeechOrder().join(' → ')}。候选人可以退水。`);
        break;
      }
      case 'SHERIFF_VOTE': {
        this.pushLog('警上发言结束，警下玩家开始投票。候选人没有投票权。');
        break;
      }
      case 'SHERIFF_PK': {
        this.pushLog(`平票候选人 ${this.currentSheriffCandidates().join('、')} 号进行 PK 发言，仍可退水。`);
        break;
      }
      case 'SHERIFF_REVOTE': {
        this.pushLog('PK 发言结束，非候选人重新投票；再次平票则警徽流失。');
        break;
      }
      case 'DAY_SPEECH': {
        this.speechDirection = null;
        this.computeSpeechOrder();
        if (this.sheriffSeat !== null) {
          this.pushLog(`请警长（${this.sheriffSeat} 号）选择发言方向；警长最后发言并归票。`);
        } else {
          this.pushLog(`请大家依次发言（建议顺序：${this.speechOrder().join(' → ')}）。`);
        }
        break;
      }
      case 'DAY_VOTE': {
        this.votes = new Map();
        this.exiled = null;
        this.voteDetail = [];
        this.pushLog('发言结束，请投票放逐一名玩家。警长票按 1.5 票计算。');
        break;
      }
      case 'DAY_EXILE': {
        this.resolveExile();
        break;
      }
      case 'HUNTER_SHOOT': {
        this.hunterChoice = undefined;
        const shooter = this.hunterPendingSeat === null ? undefined : this.bySeat(this.hunterPendingSeat);
        this.pushLog(`${shooter ? this.deathShooterName(shooter) : '玩家'}出局，可以开枪带走一名玩家。`);
        break;
      }
      case 'WOLF_KING_BOOM': {
        this.boomChoice = undefined;
        this.pushLog('白狼王自爆，请指定要带走的玩家。');
        break;
      }
      case 'SHERIFF_TRANSFER': {
        this.sheriffTransferChoice = undefined;
        this.pushLog(`警长（${this.sheriffTransferFrom} 号）出局，请移交或撕毁警徽。`);
        break;
      }
      case 'GAME_OVER': {
        if (this.draw && !this.winner) {
          this.pushLog(`游戏结束：已进行 ${this.day} 天仍未分出胜负，本局流局。`);
        } else if (this.winner) {
          this.pushLog(`游戏结束：${CAMP_NAME[this.winner]}胜利！`);
        }
        break;
      }
      default:
        break;
    }
  }

  private deathCauseOf(seat: number): DeathCause | null {
    const rec = [...this.deaths].reverse().find((d) => d.seat === seat);
    return rec ? rec.cause : null;
  }

  private resolveNightDeaths(): void {
    /** 基础死因优先级：毒 > 舞池 > 狼刀；摄梦结算最后覆盖梦游者。 */
    const causes = new Map<number, DeathCause>();
    const wolfTarget = this.night.wolfTarget;
    const dreamer = this.aliveSole('DREAMER');
    const dreamTarget = this.night.dreamerTarget;

    /**
     * ── 傀儡的技能异常，全部在**结算**这一层处理 ──
     *
     * 为什么不在提交时就把字段清空：傀儡的界面必须照常显示
     * 「已使用解药」「已守护 5 号」—— 他在提交那一刻就得看到正常的反馈，
     * 否则他当场就知道自己中招了，信息污染就没了。
     * 所以「记录照常、生效作废」：字段照写，只是不允许它影响结果。
     */
    const guard = this.soleOf('GUARD');
    const witch = this.soleOf('WITCH');
    /** 傀儡守卫：守护照选，但完全不生效（狼刀照样落下去） */
    const guardIsPuppet = guard !== undefined && this.isPuppet(guard);
    /** 傀儡女巫：两瓶药照用，但都不产生效果 */
    const witchIsPuppet = witch !== undefined && this.isPuppet(witch);

    const guardTargets = [
      guardIsPuppet ? null : this.night.guardTarget,
      this.night.mechanicalGuardTarget,
    ].filter((seat): seat is number => seat !== null);
    /** 生效的解药（傀儡的解药不挡刀） */
    const witchSaved = witchIsPuppet ? false : this.night.witchSave;
    /** 是否消耗解药：只看**用没用**，不看有没有效 —— 傀儡的药也扣掉 */
    const witchAntidoteUsed = this.night.witchSave;
    const dancer = this.soleOf('DANCER');
    const danceProtected = new Set<number>(
      dancer && this.night.dancerTargets.includes(dancer.seat) ? this.night.dancerTargets : [],
    );

    // ── 狼刀是否真的落在目标身上 ──
    //
    // 守卫守护 与 女巫解药 单独作用都能挡住狼刀，
    // 但**两者同时作用在同一人身上时（同守同救），该玩家依然死亡** ——
    // 这是主流平台的规则，双重保护被视为无效。
    if (wolfTarget !== null) {
      const byGuard = guardTargets.includes(wolfTarget);
      const byWitch = witchSaved;

      if (danceProtected.has(wolfTarget)) {
        this.pushSecret(`舞者在舞池中，${wolfTarget} 号获得舞池狼刀保护`);
      } else if (byGuard && byWitch) {
        causes.set(wolfTarget, 'WOLF');
        this.pushSecret(`同守同救：${wolfTarget} 号同时被守护和解药保护，依然死亡`);
      } else if (byGuard) {
        this.pushSecret(`守卫守住了 ${wolfTarget} 号，狼刀无效`);
      } else if (byWitch) {
        this.pushSecret(`女巫用解药救下 ${wolfTarget} 号`);
      } else {
        causes.set(wolfTarget, 'WOLF');
      }
    }

    // ── 舞池结算 ──
    // 假面的面具只在这里临时反转阵营，不改变真实身份、预言家结果或最终胜负。
    if (this.night.dancerTargets.length === 3) {
      const camps = this.night.dancerTargets.map((seat) => {
        const player = this.bySeat(seat)!;
        let camp: Camp = this.truthCamp(player);
        if (seat === this.night.maskTarget) camp = camp === 'WOLF' ? 'GOOD' : 'WOLF';
        return { seat, camp };
      });
      const wolves = camps.filter((entry) => entry.camp === 'WOLF');
      const good = camps.filter((entry) => entry.camp === 'GOOD');
      const minority = wolves.length === 1 ? wolves : good.length === 1 ? good : [];
      if (minority.length === 1) {
        causes.set(minority[0]!.seat, 'DANCE');
        this.pushSecret(`舞池阵营为 2 比 1，${minority[0]!.seat} 号作为少数阵营出局`);
      } else {
        this.pushSecret('舞池三人计算阵营一致，本夜没有舞池死亡');
      }
    }

    if (this.night.witchPoison !== null) {
      if (witchIsPuppet) {
        // 傀儡女巫的毒药下肚了、界面也显示「已使用」，但**不产生任何效果**
        this.pushSecret(`傀儡女巫 ${witch?.seat ?? '?'} 号对 ${this.night.witchPoison} 号使用毒药，但药是假的`);
      } else {
        // 舞者与假面免疫毒药，但毒药仍会被消耗。
        const target = this.bySeat(this.night.witchPoison);
        if (target?.role === 'DANCER' || target?.role === 'MASK') {
          this.pushSecret(`女巫对 ${this.night.witchPoison} 号使用毒药，但该角色免疫毒药`);
        } else {
          causes.set(this.night.witchPoison, 'POISON');
          this.pushSecret(`女巫使用毒药毒杀 ${this.night.witchPoison} 号`);
        }
      }
    }
    if (this.night.mechanicalPoison !== null && this.mechanicalPoisonAvailable) {
      const target = this.bySeat(this.night.mechanicalPoison);
      if (target?.role !== 'DANCER' && target?.role !== 'MASK') {
        causes.set(this.night.mechanicalPoison, 'POISON');
      }
      this.mechanicalPoisonAvailable = false;
      this.pushSecret(
        target?.role === 'DANCER' || target?.role === 'MASK'
          ? `机械狼对 ${this.night.mechanicalPoison} 号使用复制毒药，但该角色免疫毒药`
          : `机械狼使用复制毒药毒杀 ${this.night.mechanicalPoison} 号`,
      );
    }

    // ── 摄梦结算 ──
    // 梦游者不会得知自己被选中，并免疫本夜狼刀、毒药和舞池等夜间伤害；
    // 但“连续两夜摄梦同一人”和“摄梦人夜里死亡”会直接令其以 DREAM 死因出局。
    if (dreamer && dreamTarget !== null) {
      const blockedCause = causes.get(dreamTarget);
      if (blockedCause) {
        causes.delete(dreamTarget);
        this.pushSecret(`梦游者 ${dreamTarget} 号免疫了本夜的【${DEATH_CAUSE_LABEL[blockedCause]}】`);
      }

      const consecutive = this.lastDreamedSeat === dreamTarget;
      const dreamerDies = causes.has(dreamer.seat);
      if (consecutive) {
        causes.set(dreamTarget, 'DREAM');
        this.pushSecret(`${dreamTarget} 号连续两夜成为梦游者，被摄梦人带走`);
      } else if (dreamerDies) {
        causes.set(dreamTarget, 'DREAM');
        this.pushSecret(`摄梦人 ${dreamer.seat} 号夜里死亡，梦游者 ${dreamTarget} 号一同出局`);
      }
      this.lastDreamedSeat = dreamTarget;
    }

    // ── 消耗药水 ──
    // 注意用 `witchAntidoteUsed` 而不是生效的 `witchSaved`：
    // 傀儡女巫的解药**虽然没用**，但也要扣掉 —— 否则他能反复"救"同一晚，
    // 一试就知道药是假的。
    if (witchAntidoteUsed && wolfTarget !== null) this.witchPotions.antidote = false;
    if (this.night.witchPoison !== null) this.witchPotions.poison = false;

    // ── 记下守卫这一夜守了谁（供下一夜判断「不能连续守同一人」） ──
    if (this.night.guardTarget !== null) this.lastGuardedSeat = this.night.guardTarget;
    if (this.night.mechanicalGuardTarget !== null) this.mechanicalLastGuardedSeat = this.night.mechanicalGuardTarget;

    // ── 恶灵骑士结算 ──
    //
    // ① 反伤：夜里对他动手的女巫/预言家/通灵师，天亮时死亡。
    //    放在这里而不是提交时，是因为死讯必须进天亮公告 ——
    //    `kill()` 是在下面算完 `lastNightDeaths` 之后才跑的。
    if (this.night.darkLordReflectVictim !== null && !this.darkLordReflectUsed) {
      const victim = this.night.darkLordReflectVictim;
      this.darkLordReflectUsed = true;
      if (this.bySeat(victim)?.alive) {
        causes.set(victim, 'REFLECT');
        this.pushSecret(`${victim} 号遭到恶灵骑士反伤出局`);
      }
    }

    // ② 「夜里不会死亡」：所有夜间伤害对他无效，而且**连公告都不能把他列进去**
    //    （否则会出现「昨晚死亡的是 7 号」但 7 号明明还活着）。
    //    殉情（LOVE）不算夜间伤害 —— 那是羁绊不是攻击，官方也没把它算进来。
    for (const seat of [...causes.keys()]) {
      const p = this.bySeat(seat);
      const cause = causes.get(seat)!;
      if (p && p.role === 'DARK_LORD' && cause !== 'LOVE') {
        causes.delete(seat);
        this.pushSecret(`恶灵骑士 ${seat} 号免疫了本夜的【${DEATH_CAUSE_LABEL[cause]}】`);
      }
    }

    // ── 狼美人殉情 ──
    // 她夜里出局时，**前一晚**被她魅惑的人陪葬，且殉情者不能发动技能。
    // 同样必须在这里追加进 causes，否则天亮公告会漏掉殉情者。
    const beauty = this.soleOf('WOLF_BEAUTY');
    if (beauty && causes.has(beauty.seat)) {
      const charmed = this.takeLovePactVictim();
      if (charmed !== null) {
        causes.set(charmed, 'LOVE');
        this.pushSecret(`狼美人 ${beauty.seat} 号夜里出局，${charmed} 号殉情`);
      }
    }

    this.lastNightDeaths = [...causes.keys()].sort((a, b) => a - b);
    for (const seat of this.lastNightDeaths) {
      const p = this.bySeat(seat);
      if (p) this.kill(p, causes.get(seat)!, true);
    }

    // 本夜新魅惑的人从**下一夜**起才生效 —— 殉情只带「前一晚」那个。
    // 必须放在上面的 kill 循环**之后**：kill() 里还有一个殉情钩子
    // （负责白天出局的情形，前提是「夜结算已清空 lastCharmedSeat」），
    // 若在此之前更新，狼美人当夜出局会把本夜刚魅惑的人也误带走。
    this.lastCharmedSeat = this.night.beautyCharmTarget;

    this.replayNights.push({
      day: this.day,
      wolfVotes: [...this.night.wolfPicks.entries()]
        .map(([voter, target]) => ({ voter, target }))
        .sort((a, b) => a.voter - b.voter),
      wolfTarget: this.night.wolfTarget,
      guardTarget: this.night.guardTarget,
      mechanicalGuardTarget: this.night.mechanicalGuardTarget,
      witchActed: this.night.witchActed,
      witchSave: this.night.witchSave,
      witchPoison: this.night.witchPoison,
      mechanicalPoison: this.night.mechanicalPoison,
      seerTarget: this.night.seerTarget,
      seerCamp: this.night.seerCamp,
      mechanicalSeerTarget: this.night.mechanicalSeerTarget,
      mechanicalSeerCamp: this.night.mechanicalSeerCamp,
      spiritTarget: this.night.spiritTarget,
      spiritRole: this.night.spiritRole,
      mechanicalSpiritTarget: this.night.mechanicalSpiritTarget,
      mechanicalSpiritRole: this.night.mechanicalSpiritRole,
      dancerTargets: this.night.dancerTargets.slice(),
      maskInspectTarget: this.night.maskInspectTarget,
      maskInspectResult: this.night.maskInspectResult,
      maskTarget: this.night.maskTarget,
      dreamerTarget: this.night.dreamerTarget,
      beautyCharmTarget: this.night.beautyCharmTarget,
      graveCheck: this.night.graveCheck ? { ...this.night.graveCheck } : null,
      deaths: this.lastNightDeaths.map((seat) => ({ seat, cause: causes.get(seat)! })),
    });
  }

  private resolveExile(): void {
    const entries = [...this.votes.entries()];
    this.voteDetail = entries
      .map(([voter, target]) => ({ voter, target, weight: voter === this.sheriffSeat ? 1.5 : 1 }))
      .sort((a, b) => a.voter - b.voter);
    this.replayDayVotes.push({
      day: this.day,
      votes: this.voteDetail.map((vote) => ({ ...vote })),
    });

    const totals = new Map<number, number>();
    for (const [voter, target] of entries) {
      if (target !== null) totals.set(target, (totals.get(target) ?? 0) + (voter === this.sheriffSeat ? 1.5 : 1));
    }
    if (totals.size === 0) {
      this.pushLog('全员弃票，本轮无人出局。');
      return;
    }
    const max = Math.max(...totals.values());
    const topSeats = [...totals.entries()].filter(([, score]) => score === max).map(([seat]) => seat);
    if (topSeats.length !== 1) {
      this.pushLog('投票出现平票，本轮无人出局。');
      return;
    }
    const top = topSeats[0]!;
    const p = this.bySeat(top)!;
    this.exiled = { seat: p.seat, nickname: p.nickname };

    if (this.canFlipAsIdiot(p) && !p.idiotRevealed) {
      p.idiotRevealed = true;
      const identityText = p.role === 'IDIOT' ? '白痴' : '继承白痴技能的机械狼';
      this.pushLog(
        `${p.seat} 号（${p.nickname}）被投票放逐，翻牌为【${identityText}】，免于死亡，但从此失去投票权。`,
      );
      return;
    }

    this.kill(p, 'VOTE');
    this.pushLog(`${p.seat} 号（${p.nickname}）被投票放逐出局。`);
    if (this.canTriggerDeathShot(p, 'VOTE')) {
      this.pushLog(`被放逐的是${this.deathShooterName(p)}，可以开枪带走一名玩家。`);
    }
    this.checkWinner();
  }

  private kill(p: PlayerState, cause: DeathCause, night = false): void {
    if (!p.alive) return;
    p.alive = false;
    this.deaths.push({ seat: p.seat, cause, day: this.day, night });
    if (this.canTriggerDeathShot(p, cause)) this.queueHunter(p.seat);
    if (p.seat === this.sheriffSeat) {
      this.sheriffSeat = null;
      this.sheriffTransferFrom = p.seat;
    }
    // 狼美人出局 → 前一晚被魅惑的人殉情。
    //
    // 夜里出局的情况上面已经在 causes 里处理过了（那边必须提前处理，死讯才进得了
    // 天亮公告），此时 lastCharmedSeat 已被清空，所以这里取到 null，不会重复。
    // 这里真正负责的是**白天出局**：被放逐、被开枪、被白狼王带走。
    //
    // 例外：被骑士决斗处决不触发殉情（官方规则，她的角色说明里写明了这一条）。
    if (p.role === 'WOLF_BEAUTY' && cause !== 'DUEL') {
      const charmed = this.takeLovePactVictim();
      if (charmed !== null) this.killByLovePact(charmed, night);
    }
  }

  /**
   * 殉情出局。
   *
   * 有意**不走 `kill()`**：官方规定殉情者不能发动技能，
   * 而 `kill()` 会给猎人/狼王排队开枪。所以这里手写一份「死亡」，
   * 唯一的区别就是不给开枪机会。
   */
  private killByLovePact(seat: number, night: boolean): void {
    const victim = this.bySeat(seat);
    if (!victim || !victim.alive) return;
    victim.alive = false;
    this.deaths.push({ seat, cause: 'LOVE', day: this.day, night });
    this.pushLog(`${seat} 号（${victim.nickname}）为狼美人殉情，不能发动技能。`);
    if (seat === this.sheriffSeat) {
      this.sheriffSeat = null;
      this.sheriffTransferFrom = seat;
    }
  }

  private checkWinner(): void {
    if (this.winner) return;
    const wolves = this.aliveWolves().length;
    /**
     * 屠边名额**不含傀儡**：他已经属于狼人阵营，不再是神也不再是民。
     *
     * 换句话说，如果傀儡原本是预言家，好人这边的神只剩 3 个 ——
     * 狼队杀光这 3 个就屠神成功，不需要多杀傀儡一次。
     * 而傀儡自己那一票要算在 `aliveWolves()` 里（好人必须清掉他），
     * 两件事是分开判的，别写混。
     */
    const gods = this.players.filter((p) => p.alive && p.seat !== this.puppetSeat && isGod(p.role)).length;
    const villagers = this.players.filter(
      (p) => p.alive && p.seat !== this.puppetSeat && (p.role === 'VILLAGER' || p.role === 'HYBRID'),
    ).length;

    if (wolves === 0) {
      this.winner = 'GOOD';
    } else if (
      // 只有「开局时确实存在」的类别全灭才算屠边成功。
      // 否则一个没有平民的版型会因为「平民数 = 0」在第一天就判狼人胜。
      (this.initialGods > 0 && gods === 0) ||
      (this.initialVillagers > 0 && villagers === 0)
    ) {
      this.winner = 'WOLF';
    }

    // 安全阀：全员挂机（每天全弃票、狼人每晚空刀）时也要能收场
    if (!this.winner && this.day >= MAX_DAYS) this.draw = true;
  }

  /** 对局是否已经结束（分出胜负或流局） */
  get isOver(): boolean {
    return this.winner !== null || this.draw;
  }

  /** 获胜阵营（未分胜负或流局时为 null）。只读，供服务端与测试读取。 */
  get winnerCamp(): Camp | null {
    return this.winner;
  }

  outcome(): Outcome | null {
    if (this.winner) return this.winner;
    return this.draw ? 'DRAW' : null;
  }

  private resultCampFor(player: PlayerState): Camp {
    // 傀儡按**真实阵营**计分：他最终确实是跟着狼队赢的。
    // 这也是整局结束、真相揭晓的时刻 —— 让他（和所有人）看到这一点正是这个板子的戏剧性所在。
    if (player.seat === this.puppetSeat) return 'WOLF';
    if (player.role === 'HYBRID' && this.hybridModelSeat !== null) {
      const model = this.bySeat(this.hybridModelSeat);
      return model && isWolfRole(model.role) ? 'WOLF' : 'GOOD';
    }
    return isWolfRole(player.role) ? 'WOLF' : 'GOOD';
  }

  private computeSpeechOrder(): void {
    const alive = this.aliveSeats();
    if (alive.length === 0) {
      this.speechStartSeat = null;
      return;
    }
    if (this.sheriffSeat !== null && alive.includes(this.sheriffSeat) && this.speechDirection !== null) {
      const idx = alive.indexOf(this.sheriffSeat);
      const others = [...alive.slice(idx + 1), ...alive.slice(0, idx)];
      const directed = this.speechDirection === 'FORWARD' ? others : others.reverse();
      this.speechStartSeat = directed[0] ?? this.sheriffSeat;
      return;
    }
    const anchor = this.lastNightDeaths.length > 0 ? Math.min(...this.lastNightDeaths) : 0;
    const start = alive.find((s) => s > anchor) ?? alive[0]!;
    this.speechStartSeat = start;
  }

  private speechOrder(): number[] {
    const alive = this.aliveSeats();
    const start = this.speechStartSeat;
    if (start === null || !alive.includes(start)) return alive;
    if (this.sheriffSeat !== null && this.speechDirection !== null && alive.includes(this.sheriffSeat)) {
      const sheriffIdx = alive.indexOf(this.sheriffSeat);
      const others = [...alive.slice(sheriffIdx + 1), ...alive.slice(0, sheriffIdx)];
      return [...(this.speechDirection === 'FORWARD' ? others : others.reverse()), this.sheriffSeat];
    }
    const idx = alive.indexOf(start);
    return [...alive.slice(idx), ...alive.slice(0, idx)];
  }

  private pushLog(text: string): void {
    this.log.push(text);
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }

  /**
   * 记录隐藏信息（刀口、药水、存活狼人数量等）。
   * 这些内容一旦进入公开日志，玩家就能直接推出狼人和女巫的身份 —— 所以必须隔离。
   */
  private pushSecret(text: string): void {
    this.secretLog.push(`[第${this.day}天 ${this.phase}] ${text}`);
    if (this.secretLog.length > 500) this.secretLog.splice(0, this.secretLog.length - 500);
  }

  /** 仅供服务端运营排查使用 */
  secretLogSnapshot(): readonly string[] {
    return this.secretLog;
  }

  /** 仅供服务端在保存已结束/提前结束的场次时调用。 */
  replaySnapshot(): MatchReplay {
    return {
      version: 1,
      nights: this.replayNights.map((night) => ({
        ...night,
        wolfVotes: night.wolfVotes.map((vote) => ({ ...vote })),
        dancerTargets: night.dancerTargets.slice(),
        deaths: night.deaths.map((death) => ({ ...death })),
      })),
      dayVotes: this.replayDayVotes.map((round) => ({
        day: round.day,
        votes: round.votes.map((vote) => ({ ...vote })),
      })),
      publicEvents: this.log.slice(),
      secretEvents: this.secretLog.slice(),
    };
  }

  // ─────────────────── 视图（信息过滤的核心） ───────────────────

  /** 房间座位视图：自己与狼队友可见身份，其余人只见公开信息 */
  seatViewsFor(playerId: string): SeatView[] {
    const me = this.byId(playerId);
    const started = this.phase !== 'WAITING';
    const wolfAlly = me ? this.knowsWolfPack(me) : false;
    return this.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map<SeatView>((p) => {
        const isMe = me?.id === p.id;
        const canSeeRole = isMe || (wolfAlly && this.knowsWolfPack(p));
        return {
          seat: p.seat,
          occupied: true,
          nickname: p.nickname,
          avatar: p.avatar,
          online: true,
          ready: started,
          isHost: p.isHost,
          isMe,
          ...(started ? { alive: p.alive, idiotRevealed: p.idiotRevealed } : {}),
          ...(started ? { isSheriff: p.seat === this.sheriffSeat } : {}),
          ...(canSeeRole ? { role: p.role, roleName: ROLE_NAME[p.role] } : {}),
        };
      });
  }

  /**
   * 当前阶段该朗读的台词（当法官用）。
   *
   * 铁律：**只能包含公开信息**。
   * 例如女巫阶段只能说「女巫请睁眼」，绝不能把刀口念出来 ——
   * 那等于用喇叭把狼人的选择广播给所有人。
   */
  voiceLineFor(): string {
    // 夜间角色阶段：把「上一个角色的闭眼」拼在本阶段睁眼之前。
    // 台词只由「阶段 + 天数 + 公开板子」决定，因此全场每个人听到的一模一样。
    if (NIGHT_OPEN_LINE[this.phase]) {
      const seq = this.nightSequence();
      const idx = seq.indexOf(this.phase);
      const prev = idx > 0 ? seq[idx - 1] : undefined;
      const close = prev ? (NIGHT_CLOSE_LINE[prev] ?? '') : '';
      return `${close}${NIGHT_OPEN_LINE[this.phase]}`;
    }

    switch (this.phase) {
      case 'ROLE_REVEAL':
        // 全场同一句，不含任何身份信息。
        // 尤其不能出现「请神职确认」这种按阵营分批喊人的说法 —— 那等于用喇叭点名。
        return '请查看你的身份牌，看清你的角色和能力。全员确认后，由房主开始第一夜。';
      case 'NIGHT_START':
        // 自爆/空爆是白天发生的公开事件：全场播报谁爆了（见 selfDestruct）。
        // 排除法不泄露「是谁」的任何私有信息 —— 自爆者已经亮牌，日志同样公示。
        if (this.boomAnnouncements.length > 0) {
          return `天黑请闭眼。${this.boomAnnouncements.join('、')} 号自爆了，今天不再发言与投票。现在是第 ${this.day} 天夜晚。`;
        }
        return `天黑请闭眼。现在是第 ${this.day} 天夜晚。`;
      case 'NIGHT_RESOLVE': {
        // 最后一个夜间角色也要明确念到闭眼，否则玩家会怀疑阶段被吞掉了
        const seq = this.nightSequence();
        const last = seq[seq.length - 1];
        const close = last ? (NIGHT_CLOSE_LINE[last] ?? '') : '';
        return `${close}天就快亮了。`;
      }
      case 'DAY_ANNOUNCE':
        if (this.lastNightDeaths.length === 0) {
          return '天亮了。昨晚是平安夜，没有人死亡。';
        }
        return `天亮了。昨晚死亡的是 ${this.lastNightDeaths.join('、')} 号。`;
      case 'SHERIFF_SIGNUP':
        return '警长竞选开始，请所有存活玩家选择上警或留在警下。';
      case 'SHERIFF_CAMPAIGN':
        return `上警玩家是 ${this.currentSheriffCandidates().join('、')} 号，请依次竞选发言。`;
      case 'SHERIFF_VOTE':
        return '警上发言结束，请警下玩家投票选出警长。';
      case 'SHERIFF_PK':
        return `平票候选人 ${this.currentSheriffCandidates().join('、')} 号进行 PK 发言。`;
      case 'SHERIFF_REVOTE':
        return 'PK 发言结束，请非候选人重新投票。';
      case 'DAY_SPEECH':
        return this.sheriffSeat === null
          ? '请按页面显示的顺序依次发言。'
          : '请警长选择发言方向，警长最后发言并归票。';
      case 'DAY_VOTE':
        return '天亮了，请依次发言，然后投票选出你要放逐的玩家。';
      case 'DAY_EXILE':
        if (this.exiled) return `${this.exiled.seat} 号被投票放逐出局。`;
        return '本轮投票没有产生放逐对象。';
      case 'SHERIFF_TRANSFER':
        return '警长出局，请选择移交警徽或撕毁警徽。';
      case 'HUNTER_SHOOT': {
        const shooter = this.hunterPendingSeat === null ? undefined : this.bySeat(this.hunterPendingSeat);
        return `${shooter ? this.deathShooterName(shooter) : '玩家'}出局，请选择是否开枪带走一名玩家。`;
      }
      case 'WOLF_KING_BOOM':
        return '白狼王自爆，请选择要带走的玩家。';
      case 'GAME_OVER':
        if (this.draw && !this.winner) return '游戏结束，本局流局。';
        return this.winner ? `游戏结束，${CAMP_NAME[this.winner]}胜利。` : '游戏结束。';
      default:
        return '';
    }
  }

  /**
   * 当前阶段该播报的**片段序列**（录音语音包用）。
   *
   * 和 `voiceLineFor()` 是同一段话的两种表达：
   *   - `voiceLineFor()` → 整句文字，浏览器 TTS 兜底时念它
   *   - `voiceCuesFor()` → 片段序列，语音包按顺序播；数字单独成段、句子之间留停顿
   *
   * **两者用词必须一致**（`engine.test.ts` 有测试逐阶段比对），
   * 否则「语音包里念的」和「没装语音包时念的」会不一样，
   * 而这种不一致只有听的人才发现得了。
   */
  voiceCuesFor(): VoiceCue[] {
    const seq = this.nightSequence();

    const openId = OPEN_CLIP[this.phase];
    if (openId) {
      const idx = seq.indexOf(this.phase);
      const prev = idx > 0 ? seq[idx - 1] : undefined;
      const closeId = prev ? CLOSE_CLIP[prev] : undefined;
      const cues: VoiceCue[] = [];
      // 「上一个角色闭眼」和「本角色睁眼」拆成两段，中间留一个停顿 ——
      // 这正是录音包比 TTS 好听的关键：法官会在这里停顿一下。
      if (closeId) cues.push({ clip: closeId }, { pause: SENTENCE_GAP_MS });
      cues.push({ clip: openId });
      return cues;
    }

    switch (this.phase) {
      case 'ROLE_REVEAL':
        return [{ clip: 'reveal.tip' }];
      case 'NIGHT_START': {
        const cues: VoiceCue[] = [
          { clip: 'night.fall' },
          { pause: SENTENCE_GAP_MS },
        ];
        // 白天的自爆/空爆在这里公开播报（与 voiceLineFor 的 NIGHT_START 文本一致）
        for (const seat of this.boomAnnouncements) {
          cues.push({ num: seat }, { clip: 'boom.plainTail' }, { pause: SENTENCE_GAP_MS });
        }
        cues.push({ clip: 'night.now' }, { num: this.day }, { clip: 'night.dayTail' });
        return cues;
      }
      case 'NIGHT_RESOLVE': {
        const last = seq[seq.length - 1];
        const closeId = last ? CLOSE_CLIP[last] : undefined;
        const cues: VoiceCue[] = [];
        if (closeId) cues.push({ clip: closeId }, { pause: SENTENCE_GAP_MS });
        cues.push({ clip: 'night.almost' });
        return cues;
      }
      case 'DAY_ANNOUNCE':
        if (this.lastNightDeaths.length === 0) {
          return [{ clip: 'day.break' }, { pause: SENTENCE_GAP_MS }, { clip: 'day.safe' }];
        }
        return [
          { clip: 'day.break' },
          { pause: SENTENCE_GAP_MS },
          { clip: 'day.deathsHead' },
          ...seatsCues(this.lastNightDeaths, 'day.seatTail'),
        ];
      case 'SHERIFF_SIGNUP':
        return [{ clip: 'sheriff.start' }];
      case 'SHERIFF_CAMPAIGN':
        return [
          { clip: 'sheriff.candHead' },
          ...seatsCues(this.currentSheriffCandidates(), 'sheriff.candTail'),
        ];
      case 'SHERIFF_VOTE':
        return [{ clip: 'sheriff.vote' }];
      case 'SHERIFF_PK':
        return [
          { clip: 'sheriff.pkHead' },
          ...seatsCues(this.currentSheriffCandidates(), 'sheriff.pkTail'),
        ];
      case 'SHERIFF_REVOTE':
        return [{ clip: 'sheriff.revote' }];
      case 'DAY_SPEECH':
        return [{ clip: this.sheriffSeat === null ? 'day.speech' : 'day.speechSheriff' }];
      case 'DAY_VOTE':
        return [{ clip: 'day.vote' }];
      case 'DAY_EXILE':
        if (!this.exiled) return [{ clip: 'day.noExile' }];
        return [{ num: this.exiled.seat }, { clip: 'day.exiledTail' }];
      case 'SHERIFF_TRANSFER':
        return [{ clip: 'sheriff.transfer' }];
      case 'HUNTER_SHOOT': {
        const shooter = this.hunterPendingSeat === null ? undefined : this.bySeat(this.hunterPendingSeat);
        if (!shooter) return [{ clip: 'shooter.player' }];
        if (shooter.role === 'HUNTER') return [{ clip: 'shooter.hunter' }];
        if (shooter.role === 'BLACK_WOLF_KING') return [{ clip: 'shooter.wolfking' }];
        if (shooter.role === 'MECHANICAL_WOLF') return [{ clip: 'shooter.mechanical' }];
        return [{ clip: 'shooter.player' }];
      }
      case 'WOLF_KING_BOOM':
        return [{ clip: 'boom.out' }];
      case 'GAME_OVER':
        if (this.draw && !this.winner) return [{ clip: 'over.draw' }];
        if (this.winner === 'WOLF') return [{ clip: 'over.wolf' }];
        if (this.winner === 'GOOD') return [{ clip: 'over.good' }];
        return [{ clip: 'over.plain' }];
      default:
        return [];
    }
  }

  gameViewFor(playerId: string): GameView {    const me = this.byId(playerId);
    const wolf = me ? this.knowsWolfPack(me) : false;
    const wolfNight = wolf && this.phase.startsWith('NIGHT_');

    const view: GameView = {
      phase: this.phase,
      phaseTitle: PHASE_LABEL[this.phase],
      phaseHint: this.hintFor(me),
      day: this.day,
      deadline: this.deadline,
      countdown: this.countdown,
      countdownEndsAt: this.countdownEndsAt,
      // 身份确认阶段的进度与门槛。只在这一阶段下发。
      ...(this.phase === 'ROLE_REVEAL'
        ? {
            roleReveal: {
              confirmedSeats: this.confirmedRoleRevealSeats(),
              pendingSeats: this.pendingRoleRevealSeats(),
              total: this.players.length,
              iConfirmed: Boolean(playerId) && this.roleRevealConfirmed.has(playerId),
              iAmHost: Boolean(playerId) && playerId === this.hostPlayerId,
              canBeginNight: this.canBeginNight(),
            },
          }
        : {}),
      me: me ? this.meView(me) : null,
      myTurn: this.isMyTurn(me),
      myOptions: this.optionsFor(me),
      mySubmitted: this.submittedFor(me),
      sheriffSeat: this.sheriffSeat,
      sheriffCandidates: this.currentSheriffCandidates(),
      sheriffWithdrawn: [...this.sheriffWithdrawn].sort((a, b) => a - b),
      sheriffElectionRound: this.sheriffElectionRound,
      sheriffElectionFinished: this.sheriffElectionFinished,
      speechDirection: this.speechDirection,
      deaths: this.deaths.map<DeathView>((d) => ({
        seat: d.seat,
        nickname: this.bySeat(d.seat)?.nickname ?? '?',
        // 死因与出局天数都是隐藏信息：只有真正进入 GAME_OVER 阶段才随复盘公开。
        // 注意不能用 isOver —— 胜负在 DAY_EXILE 阶段就算出来了，
        // 那一刻还会停留一个过场时间，提前下发等于让改过的客户端偷看答案。
        ...(this.phase === 'GAME_OVER' ? { cause: d.cause, day: d.day } : {}),
      })),
      lastNightDeaths: this.lastNightDeaths.slice(),
      exiled: this.exiled,
      boomPendingSeat: this.boomPendingSeat,
      hunterPendingSeat: this.hunterPendingSeat,
      shooterRoleName:
        this.phase === 'HUNTER_SHOOT' && this.hunterPendingSeat !== null
          ? this.deathShooterName(this.bySeat(this.hunterPendingSeat)!)
          : null,
      winner: this.phase === 'GAME_OVER' ? this.winner : null,
      outcome: this.phase === 'GAME_OVER' ? this.outcome() : null,
      voiceLine: this.voiceLineFor(),
      voiceCues: this.voiceCuesFor(),
      log: this.log.slice(-60),
      ...(this.canSeeProgress(me) ? { progress: this.progressFor(me) } : {}),
      voteDetail: this.voteDetail.slice(),
      ...(['SHERIFF_CAMPAIGN', 'SHERIFF_PK'].includes(this.phase)
        ? { speechOrder: this.currentSheriffSpeechOrder() }
        : ['DAY_SPEECH', 'DAY_VOTE'].includes(this.phase)
          ? { speechOrder: this.speechOrder() }
          : {}),
      // 防窥屏不仅靠前端隐藏：白天服务端不向任何页面下发狼队战术数据。
      ...(wolfNight
        ? {
            wolfTags: this.wolfSeats()
              .slice()
              .sort((a, b) => a - b)
              .map((seat) => ({
                seat,
                nickname: this.bySeat(seat)?.nickname ?? '?',
                tag: this.wolfTags.get(seat) ?? null,
                // 狼踩狼：填的「踩谁」以及这一对有没有互指成功
                target: this.wolfTagTargets.get(seat) ?? null,
                paired: this.wolfVsWolfPaired(seat),
              })),
          }
        : {}),
      // 点刀选择只在真正的狼人行动阶段下发，避免其他夜间身份阶段提前露出。
      ...(wolf && this.phase === 'NIGHT_WOLVES'
        ? {
            wolfVotes: [...this.night.wolfPicks.entries()]
              .map(([seat, target]) => ({ seat, target }))
              .sort((a, b) => a.seat - b.seat),
          }
        : {}),
      /**
       * 「唯邻是从」的傀儡信息：**只给狼队**，而且整局都下发。
       *
       * 为什么不像 wolfVotes 那样只限狼人阶段：三狼需要**一直记得**首夜选了谁 ——
       * 他们得避开刀他、还要在发言里配合他。只在首夜下发的话，天亮以后就忘了。
       * 候选人/投票只在首夜有意义，其余时候给空数组。
       *
       * 条件里的 `wolf` 是关键：漏掉它，傀儡（一个好人）就会收到这份视图，
       * 他看一眼就知道自己中招了。
       */
      ...(wolf && this.puppetEnabled
        ? {
            puppetInfo: {
              candidates: this.phase === 'NIGHT_WOLVES' ? this.puppetCandidates() : [],
              votes:
                this.phase === 'NIGHT_WOLVES'
                  ? [...this.night.puppetPicks.entries()]
                      .map(([seat, target]) => ({ seat, target }))
                      .sort((a, b) => a.seat - b.seat)
                  : [],
              chosen: this.puppetSeat,
            },
          }
        : {}),
      // 守卫专属：上一夜守了谁（界面要标出来，避免玩家误点导致提交被拒）
      ...(me && me.role === 'GUARD' ? { guardBlockedSeat: this.lastGuardedSeat } : {}),
      // 全场身份：游戏结束后所有人可见；游戏进行中只有「已经出局的人」能主动看。
      // 活着的玩家即使伪造 setGodView 请求也会被 engine 拒绝，服务端根本不生成这一份视图。
      ...((this.phase === 'GAME_OVER' ||
      (this.mayUseGodView(playerId) && this.revealAllRequested.has(playerId)))
        ? { revealAll: this.revealRows() }
        : {}),
      // 「上帝视角」按钮只在游戏进行中、且我自己已经出局时出现（客户端还会先弹确认）
      ...(this.phase !== 'GAME_OVER' && this.mayUseGodView(playerId)
        ? { godViewAvailable: true, godViewActive: this.revealAllRequested.has(playerId) }
        : {}),
    };

    // ── 以下为分角色信息补齐：只影响「我自己」看到的内容 ──
    if (me && me.role === 'WITCH' && this.phase === 'NIGHT_WITCH') {
      const target = this.night.wolfTarget;
      const canSave =
        this.witchPotions.antidote &&
        target !== null &&
        (target !== me.seat || this.config.witchCanSelfSave);
      let blocked: string | null = null;
      if (!this.witchPotions.antidote) blocked = '解药已经用过了';
      else if (target === null) blocked = '今晚没有人被狼人杀害';
      else if (target === me.seat && !this.config.witchCanSelfSave) blocked = '本局规则不允许女巫自救';

      view.witchInfo = { wolfTargetSeat: target, canSave, saveBlockedReason: blocked };
      view.phaseHint =
        target === null
          ? '今晚没有人被狼人杀害，你可以选择是否使用毒药。'
          : `今晚 ${target} 号（${this.bySeat(target)?.nickname ?? '?'}）被狼人杀害。${
              target === me.seat ? '（你不能自救）' : ''
            }`;
    }

    if (me && me.role === 'GUARD' && this.phase === 'NIGHT_GUARD') {
      view.phaseHint =
        this.lastGuardedSeat === null
          ? '选择一名玩家守护，他今晚不会被狼人杀害。'
          : `选择一名玩家守护。注意：${this.lastGuardedSeat} 号是你上一夜守过的人，本夜不能再守。`;
    }

    if (me && me.role === 'SEER' && this.phase === 'NIGHT_SEER' && this.night.seerTarget !== null) {
      const t = this.bySeat(this.night.seerTarget);
      view.phaseHint = `查验结果：${this.night.seerTarget} 号（${t?.nickname ?? '?'}）是${
        this.night.seerCamp === 'WOLF' ? '【狼人】' : '【好人】'
      }。`;
    }

    if (me && me.role === 'SPIRIT_SEER' && this.phase === 'NIGHT_SPIRIT_SEER' && this.night.spiritTarget !== null) {
      const target = this.bySeat(this.night.spiritTarget);
      view.phaseHint = `查验结果：${this.night.spiritTarget} 号（${target?.nickname ?? '?'}）的身份是【${this.night.spiritRole ? ROLE_NAME[this.night.spiritRole] : '?'}】。`;
    }

    if (me?.role === 'MECHANICAL_WOLF') {
      if (this.phase === 'NIGHT_MECHANICAL' && this.mechanicalLearnedRole !== null) {
        view.phaseHint = `你学习到的身份是【${ROLE_NAME[this.mechanicalLearnedRole]}】，复制技能从下一夜开始生效。`;
      } else if (this.phase === 'NIGHT_SEER' && this.night.mechanicalSeerTarget !== null) {
        view.phaseHint = `复制查验结果：${this.night.mechanicalSeerTarget} 号是${this.night.mechanicalSeerCamp === 'WOLF' ? '【狼人】' : '【好人】'}。`;
      } else if (this.phase === 'NIGHT_SPIRIT_SEER' && this.night.mechanicalSpiritTarget !== null) {
        view.phaseHint = `复制通灵结果：${this.night.mechanicalSpiritTarget} 号的身份是【${this.night.mechanicalSpiritRole ? ROLE_NAME[this.night.mechanicalSpiritRole] : '?'}】。`;
      }
    }

    if (me?.role === 'MASK' && this.phase === 'NIGHT_MASK' && this.night.maskInspectActed) {
      view.phaseHint = this.night.maskActed
        ? '你已完成本夜行动。'
        : `查验结果：${this.night.maskInspectTarget} 号${this.night.maskInspectResult ? '【在舞池】' : '【不在舞池】'}。现在请选择一名玩家戴上面具。`;
    }

    if (me?.role === 'GRAVE_KEEPER' && this.phase === 'NIGHT_GRAVE_KEEPER') {
      const check = this.night.graveCheck;
      if (check && check.seat !== null) {
        const who = this.bySeat(check.seat);
        view.phaseHint = `查验结果：昨天被放逐的 ${check.seat} 号（${who?.nickname ?? '?'}）是${check.isWolf ? '【狼人】' : '【好人】'}。`;
      }
    }

    return view;
  }

  private meView(me: PlayerState): GameView['me'] {
    const base = {
      seat: me.seat,
      role: me.role,
      roleName: ROLE_NAME[me.role],
      roleDesc: ROLE_DESC[me.role],
      camp: (isWolfRole(me.role) ? 'WOLF' : 'GOOD') as Camp,
      alive: me.alive,
      idiotRevealed: me.idiotRevealed,
      canVote: me.alive && !me.idiotRevealed,
    };
    if (me.role === 'HYBRID') {
      return { ...base, hybridModelSeat: this.hybridModelSeat };
    }
    if (me.role === 'DANCER') {
      return {
        ...base,
        danceHistory: this.danceHistory.map((entry) => ({ day: entry.day, seats: entry.seats.slice() })),
      };
    }
    if (me.role === 'MASK') {
      return {
        ...base,
        maskHistory: this.maskHistory.map((entry) => ({ ...entry })),
        maskInspect: this.night.maskInspectActed && this.night.maskInspectTarget !== null
          ? { seat: this.night.maskInspectTarget, inDance: this.night.maskInspectResult === true }
          : null,
        maskNeedsDisguise: this.phase === 'NIGHT_MASK' && this.night.maskInspectActed && !this.night.maskActed,
      };
    }
    if (me.role === 'DREAMER') {
      return {
        ...base,
        dreamHistory: this.dreamHistory.map((entry) => ({
          day: entry.day,
          seat: entry.seat,
          nickname: this.bySeat(entry.seat)?.nickname ?? '?',
        })),
        lastDreamedSeat: this.lastDreamedSeat,
      };
    }
    if (me.role === 'WOLF_BEAUTY') {
      // 她必须知道自己上一夜魅惑了谁 —— 那个人就是她死后要陪葬的人。
      // 互认规则：她和狼队互相认识。这个分支提前 return，走不到下面
      // isWolfRole 的通用狼队字段，所以队友名单和夜间战术标签在这里补齐。
      return {
        ...base,
        lastCharmedSeat: this.lastCharmedSeat,
        teammates: this.wolfSeats().filter((seat) => seat !== me.seat),
        ...(this.phase.startsWith('NIGHT_')
          ? {
              myWolfTag: this.wolfTags.get(me.seat) ?? null,
              myWolfTagTarget: this.wolfTagTargets.get(me.seat) ?? null,
              myWolfTagTargets: this.wolfTagTargetCandidates(me.seat),
              canEditWolfTag: me.alive,
            }
          : {}),
      };
    }
    if (me.role === 'SPIRIT_SEER') {
      const history = (this.spiritHistory.get(me.seat) ?? []).map((entry) => ({
        seat: entry.seat,
        nickname: this.bySeat(entry.seat)?.nickname ?? '?',
        role: entry.role,
        roleName: ROLE_NAME[entry.role],
      }));
      return { ...base, spiritHistory: history };
    }
    if (me.role === 'MECHANICAL_WOLF') {
      const learned = this.mechanicalLearnedRole;
      const common = {
        ...base,
        mechanicalLearnedRole: learned,
        mechanicalLearnedRoleName: learned ? ROLE_NAME[learned] : null,
        mechanicalSkillActive: this.mechanicalSkillActive(),
        mechanicalPoisonAvailable: this.mechanicalPoisonAvailable,
      };
      const histories = {
        seerHistory: (this.seerHistory.get(me.seat) ?? []).map((entry) => ({
          seat: entry.seat,
          nickname: this.bySeat(entry.seat)?.nickname ?? '?',
          camp: entry.camp,
        })),
        spiritHistory: (this.spiritHistory.get(me.seat) ?? []).map((entry) => ({
          seat: entry.seat,
          nickname: this.bySeat(entry.seat)?.nickname ?? '?',
          role: entry.role,
          roleName: ROLE_NAME[entry.role],
        })),
      };
      if (this.knowsWolfPack(me)) {
        return {
          ...common,
          ...histories,
          teammates: this.wolfSeats().filter((seat) => seat !== me.seat),
          ...(this.phase.startsWith('NIGHT_')
            ? {
                myWolfTag: this.wolfTags.get(me.seat) ?? null,
                myWolfTagTarget: this.wolfTagTargets.get(me.seat) ?? null,
                myWolfTagTargets: this.wolfTagTargetCandidates(me.seat),
                canEditWolfTag: me.alive,
              }
            : {}),
        };
      }
      return { ...common, ...histories };
    }
    if (isWolfRole(me.role)) {
      const teammates = this.wolfSeats().filter((s) => s !== me.seat);
      // 白狼王（可带人）与普通狼人（空爆）都能自爆；界面用 me.role 区分文案。
      // 其余狼营角色（狼王/机械狼/假面/狼美人）没有自爆按钮。
      const extra: { canSelfDestruct?: boolean } = {};
      if (me.role === 'WOLF_KING' || me.role === 'WOLF') {
        extra.canSelfDestruct =
          me.alive &&
          ['SHERIFF_SIGNUP', 'SHERIFF_CAMPAIGN', 'SHERIFF_VOTE', 'SHERIFF_PK', 'SHERIFF_REVOTE', 'DAY_SPEECH', 'DAY_VOTE'].includes(this.phase) &&
          this.boomPendingSeat === null;
      }
      return {
        ...base,
        teammates,
        ...(this.phase.startsWith('NIGHT_')
          ? {
              myWolfTag: this.wolfTags.get(me.seat) ?? null,
              myWolfTagTarget: this.wolfTagTargets.get(me.seat) ?? null,
              myWolfTagTargets: this.wolfTagTargetCandidates(me.seat),
              canEditWolfTag: me.alive,
            }
          : {}),
        ...extra,
      };
    }
    if (me.role === 'WITCH') {
      return { ...base, potions: { ...this.witchPotions } };
    }
    if (me.role === 'GRAVE_KEEPER') {
      return {
        ...base,
        graveHistory: this.graveHistory.map((entry) => ({
          day: entry.day,
          seat: entry.seat,
          nickname: entry.seat === null ? null : this.bySeat(entry.seat)?.nickname ?? null,
          isWolf: entry.isWolf,
        })),
      };
    }
    if (me.role === 'KNIGHT') {
      return {
        ...base,
        knightUsed: this.knightUsed,
        canDuel: me.alive && !this.knightUsed && this.phase === 'DAY_SPEECH',
      };
    }
    if (me.role === 'SEER') {
      const history = (this.seerHistory.get(me.seat) ?? []).map((h) => ({
        seat: h.seat,
        nickname: this.bySeat(h.seat)?.nickname ?? '?',
        camp: h.camp,
      }));
      return { ...base, seerHistory: history };
    }
    if (me.role === 'GUARD') {
      return { ...base, lastGuardedSeat: this.lastGuardedSeat };
    }
    return base;
  }

  private optionsFor(me: PlayerState | undefined): number[] {
    if (!me) return [];
    switch (this.phase) {
      case 'NIGHT_HYBRID':
        return me.role === 'HYBRID' && me.alive && this.hybridModelSeat === null
          ? this.aliveSeats().filter((seat) => seat !== me.seat)
          : [];
      case 'NIGHT_MECHANICAL':
        return me.role === 'MECHANICAL_WOLF' && me.alive && this.mechanicalLearnedRole === null
          ? this.aliveSeats().filter((seat) => seat !== me.seat)
          : [];
      case 'NIGHT_DANCER':
        return me.role === 'DANCER' && me.alive && !this.night.dancerActed
          ? this.dancerCandidates()
          : [];
      case 'NIGHT_MASK':
        if (me.role !== 'MASK' || !me.alive) return [];
        return this.night.maskInspectActed
          ? (this.night.maskActed ? [] : this.maskTargetCandidates())
          : this.maskInspectCandidates();
      case 'NIGHT_DREAMER':
        return me.role === 'DREAMER' && me.alive
          ? this.aliveSeats().filter((seat) => seat !== me.seat)
          : [];
      case 'NIGHT_WOLVES':
        return this.aliveKnifeWolves().some((wolf) => wolf.id === me.id) ? this.knifeCandidates() : [];
      case 'NIGHT_BEAUTY_CHARM': {
        const beauty = this.soleOf('WOLF_BEAUTY');
        if (!beauty || beauty.id !== me.id || !beauty.alive) return [];
        if (this.night.beautyCharmActed) return [];
        return this.aliveSeats().filter((seat) => seat !== beauty.seat);
      }
      // 守墓人没有目标可选 —— 他的「行动」只是确认已看到结果
      case 'NIGHT_GRAVE_KEEPER':
        return [];
      case 'NIGHT_GUARD': {
        if (me.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'GUARD') {
          return this.aliveSeats().filter((seat) => seat !== this.mechanicalLastGuardedSeat);
        }
        const guard = this.soleOf('GUARD');
        if (!guard || guard.id !== me.id || !guard.alive) return [];
        return this.guardCandidates();
      }
      case 'NIGHT_WITCH': {
        if (me.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'WITCH') {
          return this.mechanicalPoisonAvailable ? this.aliveSeats().filter((seat) => seat !== me.seat) : [];
        }
        const witch = this.soleOf('WITCH');
        if (!witch || witch.id !== me.id || !witch.alive) return [];
        if (!this.witchPotions.poison) return [];
        return this.aliveSeats().filter((s) => s !== witch.seat);
      }
      case 'NIGHT_SEER':
        if (me.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'SEER') {
          return this.aliveSeats().filter((seat) => seat !== me.seat);
        }
        return me.role === 'SEER' && me.alive ? this.aliveSeats().filter((s) => s !== me.seat) : [];
      case 'NIGHT_SPIRIT_SEER':
        if (me.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'SPIRIT_SEER') {
          return this.aliveSeats().filter((seat) => seat !== me.seat);
        }
        return me.role === 'SPIRIT_SEER' && me.alive ? this.aliveSeats().filter((s) => s !== me.seat) : [];
      case 'SHERIFF_VOTE':
      case 'SHERIFF_REVOTE':
        return this.sheriffVoterSeats().includes(me.seat) ? this.currentSheriffCandidates() : [];
      case 'DAY_VOTE':
        return me.alive && !me.idiotRevealed ? this.voteTargets(me.seat) : [];
      case 'SHERIFF_TRANSFER':
        return this.sheriffTransferFrom === me.seat ? this.aliveSeats() : [];
      case 'HUNTER_SHOOT': {
        if (!this.hasDeathShotAbility(me) || this.hunterPendingSeat !== me.seat) return [];
        return this.aliveSeats().filter((s) => s !== me.seat);
      }
      case 'WOLF_KING_BOOM': {
        if (this.boomPendingSeat !== me.seat) return [];
        return this.aliveSeats().filter((s) => s !== me.seat);
      }
      default:
        return [];
    }
  }

  private isMyTurn(me: PlayerState | undefined): boolean {
    if (!me) return false;
    switch (this.phase) {
      case 'NIGHT_HYBRID':
        return me.role === 'HYBRID' && me.alive && this.hybridModelSeat === null && !this.night.hybridActed;
      case 'NIGHT_MECHANICAL':
        return me.role === 'MECHANICAL_WOLF' && me.alive && this.mechanicalLearnedRole === null && !this.night.mechanicalLearnActed;
      case 'NIGHT_DANCER':
        return me.role === 'DANCER' && me.alive && !this.night.dancerActed && this.dancerCandidates().length >= 3;
      case 'NIGHT_MASK':
        return me.role === 'MASK' && me.alive && (!this.night.maskInspectActed || !this.night.maskActed);
      case 'NIGHT_DREAMER':
        return me.role === 'DREAMER' && me.alive && !this.night.dreamerActed;
      case 'NIGHT_BEAUTY_CHARM':
        return me.role === 'WOLF_BEAUTY' && me.alive && !this.night.beautyCharmActed;
      case 'NIGHT_GRAVE_KEEPER':
        return me.role === 'GRAVE_KEEPER' && me.alive && !this.night.graveKeeperActed;
      case 'NIGHT_WOLVES':
        return this.aliveKnifeWolves().some((wolf) => wolf.id === me.id) && !this.night.wolfPicks.has(me.seat);
      case 'NIGHT_GUARD':
        if (me.role === 'MECHANICAL_WOLF') {
          return me.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'GUARD' && !this.night.mechanicalGuardActed;
        }
        return me.role === 'GUARD' && me.alive && !this.night.guardActed && this.guardHasDecision();
      case 'NIGHT_WITCH':
        if (me.role === 'MECHANICAL_WOLF') {
          return me.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'WITCH' && !this.night.mechanicalPoisonActed;
        }
        return me.role === 'WITCH' && me.alive && !this.night.witchActed && this.witchHasDecision();
      case 'NIGHT_SEER':
        if (me.role === 'MECHANICAL_WOLF') {
          return me.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'SEER' && !this.night.mechanicalSeerActed;
        }
        return me.role === 'SEER' && me.alive && !this.night.seerActed;
      case 'NIGHT_SPIRIT_SEER':
        if (me.role === 'MECHANICAL_WOLF') {
          return me.alive && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'SPIRIT_SEER' && !this.night.mechanicalSpiritActed;
        }
        return me.role === 'SPIRIT_SEER' && me.alive && !this.night.spiritActed;
      case 'SHERIFF_SIGNUP':
        return me.alive && !this.sheriffSignup.has(me.seat);
      case 'SHERIFF_VOTE':
      case 'SHERIFF_REVOTE':
        return this.sheriffVoterSeats().includes(me.seat) && !this.sheriffVotes.has(me.seat);
      case 'DAY_VOTE':
        return me.alive && !me.idiotRevealed && !this.votes.has(me.seat);
      case 'SHERIFF_TRANSFER':
        return this.sheriffTransferFrom === me.seat && this.sheriffTransferChoice === undefined;
      case 'HUNTER_SHOOT': {
        return (
          this.hasDeathShotAbility(me) &&
          this.hunterPendingSeat === me.seat &&
          this.hunterChoice === undefined
        );
      }
      case 'WOLF_KING_BOOM':
        return this.boomPendingSeat === me.seat && this.boomChoice === undefined;
      default:
        return false;
    }
  }

  private submittedFor(me: PlayerState | undefined): NightAction | number | boolean | null | undefined {
    if (!me) return undefined;
    switch (this.phase) {
      case 'NIGHT_HYBRID':
        return me.role === 'HYBRID' && this.night.hybridActed
          ? { kind: 'hybrid', target: this.night.hybridTarget ?? 0 }
          : undefined;
      case 'NIGHT_MECHANICAL':
        return me.role === 'MECHANICAL_WOLF' && this.night.mechanicalLearnActed
          ? { kind: 'mechanicalLearn', target: this.night.mechanicalLearnTarget ?? 0 }
          : undefined;
      case 'NIGHT_DANCER':
        return me.role === 'DANCER' && this.night.dancerActed
          ? { kind: 'dancer', targets: this.night.dancerTargets.slice() }
          : undefined;
      case 'NIGHT_MASK':
        if (me.role !== 'MASK') return undefined;
        if (this.night.maskActed) return { kind: 'mask', target: this.night.maskTarget ?? 0 };
        if (this.night.maskInspectActed) return { kind: 'maskInspect', target: this.night.maskInspectTarget ?? 0 };
        return undefined;
      case 'NIGHT_DREAMER':
        return me.role === 'DREAMER' && this.night.dreamerActed && this.night.dreamerTarget !== null
          ? { kind: 'dreamer', target: this.night.dreamerTarget }
          : undefined;
      case 'NIGHT_WOLVES': {
        if (!this.aliveKnifeWolves().some((wolf) => wolf.id === me.id) && !this.night.wolfPicks.has(me.seat)) return undefined;
        if (!this.night.wolfPicks.has(me.seat)) return undefined;
        const a: WolfAction = { kind: 'wolf', target: this.night.wolfPicks.get(me.seat)! };
        return a;
      }
      case 'NIGHT_BEAUTY_CHARM':
        return me.role === 'WOLF_BEAUTY' && this.night.beautyCharmActed && this.night.beautyCharmTarget !== null
          ? { kind: 'beautyCharm', target: this.night.beautyCharmTarget }
          : undefined;
      case 'NIGHT_GRAVE_KEEPER':
        return me.role === 'GRAVE_KEEPER' && this.night.graveKeeperActed ? true : undefined;
      case 'NIGHT_GUARD': {
        if (me.role === 'MECHANICAL_WOLF') {
          return this.night.mechanicalGuardActed
            ? { kind: 'mechanicalSkill', skill: 'guard', target: this.night.mechanicalGuardTarget }
            : undefined;
        }
        if (me.role !== 'GUARD' || !this.night.guardActed) return undefined;
        const a: GuardAction = { kind: 'guard', target: this.night.guardTarget ?? 0 };
        return a;
      }
      case 'NIGHT_WITCH': {
        if (me.role === 'MECHANICAL_WOLF') {
          return this.night.mechanicalPoisonActed
            ? { kind: 'mechanicalSkill', skill: 'poison', target: this.night.mechanicalPoison }
            : undefined;
        }
        if (me.role !== 'WITCH' || !this.night.witchActed) return undefined;
        const a: WitchAction = {
          kind: 'witch',
          save: this.night.witchSave,
          poison: this.night.witchPoison,
        };
        return a;
      }
      case 'NIGHT_SEER': {
        if (me.role === 'MECHANICAL_WOLF') {
          return this.night.mechanicalSeerActed
            ? { kind: 'mechanicalSkill', skill: 'seer', target: this.night.mechanicalSeerTarget }
            : undefined;
        }
        if (me.role !== 'SEER' || this.night.seerTarget === null) return undefined;
        const a: SeerAction = { kind: 'seer', target: this.night.seerTarget };
        return a;
      }
      case 'NIGHT_SPIRIT_SEER':
        if (me.role === 'MECHANICAL_WOLF') {
          return this.night.mechanicalSpiritActed
            ? { kind: 'mechanicalSkill', skill: 'spiritSeer', target: this.night.mechanicalSpiritTarget }
            : undefined;
        }
        return me.role === 'SPIRIT_SEER' && this.night.spiritActed
          ? { kind: 'spiritSeer', target: this.night.spiritTarget ?? 0 }
          : undefined;
      case 'SHERIFF_SIGNUP':
        return this.sheriffSignup.has(me.seat) ? this.sheriffSignup.get(me.seat)! : undefined;
      case 'SHERIFF_VOTE':
      case 'SHERIFF_REVOTE':
        return this.sheriffVotes.has(me.seat) ? this.sheriffVotes.get(me.seat)! : undefined;
      case 'DAY_VOTE':
        return this.votes.has(me.seat) ? this.votes.get(me.seat)! : undefined;
      case 'SHERIFF_TRANSFER':
        return this.sheriffTransferFrom === me.seat ? this.sheriffTransferChoice : undefined;
      case 'HUNTER_SHOOT':
        return this.hunterChoice === undefined ? undefined : this.hunterChoice;
      case 'WOLF_KING_BOOM':
        return this.boomPendingSeat === me.seat && this.boomChoice !== undefined
          ? this.boomChoice
          : undefined;
      default:
        return undefined;
    }
  }

  private canSeeProgress(me: PlayerState | undefined): boolean {
    if (!this.phase.startsWith('NIGHT_') || ['NIGHT_START', 'NIGHT_RESOLVE'].includes(this.phase)) return true;
    if (!me || !me.alive) return false;
    switch (this.phase) {
      case 'NIGHT_HYBRID': return me.role === 'HYBRID';
      case 'NIGHT_MECHANICAL': return me.role === 'MECHANICAL_WOLF';
      case 'NIGHT_DANCER': return me.role === 'DANCER';
      case 'NIGHT_MASK': return me.role === 'MASK';
      case 'NIGHT_DREAMER': return me.role === 'DREAMER';
      case 'NIGHT_WOLVES': return this.aliveKnifeWolves().some((wolf) => wolf.id === me.id);
      case 'NIGHT_BEAUTY_CHARM':
        return me.role === 'WOLF_BEAUTY' && me.alive && !this.night.beautyCharmActed;
      case 'NIGHT_GUARD': return me.role === 'GUARD' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'GUARD');
      case 'NIGHT_WITCH': return me.role === 'WITCH' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'WITCH');
      case 'NIGHT_SEER': return me.role === 'SEER' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'SEER');
      case 'NIGHT_SPIRIT_SEER': return me.role === 'SPIRIT_SEER' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'SPIRIT_SEER');
      case 'NIGHT_GRAVE_KEEPER': return me.role === 'GRAVE_KEEPER';
      default: return false;
    }
  }

  private progressFor(me?: PlayerState): { done: number; total: number } | undefined {
    switch (this.phase) {
      case 'NIGHT_HYBRID':
        return { done: this.night.hybridActed ? 1 : 0, total: 1 };
      case 'NIGHT_MECHANICAL':
        return { done: this.night.mechanicalLearnActed ? 1 : 0, total: 1 };
      case 'NIGHT_DANCER':
        return { done: this.night.dancerActed ? 1 : 0, total: 1 };
      case 'NIGHT_MASK':
        return { done: Number(this.night.maskInspectActed) + Number(this.night.maskActed), total: 2 };
      case 'NIGHT_DREAMER':
        return { done: this.night.dreamerActed ? 1 : 0, total: 1 };
      case 'NIGHT_WOLVES': {
        const wolves = this.aliveKnifeWolves();
        return { done: this.night.wolfPicks.size, total: wolves.length };
      }
      case 'NIGHT_BEAUTY_CHARM':
        return { done: this.night.beautyCharmActed ? 1 : 0, total: 1 };
      case 'NIGHT_GUARD': {
        const done = me?.role === 'MECHANICAL_WOLF' ? this.night.mechanicalGuardActed : this.night.guardActed;
        return { done: done ? 1 : 0, total: 1 };
      }
      case 'NIGHT_WITCH': {
        const done = me?.role === 'MECHANICAL_WOLF' ? this.night.mechanicalPoisonActed : this.night.witchActed;
        return { done: done ? 1 : 0, total: 1 };
      }
      case 'NIGHT_SEER': {
        const done = me?.role === 'MECHANICAL_WOLF' ? this.night.mechanicalSeerActed : this.night.seerActed;
        return { done: done ? 1 : 0, total: 1 };
      }
      case 'NIGHT_SPIRIT_SEER': {
        const done = me?.role === 'MECHANICAL_WOLF' ? this.night.mechanicalSpiritActed : this.night.spiritActed;
        return { done: done ? 1 : 0, total: 1 };
      }
      case 'NIGHT_GRAVE_KEEPER':
        return { done: this.night.graveKeeperActed ? 1 : 0, total: 1 };
      case 'SHERIFF_SIGNUP':
        return { done: this.sheriffSignup.size, total: this.alivePlayers().length };
      case 'SHERIFF_VOTE':
      case 'SHERIFF_REVOTE': {
        const voters = this.sheriffVoterSeats();
        return { done: this.sheriffVotes.size, total: voters.length };
      }
      case 'DAY_VOTE': {
        const voters = this.aliveVoters();
        return { done: this.votes.size, total: voters.length };
      }
      case 'HUNTER_SHOOT':
        return { done: this.hunterChoice === undefined ? 0 : 1, total: 1 };
      case 'WOLF_KING_BOOM':
        return { done: this.boomChoice === undefined ? 0 : 1, total: 1 };
      case 'SHERIFF_TRANSFER':
        return { done: this.sheriffTransferChoice === undefined ? 0 : 1, total: 1 };
      default:
        return undefined;
    }
  }

  private hintFor(me: PlayerState | undefined): string {
    switch (this.phase) {
      case 'WAITING':
        return '等待房主开始游戏。';
      case 'ROLE_REVEAL':
        return '按住（或点开）下方身份牌看清你的角色和能力。看清后点「我已看清我的身份」。';
      case 'NIGHT_START':
        return '天黑请闭眼，所有人停止发言。';
      case 'NIGHT_HYBRID':
        return me?.role === 'HYBRID' ? '请选择一名玩家作为榜样。你不会得知他的身份或阵营。' : '混血儿正在选择榜样，请闭眼等待。';
      case 'NIGHT_MECHANICAL':
        if (me?.role === 'MECHANICAL_WOLF') {
          return this.mechanicalLearnedRole === null ? '请选择一名玩家学习其具体身份；复制技能从下一夜开始生效。' : `你已学习【${ROLE_NAME[this.mechanicalLearnedRole]}】，无需再次学习。`;
        }
        return '机械狼正在行动，请闭眼等待。';
      case 'NIGHT_DANCER':
        if (me?.role === 'DANCER') {
          return '请选择三名从未进入过舞池的存活玩家；可以选择自己。';
        }
        return '舞者正在选择舞池，请闭眼等待。';
      case 'NIGHT_MASK':
        if (me?.role === 'MASK') {
          return this.night.maskInspectActed
            ? `查验结果：${this.night.maskInspectTarget} 号${this.night.maskInspectResult ? '在舞池' : '不在舞池'}。请选择戴面具目标。`
            : '先查验一名玩家是否在当夜舞池，再选择一名玩家戴面具；两次可以选择同一人或自己。';
        }
        return '假面正在行动，请闭眼等待。';
      case 'NIGHT_DREAMER':
        if (me?.role === 'DREAMER') {
          return this.lastDreamedSeat === null
            ? '请选择另一名存活玩家成为梦游者；本夜不能跳过。'
            : `请选择另一名存活玩家成为梦游者；${this.lastDreamedSeat} 号是上一夜目标，再次选择会令其出局。`;
        }
        return '摄梦人正在选择梦游者，请闭眼等待。';
      case 'NIGHT_BEAUTY_CHARM':
        if (me?.role === 'WOLF_BEAUTY') {
          return this.lastCharmedSeat === null
            ? '请选择今晚要魅惑的玩家。你出局时，被魅惑的人会为你殉情（从下一夜起生效）。'
            : `请选择今晚要魅惑的玩家。目前 ${this.lastCharmedSeat} 号是上一夜的目标 —— 你一出局他就会殉情。`;
        }
        return '狼美人正在选择要魅惑的人，请闭眼等待。';
      case 'NIGHT_WOLVES':
        if (me && this.aliveKnifeWolves().some((wolf) => wolf.id === me.id)) {
          return '请与狼队友协商后，选择今晚要击杀的玩家。多数票生效，平票则空刀。';
        }
        return '狼人正在行动，请闭眼等待。';
      case 'NIGHT_GUARD':
        if (me?.role === 'GUARD') {
          return '选择一名玩家守护，他今晚不会被狼人杀害（不能连续两晚守同一人）。';
        }
        return '守卫正在行动，请闭眼等待。';
      case 'NIGHT_WITCH':
        if (me?.role === 'WITCH') return '你可以使用解药救人或毒药杀人，也可以选择不用。';
        return '女巫正在行动，请闭眼等待。';
      case 'NIGHT_SEER':
        if (me?.role === 'SEER') return '请选择一名玩家查验其阵营。';
        return '预言家正在查验，请闭眼等待。';
      case 'NIGHT_SPIRIT_SEER':
        if (me?.role === 'SPIRIT_SEER') return '请选择一名玩家，查验他的具体身份。';
        if (me?.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'SPIRIT_SEER') return '请选择一名玩家，使用复制的通灵查验。';
        return '通灵师正在查验，请闭眼等待。';
      case 'NIGHT_GRAVE_KEEPER': {
        if (me?.role !== 'GRAVE_KEEPER') return '守墓人正在查看昨天的放逐结果，请闭眼等待。';
        const check = this.night.graveCheck;
        if (!check) return '请确认今天的放逐结果。';
        if (check.seat === null) return '昨天没有人被投票放逐，今晚没有新信息。';
        const who = this.bySeat(check.seat);
        return `昨天被放逐的 ${check.seat} 号（${who?.nickname ?? '?'}）是${check.isWolf ? '【狼人】' : '【好人】'}。`;
      }
      case 'NIGHT_RESOLVE':
        return '天就快亮了……';
      case 'DAY_ANNOUNCE':
        return '请查看昨晚的结果。';
      case 'SHERIFF_SIGNUP':
        return me?.alive ? '请选择上警竞选或留在警下投票。' : '请等待存活玩家完成上警报名。';
      case 'SHERIFF_CAMPAIGN':
        return this.sheriffCandidates.has(me?.seat ?? -1) ? '请发表竞选发言；你也可以退水。' : '请听候选人依次发表竞选发言。';
      case 'SHERIFF_VOTE':
        return this.sheriffVoterSeats().includes(me?.seat ?? -1) ? '请选择一名候选人，或弃票。' : '候选人不能投票，请等待警下玩家投票。';
      case 'SHERIFF_PK':
        return this.sheriffCandidates.has(me?.seat ?? -1) ? '请发表 PK 发言；你仍可以退水。' : '请听平票候选人进行 PK 发言。';
      case 'SHERIFF_REVOTE':
        return this.sheriffVoterSeats().includes(me?.seat ?? -1) ? '请在 PK 候选人中重新投票；再次平票则警徽流失。' : '请等待非候选人重新投票。';
      case 'DAY_SPEECH':
        if (me?.seat === this.sheriffSeat && this.speechDirection === null) return '请选择顺时针或逆时针发言；你最后发言并归票。';
        if (me?.role === 'KNIGHT' && me.alive && !this.knightUsed) return '请按照页面显示的顺序依次发言；你还可以翻牌决斗一名玩家（整局一次）。';
        return '请按照页面显示的顺序依次发言。';
      case 'DAY_VOTE':
        // 注意：这里绝不能按角色给不同提示（曾经给狼人写过「你也可以自爆」——
        // 同屏瞄一眼公开提示就知道谁是狼了）。自爆入口是隐藏手势，
        // 说明只出现在按住身份牌时的私密区域。
        return '依次发言后投票，得票最多者被放逐；平票则无人出局。';
      case 'DAY_EXILE':
        return '正在统计放逐结果……';
      case 'SHERIFF_TRANSFER':
        return me?.seat === this.sheriffTransferFrom ? '请选择一名存活玩家移交警徽，或撕毁警徽。' : '警长正在处理警徽。';
      case 'HUNTER_SHOOT':
        if (me?.seat === this.hunterPendingSeat) {
          return `${this.deathShooterName(me)}出局，可以开枪带走一名玩家，也可以放弃。`;
        }
        return `${this.hunterPendingSeat === null ? '玩家' : this.deathShooterName(this.bySeat(this.hunterPendingSeat)!)}正在决定是否开枪。`;
      case 'WOLF_KING_BOOM':
        return '白狼王自爆，请选择要带走一名玩家。';
      case 'GAME_OVER':
        if (this.draw && !this.winner) return '本局流局。';
        return this.winner ? `${CAMP_NAME[this.winner]}胜利。` : '游戏结束。';
      default:
        return '';
    }
  }

  revealRows(): RevealRow[] {
    return this.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map<RevealRow>((p) => ({
        seat: p.seat,
        nickname: p.nickname,
        role: p.role,
        roleName: ROLE_NAME[p.role],
        camp: this.resultCampFor(p),
        alive: p.alive,
      }));
  }

  /**
   * 谁能看上帝视角。
   *
   * 规则：游戏结束后人人可见；游戏进行中**只有已经出局的玩家**。
   *
   * 为什么必须放在 engine 而不是客户端：客户端藏个按钮是纸糊的权限，
   * 改一行 JS 就能拿到全场身份。所以判断在这里，活人压根收不到 revealAll。
   *
   * 旁观者（没有座位）目前也不放行 —— 拿一个旧 token 就能冒充观众，
   * 分不清真假的情况下宁可拒绝。
   */
  private mayUseGodView(playerId: string): boolean {
    if (this.phase === 'GAME_OVER') return true;
    if (this.phase === 'WAITING') return false;
    const me = this.byId(playerId);
    return Boolean(me && !me.alive);
  }

  /**
   * 开关「上帝视角」——只看得到自己请求的那一份。
   *
   * 用 Set 而不是一个全局开关：全局开关会让**一个人**点开之后
   * 所有人都被动看到全场身份，那就不是「自愿进入」了。
   */
  setGodView(playerId: string, active: boolean): void {
    if (active && !this.mayUseGodView(playerId)) {
      // 没资格就顺手清掉，防止有人先请求、之后靠状态变化白拿一份
      this.revealAllRequested.delete(playerId);
      return;
    }
    if (active) this.revealAllRequested.add(playerId);
    else this.revealAllRequested.delete(playerId);
  }

  godViewActiveFor(playerId: string): boolean {
    return this.revealAllRequested.has(playerId);
  }

  // ─────────────────── 测试 / 调试辅助 ───────────────────

  /** 仅供测试：按座位号读取角色 */
  roleAt(seat: number): Role | undefined {
    return this.bySeat(seat)?.role;
  }

  /** 仅供测试：按角色读取座位号 */
  seatOfRole(role: Role): number | undefined {
    return this.soleOf(role)?.seat;
  }

  aliveSeatsSnapshot(): number[] {
    return this.aliveSeats();
  }

  deathRecords(): ReadonlyArray<DeathRecord> {
    return this.deaths;
  }

  /** 仅供测试：当前是否在等待白狼王指定带走目标 */
  boomPendingSnapshot(): number | null {
    return this.boomPendingSeat;
  }

  /** 仅供测试：守卫上一夜守了谁 */
  lastGuardedSnapshot(): number | null {
    return this.lastGuardedSeat;
  }

  /** 仅供测试：本轮被投票放逐的玩家 */
  exiledSnapshot(): { seat: number; nickname: string } | null {
    return this.exiled;
  }

  get summary(): {
    wolves: number;
    gods: number;
    villagers: number;
    alive: number;
    day: number;
  } {
    return {
      wolves: this.aliveWolves().length,
      gods: this.players.filter((p) => p.alive && isGod(p.role)).length,
      villagers: this.players.filter(
        (p) => p.alive && (p.role === 'VILLAGER' || p.role === 'HYBRID'),
      ).length,
      alive: this.alivePlayers().length,
      day: this.day,
    };
  }

  static causeLabel(cause: DeathCause): string {
    return DEATH_CAUSE_LABEL[cause];
  }
}

// ────────────────────────────── 小工具 ──────────────────────────────

function emptyNight(): NightState {
  return {
    hybridTarget: null,
    hybridActed: false,
    mechanicalLearnTarget: null,
    mechanicalLearnActed: false,
    dancerTargets: [],
    dancerActed: false,
    maskInspectTarget: null,
    maskInspectResult: null,
    maskInspectActed: false,
    maskTarget: null,
    maskActed: false,
    dreamerTarget: null,
    dreamerActed: false,
    beautyCharmTarget: null,
    beautyCharmActed: false,
    darkLordReflectVictim: null,
    wolfPicks: new Map(),
    wolfTarget: null,
    puppetPicks: new Map(),
    puppetTarget: null,
    guardTarget: null,
    guardActed: false,
    mechanicalGuardTarget: null,
    mechanicalGuardActed: false,
    witchSave: false,
    witchPoison: null,
    witchActed: false,
    mechanicalPoison: null,
    mechanicalPoisonActed: false,
    seerTarget: null,
    seerCamp: null,
    seerActed: false,
    mechanicalSeerTarget: null,
    mechanicalSeerCamp: null,
    mechanicalSeerActed: false,
    spiritTarget: null,
    spiritRole: null,
    spiritActed: false,
    mechanicalSpiritTarget: null,
    mechanicalSpiritRole: null,
    mechanicalSpiritActed: false,
    graveCheck: null,
    graveKeeperActed: false,
  };
}

/** 多数决：票数唯一最高者胜出；平票返回 null */
function plurality(values: ReadonlyArray<number | null>): number | null {
  const counts = new Map<number | null, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = -1;
  let tie = false;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
      tie = false;
    } else if (c === bestCount) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** 用于投票：平票显式返回 'TIE' */
function pluralityOrTie(values: ReadonlyArray<number>): number | 'TIE' {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = -1;
  let bestCount = -1;
  let tie = false;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
      tie = false;
    } else if (c === bestCount) {
      tie = true;
    }
  }
  return tie ? 'TIE' : best;
}

export { GOD_ROLES, ROLE_NAME, ROLE_DESC } from './roles.ts';
