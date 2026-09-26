/**
 * 狼人杀规则引擎（服务端权威）
 *
 * 设计原则：
 * - 纯逻辑，不依赖 Node / DOM / 网络 / 时钟。阶段推进由外部（服务端定时器）驱动，
 *   这样引擎可以在单元测试里用「零时间」跑完一整局。
 * - 所有信息过滤发生在 gameViewFor()：预言家只拿得到自己的验人结果，狼人只拿得到
 *   狼队友座位。客户端永远拿不到可以作弊的全局状态。
 * - 板子：12 人「预女猎白」= 4 狼 + 4 民 + 预言家 / 女巫 / 猎人 / 白痴。
 *
 * 已实现规则要点：
 * - 夜晚顺序：狼人 → 女巫 → 预言家（按需求指定的顺序）。
 * - 狼人各自点刀，多票者得刀；平票或多数选「空刀」则平安夜。
 * - 女巫解药、毒药各 1 瓶，全局仅一次；同一夜不能同时使用两瓶；默认不可自救。
 * - 猎人在「被狼刀死」或「被投票放逐」时可开枪；被女巫毒死时不能开枪。
 * - 白痴被投票放逐时翻牌免死，但永久失去投票权，且不再成为投票目标。
 * - 投票平票为「无人出局」。
 * - 胜负采用「屠边」：狼人全部出局 → 好人胜；神职全灭 或 平民全灭 → 狼人胜。
 */

import {
  BOARD_12,
  CAMP_NAME,
  GOD_ROLES,
  ROLE_DESC,
  ROLE_NAME,
  isGod,
  type Camp,
  type Role,
} from './roles.ts';
import {
  DEFAULT_ROOM_CONFIG,
  DEATH_CAUSE_LABEL,
  PHASE_LABEL,
  type DeathCause,
  type DeathView,
  type GameView,
  type NightAction,
  type Phase,
  type RevealRow,
  type RoomConfig,
  type SeatView,
  type VoteRecordView,
  type WitchAction,
  type WolfAction,
  type SeerAction,
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

/** 各阶段的标准时长（毫秒）。服务端据此设定 deadline，引擎本身不感知时间。 */
export const PHASE_TIMEOUT_MS: Record<Phase, number> = {
  WAITING: Number.POSITIVE_INFINITY,
  NIGHT_START: 5_000,
  NIGHT_WOLVES: 45_000,
  NIGHT_WITCH: 35_000,
  NIGHT_SEER: 35_000,
  NIGHT_RESOLVE: 2_500,
  DAY_ANNOUNCE: 18_000,
  DAY_VOTE: 60_000,
  DAY_EXILE: 7_000,
  HUNTER_SHOOT: 25_000,
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
  'DAY_EXILE',
  'GAME_OVER',
]);

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
  /** 狼人各自的选择：座位 → 目标座位（null = 空刀） */
  wolfPicks: Map<number, number | null>;
  /** 多数决出的刀口 */
  wolfTarget: number | null;
  witchSave: boolean;
  witchPoison: number | null;
  witchActed: boolean;
  seerTarget: number | null;
  seerCamp: Camp | null;
  seerActed: boolean;
}

export interface GameOptions {
  config?: Partial<RoomConfig>;
  seed?: number;
  /** 测试专用：直接指定每个座位的角色（index = seat - 1） */
  forcedRoles?: Role[];
}

export class Game {
  readonly roomId: string;
  config: RoomConfig;
  phase: Phase = 'WAITING';
  day = 0;
  /** 由服务端写入的当前阶段截止时间（epoch ms），引擎不读系统时钟 */
  deadline: number | null = null;

  private players: PlayerState[] = [];
  private night: NightState = emptyNight();
  private witchPotions = { antidote: true, poison: true };
  private seerHistory = new Map<number, { seat: number; camp: Camp }[]>();
  private votes = new Map<number, number | null>();
  private deaths: DeathRecord[] = [];
  private lastNightDeaths: number[] = [];
  private exiled: { seat: number; nickname: string } | null = null;
  private voteDetail: VoteRecordView[] = [];
  private hunterPendingSeat: number | null = null;
  private hunterChoice: number | null | undefined = undefined;
  private hunterReturnPhase: Phase = 'DAY_VOTE';
  private winner: Camp | null = null;
  /** 流局标记：达到 MAX_DAYS 仍无胜者 */
  private draw = false;
  /** 公开事件流：所有玩家都能看到，只包含公开信息 */
  private log: string[] = [];
  /** 私有事件流：仅服务端可见，用于运营排查，绝不下发给客户端 */
  private secretLog: string[] = [];
  private revealAllRequested = false;
  private speechStartSeat: number | null = null;
  private readonly rng: () => number;

  constructor(roomId: string, seeds: PlayerSeed[], options: GameOptions = {}) {
    this.roomId = roomId;
    this.config = { ...DEFAULT_ROOM_CONFIG, ...(options.config ?? {}) };
    this.rng = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 31));

    const roles =
      options.forcedRoles && options.forcedRoles.length === seeds.length
        ? options.forcedRoles.slice()
        : shuffle(BOARD_12, this.rng);

    this.players = seeds
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((s, i) => ({
        id: s.id,
        seat: s.seat,
        nickname: s.nickname,
        avatar: s.avatar ?? '',
        isHost: s.isHost ?? false,
        role: roles[i]!,
        alive: true,
        idiotRevealed: false,
      }));
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

  private aliveWolves(): PlayerState[] {
    return this.players.filter((p) => p.alive && p.role === 'WOLF');
  }

  private wolfSeats(): number[] {
    return this.players.filter((p) => p.role === 'WOLF').map((p) => p.seat);
  }

  private soleOf(role: Role): PlayerState | undefined {
    return this.players.find((p) => p.role === role);
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

  // ─────────────────── 开局 ───────────────────

  start(): ActResult {
    if (this.phase !== 'WAITING') return fail('BAD_PHASE', '游戏已经开始');
    if (this.players.length !== BOARD_12.length) {
      return fail('PLAYER_COUNT', `需要 ${BOARD_12.length} 名玩家，当前 ${this.players.length} 名`);
    }
    this.day = 1;
    this.pushLog(`【第 1 天】天黑请闭眼，游戏开始。本局板子：4 狼人 / 4 平民 / 预言家 / 女巫 / 猎人 / 白痴。`);
    this.enter('NIGHT_START');
    return OK;
  }

  // ─────────────────── 玩家行动 ───────────────────

  submitNightAction(playerId: string, action: NightAction): ActResult {
    const me = this.byId(playerId);
    if (!me) return fail('NOT_IN_ROOM', '你不在本局游戏中');

    switch (action.kind) {
      case 'wolf': {
        if (this.phase !== 'NIGHT_WOLVES') return fail('BAD_PHASE', '现在不是狼人行动阶段');
        if (me.role !== 'WOLF' || !me.alive) return fail('NOT_YOUR_TURN', '你不是狼人');
        if (action.target !== null && !this.aliveSeats().includes(action.target)) {
          return fail('INVALID_TARGET', '目标不是存活玩家');
        }
        this.night.wolfPicks.set(me.seat, action.target);
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
        this.night.seerCamp = target.role === 'WOLF' ? 'WOLF' : 'GOOD';
        this.night.seerActed = true;
        const history = this.seerHistory.get(seer.seat) ?? [];
        history.push({ seat: target.seat, camp: this.night.seerCamp });
        this.seerHistory.set(seer.seat, history);
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

  submitHunterShoot(playerId: string, target: number | null): ActResult {
    if (this.phase !== 'HUNTER_SHOOT') return fail('BAD_PHASE', '现在不是猎人开枪阶段');
    const hunter = this.soleOf('HUNTER');
    if (!hunter || hunter.id !== playerId) return fail('NOT_YOUR_TURN', '你不是猎人');
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

  private canAutoAdvance(): boolean {
    switch (this.phase) {
      case 'NIGHT_WOLVES': {
        const wolves = this.aliveWolves();
        return wolves.length > 0 && wolves.every((w) => this.night.wolfPicks.has(w.seat));
      }
      case 'NIGHT_WITCH':
        return this.night.witchActed;
      case 'NIGHT_SEER':
        return this.night.seerActed;
      case 'DAY_VOTE': {
        const voters = this.aliveVoters();
        if (voters.length === 0) return true;
        return voters.every((v) => this.votes.has(v.seat));
      }
      case 'HUNTER_SHOOT':
        return this.hunterChoice !== undefined;
      default:
        return false;
    }
  }

  /** 超时或房主手动跳过：把当前阶段剩余未提交的行动按「放弃」处理，然后推进。 */
  forceAdvance(): void {
    if (this.phase === 'GAME_OVER' || this.phase === 'WAITING') return;

    // 过场阶段只推进一步，把「阅读时间」留给下一个阶段的定时器
    if (PAUSE_PHASES.has(this.phase)) {
      this.advance();
      this.settle();
      return;
    }

    switch (this.phase) {
      case 'NIGHT_WOLVES': {
        const wolves = this.aliveWolves();
        const any = [...this.night.wolfPicks.values()];
        // 超时未提交的狼人按「跟随当前多数」处理，避免因为掉线导致空刀
        const fallback = any.length > 0 ? plurality(any) : null;
        for (const w of wolves) {
          if (!this.night.wolfPicks.has(w.seat)) this.night.wolfPicks.set(w.seat, fallback);
        }
        break;
      }
      case 'NIGHT_WITCH':
        if (!this.night.witchActed) {
          this.night.witchActed = true;
          this.pushSecret('女巫超时未行动，本夜未使用药水');
        }
        break;
      case 'NIGHT_SEER':
        if (!this.night.seerActed) {
          this.night.seerActed = true;
          this.pushSecret('预言家超时未查验');
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
        this.resolveWolfVotes();
        this.enter(this.nextNightPhase('NIGHT_START'));
        return;
      case 'NIGHT_WOLVES':
        this.resolveWolfVotes();
        this.enter(this.nextNightPhase('NIGHT_WOLVES'));
        return;
      case 'NIGHT_WITCH':
        this.enter(this.nextNightPhase('NIGHT_WITCH'));
        return;
      case 'NIGHT_SEER':
        this.enter('NIGHT_RESOLVE');
        return;
      case 'NIGHT_RESOLVE':
        this.enter('DAY_ANNOUNCE');
        return;
      case 'DAY_ANNOUNCE':
        if (this.hunterPendingSeat !== null) {
          this.hunterReturnPhase = 'DAY_VOTE';
          this.enter('HUNTER_SHOOT');
        } else if (this.isOver) {
          this.enter('GAME_OVER');
        } else {
          this.enter('DAY_VOTE');
        }
        return;
      case 'DAY_VOTE':
        this.enter('DAY_EXILE');
        return;
      case 'DAY_EXILE':
        if (this.hunterPendingSeat !== null) {
          this.hunterReturnPhase = 'NIGHT_START';
          this.enter('HUNTER_SHOOT');
        } else if (this.isOver) {
          this.enter('GAME_OVER');
        } else {
          this.nextNight();
        }
        return;
      case 'HUNTER_SHOOT':
        // 关键：开枪机会只能消耗一次。忘记清空会导致猎人无限重复开枪。
        this.hunterPendingSeat = null;
        if (this.isOver) {
          this.enter('GAME_OVER');
        } else if (this.hunterReturnPhase === 'NIGHT_START') {
          this.nextNight();
        } else {
          this.enter('DAY_VOTE');
        }
        return;
      case 'GAME_OVER':
        return;
    }
  }

  /** 进入下一夜：天数递增，重新开始夜晚流程 */
  private nextNight(): void {
    this.day += 1;
    this.enter('NIGHT_START');
  }

  /** 夜晚阶段顺序推进，自动跳过已出局或无事可做的角色 */
  private nextNightPhase(after: 'NIGHT_START' | 'NIGHT_WOLVES' | 'NIGHT_WITCH'): Phase {
    const order: Phase[] = ['NIGHT_WOLVES', 'NIGHT_WITCH', 'NIGHT_SEER'];
    const startIdx = after === 'NIGHT_START' ? 0 : order.indexOf(after) + 1;
    for (let i = startIdx; i < order.length; i++) {
      const p = order[i]!;
      if (p === 'NIGHT_WOLVES') {
        if (this.aliveWolves().length === 0) continue;
        return p;
      }
      if (p === 'NIGHT_WITCH') {
        if (!this.witchHasDecision()) continue;
        return p;
      }
      if (p === 'NIGHT_SEER') {
        const seer = this.soleOf('SEER');
        if (!seer || !seer.alive) continue;
        return p;
      }
    }
    return 'NIGHT_RESOLVE';
  }

  private witchHasDecision(): boolean {
    const witch = this.soleOf('WITCH');
    if (!witch || !witch.alive) return false;
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
        this.pushLog(`【第 ${this.day} 天】天黑请闭眼。`);
        break;
      }
      case 'NIGHT_WOLVES': {
        this.pushLog('狼人请睁眼，请选择今晚要击杀的目标。');
        this.pushSecret(`存活狼人 ${this.aliveWolves().length} 名`);
        break;
      }
      case 'NIGHT_WITCH': {
        const who = this.night.wolfTarget;
        this.pushLog('女巫请睁眼。');
        this.pushSecret(
          who === null ? '今晚无人被狼人杀害' : `今晚 ${who} 号被狼人杀害`,
        );
        break;
      }
      case 'NIGHT_SEER': {
        this.pushLog('预言家请睁眼，请选择今晚要查验的玩家。');
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
          if (p.role === 'HUNTER' && cause === 'WOLF') {
            this.hunterPendingSeat = seat;
            this.pushSecret(`猎人（${seat} 号）在夜里出局，可获得开枪机会`);
          }
        }
        this.checkWinner();
        break;
      }
      case 'DAY_VOTE': {
        this.votes = new Map();
        this.exiled = null;
        this.voteDetail = [];
        this.computeSpeechOrder();
        const order = this.speechOrder().join(' → ');
        this.pushLog(`请大家依次发言（建议顺序：${order}），然后投票放逐一名玩家。`);
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
    /** 同一人同时被刀被毒时，以「毒」为准（更严格：被毒的猎人不能开枪） */
    const causes = new Map<number, DeathCause>();
    const wolfTarget = this.night.wolfTarget;
    const saved = this.night.witchSave;

    if (wolfTarget !== null && !saved) causes.set(wolfTarget, 'WOLF');
    if (this.night.witchPoison !== null) causes.set(this.night.witchPoison, 'POISON');

    if (saved && wolfTarget !== null) {
      this.witchPotions.antidote = false;
      this.pushSecret(`女巫使用解药救下 ${wolfTarget} 号`);
    }
    if (this.night.witchPoison !== null) {
      this.witchPotions.poison = false;
      this.pushSecret(`女巫使用毒药毒杀 ${this.night.witchPoison} 号`);
    }

    this.lastNightDeaths = [...causes.keys()].sort((a, b) => a - b);
    for (const seat of this.lastNightDeaths) {
      const p = this.bySeat(seat);
      if (p) this.kill(p, causes.get(seat)!, true);
    }
  }

  private resolveExile(): void {
    const entries = [...this.votes.entries()];
    this.voteDetail = entries
      .map(([voter, target]) => ({ voter, target }))
      .sort((a, b) => a.voter - b.voter);

    const valid = entries.map(([, t]) => t).filter((t): t is number => t !== null);
    if (valid.length === 0) {
      this.pushLog('全员弃票，本轮无人出局。');
      return;
    }
    const top = pluralityOrTie(valid);
    if (top === 'TIE') {
      this.pushLog('投票出现平票，本轮无人出局。');
      return;
    }
    const p = this.bySeat(top)!;
    this.exiled = { seat: p.seat, nickname: p.nickname };

    if (p.role === 'IDIOT' && !p.idiotRevealed) {
      p.idiotRevealed = true;
      this.pushLog(
        `${p.seat} 号（${p.nickname}）被投票放逐，翻牌为【白痴】，免于死亡，但从此失去投票权。`,
      );
      return;
    }

    this.kill(p, 'VOTE');
    this.pushLog(`${p.seat} 号（${p.nickname}）被投票放逐出局。`);
    if (p.role === 'HUNTER') {
      this.hunterPendingSeat = p.seat;
      this.pushLog('被放逐的是猎人，猎人可以开枪带走一名玩家。');
    }
    this.checkWinner();
  }

  private kill(p: PlayerState, cause: DeathCause, night = false): void {
    if (!p.alive) return;
    p.alive = false;
    this.deaths.push({ seat: p.seat, cause, day: this.day, night });
  }

  private checkWinner(): void {
    if (this.winner) return;
    const wolves = this.aliveWolves().length;
    const gods = this.players.filter((p) => p.alive && isGod(p.role)).length;
    const villagers = this.players.filter((p) => p.alive && p.role === 'VILLAGER').length;
    if (wolves === 0) {
      this.winner = 'GOOD';
    } else if (gods === 0 || villagers === 0) {
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

  private computeSpeechOrder(): void {
    const alive = this.aliveSeats();
    if (alive.length === 0) {
      this.speechStartSeat = null;
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
    const wolfAlly = me?.role === 'WOLF';
    return this.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map<SeatView>((p) => {
        const isMe = me?.id === p.id;
        const canSeeRole = isMe || (wolfAlly && p.role === 'WOLF');
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
          ...(canSeeRole ? { role: p.role, roleName: ROLE_NAME[p.role] } : {}),
        };
      });
  }

  gameViewFor(playerId: string): GameView {
    const me = this.byId(playerId);
    const wolf = me?.role === 'WOLF';

    const view: GameView = {
      phase: this.phase,
      phaseTitle: PHASE_LABEL[this.phase],
      phaseHint: this.hintFor(me),
      day: this.day,
      deadline: this.deadline,
      me: me ? this.meView(me) : null,
      myTurn: this.isMyTurn(me),
      myOptions: this.optionsFor(me),
      mySubmitted: this.submittedFor(me),
      deaths: this.deaths.map<DeathView>((d) => ({
        seat: d.seat,
        nickname: this.bySeat(d.seat)?.nickname ?? '?',
        // 死因是隐藏信息：只有真正进入 GAME_OVER 阶段才随复盘公开。
        // 注意不能用 isOver —— 胜负在 DAY_EXILE 阶段就算出来了，
        // 那一刻还会停留一个过场时间，提前下发等于让改过的客户端偷看答案。
        ...(this.phase === 'GAME_OVER' ? { cause: d.cause } : {}),
      })),
      lastNightDeaths: this.lastNightDeaths.slice(),
      exiled: this.exiled,
      hunterPendingSeat: this.hunterPendingSeat,
      winner: this.phase === 'GAME_OVER' ? this.winner : null,
      // 同理：胜负结果也要等 GAME_OVER 阶段才告诉客户端
      outcome: this.phase === 'GAME_OVER' ? this.outcome() : null,
      log: this.log.slice(-60),
      progress: this.progressFor(),
      voteDetail: this.voteDetail.slice(),
      ...(this.phase === 'DAY_VOTE' ? { speechOrder: this.speechOrder() } : {}),
      // 狼队夜间的点刀情况只下发给狼人 —— 用于线上协作，好人拿不到
      ...(wolf
        ? {
            wolfVotes: [...this.night.wolfPicks.entries()]
              .map(([seat, target]) => ({ seat, target }))
              .sort((a, b) => a.seat - b.seat),
          }
        : {}),
      // 全场身份只在 GAME_OVER 阶段（或房主主动公开时）下发
      ...(this.phase === 'GAME_OVER' || this.revealAllRequested
        ? { revealAll: this.revealRows() }
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

    if (me && me.role === 'SEER' && this.phase === 'NIGHT_SEER' && this.night.seerTarget !== null) {
      const t = this.bySeat(this.night.seerTarget);
      view.phaseHint = `查验结果：${this.night.seerTarget} 号（${t?.nickname ?? '?'}）是${
        this.night.seerCamp === 'WOLF' ? '【狼人】' : '【好人】'
      }。`;
    }

    return view;
  }

  private meView(me: PlayerState): GameView['me'] {
    const base = {
      seat: me.seat,
      role: me.role,
      roleName: ROLE_NAME[me.role],
      roleDesc: ROLE_DESC[me.role],
      camp: (me.role === 'WOLF' ? 'WOLF' : 'GOOD') as Camp,
      alive: me.alive,
      idiotRevealed: me.idiotRevealed,
      canVote: me.alive && !me.idiotRevealed,
    };
    if (me.role === 'WOLF') {
      return { ...base, teammates: this.wolfSeats().filter((s) => s !== me.seat) };
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
    return base;
  }

  private optionsFor(me: PlayerState | undefined): number[] {
    if (!me) return [];
    switch (this.phase) {
      case 'NIGHT_WOLVES':
        return me.role === 'WOLF' && me.alive ? this.aliveSeats() : [];
      case 'NIGHT_WITCH': {
        const witch = this.soleOf('WITCH');
        if (!witch || witch.id !== me.id) return [];
        if (!this.witchPotions.poison) return [];
        return this.aliveSeats().filter((s) => s !== witch.seat);
      }
      case 'NIGHT_SEER':
        return me.role === 'SEER' && me.alive ? this.aliveSeats().filter((s) => s !== me.seat) : [];
      case 'DAY_VOTE':
        return me.alive && !me.idiotRevealed ? this.voteTargets(me.seat) : [];
      case 'HUNTER_SHOOT': {
        const hunter = this.soleOf('HUNTER');
        if (!hunter || hunter.id !== me.id || this.hunterPendingSeat !== hunter.seat) return [];
        return this.aliveSeats().filter((s) => s !== hunter.seat);
      }
      default:
        return [];
    }
  }

  private isMyTurn(me: PlayerState | undefined): boolean {
    if (!me) return false;
    switch (this.phase) {
      case 'NIGHT_WOLVES':
        return me.role === 'WOLF' && me.alive && !this.night.wolfPicks.has(me.seat);
      case 'NIGHT_WITCH':
        return (
          me.role === 'WITCH' && !this.night.witchActed && this.witchHasDecision()
        );
      case 'NIGHT_SEER':
        return me.role === 'SEER' && me.alive && !this.night.seerActed;
      case 'DAY_VOTE':
        return me.alive && !me.idiotRevealed && !this.votes.has(me.seat);
      case 'HUNTER_SHOOT': {
        const hunter = this.soleOf('HUNTER');
        return (
          !!hunter &&
          hunter.id === me.id &&
          this.hunterPendingSeat === hunter.seat &&
          this.hunterChoice === undefined
        );
      }
      default:
        return false;
    }
  }

  private submittedFor(me: PlayerState | undefined): NightAction | number | null | undefined {
    if (!me) return undefined;
    switch (this.phase) {
      case 'NIGHT_WOLVES': {
        if (me.role !== 'WOLF') return undefined;
        if (!this.night.wolfPicks.has(me.seat)) return undefined;
        const a: WolfAction = { kind: 'wolf', target: this.night.wolfPicks.get(me.seat)! };
        return a;
      }
      case 'NIGHT_WITCH': {
        if (me.role !== 'WITCH' || !this.night.witchActed) return undefined;
        const a: WitchAction = {
          kind: 'witch',
          save: this.night.witchSave,
          poison: this.night.witchPoison,
        };
        return a;
      }
      case 'NIGHT_SEER': {
        if (me.role !== 'SEER' || this.night.seerTarget === null) return undefined;
        const a: SeerAction = { kind: 'seer', target: this.night.seerTarget };
        return a;
      }
      case 'DAY_VOTE':
        return this.votes.has(me.seat) ? this.votes.get(me.seat)! : undefined;
      case 'HUNTER_SHOOT':
        return this.hunterChoice === undefined ? undefined : this.hunterChoice;
      default:
        return undefined;
    }
  }

  private progressFor(): { done: number; total: number } | undefined {
    switch (this.phase) {
      case 'NIGHT_WOLVES': {
        const wolves = this.aliveWolves();
        return { done: this.night.wolfPicks.size, total: wolves.length };
      }
      case 'NIGHT_WITCH':
        return { done: this.night.witchActed ? 1 : 0, total: 1 };
      case 'NIGHT_SEER':
        return { done: this.night.seerActed ? 1 : 0, total: 1 };
      case 'DAY_VOTE': {
        const voters = this.aliveVoters();
        return { done: this.votes.size, total: voters.length };
      }
      case 'HUNTER_SHOOT':
        return { done: this.hunterChoice === undefined ? 0 : 1, total: 1 };
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
      case 'NIGHT_WOLVES':
        if (me?.role === 'WOLF' && me.alive) return '请与狼队友协商后，选择今晚要击杀的玩家。多数票生效，平票则空刀。';
        return '狼人正在行动，请闭眼等待。';
      case 'NIGHT_WITCH':
        if (me?.role === 'WITCH') return '你可以使用解药救人或毒药杀人，也可以选择不用。';
        return '女巫正在行动，请闭眼等待。';
      case 'NIGHT_SEER':
        if (me?.role === 'SEER') return '请选择一名玩家查验其阵营。';
        return '预言家正在查验，请闭眼等待。';
      case 'NIGHT_RESOLVE':
        return '天就快亮了……';
      case 'DAY_ANNOUNCE':
        return '请查看昨晚的结果。';
      case 'DAY_VOTE':
        return '依次发言后投票，得票最多者被放逐；平票则无人出局。';
      case 'DAY_EXILE':
        return '正在统计放逐结果……';
      case 'HUNTER_SHOOT':
        return '猎人出局，可以开枪带走一名玩家，也可以放弃。';
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
        camp: p.role === 'WOLF' ? 'WOLF' : 'GOOD',
        alive: p.alive,
      }));
  }

  requestRevealAll(): void {
    this.revealAllRequested = true;
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

  get summary(): { wolves: number; gods: number; villagers: number; alive: number; day: number } {
    return {
      wolves: this.aliveWolves().length,
      gods: this.players.filter((p) => p.alive && isGod(p.role)).length,
      villagers: this.players.filter((p) => p.alive && p.role === 'VILLAGER').length,
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
    wolfPicks: new Map(),
    wolfTarget: null,
    witchSave: false,
    witchPoison: null,
    witchActed: false,
    seerTarget: null,
    seerCamp: null,
    seerActed: false,
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

export { GOD_ROLES, ROLE_NAME, ROLE_DESC };
