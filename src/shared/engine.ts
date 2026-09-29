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
 * - 守卫：每晚守护一人免疫狼刀；不能连续两晚守同一人；**同守同救时该玩家依然死亡**。
 * - 女巫：解药 / 毒药各 1 瓶，全局一次；同一夜不能双药；默认不可自救。
 * - 预言家：每晚查验一人阵营。
 * - 猎人：被狼刀死 或 被投票放逐 可开枪；被毒死、被白狼王带走不能开枪。
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
import {
  DEFAULT_ROOM_CONFIG,
  DEATH_CAUSE_LABEL,
  PHASE_LABEL,
  isExclusiveWolfTag,
  type DeathCause,
  type DeathView,
  type GameView,
  type NightAction,
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

/** 可复现的伪随机数生成器（用于测试固定牌序） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  NIGHT_START: 5_000,
  NIGHT_HYBRID: 30_000,
  NIGHT_MECHANICAL: 40_000,
  NIGHT_DANCER: 60_000,
  NIGHT_MASK: 60_000,
  NIGHT_WOLVES: 90_000, // 1 分半战术安排
  NIGHT_GUARD: 30_000,
  NIGHT_WITCH: 40_000,
  NIGHT_SEER: 30_000,
  NIGHT_SPIRIT_SEER: 30_000,
  NIGHT_RESOLVE: 2_500,
  DAY_ANNOUNCE: 18_000,
  SHERIFF_SIGNUP: 30_000,
  SHERIFF_CAMPAIGN: 180_000,
  SHERIFF_VOTE: 45_000,
  SHERIFF_PK: 120_000,
  SHERIFF_REVOTE: 45_000,
  DAY_SPEECH: 180_000,
  DAY_VOTE: 60_000,
  DAY_EXILE: 7_000,
  SHERIFF_TRANSFER: 30_000,
  HUNTER_SHOOT: 25_000,
  WOLF_KING_BOOM: 20_000,
  GAME_OVER: Number.POSITIVE_INFINITY,
};

/** 超过这个天数仍未分出胜负即判定流局 —— 保证状态机一定会在有限步内终止 */
export const MAX_DAYS = 20;

/** 这些阶段只由定时器 / 房主手动推进，给玩家留出阅读时间 */
const PAUSE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'WAITING',
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
  NIGHT_WOLVES: '狼人请睁眼，请确认今晚的战术，选择要击杀的玩家。',
  NIGHT_GUARD: '守卫请睁眼，请选择今晚要守护的玩家。',
  NIGHT_WITCH: '女巫请睁眼。',
  NIGHT_SEER: '预言家请睁眼，请选择今晚要查验的玩家。',
  NIGHT_SPIRIT_SEER: '通灵师请睁眼，请选择今晚要查验具体身份的玩家。',
};

/** 对应的「闭眼」台词，会拼在下一个阶段的开头 */
const NIGHT_CLOSE_LINE: Partial<Record<Phase, string>> = {
  NIGHT_HYBRID: '混血儿请闭眼。',
  NIGHT_MECHANICAL: '机械狼请闭眼。',
  NIGHT_DANCER: '舞者请闭眼。',
  NIGHT_MASK: '假面请闭眼。',
  NIGHT_WOLVES: '狼人请闭眼。',
  NIGHT_GUARD: '守卫请闭眼。',
  NIGHT_WITCH: '女巫请闭眼。',
  NIGHT_SEER: '预言家请闭眼。',
  NIGHT_SPIRIT_SEER: '通灵师请闭眼。',
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
  /** 狼人各自的选择：座位 → 目标座位（null = 空刀） */
  wolfPicks: Map<number, number | null>;
  /** 多数决出的刀口 */
  wolfTarget: number | null;
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
}

export interface GameOptions {
  /** 牌堆内容：每个元素是一张角色牌。长度必须等于玩家数。 */
  roles: Role[];
  /** 是否洗牌。房间开局传 true；单元测试传 false 以便按座位断言。 */
  shuffle?: boolean;
  config?: Partial<RoomConfig>;
  seed?: number;
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
  private sheriffTransferReturn: 'ANNOUNCE' | 'EXILE' | 'HUNTER' | 'BOOM' = 'ANNOUNCE';
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
  /** 狼队战术标签：座位 → 标签。只有狼人之间能看到。 */
  private wolfTags = new Map<number, WolfTag>();
  private winner: Camp | null = null;
  /** 流局标记：达到 MAX_DAYS 仍无胜者 */
  private draw = false;
  /** 公开事件流：所有玩家都能看到，只包含公开信息 */
  private log: string[] = [];
  /** 私有事件流：仅服务端可见，用于运营排查，绝不下发给客户端 */
  private secretLog: string[] = [];
  private revealAllRequested = new Set<string>();
  private speechStartSeat: number | null = null;
  private readonly rng: () => number;
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

  constructor(roomId: string, seeds: PlayerSeed[], options: GameOptions) {
    this.roomId = roomId;
    this.config = { ...DEFAULT_ROOM_CONFIG, ...(options.config ?? {}) };
    this.rng = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.deckSize = options.roles.length;
    this.boardRoles = options.roles.slice();

    const deck = options.shuffle ? shuffle(options.roles, this.rng) : options.roles.slice();

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

  /** 活着的狼（含白狼王） */
  private aliveWolves(): PlayerState[] {
    return this.players.filter((p) => p.alive && isWolfRole(p.role));
  }

  /** 真正参与当夜狼刀的玩家；机械狼只有学习狼人身份后的下一夜才加入。 */
  private aliveKnifeWolves(): PlayerState[] {
    return this.players.filter((p) => {
      if (!p.alive) return false;
      if (p.role === 'WOLF' || p.role === 'WOLF_KING') return true;
      if (p.role === 'MASK') return this.maskHasKnife();
      return p.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() &&
        (this.mechanicalLearnedRole === 'WOLF' || this.mechanicalLearnedRole === 'WOLF_KING');
    });
  }

  /** 普通狼（含尚未隔离的狼系角色）全部出局后，假面从下一次狼刀阶段起接刀。 */
  private maskHasKnife(): boolean {
    const mask = this.aliveSole('MASK');
    if (!mask) return false;
    return !this.players.some((p) => p.alive && p.role !== 'MASK' && isWolfRole(p.role));
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
      .filter((p) => p.role === 'WOLF' || p.role === 'WOLF_KING' ||
        (p.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() &&
          (this.mechanicalLearnedRole === 'WOLF' || this.mechanicalLearnedRole === 'WOLF_KING')))
      .map((p) => p.seat);
  }

  private mechanicalSkillActive(): boolean {
    return this.mechanicalLearnedRole !== null && this.mechanicalLearnedDay !== null && this.day > this.mechanicalLearnedDay;
  }

  private mechanical(): PlayerState | undefined {
    return this.soleOf('MECHANICAL_WOLF');
  }

  private knowsWolfPack(player: PlayerState): boolean {
    return player.role === 'WOLF' || player.role === 'WOLF_KING' ||
      (player.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() &&
        (this.mechanicalLearnedRole === 'WOLF' || this.mechanicalLearnedRole === 'WOLF_KING'));
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
    this.pushLog(
      `【第 1 天】天黑请闭眼，游戏开始。本局共 ${this.players.length} 人：${this.boardSummaryText()}。`,
    );
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
      case 'wolf': {
        if (this.phase !== 'NIGHT_WOLVES') return fail('BAD_PHASE', '现在不是狼人行动阶段');
        if (!this.aliveKnifeWolves().some((wolf) => wolf.id === me.id)) {
          return fail('NOT_YOUR_TURN', '你当前没有狼刀权');
        }
        if (action.target !== null && !this.aliveSeats().includes(action.target)) {
          return fail('INVALID_TARGET', '目标不是存活玩家');
        }
        this.night.wolfPicks.set(me.seat, action.target);
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
        this.night.seerCamp = isWolfRole(target.role) ? 'WOLF' : 'GOOD';
        this.night.seerActed = true;
        const history = this.seerHistory.get(seer.seat) ?? [];
        history.push({ seat: target.seat, camp: this.night.seerCamp });
        this.seerHistory.set(seer.seat, history);
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
          this.night.mechanicalSeerCamp = isWolfRole(target.role) && target.role !== 'HYBRID' ? 'WOLF' : 'GOOD';
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
    if (this.phase !== 'HUNTER_SHOOT') return fail('BAD_PHASE', '现在不是猎人开枪阶段');
    const hunter = this.byId(playerId);
    if (!hunter || !this.canShootAsHunter(hunter)) return fail('NOT_YOUR_TURN', '你没有猎人开枪能力');
    if (this.hunterPendingSeat !== hunter.seat) return fail('NOT_YOUR_TURN', '你当前不能开枪');
    if (this.hunterChoice !== undefined) return fail('ALREADY_DONE', '你已经决定过了');
    if (target !== null && !this.aliveSeats().includes(target)) {
      return fail('INVALID_TARGET', '目标不是存活玩家');
    }
    this.hunterChoice = target;
    if (target !== null) {
      const tp = this.bySeat(target)!;
      this.kill(tp, 'SHOOT');
      this.pushLog(`猎人开枪带走了 ${target} 号（${tp.nickname}）。`);
    } else {
      this.pushLog('猎人选择放弃开枪。');
    }
    this.checkWinner();
    this.settle();
    return OK;
  }

  /** 白狼王自爆（白天可用）：自爆后立刻进入黑夜，当天不再投票 */
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
    if (me.role !== 'WOLF_KING') return fail('NOT_YOUR_TURN', '你不是白狼王');
    if (!me.alive) return fail('DEAD', '你已经出局');
    if (this.boomPendingSeat !== null) return fail('ALREADY_DONE', '自爆已经发生过了');

    if (!this.sheriffElectionFinished) {
      this.sheriffElectionFinished = true;
      this.sheriffCandidates.clear();
      this.pushLog('警长竞选因白狼王自爆中止，本局警徽流失。');
    }
    this.kill(me, 'EXPLODE');
    this.pushLog(`${me.seat} 号（${me.nickname}）亮出【白狼王】，自爆！`);
    this.boomPendingSeat = me.seat;
    this.pushSecret(`白狼王（${me.seat} 号）自爆，进入指定带走目标阶段`);
    // 有意不在这里判定胜负：白狼王先带人，带完之后再判 ——
    // 这样「自爆带走最后一名平民 → 狼人胜」这类边缘情况才符合常规规则。
    this.enter('WOLF_KING_BOOM');
    this.settle();
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
   * 给自己挂一个狼队战术标签（传 null 取消）。
   *
   * 「悍跳位」是排他的：一队只能有一个人跳预言家，
   * 所以别人占着的时候就拒绝，而不是静默把对方的标签抢走 ——
   * 抢走会让对方以为自己还挂着，配合会直接出岔子。
   */
  setWolfTag(playerId: string, tag: WolfTag | null): ActResult {
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');
    if (!this.knowsWolfPack(me)) {
      return fail('NOT_YOUR_TURN', '只有狼人或已经进入狼队的机械狼才能挂战术标签');
    }
    if (this.phase === 'WAITING') return fail('BAD_PHASE', '游戏还没有开始');
    if (this.phase === 'GAME_OVER') return fail('BAD_PHASE', '本局已经结束了');

    if (tag === null) {
      this.wolfTags.delete(me.seat);
      return OK;
    }

    if (isExclusiveWolfTag(tag)) {
      const holder = [...this.wolfTags.entries()].find(([seat, t]) => t === tag && seat !== me.seat);
      if (holder) {
        const other = this.bySeat(holder[0]);
        return fail(
          'INVALID_TARGET',
          `「悍跳位」已经由 ${holder[0]} 号（${other?.nickname ?? '?'}）占了，一队只能有一个人跳预言家`,
        );
      }
    }

    this.wolfTags.set(me.seat, tag);
    return OK;
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
        return wolves.length > 0 && wolves.every((w) => this.night.wolfPicks.has(w.seat));
      }
      case 'NIGHT_HYBRID':
        return this.night.hybridActed;
      case 'NIGHT_MECHANICAL':
        return this.night.mechanicalLearnActed;
      case 'NIGHT_DANCER':
        return this.night.dancerActed;
      case 'NIGHT_MASK':
        return this.night.maskInspectActed && this.night.maskActed;
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
        break;
      }
      case 'NIGHT_HYBRID': {
        if (!this.night.hybridActed) {
          const hybrid = this.aliveSole('HYBRID');
          const options = hybrid ? this.aliveSeats().filter((seat) => seat !== hybrid.seat) : [];
          const target = options.length > 0 ? options[Math.floor(this.rng() * options.length)]! : null;
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
          const targetSeat = options.length > 0 ? options[Math.floor(this.rng() * options.length)]! : null;
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
          const options = shuffle(this.dancerCandidates(), this.rng);
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
          const target = mask && options.length > 0 ? options[Math.floor(this.rng() * options.length)]! : null;
          this.night.maskInspectTarget = target;
          this.night.maskInspectResult = target !== null && this.night.dancerTargets.includes(target);
          this.night.maskInspectActed = true;
        }
        if (!this.night.maskActed) {
          const options = this.maskTargetCandidates();
          this.night.maskTarget = mask && options.length > 0 ? options[Math.floor(this.rng() * options.length)]! : null;
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
          this.pushLog('猎人超时未开枪。');
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
      case 'NIGHT_WOLVES':
        this.resolveWolfVotes();
        this.enter(this.nextNightPhase('NIGHT_WOLVES'));
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
        else this.nextNight();
        return;
      }
      case 'GAME_OVER':
        return;
    }
  }

  private continueAfterAnnounce(): void {
    if (this.isOver) return void this.enter('GAME_OVER');
    if (this.sheriffTransferFrom !== null) return this.beginSheriffTransfer('ANNOUNCE');
    if (this.hunterPendingSeat !== null) {
      this.hunterReturnPhase = 'DAY_ANNOUNCE';
      return void this.enter('HUNTER_SHOOT');
    }
    if (this.day === 1 && !this.sheriffElectionFinished) return void this.enter('SHERIFF_SIGNUP');
    this.enter('DAY_SPEECH');
  }

  private canShootAsHunter(player: PlayerState): boolean {
    return player.role === 'HUNTER' ||
      (player.role === 'MECHANICAL_WOLF' && this.mechanicalSkillActive() && this.mechanicalLearnedRole === 'HUNTER');
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
    if (this.isOver) return void this.enter('GAME_OVER');
    if (this.sheriffTransferFrom !== null) return this.beginSheriffTransfer('EXILE');
    if (this.hunterPendingSeat !== null) {
      this.hunterReturnPhase = 'NIGHT_START';
      return void this.enter('HUNTER_SHOOT');
    }
    this.nextNight();
  }

  private continueAfterHunter(): void {
    if (this.isOver) return void this.enter('GAME_OVER');
    if (this.sheriffTransferFrom !== null) return this.beginSheriffTransfer('HUNTER');
    if (this.hunterReturnPhase === 'NIGHT_START') this.nextNight();
    else this.continueAfterAnnounce();
  }

  private beginSheriffTransfer(returnTo: 'ANNOUNCE' | 'EXILE' | 'HUNTER' | 'BOOM'): void {
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
    const start = Math.floor(this.rng() * seats.length);
    const rotated = [...seats.slice(start), ...seats.slice(0, start)];
    this.sheriffSpeechOrder = this.rng() < 0.5 ? rotated : rotated.reverse();
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
   * **只看公开的板子配置** —— 板子是开局前就公示的，所以「本局有守卫」
   * 这件事本身不含任何隐藏信息。绝对不能掺进「守卫死没死」「女巫还有没有药」。
   */
  private nightSequence(): Phase[] {
    const seq: Phase[] = [];
    if (this.day === 1 && this.boardRoles.includes('HYBRID')) seq.push('NIGHT_HYBRID');
    if (this.boardRoles.includes('MECHANICAL_WOLF')) {
      seq.push('NIGHT_MECHANICAL');
    }
    // 舞者和假面首夜都不行动，从第二夜开始固定为舞者 → 假面。
    if (this.day >= 2 && this.boardRoles.includes('DANCER')) seq.push('NIGHT_DANCER');
    if (this.day >= 2 && this.boardRoles.includes('MASK')) seq.push('NIGHT_MASK');
    if (this.boardRoles.includes('MECHANICAL_WOLF')) {
      // 机械狼板采用“守卫 → 狼刀”的固定顺序；普通旧板仍保持原来的“狼刀 → 守卫”。
      if (this.boardRoles.includes('GUARD')) seq.push('NIGHT_GUARD');
      seq.push('NIGHT_WOLVES');
    } else {
      seq.push('NIGHT_WOLVES');
      if (this.boardRoles.includes('GUARD')) seq.push('NIGHT_GUARD');
    }
    if (this.boardRoles.includes('WITCH')) seq.push('NIGHT_WITCH');
    if (this.boardRoles.includes('SEER')) seq.push('NIGHT_SEER');
    if (this.boardRoles.includes('SPIRIT_SEER')) seq.push('NIGHT_SPIRIT_SEER');
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

  /** 进入新阶段并执行该阶段的入场结算 */
  private enter(phase: Phase): void {
    this.phase = phase;

    switch (phase) {
      case 'NIGHT_START': {
        this.night = emptyNight();
        this.votes = new Map();
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
      case 'NIGHT_RESOLVE': {
        this.resolveNightDeaths();
        break;
      }
      case 'DAY_ANNOUNCE': {
        if (this.lastNightDeaths.length === 0) {
          this.pushLog(`【第 ${this.day} 天】天亮了。昨晚是平安夜，无人死亡。`);
        } else {
          const names = this.lastNightDeaths
            .map((s) => `${s} 号（${this.bySeat(s)?.nickname ?? '?'}）`)
            .join('、');
          this.pushLog(`【第 ${this.day} 天】天亮了。昨晚死亡的是：${names}。`);
        }
        // 猎人被狼刀死可以开枪；被毒死不能
        for (const seat of this.lastNightDeaths) {
          const p = this.bySeat(seat);
          if (!p) continue;
          const cause = this.deathCauseOf(seat);
          if (this.canShootAsHunter(p) && cause === 'WOLF') {
            this.queueHunter(seat);
            this.pushSecret(`猎人（${seat} 号）在夜里出局，可获得开枪机会`);
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
        this.pushLog('猎人出局，可以开枪带走一名玩家。');
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
    /** 死因优先级：毒 > 舞池 > 狼刀。 */
    const causes = new Map<number, DeathCause>();
    const wolfTarget = this.night.wolfTarget;
    const guardTargets = [this.night.guardTarget, this.night.mechanicalGuardTarget].filter(
      (seat): seat is number => seat !== null,
    );
    const witchSaved = this.night.witchSave;
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
        let camp: Camp = isWolfRole(player.role) ? 'WOLF' : 'GOOD';
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
      // 舞者与假面免疫毒药，但毒药仍会被消耗。
      const target = this.bySeat(this.night.witchPoison);
      if (target?.role === 'DANCER' || target?.role === 'MASK') {
        this.pushSecret(`女巫对 ${this.night.witchPoison} 号使用毒药，但该角色免疫毒药`);
      } else {
        causes.set(this.night.witchPoison, 'POISON');
        this.pushSecret(`女巫使用毒药毒杀 ${this.night.witchPoison} 号`);
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

    // ── 消耗药水 ──
    if (witchSaved && wolfTarget !== null) this.witchPotions.antidote = false;
    if (this.night.witchPoison !== null) this.witchPotions.poison = false;

    // ── 记下守卫这一夜守了谁（供下一夜判断「不能连续守同一人」） ──
    if (this.night.guardTarget !== null) this.lastGuardedSeat = this.night.guardTarget;
    if (this.night.mechanicalGuardTarget !== null) this.mechanicalLastGuardedSeat = this.night.mechanicalGuardTarget;

    this.lastNightDeaths = [...causes.keys()].sort((a, b) => a - b);
    for (const seat of this.lastNightDeaths) {
      const p = this.bySeat(seat);
      if (p) this.kill(p, causes.get(seat)!, true);
    }
  }

  private resolveExile(): void {
    const entries = [...this.votes.entries()];
    this.voteDetail = entries
      .map(([voter, target]) => ({ voter, target, weight: voter === this.sheriffSeat ? 1.5 : 1 }))
      .sort((a, b) => a.voter - b.voter);

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
    if (this.canShootAsHunter(p)) {
      this.queueHunter(p.seat);
      this.pushLog('被放逐的是猎人，猎人可以开枪带走一名玩家。');
    }
    this.checkWinner();
  }

  private kill(p: PlayerState, cause: DeathCause, night = false): void {
    if (!p.alive) return;
    p.alive = false;
    this.deaths.push({ seat: p.seat, cause, day: this.day, night });
    if (p.seat === this.sheriffSeat) {
      this.sheriffSeat = null;
      this.sheriffTransferFrom = p.seat;
    }
  }

  private checkWinner(): void {
    if (this.winner) return;
    const wolves = this.aliveWolves().length;
    const gods = this.players.filter((p) => p.alive && isGod(p.role)).length;
    const villagers = this.players.filter(
      (p) => p.alive && (p.role === 'VILLAGER' || p.role === 'HYBRID'),
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
      case 'NIGHT_START':
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
      case 'HUNTER_SHOOT':
        return '猎人出局，请选择是否开枪带走一名玩家。';
      case 'WOLF_KING_BOOM':
        return '白狼王自爆，请选择要带走的玩家。';
      case 'GAME_OVER':
        if (this.draw && !this.winner) return '游戏结束，本局流局。';
        return this.winner ? `游戏结束，${CAMP_NAME[this.winner]}胜利。` : '游戏结束。';
      default:
        return '';
    }
  }

  gameViewFor(playerId: string): GameView {
    const me = this.byId(playerId);
    const wolf = me ? this.knowsWolfPack(me) : false;

    const view: GameView = {
      phase: this.phase,
      phaseTitle: PHASE_LABEL[this.phase],
      phaseHint: this.hintFor(me),
      day: this.day,
      deadline: this.deadline,
      countdown: this.countdown,
      countdownEndsAt: this.countdownEndsAt,
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
      winner: this.phase === 'GAME_OVER' ? this.winner : null,
      outcome: this.phase === 'GAME_OVER' ? this.outcome() : null,
      voiceLine: this.voiceLineFor(),
      log: this.log.slice(-60),
      ...(this.canSeeProgress(me) ? { progress: this.progressFor(me) } : {}),
      voteDetail: this.voteDetail.slice(),
      ...(['SHERIFF_CAMPAIGN', 'SHERIFF_PK'].includes(this.phase)
        ? { speechOrder: this.currentSheriffSpeechOrder() }
        : ['DAY_SPEECH', 'DAY_VOTE'].includes(this.phase)
          ? { speechOrder: this.speechOrder() }
          : {}),
      // 狼队夜间的点刀情况只下发给狼人 —— 用于线上协作，好人拿不到
      ...(wolf
        ? {
            wolfVotes: [...this.night.wolfPicks.entries()]
              .map(([seat, target]) => ({ seat, target }))
              .sort((a, b) => a.seat - b.seat),
            // 战术标签同理：狼队友互相看得见，好人一律看不到
            wolfTags: this.wolfSeats()
              .slice()
              .sort((a, b) => a - b)
              .map((seat) => ({
                seat,
                nickname: this.bySeat(seat)?.nickname ?? '?',
                tag: this.wolfTags.get(seat) ?? null,
              })),
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
          myWolfTag: this.wolfTags.get(me.seat) ?? null,
          canEditWolfTag: me.alive && this.phase !== 'GAME_OVER',
        };
      }
      return { ...common, ...histories };
    }
    if (isWolfRole(me.role)) {
      const teammates = this.wolfSeats().filter((s) => s !== me.seat);
      const extra: { canSelfDestruct?: boolean } = {};
      if (me.role === 'WOLF_KING') {
        extra.canSelfDestruct =
          me.alive &&
          ['SHERIFF_SIGNUP', 'SHERIFF_CAMPAIGN', 'SHERIFF_VOTE', 'SHERIFF_PK', 'SHERIFF_REVOTE', 'DAY_SPEECH', 'DAY_VOTE'].includes(this.phase) &&
          this.boomPendingSeat === null;
      }
      return {
        ...base,
        teammates,
        myWolfTag: this.wolfTags.get(me.seat) ?? null,
        canEditWolfTag: me.alive && this.phase !== 'GAME_OVER',
        ...extra,
      };
    }
    if (me.role === 'WITCH') {
      return { ...base, potions: { ...this.witchPotions } };
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
      case 'NIGHT_WOLVES':
        return this.aliveKnifeWolves().some((wolf) => wolf.id === me.id) ? this.aliveSeats() : [];
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
        if (!this.canShootAsHunter(me) || this.hunterPendingSeat !== me.seat) return [];
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
          this.canShootAsHunter(me) &&
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
      case 'NIGHT_WOLVES': {
        if (!this.aliveKnifeWolves().some((wolf) => wolf.id === me.id) && !this.night.wolfPicks.has(me.seat)) return undefined;
        if (!this.night.wolfPicks.has(me.seat)) return undefined;
        const a: WolfAction = { kind: 'wolf', target: this.night.wolfPicks.get(me.seat)! };
        return a;
      }
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
      case 'NIGHT_WOLVES': return this.aliveKnifeWolves().some((wolf) => wolf.id === me.id);
      case 'NIGHT_GUARD': return me.role === 'GUARD' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'GUARD');
      case 'NIGHT_WITCH': return me.role === 'WITCH' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'WITCH');
      case 'NIGHT_SEER': return me.role === 'SEER' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'SEER');
      case 'NIGHT_SPIRIT_SEER': return me.role === 'SPIRIT_SEER' || (me.role === 'MECHANICAL_WOLF' && this.mechanicalLearnedRole === 'SPIRIT_SEER');
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
      case 'NIGHT_WOLVES': {
        const wolves = this.aliveKnifeWolves();
        return { done: this.night.wolfPicks.size, total: wolves.length };
      }
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
        return '请按照页面显示的顺序依次发言。';
      case 'DAY_VOTE':
        if (me?.role === 'WOLF_KING' && me.alive) {
          return '依次发言后投票；你也可以自爆并带走一名玩家（自爆后直接进入黑夜）。';
        }
        return '依次发言后投票，得票最多者被放逐；平票则无人出局。';
      case 'DAY_EXILE':
        return '正在统计放逐结果……';
      case 'SHERIFF_TRANSFER':
        return me?.seat === this.sheriffTransferFrom ? '请选择一名存活玩家移交警徽，或撕毁警徽。' : '警长正在处理警徽。';
      case 'HUNTER_SHOOT':
        return '猎人出局，可以开枪带走一名玩家，也可以放弃。';
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
    wolfPicks: new Map(),
    wolfTarget: null,
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
