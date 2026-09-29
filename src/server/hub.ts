/**
 * 服务端房间与会话管理
 *
 * 职责：
 * - 维护 12 个座位的房间、会话令牌、断线重连
 * - 驱动游戏引擎的阶段定时器（引擎本身不读时钟）
 * - 为每个玩家生成**个性化视图**并推送（信息隔离在这里落地）
 *
 * 身份模型：客户端在 localStorage 里保存一个 token，WebSocket 用 ?token= 带上。
 * 手机在微信里切后台会被杀连接，重连时用同一个 token 就能回到原来的座位和角色，
 * 这是移动端必须做对的一件事。
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

import { Game, PHASE_TIMEOUT_MS } from '../shared/engine.ts';
import { GameDatabase, type AccountUser } from './database.ts';
import {
  DEFAULT_ROOM_CONFIG,
  ERR,
  type ClientMsg,
  type NightAction,
  type Phase,
  type RoomConfig,
  type RoomView,
  type SeatView,
  type SheriffDirection,
  type ServerMsg,
  type WolfTag,
} from '../shared/protocol.ts';
import {
  MAX_PLAYERS,
  boardErrors,
  boardSummary,
  boardToDeck,
  boardWarnings,
  cloneBoard,
  defaultBoard,
  type BoardConfig,
} from '../shared/roles.ts';

export interface Reply {
  ok: boolean;
  code?: string;
  message?: string;
}

const OK: Reply = { ok: true };
function fail(code: string, message: string): Reply {
  return { ok: false, code, message };
}

interface Session {
  token: string;
  userId: string | null;
  /** 仅允许来自本机、显式声明的自动化客户端绕过账号系统。 */
  automation: boolean;
  nickname: string;
  avatar: string;
  roomId: string | null;
  socket: WebSocket | null;
  /** 最后一次收到消息的时间，用于清理僵尸会话 */
  lastSeen: number;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NICK_MAX = 12;

/**
 * 阶段时长倍率，默认 1。
 * WEREWOLF_TIMEOUT_SCALE=0.05 可以把过场时间压到几百毫秒 ——
 * 自动化测试和「快速演示」都靠它，否则一局要跑好几分钟。
 */
const DEFAULT_TIMEOUT_SCALE = clampScale(Number(process.env.WEREWOLF_TIMEOUT_SCALE ?? 1));

function clampScale(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(n, 0.02), 10);
}

function makeRoomId(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]!;
  }
  return out;
}

export function sanitizeNickname(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  // 去掉控制字符与换行，防止把 UI 撑坏
  const cleaned = input.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, NICK_MAX);
}

function send(socket: WebSocket | null, msg: ServerMsg): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // 单个连接发送失败不应影响其他人
  }
}

// ────────────────────────────────────────────────────────────────

/**
 * 夜间「角色回合」阶段。
 *
 * 这些回合如果「行动一提交就推进」，机器人瞬间出牌会让四个回合在几十毫秒内跑完，
 * 语音根本来不及播报。所以服务端在整段战术时间里按住引擎（holdAdvance），
 * 只在**最后 5 秒**做 54321 倒数提醒 —— 倒数是提醒，不是终止信号。
 */
const NIGHT_ROLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'NIGHT_HYBRID',
  'NIGHT_MECHANICAL',
  'NIGHT_DANCER',
  'NIGHT_MASK',
  'NIGHT_WOLVES',
  'NIGHT_GUARD',
  'NIGHT_WITCH',
  'NIGHT_SEER',
  'NIGHT_SPIRIT_SEER',
]);

const DAYTIME_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'DAY_ANNOUNCE',
  'SHERIFF_SIGNUP',
  'SHERIFF_CAMPAIGN',
  'SHERIFF_VOTE',
  'SHERIFF_PK',
  'SHERIFF_REVOTE',
  'DAY_SPEECH',
  'DAY_VOTE',
  'DAY_EXILE',
  'SHERIFF_TRANSFER',
  'HUNTER_SHOOT',
  'WOLF_KING_BOOM',
  'GAME_OVER',
]);
const HOST_FAILOVER_MS = 60_000;

/** 倒数提醒窗口：阶段结束前最后 5 秒开始念数字 */
const COUNTDOWN_WINDOW_MS = 5_000;

export class Room {
  readonly id: string;
  readonly config: RoomConfig;
  readonly createdAt = Date.now();

  /**
   * 注意：这里不能用 TypeScript 的「参数属性」写法（constructor(private hub: Hub)）。
   * Node 的类型擦除（strip-only）不支持它，会在运行时直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
   */
  private readonly hub: Hub;
  /**
   * 座位槽位固定 MAX_PLAYERS 个，但**只有前 board.playerCount 个是「本局生效」的**。
   * 这样房主改人数时不用重建房间、也不会把人踢出去 ——
   * 只是把生效范围收窄，并把超出范围的人拦住（见 setBoard）。
   */
  private seats: (string | null)[] = new Array<string | null>(MAX_PLAYERS).fill(null);
  private ready = new Set<string>();
  private primaryHostToken: string;
  private hostToken: string;
  private hostTemporary = false;
  private hostFailoverTimer: NodeJS.Timeout | null = null;
  private readonly ownerUserId: string | null;
  private matchNumber: number;
  /** 定时器当前对应的「阶段|天数」，用于避免同一阶段内反复重置倒计时 */
  private scheduledKey = '';
  private game: Game | null = null;
  /** 已写入数据库的当前场次；结束时补写结果，重开时创建新场次。 */
  private matchId: string | null = null;
  private matchFinished = false;
  /** 第一夜锁定的悍跳位；一旦选定，本场不能取消或转让。 */
  private fakeSeerToken: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** 当前阶段是在什么时刻进入的（用于播报窗口计时） */
  private phaseEnteredAt = Date.now();
  /** 夜间回合的 250ms 心跳：负责算倒数、驱动广播 */
  private phaseTicker: NodeJS.Timeout | null = null;
  /** 当前版型（房主可改） */
  private board: BoardConfig = defaultBoard();

  constructor(hub: Hub, id: string, hostToken: string, ownerUserId: string | null) {
    this.hub = hub;
    this.id = id;
    this.primaryHostToken = hostToken;
    this.hostToken = hostToken;
    this.ownerUserId = ownerUserId;
    this.hub.database.createHall(id, ownerUserId);
    this.matchNumber = this.hub.database.nextMatchNumber(id);
    this.config = { ...DEFAULT_ROOM_CONFIG, timeoutScale: DEFAULT_TIMEOUT_SCALE };
  }

  get playing(): boolean {
    return this.game !== null;
  }

  /** 本局生效的座位数 */
  get seatCapacity(): number {
    return this.board.playerCount;
  }

  /** 已入座人数（只算生效范围内的座位） */
  get playerCount(): number {
    return this.activeSeats().filter((s) => s !== null).length;
  }

  /** 生效范围内的座位（长度 = 当前版型人数） */
  private activeSeats(): (string | null)[] {
    return this.seats.slice(0, this.seatCapacity);
  }

  get boardConfig(): BoardConfig {
    return cloneBoard(this.board);
  }

  seatOf(token: string): number | null {
    const idx = this.seats.indexOf(token);
    return idx === -1 ? null : idx + 1;
  }

  has(token: string): boolean {
    return this.seats.includes(token);
  }

  // ─────────────── 大厅操作 ───────────────

  addPlayer(token: string): Reply {
    if (this.has(token)) return OK;
    if (this.playing) return fail(ERR.ROOM_PLAYING, '游戏已经开始，无法加入');
    // 只在「本局生效」的座位范围内找空位
    const free = this.seats.slice(0, this.seatCapacity).indexOf(null);
    if (free === -1) {
      return fail(ERR.ROOM_FULL, `房间已满（当前版型是 ${this.seatCapacity} 人局）`);
    }
    this.seats[free] = token;
    this.hub.get(token)!.roomId = this.id;
    this.afterChange();
    return OK;
  }

  removePlayer(token: string): void {
    const idx = this.seats.indexOf(token);
    if (idx === -1) return;
    this.seats[idx] = null;
    this.ready.delete(token);

    // 房间空了就销毁
    if (this.playerCount === 0) {
      this.dispose();
      this.hub.destroyRoom(this.id);
      return;
    }
    // 厅主主动离开座位后，把本大厅当前控制权交给下一名玩家；数据库里的厅主所有权不变。
    if (this.primaryHostToken === token) {
      const next = this.seats.find((s): s is string => s !== null);
      if (next) {
        this.primaryHostToken = next;
        this.hostToken = next;
        this.hostTemporary = true;
      }
    } else if (this.hostToken === token) {
      this.hostToken = this.primaryHostToken;
      this.hostTemporary = false;
    }
    // 游戏已经开始：玩家中途退出就交给引擎的定时器继续推进，不做替换
    this.afterChange();
  }

  /** 连接变化或阶段变化时维护“白天掉线 60 秒后临时移交房主”。 */
  onConnectionChanged(): void {
    this.manageHostFailover();
    this.broadcast();
  }

  private manageHostFailover(): void {
    const game = this.game;
    const primary = this.hub.get(this.primaryHostToken);
    const primaryOnline = primary?.socket != null && this.has(this.primaryHostToken);

    if (!game || !DAYTIME_PHASES.has(game.phase)) {
      this.clearHostFailoverTimer();
      if (this.has(this.primaryHostToken)) {
        this.hostToken = this.primaryHostToken;
        this.hostTemporary = false;
      }
      return;
    }

    if (primaryOnline) {
      this.clearHostFailoverTimer();
      this.hostToken = this.primaryHostToken;
      this.hostTemporary = false;
      return;
    }
    if (this.hostTemporary || this.hostFailoverTimer) return;

    this.hostFailoverTimer = setTimeout(() => {
      this.hostFailoverTimer = null;
      const currentGame = this.game;
      const owner = this.hub.get(this.primaryHostToken);
      if (!currentGame || !DAYTIME_PHASES.has(currentGame.phase) || owner?.socket) return;
      const candidates = this.activeSeats().filter((candidate): candidate is string => {
        if (!candidate || candidate === this.primaryHostToken) return false;
        const session = this.hub.get(candidate);
        const me = currentGame.gameViewFor(candidate).me;
        return session?.socket != null && me?.alive === true;
      });
      const next = candidates[Math.floor(Math.random() * candidates.length)];
      if (!next) return;
      this.hostToken = next;
      this.hostTemporary = true;
      this.broadcast();
      this.sendTo(next, { t: 'toast', text: '原房主掉线，你已临时接管白天操作', level: 'info' });
    }, HOST_FAILOVER_MS);
  }

  private clearHostFailoverTimer(): void {
    if (this.hostFailoverTimer) {
      clearTimeout(this.hostFailoverTimer);
      this.hostFailoverTimer = null;
    }
  }

  takeSeat(token: string, seat: number): Reply {
    if (this.playing) return fail(ERR.ROOM_PLAYING, '游戏已经开始时不能换座位');
    if (!Number.isInteger(seat) || seat < 1 || seat > this.seatCapacity) {
      return fail(ERR.INVALID_TARGET, `座位号必须在 1-${this.seatCapacity} 之间`);
    }
    const from = this.seats.indexOf(token);
    if (from === -1) return fail(ERR.NOT_IN_ROOM, '你不在这个房间里');
    if (from === seat - 1) return OK;

    const target = this.seats[seat - 1] ?? null;
    this.seats[seat - 1] = token;
    // 目标座位有人则两人互换
    this.seats[from] = target;
    this.afterChange();
    return OK;
  }

  setReady(token: string, ready: boolean): Reply {
    if (!this.has(token)) return fail(ERR.NOT_IN_ROOM, '你不在这个房间里');
    // 就绪是**大厅**的动作。游戏开始后还允许改，会让「就绪」这个状态失去意义，
    // 而且（在修掉定时器重置问题之前）会顺手把阶段倒计时重置掉。
    if (this.playing) return fail(ERR.ROOM_PLAYING, '游戏已经开始，不需要再点就绪');
    if (ready) this.ready.add(token);
    else this.ready.delete(token);
    this.afterChange();
    return OK;
  }

  /**
   * 房主修改版型。
   *
   * 有一条硬规矩：**不能把人数改到比当前最高的已占座位还小**，
   * 否则那个座位上的玩家会凭空掉出本局。宁可拒绝并说明原因，也不要静默把人踢走。
   */
  setBoard(byToken: string, board: BoardConfig): Reply {
    if (this.playing) return fail(ERR.ROOM_PLAYING, '游戏已经开始，不能改版型');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以修改版型');

    const candidate = this.sanitizeBoard(board);
    const highestOccupied = this.seats.reduce(
      (acc, s, i) => (s !== null ? Math.max(acc, i + 1) : acc),
      0,
    );
    if (candidate.playerCount < highestOccupied) {
      return fail(
        ERR.INVALID_TARGET,
        `不能把人数改成 ${candidate.playerCount} 人：${highestOccupied} 号座位还有人在。` +
          `请先让对方离开，或者把人数改回 ${highestOccupied} 人以上。`,
      );
    }

    this.board = candidate;
    // 人数变了之后，原来就绪的人需要重新确认（版型都变了，之前的就绪没有意义）
    this.ready.clear();
    this.afterChange();
    return OK;
  }

  /** 把客户端传来的任意 JSON 洗成合法的 BoardConfig（不信任输入） */
  private sanitizeBoard(input: unknown): BoardConfig {
    const fallback = this.board;
    if (typeof input !== 'object' || input === null) return cloneBoard(fallback);
    const raw = input as { playerCount?: unknown; roles?: unknown };

    const playerCount = Number(raw.playerCount);
    const rolesInput = (typeof raw.roles === 'object' && raw.roles !== null
      ? raw.roles
      : {}) as Record<string, unknown>;

    const base: BoardConfig = {
      playerCount: Number.isInteger(playerCount)
        ? Math.min(Math.max(playerCount, 1), MAX_PLAYERS)
        : fallback.playerCount,
      roles: cloneBoard(fallback).roles,
    };
    for (const key of Object.keys(base.roles) as (keyof typeof base.roles)[]) {
      const value = Number(rolesInput[key]);
      if (Number.isFinite(value) && value >= 0) {
        base.roles[key] = Math.min(Math.floor(value), MAX_PLAYERS);
      } else {
        base.roles[key] = 0;
      }
    }
    return base;
  }

  // ─────────────── 游戏流程 ───────────────

  startGame(byToken: string, skipReadyCheck = false): Reply {
    if (this.game) return fail(ERR.BAD_PHASE, '游戏已经开始了');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以开始游戏');

    // ① 版型必须自洽（角色总数 = 人数）
    const errors = boardErrors(this.board);
    if (errors.length > 0) {
      return fail(ERR.INVALID_TARGET, `版型还没配好：${errors[0]!.message}`);
    }

    // ② 人数必须坐满
    const occupied = this.playerCount;
    if (occupied !== this.seatCapacity) {
      return fail(
        ERR.PLAYER_COUNT,
        `当前是 ${this.seatCapacity} 人局，还需要 ${this.seatCapacity - occupied} 名玩家`,
      );
    }

    // ③ 除房主外所有人都要点「我准备好了」
    const notReady = this.notReadySeats();
    if (!skipReadyCheck && notReady.length > 0) {
      return fail(ERR.NOT_READY, `还有 ${notReady.length} 人没就绪：${notReady.join('、')} 号`);
    }

    const seeds = this.activeSeats().map((token, i) => {
      const session = this.hub.get(token!);
      return {
        id: token!,
        seat: i + 1,
        nickname: session?.nickname ?? `玩家${i + 1}`,
        avatar: session?.avatar ?? '',
        isHost: token === this.hostToken,
      };
    });

    this.fakeSeerToken = null;
    this.matchNumber = this.hub.database.nextMatchNumber(this.id);
    this.game = new Game(this.id, seeds, {
      roles: boardToDeck(this.board),
      shuffle: true,
      config: this.config,
    });
    const res = this.game.start();
    if (!res.ok) {
      this.game = null;
      return fail(res.code ?? ERR.BAD_PHASE, res.message ?? '开局失败');
    }
    const participants = this.activeSeats().map((token) => {
      const session = this.hub.get(token!);
      const me = this.game!.gameViewFor(token!).me!;
      return {
        userId: session?.userId ?? null,
        nickname: session?.nickname ?? me.roleName,
        seat: me.seat,
        role: me.role,
        camp: me.camp,
      };
    });
    try {
      this.matchId = this.hub.database.startMatch(
        this.id,
        this.board,
        boardSummary(this.board),
        participants,
      );
    } catch (error) {
      console.error('保存场次失败，已取消开局：', error);
      this.game = null;
      this.matchId = null;
      return fail(ERR.BAD_PHASE, '场次保存失败，暂时无法开局');
    }
    this.matchFinished = false;
    this.afterChange();
    return OK;
  }

  /** 还没点就绪的玩家座位号（房主不需要点，他点「开始」即代表就绪） */
  notReadySeats(): number[] {
    const out: number[] = [];
    this.activeSeats().forEach((token, i) => {
      if (token === null) return;
      if (token === this.hostToken) return;
      if (!this.ready.has(token)) out.push(i + 1);
    });
    return out;
  }

  submitAction(token: string, action: NightAction): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitNightAction(token, action);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '行动失败');
  }

  submitVote(token: string, target: number | null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitVote(token, target);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '投票失败');
  }

  submitSheriffSignup(token: string, candidate: boolean): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitSheriffSignup(token, candidate);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '上警失败');
  }

  withdrawSheriff(token: string): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.withdrawSheriff(token);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '退水失败');
  }

  submitSheriffVote(token: string, target: number | null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitSheriffVote(token, target);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '警长投票失败');
  }

  submitSheriffTransfer(token: string, target: number | null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitSheriffTransfer(token, target);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '警徽处理失败');
  }

  setSpeechDirection(token: string, direction: SheriffDirection): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.setSpeechDirection(token, direction);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '设置发言方向失败');
  }

  submitHunterShoot(token: string, target: number | null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitHunterShoot(token, target);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '开枪失败');
  }

  /** 白狼王自爆 */
  selfDestruct(token: string): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.selfDestruct(token);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '自爆失败');
  }

  /** 白狼王指定带走谁 */
  submitBoomTarget(token: string, target: number | null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitBoomTarget(token, target);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '操作失败');
  }

  /** 设置/取消自己的狼队战术标签 */
  setWolfTag(token: string, tag: WolfTag | null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const firstNight =
      this.game.day === 1 &&
      ['NIGHT_START', 'NIGHT_WOLVES', 'NIGHT_GUARD', 'NIGHT_WITCH', 'NIGHT_SEER'].includes(
        this.game.phase,
      );
    if (tag === 'FAKE_SEER') {
      if (!firstNight) return fail(ERR.BAD_PHASE, '悍跳位必须在第一夜结束前确定');
      if (this.fakeSeerToken && this.fakeSeerToken !== token) {
        return fail(ERR.ALREADY_DONE, '本场悍跳位已经确定，不能转让');
      }
    }
    if (this.fakeSeerToken === token && tag !== 'FAKE_SEER') {
      return fail(ERR.ALREADY_DONE, '悍跳位一旦确定，本场不能取消或改成其他标签');
    }
    const res = this.game.setWolfTag(token, tag);
    if (res.ok) {
      if (tag === 'FAKE_SEER') this.fakeSeerToken = token;
      this.afterChange();
    }
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '设置标签失败');
  }

  /** 手动跳过当前阶段（房主特权，也给定时器用） */
  forceAdvance(byToken: string | null): Reply {
    const game = this.game;
    if (!game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (byToken !== null && byToken !== this.hostToken) {
      return fail(ERR.NOT_HOST, '只有房主可以跳过当前阶段');
    }
    game.forceAdvance(byToken !== null);
    this.afterChange();
    return OK;
  }

  revealAll(byToken: string): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以公开全场身份');
    this.game.setGodView(byToken, true);
    this.afterChange();
    return OK;
  }

  /**
   * 开关「上帝视角」。
   *
   * 是**每个人都只影响自己**的：一个人进去，别人不会被动看到全场身份。
   * 客户端在按之前会先弹确认 —— 进去等于放弃本局的公平性。
   */
  setGodView(byToken: string, active: boolean): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (!this.has(byToken)) return fail(ERR.NOT_IN_ROOM, '你不在这个房间里');
    if (this.game.phase === 'GAME_OVER') {
      return fail(ERR.BAD_PHASE, '游戏已经结束，全场身份本来就公开了');
    }
    if (active && this.game.deathRecords().length === 0) {
      return fail(ERR.BAD_PHASE, '本局还没有人出局，暂时不能进上帝视角');
    }
    this.game.setGodView(byToken, active);
    this.afterChange();
    return OK;
  }

  /** 保存本场并返回大厅；未分出胜负时记为“提前结束”，不参与任何统计。 */
  closeMatch(byToken: string): Reply {
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以结束本场比赛');
    if (!this.game || !this.matchId) return fail(ERR.BAD_PHASE, '当前没有进行中的场次');

    const completed = this.game.phase === 'GAME_OVER';
    if (completed) {
      this.archiveFinishedMatch();
      if (!this.matchFinished) return fail(ERR.BAD_PHASE, '比赛结果尚未保存，请稍后重试');
    } else {
      try {
        this.hub.database.abortMatch(this.matchId, this.game.day, this.game.phase);
      } catch (error) {
        console.error('保存提前结束的场次失败：', error);
        return fail(ERR.BAD_PHASE, '场次保存失败，暂时不能结束');
      }
    }

    this.clearTimer();
    this.clearPacing();
    this.game = null;
    this.matchId = null;
    this.matchFinished = false;
    this.fakeSeerToken = null;
    this.ready.clear();
    this.matchNumber = this.hub.database.nextMatchNumber(this.id);
    if (this.has(this.primaryHostToken)) {
      this.hostToken = this.primaryHostToken;
      this.hostTemporary = false;
    }
    this.afterChange();
    for (const token of this.activeSeats()) {
      if (!token) continue;
      this.sendTo(token, {
        t: 'toast',
        text: completed ? '本场已保存，已返回大厅' : '本场已提前结束并保存，已返回大厅',
        level: 'info',
      });
    }
    return OK;
  }

  /** 当前第 N 场作废并立即重新发牌，旧牌局不留记录、不计分。 */
  restart(byToken: string): Reply {
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以重新发牌');
    if (!this.game || !this.matchId) return fail(ERR.BAD_PHASE, '当前没有可以重新发牌的场次');
    this.clearTimer();
    this.clearPacing();
    try {
      this.hub.database.discardMatch(this.matchId);
    } catch (error) {
      console.error('丢弃旧牌局失败：', error);
      return fail(ERR.BAD_PHASE, '旧牌局处理失败，暂时不能重新发牌');
    }
    this.game = null;
    this.matchId = null;
    this.matchFinished = false;
    this.fakeSeerToken = null;
    return this.startGame(byToken, true);
  }

  // ─────────────── 视图与推送 ───────────────

  roomViewFor(token: string): RoomView {
    const game = this.game;
    let seats: SeatView[];

    if (game) {
      // 开局后由引擎提供座位信息：自己与狼队友可见身份，其余人只有公开信息
      seats = game.seatViewsFor(token).map((s) => {
        const seatToken = this.seats[s.seat - 1] ?? null;
        const session = seatToken ? this.hub.get(seatToken) : undefined;
        return {
          ...s,
          online: session?.socket != null,
          ready: true,
          isHost: seatToken === this.hostToken,
          isMe: seatToken === token,
        };
      });
    } else {
      seats = this.activeSeats().map((seatToken, i) => {
        const session = seatToken ? this.hub.get(seatToken) : undefined;
        return {
          seat: i + 1,
          occupied: seatToken !== null,
          nickname: session?.nickname ?? '',
          avatar: session?.avatar ?? '',
          online: session?.socket != null,
          ready: seatToken ? this.ready.has(seatToken) : false,
          isHost: seatToken === this.hostToken,
          isMe: seatToken === token,
        };
      });
    }

    const errors = boardErrors(this.board);
    const warnings = boardWarnings(this.board);
    const notReady = this.notReadySeats();
    const isHost = token === this.hostToken;

    return {
      roomId: this.id,
      hostId: this.hostToken,
      matchNumber: this.matchNumber,
      hostTemporary: this.hostTemporary,
      isHallOwner: this.ownerUserId !== null && this.hub.get(token)?.userId === this.ownerUserId,
      status: this.game ? 'PLAYING' : 'LOBBY',
      seats,
      playerCount: this.playerCount,
      canStart:
        !this.game &&
        isHost &&
        errors.length === 0 &&
        this.playerCount === this.seatCapacity &&
        notReady.length === 0,
      config: this.config,
      board: cloneBoard(this.board),
      boardSummary: boardSummary(this.board),
      boardErrors: errors.map((e) => e.message),
      boardWarnings: warnings.map((w) => w.message),
      seatsNeeded: Math.max(0, this.seatCapacity - this.playerCount),
      notReadySeats: notReady,
      shareHint: `把链接发给朋友，或让他们输入房间号 ${this.id}`,
    };
  }

  broadcast(): void {
    // 只推给「本局生效座位」上的玩家
    for (const token of this.activeSeats()) {
      if (!token) continue;
      const session = this.hub.get(token);
      if (!session?.socket) continue;
      send(session.socket, { t: 'room', room: this.roomViewFor(token) });
      send(session.socket, { t: 'game', game: this.game ? this.game.gameViewFor(token) : null });
    }
  }

  sendTo(token: string, msg: ServerMsg): void {
    send(this.hub.get(token)?.socket ?? null, msg);
  }

  /**
   * 所有状态变更的唯一出口：重排定时器 → 节奏控制 → 广播。
   *
   * 顺序很关键：
   *  ① reschedule() 先跑，因为它负责在新的阶段上重置「阶段进入时刻」和
   *     holdAdvance。如果先跑 tickPacing()，它读到的是上一个阶段的计时，
   *     而且紧接着会被 reschedule 把自己刚设的 holdAdvance 清掉 ——
   *     表现就是「按不住引擎，阶段还是瞬间跑完」。
   *  ② 然后 tickPacing() 决定这一回合要不要留播报窗口、要不要进倒数。
   *  ③ 最后广播，保证 deadline / countdown 都是最新值。
   */
  afterChange(): void {
    this.reschedule();
    this.tickPacing();
    this.archiveFinishedMatch();
    this.manageHostFailover();
    this.broadcast();
  }

  private archiveFinishedMatch(): void {
    if (!this.game || !this.matchId || this.matchFinished || this.game.phase !== 'GAME_OVER') return;
    const token = this.activeSeats().find((value): value is string => value !== null);
    if (!token) return;
    const view = this.game.gameViewFor(token);
    if (!view.outcome) return;
    try {
      const fakeSeerUserId = this.fakeSeerToken
        ? (this.hub.get(this.fakeSeerToken)?.userId ?? null)
        : null;
      this.hub.database.finishMatch(
        this.matchId,
        view.outcome,
        view.day,
        fakeSeerUserId,
        this.game.revealRows().map((row) => ({ seat: row.seat, camp: row.camp })),
      );
      this.matchFinished = true;
    } catch (error) {
      // 保持 matchFinished=false，下一次状态广播时会重试落库。
      console.error('保存场次结果失败，将在下次状态变化时重试：', error);
    }
  }

  /**
   * 夜间回合的节奏控制。
   *
   * 一个夜间角色回合的时长 = **这个角色的战术安排时间**（见 PHASE_TIMEOUT_MS）：
   *   狼人 1 分半，其余角色 30-40 秒。
   *
   * 整段时间里引擎被按住（holdAdvance），**不会因为「都提交完了」就提前关闭** ——
   * 狼队真的需要时间商量刀谁、谁去悍跳、怎么发言。
   * 最后 5 秒由服务端倒数提醒（念 5、4、3、2、1），倒数只是提醒，不是终止信号；
   * 真正的关闭时机是阶段超时，或者房主确认跳过当前阶段。
   *
   * 白天的阶段不受影响，仍然是「行动齐了就立刻推进」。
   */
  private tickPacing(): void {
    const game = this.game;
    if (!game || game.phase === 'GAME_OVER' || game.phase === 'WAITING') {
      this.stopPhaseTicker();
      if (game) {
        game.countdown = null;
        game.countdownEndsAt = null;
        game.holdAdvance = false;
      }
      return;
    }

    // 白天 / 过场阶段：沿用原来的行为，立即结算
    if (!NIGHT_ROLE_PHASES.has(game.phase)) {
      this.stopPhaseTicker();
      game.countdown = null;
      game.countdownEndsAt = null;
      game.holdAdvance = false;
      game.settle();
      return;
    }

    // 夜间角色回合：整段按住引擎，由房主跳过或阶段超时来关闭
    game.holdAdvance = true;
    this.startPhaseTicker();
  }

  private startPhaseTicker(): void {
    if (this.phaseTicker) return;
    this.phaseTicker = setInterval(() => this.onPhaseTick(), 250);
    this.onPhaseTick();
  }

  private stopPhaseTicker(): void {
    if (this.phaseTicker) {
      clearInterval(this.phaseTicker);
      this.phaseTicker = null;
    }
  }

  /**
   * 每 250ms 算一次倒数。
   * 只在「进入了最后 5 秒」并且数字变了的时候才广播，避免刷屏。
   */
  private onPhaseTick(): void {
    const game = this.game;
    if (!game || !NIGHT_ROLE_PHASES.has(game.phase) || game.deadline === null) {
      this.stopPhaseTicker();
      return;
    }
    const remainMs = game.deadline - Date.now();
    const windowMs = COUNTDOWN_WINDOW_MS * Math.max(this.config.timeoutScale, 0.05);
    const value = remainMs <= windowMs ? Math.max(1, Math.ceil(remainMs / 1000)) : null;

    if (value !== game.countdown) {
      game.countdown = value;
      game.countdownEndsAt = value === null ? null : game.deadline;
      this.broadcast();
    }
  }

  /**
   * 「结束本轮」：夜间回合不等满时长，立刻收工进入下一回合。
   * 这是旧客户端仍可能发送的消息，也必须在服务端强制校验房主权限。
   */
  endRound(byToken: string): Reply {
    const game = this.game;
    if (!game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以跳过当前阶段');
    if (!NIGHT_ROLE_PHASES.has(game.phase)) {
      return fail(ERR.BAD_PHASE, '只有夜间回合可以提前结束');
    }
    return this.forceAdvance(byToken);
  }

  private clearPacing(): void {
    this.stopPhaseTicker();
  }

  /**
   * 重排阶段定时器。
   *
   * 关键：**只在「阶段真的变了」的时候才重置倒计时**。
   *
   * 之前这里每次 afterChange() 都无条件 clear + 重建定时器，后果是：
   * 任何一次状态变更（有人点就绪、有人发送一个被拒绝的请求……）
   * 都会把当前阶段的倒计时重新拉满。12 个人轮流点几下，
   * 阶段就永远到不了超时 —— 表现为「游戏卡在天黑不动」。
   * 这个 bug 是靠「用机器人走一遍真实开局流程」才暴露出来的。
   */
  private reschedule(): void {
    const game = this.game;
    if (!game) {
      this.clearTimer();
      this.clearPacing();
      this.scheduledKey = '';
      return;
    }
    if (game.phase === 'GAME_OVER' || game.phase === 'WAITING') {
      this.clearTimer();
      this.clearPacing();
      game.deadline = null;
      this.scheduledKey = `${game.phase}|${game.day}`;
      return;
    }
    if (!this.config.autoTimeout) {
      this.clearTimer();
      game.deadline = null;
      return;
    }
    const base = PHASE_TIMEOUT_MS[game.phase];
    if (!Number.isFinite(base)) {
      this.clearTimer();
      game.deadline = null;
      return;
    }

    // 同一个阶段（且定时器仍在）→ 保持原倒计时不动
    const key = `${game.phase}|${game.day}`;
    if (key === this.scheduledKey && this.timer !== null) return;

    this.clearTimer();
    // 阶段换了 → 清掉上一个回合的倒数与按住的引擎，交给 tickPacing 重新决定
    this.stopPhaseTicker();
    this.phaseEnteredAt = Date.now();
    game.countdown = null;
    game.countdownEndsAt = null;
    game.holdAdvance = false;

    const ms = Math.max(150, Math.round(base * this.config.timeoutScale));
    game.deadline = Date.now() + ms;
    this.scheduledKey = key;
    this.timer = setTimeout(() => {
      this.timer = null;
      const g = this.game;
      if (!g || g.phase === 'GAME_OVER') return;
      g.forceAdvance();
      this.afterChange();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.clearPacing();
    this.clearHostFailoverTimer();
    this.game = null;
  }

  refreshHallData(): void {
    this.matchNumber = this.hub.database.nextMatchNumber(this.id);
    this.broadcast();
  }

  stats(): { id: string; players: number; playing: boolean; phase: string; day: number } {
    return {
      id: this.id,
      players: this.playerCount,
      playing: this.playing,
      phase: this.game?.phase ?? 'WAITING',
      day: this.game?.day ?? 0,
    };
  }

  lobbySummary(): {
    roomId: string;
    hostName: string;
    playerCount: number;
    capacity: number;
    boardSummary: string;
    createdAt: number;
  } {
    const host = this.hub.get(this.hostToken);
    return {
      roomId: this.id,
      hostName: host?.nickname ?? '房主',
      playerCount: this.playerCount,
      capacity: this.seatCapacity,
      boardSummary: boardSummary(this.board),
      createdAt: this.createdAt,
    };
  }
}

// ────────────────────────────────────────────────────────────────

export class Hub {
  private sessions = new Map<string, Session>();
  private rooms = new Map<string, Room>();
  readonly database: GameDatabase;

  constructor(database: GameDatabase) {
    this.database = database;
  }

  // ─────────────── 会话 ───────────────

  get(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  /** 重连时带上旧 token 就能恢复座位与角色 */
  ensureSession(token: string | undefined): Session {
    if (token) {
      const existing = this.sessions.get(token);
      if (existing) return existing;
    }
    const fresh: Session = {
      token: token && token.length >= 8 ? token : randomUUID(),
      userId: null,
      automation: false,
      nickname: '',
      avatar: '',
      roomId: null,
      socket: null,
      lastSeen: Date.now(),
    };
    this.sessions.set(fresh.token, fresh);
    return fresh;
  }

  attach(
    token: string,
    socket: WebSocket,
    user: AccountUser | null = null,
    automation = false,
  ): Session {
    const session = this.ensureSession(token);
    // 同一 token 重复连接（例如微信里前后台切换）：踢掉旧连接，保留新连接
    if (session.socket && session.socket !== socket && session.socket.readyState === WebSocket.OPEN) {
      try {
        session.socket.close(4001, 'replaced by a newer connection');
      } catch {
        /* ignore */
      }
    }
    session.socket = socket;
    session.lastSeen = Date.now();
    session.automation = automation;
    if (user && !user.mustChangePassword) {
      session.userId = user.id;
      session.nickname = user.username;
    } else {
      // 不能仅凭可复制的对局恢复 token 继承上一次登录身份。
      session.userId = null;
    }
    return session;
  }

  /**
   * 连接建立后把该会话当前的房间/对局状态推回去。
   * 微信切后台会静默断连，重新打开时必须能无缝回到原来的座位和角色。
   */
  resync(token: string): void {
    const session = this.sessions.get(token);
    if (!session) return;
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room) {
      send(session.socket, { t: 'room', room: null });
      send(session.socket, { t: 'game', game: null });
      return;
    }
    // afterChange 会广播给全房，顺便让其他人看到「在线」状态更新
    room.afterChange();
  }

  detach(token: string, socket: WebSocket): void {
    const session = this.sessions.get(token);
    if (!session) return;
    if (session.socket !== socket) return; // 已被新连接替换，不要误清新连接
    session.socket = null;
    session.lastSeen = Date.now();
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (room) room.onConnectionChanged(); // 更新离线状态，并启动白天房主移交计时
  }

  // ─────────────── 消息入口 ───────────────

  handleMessage(token: string, raw: string): void {
    const session = this.sessions.get(token);
    if (!session) return;
    session.lastSeen = Date.now();

    let msg: ClientMsg;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !('t' in parsed)) {
        this.reply(session, fail(ERR.BAD_MESSAGE, '消息格式不正确'));
        return;
      }
      msg = parsed as ClientMsg;
    } catch {
      this.reply(session, fail(ERR.BAD_MESSAGE, '消息不是合法 JSON'));
      return;
    }

    switch (msg.t) {
      case 'ping':
        session.socket?.send(JSON.stringify({ t: 'pong', ts: msg.ts } satisfies ServerMsg));
        return;

      default:
        if (!session.userId && !session.automation) {
          this.reply(session, fail(ERR.BAD_MESSAGE, '请先登录后再进入游戏'));
          return;
        }
        break;
    }

    switch (msg.t) {
      case 'room.create': {
        this.leaveRoom(session);
        session.nickname = sanitizeNickname(session.nickname || msg.nickname, '房主');
        if (typeof msg.avatar === 'string') session.avatar = msg.avatar.slice(0, 200);
        let id = makeRoomId();
        let guard = 0;
        while (this.rooms.has(id) && guard++ < 50) id = makeRoomId();
        const room = new Room(this, id, session.token, session.userId);
        this.rooms.set(id, room);
        this.reply(session, room.addPlayer(session.token));
        return;
      }

      case 'room.join': {
        const roomId = typeof msg.roomId === 'string' ? msg.roomId.trim().toUpperCase() : '';
        const room = this.rooms.get(roomId);
        if (!room) {
          this.reply(session, fail(ERR.ROOM_NOT_FOUND, `没有找到房间 ${roomId}`));
          return;
        }
        if (session.roomId === roomId) {
          // 重复 join 视为重连
          this.reply(session, OK);
          room.afterChange();
          return;
        }
        this.leaveRoom(session);
        session.nickname = sanitizeNickname(
          session.nickname || msg.nickname,
          `玩家${room.playerCount + 1}`,
        );
        if (typeof msg.avatar === 'string') session.avatar = msg.avatar.slice(0, 200);
        this.reply(session, room.addPlayer(session.token));
        return;
      }

      case 'room.leave':
        this.leaveRoom(session);
        this.reply(session, OK);
        return;

      case 'room.takeSeat': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.takeSeat(session.token, Number(msg.seat)));
        return;
      }

      case 'room.ready': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.setReady(session.token, msg.ready === true));
        return;
      }

      case 'room.board': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.setBoard(session.token, msg.board));
        return;
      }

      case 'game.start': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.startGame(session.token));
        return;
      }

      case 'game.action': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const action = msg.action;
        if (!action || typeof action !== 'object' || typeof action.kind !== 'string') {
          this.reply(session, fail(ERR.BAD_MESSAGE, '行动格式不正确'));
          return;
        }
        this.reply(session, room.submitAction(session.token, action));
        return;
      }

      case 'game.vote': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const target = msg.target === null ? null : Number(msg.target);
        if (target !== null && !Number.isInteger(target)) {
          this.reply(session, fail(ERR.INVALID_TARGET, '投票目标不正确'));
          return;
        }
        this.reply(session, room.submitVote(session.token, target));
        return;
      }

      case 'game.sheriffSignup': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.submitSheriffSignup(session.token, msg.candidate === true));
        return;
      }

      case 'game.sheriffWithdraw': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.withdrawSheriff(session.token));
        return;
      }

      case 'game.sheriffVote': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const target = msg.target === null ? null : Number(msg.target);
        if (target !== null && !Number.isInteger(target)) return this.reply(session, fail(ERR.INVALID_TARGET, '投票目标不正确'));
        this.reply(session, room.submitSheriffVote(session.token, target));
        return;
      }

      case 'game.sheriffTransfer': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const target = msg.target === null ? null : Number(msg.target);
        if (target !== null && !Number.isInteger(target)) return this.reply(session, fail(ERR.INVALID_TARGET, '移交目标不正确'));
        this.reply(session, room.submitSheriffTransfer(session.token, target));
        return;
      }

      case 'game.speechDirection': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        if (msg.direction !== 'FORWARD' && msg.direction !== 'REVERSE') {
          return this.reply(session, fail(ERR.BAD_MESSAGE, '发言方向不正确'));
        }
        this.reply(session, room.setSpeechDirection(session.token, msg.direction));
        return;
      }

      case 'game.hunterShoot': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const target = msg.target === null ? null : Number(msg.target);
        if (target !== null && !Number.isInteger(target)) {
          this.reply(session, fail(ERR.INVALID_TARGET, '开枪目标不正确'));
          return;
        }
        this.reply(session, room.submitHunterShoot(session.token, target));
        return;
      }

      case 'game.selfDestruct': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.selfDestruct(session.token));
        return;
      }

      case 'game.boomTarget': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const target = msg.target === null ? null : Number(msg.target);
        if (target !== null && !Number.isInteger(target)) {
          this.reply(session, fail(ERR.INVALID_TARGET, '目标不正确'));
          return;
        }
        this.reply(session, room.submitBoomTarget(session.token, target));
        return;
      }

      case 'game.wolfTag': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const tag = msg.tag === null ? null : (msg.tag as WolfTag);
        this.reply(session, room.setWolfTag(session.token, tag));
        return;
      }

      case 'game.skipCountdown': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.endRound(session.token));
        return;
      }

      case 'game.godView': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.setGodView(session.token, msg.active === true));
        return;
      }

      case 'room.closeMatch': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.closeMatch(session.token));
        return;
      }

      case 'game.advance': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.forceAdvance(session.token));
        return;
      }

      case 'game.revealAll': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.revealAll(session.token));
        return;
      }

      case 'game.restart': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.restart(session.token));
        return;
      }

      case 'chat':
        // 暂未实现：语音沟通走微信群语音，文字频道留到后续版本
        this.reply(session, OK);
        return;

      default:
        this.reply(session, fail(ERR.BAD_MESSAGE, '未知的消息类型'));
        return;
    }
  }

  private reply(session: Session, res: Reply): void {
    if (res.ok) return;
    send(session.socket, {
      t: 'error',
      code: res.code ?? ERR.BAD_MESSAGE,
      message: res.message ?? '操作失败',
    });
    send(session.socket, {
      t: 'toast',
      text: res.message ?? '操作失败',
      level: 'warn',
    });
  }

  private currentRoom(session: Session): Room | undefined {
    return session.roomId ? this.rooms.get(session.roomId) : undefined;
  }

  private leaveRoom(session: Session): void {
    const room = this.currentRoom(session);
    if (!room) return;
    room.removePlayer(session.token);
    session.roomId = null;
  }

  destroyRoom(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    room.dispose();
    this.rooms.delete(id);
    for (const session of this.sessions.values()) {
      if (session.roomId === id) session.roomId = null;
    }
  }

  refreshHall(id: string): void {
    this.rooms.get(id)?.refreshHallData();
  }

  /** 清理长时间失联的会话与空房间 */
  sweep(maxIdleMs = 6 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.socket) continue;
      if (now - session.lastSeen < maxIdleMs) continue;
      this.leaveRoom(session);
      this.sessions.delete(token);
    }
    for (const [id, room] of this.rooms) {
      if (room.playerCount === 0 && !room.playing) {
        room.dispose();
        this.rooms.delete(id);
      }
    }
  }

  stats(): {
    rooms: number;
    sessions: number;
    online: number;
    roomList: ReturnType<Room['stats']>[];
  } {
    let online = 0;
    for (const s of this.sessions.values()) if (s.socket) online++;
    return {
      rooms: this.rooms.size,
      sessions: this.sessions.size,
      online,
      roomList: [...this.rooms.values()].map((r) => r.stats()),
    };
  }

  lobbyRooms(): ReturnType<Room['lobbySummary']>[] {
    return [...this.rooms.values()]
      .filter((room) => !room.playing && room.playerCount < room.seatCapacity)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => room.lobbySummary());
  }
}

export { boardSummary };
