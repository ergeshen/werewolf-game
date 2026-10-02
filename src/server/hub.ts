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

import { Game, PHASE_TIMEOUT_MS, type GameSnapshot } from '../shared/engine.ts';
import { GameDatabase, type AccountUser } from './database.ts';
import {
  DEFAULT_ROOM_CONFIG,
  ERR,
  NIGHT_ROLE_PHASE_LIST,
  type ClientMsg,
  type GameMode,
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
  makeBoard,
  ROLE_CAMP,
  ROLE_NAME,
  type BoardConfig,
  type Role,
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
 *
 * 清单来自协议层（`NIGHT_ROLE_PHASE_LIST`），不再手写 ——
 * 手写的那版在加了狼美人之后就漏了新阶段，那个阶段会变成「一提交就跳过」，
 * 语音根本来不及念。
 */
const NIGHT_ROLE_PHASES: ReadonlySet<Phase> = new Set<Phase>(NIGHT_ROLE_PHASE_LIST);

/**
 * 「在等人操作」的阶段 —— 房主掉线 60 秒后把操作权临时移交给别人。
 *
 * `ROLE_REVEAL` 必须在这个集合里：身份确认是**硬门槛**（在线的人全部确认，
 * 房主才能按「天黑请闭眼」），而它又没有计时器。如果房主恰好在这个阶段掉线、
 * 又不做移交，全场就会永久锁死在「等房主按按钮」上 —— 没有任何超时能救。
 */
const DAYTIME_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'ROLE_REVEAL',
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
const HEX_DRAFT_MS = 45_000;

/**
 * 房间快照格式版本。改 Room 字段语义 / 删字段时必须 bump；
 * 版本不符的快照在恢复时整体丢弃（宁可丢一局，不能加载出错乱的房间）。
 */
const ROOM_SNAPSHOT_VERSION = 1;

/**
 * 房间的完整存档（纯 JSON）。含座位上的 token → 用户映射，
 * 重启后据此重建会话，老 token 重连即可落回原座位。
 */
interface RoomSnapshot {
  v: number;
  id: string;
  createdAt: number;
  config: RoomConfig;
  seats: (string | null)[];
  ready: string[];
  primaryHostToken: string;
  hostToken: string;
  hostTemporary: boolean;
  ownerUserId: string | null;
  matchNumber: number;
  matchId: string | null;
  matchFinished: boolean;
  fakeSeerToken: string | null;
  board: BoardConfig;
  mode: GameMode;
  hexDraft: [string, { options: Role[]; selected: Role | null }][] | null;
  hexDraftDeadline: number;
  game: GameSnapshot | null;
  /** 座位 token → 身份信息（会话在内存里，重启即失，必须随快照走） */
  seatSessions: Record<string, { userId: string | null; nickname: string; avatar: string }>;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function boardFromDeck(roles: readonly Role[]): BoardConfig {
  const counts: Partial<Record<Role, number>> = {};
  for (const role of roles) counts[role] = (counts[role] ?? 0) + 1;
  return makeBoard(roles.length, counts);
}

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
  private mode: GameMode = 'STANDARD';
  private hexDraft: Map<string, { options: Role[]; selected: Role | null }> | null = null;
  private hexDraftDeadline = 0;
  private hexDraftTimer: NodeJS.Timeout | null = null;
  /** 有一个挂起的落库任务（setImmediate 合并连发广播，避免每个动作都写一次盘） */
  private persistQueued = false;

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
    return this.game !== null || this.hexDraft !== null;
  }

  // ─────────────── 快照与恢复（进行中房间持久化） ───────────────

  /**
   * 导出整间房间的纯 JSON 存档：座位、版型、模式、海克斯选牌、对局引擎全套状态。
   *
   * 注意：快照含**上帝视角**的游戏状态（所有人的身份），只允许写进数据库，
   * 绝不能发给任何客户端 —— 个性化视图仍然由 gameViewFor 按人裁剪。
   */
  snapshot(): RoomSnapshot {
    const seatSessions: RoomSnapshot['seatSessions'] = {};
    const tokens = new Set<string>(this.seats.filter((s): s is string => s !== null));
    for (const extra of [this.primaryHostToken, this.hostToken, this.fakeSeerToken]) {
      if (extra) tokens.add(extra);
    }
    if (this.hexDraft) for (const token of this.hexDraft.keys()) tokens.add(token);
    for (const token of tokens) {
      const session = this.hub.get(token);
      seatSessions[token] = {
        userId: session?.userId ?? null,
        nickname: session?.nickname ?? '',
        avatar: session?.avatar ?? '',
      };
    }
    return {
      v: ROOM_SNAPSHOT_VERSION,
      id: this.id,
      createdAt: this.createdAt,
      config: { ...this.config },
      seats: [...this.seats],
      ready: [...this.ready],
      primaryHostToken: this.primaryHostToken,
      hostToken: this.hostToken,
      hostTemporary: this.hostTemporary,
      ownerUserId: this.ownerUserId,
      matchNumber: this.matchNumber,
      matchId: this.matchId,
      matchFinished: this.matchFinished,
      fakeSeerToken: this.fakeSeerToken,
      board: cloneBoard(this.board),
      mode: this.mode,
      hexDraft: this.hexDraft
        ? [...this.hexDraft.entries()].map(([token, entry]) => [
          token,
          { options: [...entry.options], selected: entry.selected },
        ])
        : null,
      hexDraftDeadline: this.hexDraftDeadline,
      game: this.game ? this.game.snapshot() : null,
      seatSessions,
    };
  }

  /**
   * 从快照重建房间。**不走构造函数**：构造函数会写大厅表、读场次号，
   * 恢复时这些都已经存在，重复执行反而会覆盖数据。
   *
   * 恢复内容有任何问题（版本不符、结构损坏、对局引擎恢复失败）都返回 null，
   * 调用方应当丢弃这份快照。
   */
  static restore(hub: Hub, roomId: string, payload: string): Room | null {
    let input: unknown;
    try {
      input = JSON.parse(payload);
    } catch {
      return null;
    }
    if (typeof input !== 'object' || input === null) return null;
    const snap = input as Partial<RoomSnapshot>;
    if (snap.v !== ROOM_SNAPSHOT_VERSION) return null;
    if (snap.id !== roomId) return null;
    if (!Array.isArray(snap.seats)) return null;
    const game = snap.game ? Game.restore(snap.game) : null;
    if (snap.game && !game) return null; // 对局存在却恢复不了 → 整间丢弃，不能丢掉对局只留空壳

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- readonly 字段只能绕过类型系统一次性写入
    const room: any = Object.create(Room.prototype);
    room.hub = hub;
    room.id = roomId;
    room.createdAt = Number(snap.createdAt) || Date.now();
    room.config = { ...DEFAULT_ROOM_CONFIG, ...(snap.config ?? {}) };
    room.seats = [...snap.seats];
    room.ready = new Set<string>(snap.ready ?? []);
    room.primaryHostToken = snap.primaryHostToken ?? snap.seats.find((s) => s !== null) ?? '';
    room.hostToken = snap.hostToken ?? room.primaryHostToken;
    room.hostTemporary = snap.hostTemporary === true;
    room.hostFailoverTimer = null;
    room.ownerUserId = snap.ownerUserId ?? null;
    room.matchNumber = snap.matchNumber ?? 1;
    room.scheduledKey = '';
    room.game = game;
    room.matchId = snap.matchId ?? null;
    room.matchFinished = snap.matchFinished === true;
    room.fakeSeerToken = snap.fakeSeerToken ?? null;
    room.timer = null;
    room.phaseEnteredAt = Date.now();
    room.phaseTicker = null;
    room.board = snap.board ? cloneBoard(snap.board) : defaultBoard();
    room.mode = snap.mode === 'HEX_CHAOS' ? 'HEX_CHAOS' : 'STANDARD';
    room.hexDraft = Array.isArray(snap.hexDraft)
      ? new Map(snap.hexDraft.map(([token, entry]) => [token, { ...entry }]))
      : null;
    room.hexDraftDeadline = snap.hexDraftDeadline ?? 0;
    room.hexDraftTimer = null;
    room.persistQueued = false;

    room.restoreSessions(snap.seatSessions ?? {});
    room.resumeFromSnapshot(Date.now());
    return room as Room;
  }

  /** 为快照里的所有 token 重建「离线会话」：老 token 重连即可落回原座位。 */
  private restoreSessions(seatSessions: RoomSnapshot['seatSessions']): void {
    const tokens = new Set<string>(this.seats.filter((s): s is string => s !== null));
    for (const extra of [this.primaryHostToken, this.hostToken, this.fakeSeerToken]) {
      if (extra) tokens.add(extra);
    }
    if (this.hexDraft) for (const token of this.hexDraft.keys()) tokens.add(token);
    for (const token of tokens) {
      const info = seatSessions[token];
      const session = this.hub.ensureSession(token);
      if (info) {
        // 真实身份在重连时由登录会话重新核定（attach），这里只是先放一个
        // 「能被认出来的占位」，让 resync/广播找得到人。
        session.userId = info.userId;
        session.nickname = info.nickname;
        session.avatar = info.avatar;
      }
      session.roomId = this.id;
    }
  }

  /**
   * 恢复后的定时器重锚。原则：**停机期间流逝的时间和真实对局一样有效**。
   *
   * - 停机期间已到点的阶段，按「超时」结算一次（引擎的挂机自动处理，
   *   也就是服务端一直在线时会发生的同一件事）；
   * - 之后 afterChange() → reschedule() 会给当前阶段重新挂一个**完整时长**的
   *   新定时器 —— 重启对玩家表现为「这一阶段重新计时」，公平且实现简单。
   */
  private resumeFromSnapshot(now: number): void {
    if (this.hexDraft) {
      const remaining = this.hexDraftDeadline - now;
      if (remaining <= 0) {
        this.finishHexDraft();
        return; // finishHexDraft → launchGame → afterChange，已经处理完一切
      }
      this.clearHexDraftTimer();
      this.hexDraftTimer = setTimeout(() => this.finishHexDraft(), remaining);
    }
    const game = this.game;
    if (game && game.phase !== 'GAME_OVER' && game.deadline !== null && game.deadline <= now) {
      game.forceAdvance();
    }
    this.afterChange();
  }

  /** 把当前房间状态异步落库（setImmediate 合并同一轮事件里的多次变更）。 */
  private queuePersist(): void {
    if (this.persistQueued) return;
    this.persistQueued = true;
    setImmediate(() => {
      this.persistQueued = false;
      // 房间已销毁（空房清理 / 主动关闭）就不再写盘，销毁路径自己会删快照
      if (!this.hub.isHallActive(this.id)) return;
      try {
        this.hub.database.saveRoomSnapshot(this.id, JSON.stringify(this.snapshot()));
      } catch (error) {
        // 落库失败不影响对局继续；下一次状态变化会再试
        console.error(`保存房间 ${this.id} 的快照失败：`, error);
      }
    });
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
    const userId = this.hub.get(token)?.userId;
    if (userId) this.hub.database.recordHallVisit(this.id, userId);
    this.afterChange();
    return OK;
  }

  removePlayer(token: string): void {
    const idx = this.seats.indexOf(token);
    if (idx === -1) return;
    this.seats[idx] = null;
    this.ready.delete(token);
    if (this.hexDraft) {
      this.clearHexDraftTimer();
      this.hexDraft = null;
      this.hexDraftDeadline = 0;
      this.ready.clear();
    }

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
    // 有人断线/回来 → 硬门槛的「必须等谁」跟着变，重新算一遍
    this.syncEngineInputs();
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

  setMode(byToken: string, mode: GameMode): Reply {
    if (this.playing) return fail(ERR.ROOM_PLAYING, '游戏准备或进行中，不能切换模式');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以切换模式');
    if (mode !== 'STANDARD' && mode !== 'HEX_CHAOS') return fail(ERR.BAD_MESSAGE, '游戏模式不正确');
    this.mode = mode;
    if (mode === 'HEX_CHAOS' && (this.board.playerCount < 9 || this.board.playerCount > 12)) {
      this.board = { ...this.board, playerCount: 12 };
    }
    this.ready.clear();
    this.afterChange();
    return OK;
  }

  setRoleWish(token: string, role: Role | null): Reply {
    if (this.mode === 'HEX_CHAOS') return fail(ERR.BAD_PHASE, '海克斯大乱斗不使用连败愿望');
    const userId = this.hub.get(token)?.userId;
    if (!userId) return fail(ERR.BAD_MESSAGE, '登录后才能选择愿望角色');
    if (role !== null && ((this.board.roles[role] ?? 0) <= 0 || !(role in ROLE_NAME))) {
      return fail(ERR.INVALID_TARGET, '当前版型里没有这个角色');
    }
    const result = this.hub.database.setRoleWish(userId, role);
    if (!result.ok) return fail(ERR.BAD_PHASE, result.message);
    this.broadcast();
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
    const raw = input as { playerCount?: unknown; roles?: unknown; puppet?: unknown };

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
    /**
     * `puppet` 必须原样带过去。
     *
     * 这个函数只重建 `playerCount` 和 `roles`，所以任何**版型级开关**都会在这里被抹掉 ——
     * 「唯邻是从」就踩过这个坑：从预设列表选它，服务端收到的 board 里 puppet 没了，
     * 于是开局变成一个普通板子，而界面上看起来完全正常（只有玩起来才发现没有傀儡）。
     * 以后再加版型级字段，记得也在这里放行。
     */
    if (raw.puppet === true) base.puppet = true;
    return base;
  }

  // ─────────────── 游戏流程 ───────────────

  startGame(byToken: string, skipReadyCheck = false): Reply {
    if (this.game || this.hexDraft) return fail(ERR.BAD_PHASE, '游戏已经开始准备或正在进行');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以开始游戏');

    const errors = this.currentBoardErrors();
    if (errors.length > 0) {
      return fail(ERR.INVALID_TARGET, `版型还没配好：${errors[0]}`);
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

    if (this.mode === 'HEX_CHAOS') return this.startHexDraft();
    const roles = this.weightedStandardDeck();
    return this.launchGame(roles, cloneBoard(this.board), boardSummary(this.board));
  }

  private currentBoardErrors(): string[] {
    if (this.mode === 'HEX_CHAOS') {
      return this.board.playerCount >= 9 && this.board.playerCount <= 12
        ? []
        : ['海克斯大乱斗仅支持 9–12 人'];
    }
    return boardErrors(this.board).map((entry) => entry.message);
  }

  private currentBoardWarnings(): string[] {
    if (this.mode === 'HEX_CHAOS') return ['至少 3 狼，狼人最多小于总人数一半；身份选择会让阵容强度产生较大波动。'];
    return boardWarnings(this.board).map((entry) => entry.message);
  }

  private weightedStandardDeck(): Role[] {
    const deck = shuffled(boardToDeck(this.board));
    const locked = new Set<number>();
    const wishers = shuffled(this.activeSeats().map((token, index) => ({ token: token!, index })));
    for (const entry of wishers) {
      const userId = this.hub.get(entry.token)?.userId;
      if (!userId) continue;
      const wish = this.hub.database.roleWishState(userId);
      if (wish.lossStreak < 2 || !wish.role || (this.board.roles[wish.role] ?? 0) <= 0) continue;
      if (deck[entry.index] === wish.role) {
        locked.add(entry.index);
        continue;
      }
      // 额外 2/3 的交换机会叠加基础随机概率，接近“三倍权重”但不作中奖承诺。
      if (Math.random() >= 2 / 3) continue;
      const holders = deck
        .map((role, index) => ({ role, index }))
        .filter((candidate) => candidate.role === wish.role && !locked.has(candidate.index));
      const holder = holders[Math.floor(Math.random() * holders.length)];
      if (!holder) continue;
      [deck[entry.index], deck[holder.index]] = [deck[holder.index]!, deck[entry.index]!];
      locked.add(entry.index);
    }
    return deck;
  }

  private startHexDraft(): Reply {
    const tokens = this.activeSeats().filter((token): token is string => token !== null);
    const randomized = shuffled(tokens);
    const coreWolfTokens = randomized.slice(0, 3);
    const coreWolves = new Set(coreWolfTokens);
    const coreOptions = new Map<string, Role[]>([
      [coreWolfTokens[0]!, ['WOLF', 'WOLF_KING', 'BLACK_WOLF_KING']],
      [coreWolfTokens[1]!, ['WOLF', 'MECHANICAL_WOLF', 'MASK']],
      [coreWolfTokens[2]!, ['WOLF', 'WOLF_KING', 'BLACK_WOLF_KING']],
    ]);
    const extraWolfSlots = Math.max(0, Math.floor((tokens.length - 1) / 2) - 3);
    const optionalWolves = new Set(randomized.slice(3, 3 + extraWolfSlots));
    const uniqueGood: Role[] = shuffled([
      'SEER', 'SPIRIT_SEER', 'WITCH', 'GUARD', 'DREAMER', 'DANCER', 'HYBRID',
    ]);
    this.hexDraft = new Map();
    for (const token of tokens) {
      let options: Role[];
      if (coreWolves.has(token)) {
        // 这三人无论怎么选都属于狼营，从结构上保证至少三狼。
        options = shuffled(coreOptions.get(token)!);
      } else {
        const good: Role[] = ['VILLAGER', 'HUNTER', 'IDIOT'];
        const special = uniqueGood.shift();
        if (special) good[Math.floor(Math.random() * good.length)] = special;
        options = optionalWolves.has(token)
          ? shuffled(['WOLF', ...shuffled(good).slice(0, 2)])
          : shuffled(good);
      }
      this.hexDraft.set(token, { options, selected: null });
    }
    this.hexDraftDeadline = Date.now() + HEX_DRAFT_MS;
    this.clearHexDraftTimer();
    this.hexDraftTimer = setTimeout(() => this.finishHexDraft(), HEX_DRAFT_MS);
    this.broadcast();
    return OK;
  }

  submitHexChoice(token: string, role: Role): Reply {
    const entry = this.hexDraft?.get(token);
    if (!entry) return fail(ERR.BAD_PHASE, '现在不在海克斯选牌阶段');
    if (!entry.options.includes(role)) return fail(ERR.INVALID_TARGET, '这张身份牌不在你的候选中');
    entry.selected = role;
    if ([...this.hexDraft!.values()].every((value) => value.selected !== null)) {
      return this.finishHexDraft();
    }
    this.broadcast();
    return OK;
  }

  skipHexDraft(byToken: string): Reply {
    if (!this.hexDraft) return fail(ERR.BAD_PHASE, '现在不在海克斯选牌阶段');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以结束选牌时间');
    return this.finishHexDraft();
  }

  private finishHexDraft(): Reply {
    const draft = this.hexDraft;
    if (!draft) return fail(ERR.BAD_PHASE, '海克斯选牌已经结束');
    this.clearHexDraftTimer();
    const roles = this.activeSeats().map((token) => {
      const entry = draft.get(token!);
      if (!entry) return 'VILLAGER' as Role;
      return entry.selected ?? entry.options[Math.floor(Math.random() * entry.options.length)]!;
    });
    this.hexDraft = null;
    this.hexDraftDeadline = 0;
    const actualBoard = boardFromDeck(roles);
    return this.launchGame(roles, actualBoard, `海克斯大乱斗 · ${roles.length} 人 · 身份三选一`);
  }

  private clearHexDraftTimer(): void {
    if (this.hexDraftTimer) clearTimeout(this.hexDraftTimer);
    this.hexDraftTimer = null;
  }

  private launchGame(roles: Role[], recordedBoard: BoardConfig, summary: string): Reply {

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
      roles,
      shuffle: false,
      config: this.config,
      // 「唯邻是从」的首夜傀儡机制跟着**版型**走，不是跟着角色走
      puppet: this.board.puppet === true,
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
        recordedBoard,
        summary,
        participants,
        this.mode,
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

  /** 狼人自爆（白狼王带人 / 普通狼空爆） */
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

  /** 骑士翻牌决斗 */
  knightDuel(token: string, target: number): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.knightDuel(token, target);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '决斗失败');
  }

  /**
   * 设置/取消自己的狼队战术标签。
   *
   * 房间这一层只管两件**引擎管不着**的事：
   *  ① 悍跳位被队友占着的时候不许抢 —— 引擎只知道「有人占了」，不知道是谁在操作
   *  ② 战绩里的 +1 分要认到具体的人，所以记住 fakeSeerToken，并在让位时清掉
   *
   * 「悍跳位只能第一夜定、而第一夜之内随便改」这条**时间规则在引擎里**
   * （见 Game.setWolfTag）—— 那是游戏规则，放在引擎才能被单元测试钉住。
   * 之前它写在这里，唯一的覆盖是冒烟测试，冒烟一卡就再没人发现它把队友锁死了。
   */
  setWolfTag(token: string, tag: WolfTag | null, target: number | null = null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');

    if (tag === 'FAKE_SEER' && this.fakeSeerToken && this.fakeSeerToken !== token) {
      const holderSeat = this.activeSeats().indexOf(this.fakeSeerToken) + 1;
      return fail(
        ERR.ALREADY_DONE,
        holderSeat > 0
          ? `${holderSeat} 号还占着悍跳位。等他再点一下那个按钮取消，或者你自己先选别的。`
          : '悍跳位已经有人占了，等他取消或者你自己先选别的。',
      );
    }

    const res = this.game.setWolfTag(token, tag, target);
    if (res.ok) {
      if (tag === 'FAKE_SEER') {
        this.fakeSeerToken = token;
      } else if (this.fakeSeerToken === token) {
        // 主动让出悍跳位 —— 队友马上就能接手
        this.fakeSeerToken = null;
      }
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
    // 身份确认阶段不给「跳过」这条路：硬门槛的意义就是不许有人在没看牌的情况下
    // 被打进夜晚，如果「跳过阶段」能直接天黑，这个门槛等于不存在。
    if (game.phase === 'ROLE_REVEAL') {
      const pending = game.pendingRoleRevealSeats();
      return fail(
        ERR.BAD_PHASE,
        pending.length > 0
          ? `还有 ${pending.length} 人没确认身份（${pending.join('、')} 号），不能用「跳过阶段」开始夜晚`
          : '请用「天黑请闭眼」开始第一夜',
      );
    }
    game.forceAdvance(byToken !== null);
    this.afterChange();
    return OK;
  }

  /** 玩家表示「我已看清我的身份牌」 */
  confirmRole(byToken: string): Reply {
    const game = this.game;
    if (!game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (!this.has(byToken)) return fail(ERR.NOT_IN_ROOM, '你不在这个房间里');
    const res = game.confirmRole(byToken);
    if (!res.ok) return fail(res.code ?? ERR.BAD_PHASE, res.message ?? '确认失败');
    this.afterChange();
    return OK;
  }

  /**
   * 房主按下「天黑请闭眼」—— 第一夜正式开始。
   *
   * 硬门槛本身由引擎判定（它知道谁在线），这里只负责房主权限。
   * 分成两处是有意的：权限是「谁在操作」，门槛是「规则允不允许」，
   * 混在一起以后很难查「为什么按钮点了没反应」。
   */
  beginNight(byToken: string): Reply {
    const game = this.game;
    if (!game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以开始第一夜');
    const res = game.beginNight();
    if (!res.ok) return fail(res.code ?? ERR.NOT_READY, res.message ?? '还不能开始第一夜');
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
        this.hub.database.abortMatch(
          this.matchId,
          this.game.day,
          this.game.phase,
          this.game.replaySnapshot(),
        );
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

    const errors = this.currentBoardErrors();
    const warnings = this.currentBoardWarnings();
    const notReady = this.notReadySeats();
    const isHost = token === this.hostToken;
    const userId = this.hub.get(token)?.userId ?? null;
    const wish = userId ? this.hub.database.roleWishState(userId) : { lossStreak: 0, role: null };
    const wishOptions = this.mode === 'STANDARD'
      ? (Object.keys(this.board.roles) as Role[]).filter((role) => (this.board.roles[role] ?? 0) > 0)
      : [];
    const draftEntry = this.hexDraft?.get(token) ?? null;

    return {
      roomId: this.id,
      hostId: this.hostToken,
      matchNumber: this.matchNumber,
      hostTemporary: this.hostTemporary,
      isHallOwner: this.ownerUserId !== null && this.hub.get(token)?.userId === this.ownerUserId,
      status: this.game || this.hexDraft ? 'PLAYING' : 'LOBBY',
      mode: this.mode,
      seats,
      playerCount: this.playerCount,
      canStart:
        !this.game &&
        !this.hexDraft &&
        isHost &&
        errors.length === 0 &&
        this.playerCount === this.seatCapacity &&
        notReady.length === 0,
      config: this.config,
      board: cloneBoard(this.board),
      boardSummary: this.mode === 'HEX_CHAOS'
        ? `海克斯大乱斗 · ${this.board.playerCount} 人 · 身份三选一`
        : boardSummary(this.board),
      boardErrors: errors,
      boardWarnings: warnings,
      roleWish: {
        lossStreak: wish.lossStreak,
        eligible: this.mode === 'STANDARD' && wish.lossStreak >= 2,
        selected: wish.role,
        options: wishOptions,
        paused: this.mode === 'HEX_CHAOS',
      },
      hexDraft: this.hexDraft && draftEntry
        ? {
            options: draftEntry.options.slice(),
            selected: draftEntry.selected,
            submitted: [...this.hexDraft.values()].filter((entry) => entry.selected !== null).length,
            total: this.hexDraft.size,
            deadline: this.hexDraftDeadline,
          }
        : null,
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
    // 必须放在 failover 之后：临时接管会改写 hostToken，
    // 引擎的 hostPlayerId 得跟上，否则临时房主看不到「天黑请闭眼」按钮。
    this.syncEngineInputs();
    this.broadcast();
    // 最后落一份快照：服务端随时可能被重启，落库的是「这一刻之后还能继续」的状态
    this.queuePersist();
  }

  /**
   * 把「谁在线」「谁是有效房主」这两个**服务端才知道**的事实同步给引擎。
   *
   * 引擎本身不碰网络（这是它可测试的根本），但身份确认的硬门槛需要
   * 「必须等谁」这个信息 —— 掉线的人点不了按钮，不该把全场锁死。
   * 所以做成和 holdAdvance 一样的服务端输入。
   */
  private syncEngineInputs(): void {
    const game = this.game;
    if (!game) return;

    const online = new Set<number>();
    this.activeSeats().forEach((token, index) => {
      if (!token) return;
      if (this.hub.get(token)?.socket != null) online.add(index + 1);
    });
    game.onlineSeats = online;

    // token 就是引擎里的 playerId（launchGame 用 token 当 id）；
    // 房主一定是坐在座位上的 —— setBoard 会拒绝「人数小于最大已占座位」的版型，
    // 所以房主不会落在 activeSeats() 之外。
    game.hostPlayerId = this.hostToken;
  }

  /** 通知引擎「在线情况变了」（连接建立/断开），然后刷新界面 */
  refreshEngineOnline(): void {
    this.syncEngineInputs();
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
        this.game.replaySnapshot(),
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
    this.clearHexDraftTimer();
    this.hexDraft = null;
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
      boardSummary: this.mode === 'HEX_CHAOS'
        ? `海克斯大乱斗 · ${this.board.playerCount} 人`
        : boardSummary(this.board),
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

      case 'hall.open': {
        const roomId = typeof msg.roomId === 'string' ? msg.roomId.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{6}$/.test(roomId)) {
          this.reply(session, fail(ERR.BAD_MESSAGE, '大厅号格式不正确'));
          return;
        }
        const active = this.rooms.get(roomId);
        if (active) {
          if (session.roomId !== roomId) this.leaveRoom(session);
          this.reply(session, active.addPlayer(session.token));
          return;
        }
        const ownerUserId = this.database.hallOwnerUserId(roomId);
        if (!ownerUserId) {
          this.reply(session, fail(ERR.ROOM_NOT_FOUND, `没有找到大厅 ${roomId}`));
          return;
        }
        if (ownerUserId !== session.userId) {
          this.reply(session, fail(ERR.ROOM_NOT_FOUND, '该大厅目前未开启，请等待厅主重新开启'));
          return;
        }
        this.leaveRoom(session);
        const reopened = new Room(this, roomId, session.token, session.userId);
        this.rooms.set(roomId, reopened);
        this.reply(session, reopened.addPlayer(session.token));
        return;
      }

      case 'room.join': {
        const roomId = typeof msg.roomId === 'string' ? msg.roomId.trim().toUpperCase() : '';
        let room = this.rooms.get(roomId);
        if (!room && this.database.hallOwnerUserId(roomId) === session.userId) {
          room = new Room(this, roomId, session.token, session.userId);
          this.rooms.set(roomId, room);
        }
        if (!room) {
          const historical = this.database.hallOwnerUserId(roomId) !== null;
          this.reply(
            session,
            fail(
              ERR.ROOM_NOT_FOUND,
              historical ? '该大厅目前未开启，请等待厅主重新开启' : `没有找到大厅 ${roomId}`,
            ),
          );
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

      case 'room.mode': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.setMode(session.token, msg.mode));
        return;
      }

      case 'room.roleWish': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const role = msg.role === null ? null : msg.role;
        if (role !== null && !(role in ROLE_NAME)) {
          return this.reply(session, fail(ERR.BAD_MESSAGE, '愿望角色不正确'));
        }
        this.reply(session, room.setRoleWish(session.token, role));
        return;
      }

      case 'room.hexChoose': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        if (!(msg.role in ROLE_NAME)) return this.reply(session, fail(ERR.BAD_MESSAGE, '身份牌不正确'));
        this.reply(session, room.submitHexChoice(session.token, msg.role));
        return;
      }

      case 'room.hexSkip': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.skipHexDraft(session.token));
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

      case 'game.knightDuel': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const target = Number(msg.target);
        if (!Number.isInteger(target)) {
          this.reply(session, fail(ERR.INVALID_TARGET, '决斗目标不正确'));
          return;
        }
        this.reply(session, room.knightDuel(session.token, target));
        return;
      }

      case 'game.confirmRole': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.confirmRole(session.token));
        return;
      }

      case 'game.beginNight': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        this.reply(session, room.beginNight(session.token));
        return;
      }

      case 'game.wolfTag': {
        const room = this.currentRoom(session);
        if (!room) return this.reply(session, fail(ERR.NOT_IN_ROOM, '你还没有加入房间'));
        const tag = msg.tag === null ? null : (msg.tag as WolfTag);
        const target = msg.target === undefined || msg.target === null ? null : Number(msg.target);
        if (target !== null && !Number.isInteger(target)) {
          return this.reply(session, fail(ERR.INVALID_TARGET, '狼踩狼的目标座位不正确'));
        }
        this.reply(session, room.setWolfTag(session.token, tag, target));
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
    // 房间已不存在，快照留着只会让下次启动复活一个空壳
    try {
      this.database.deleteRoomSnapshot(id);
    } catch (error) {
      console.error(`删除房间 ${id} 的快照失败：`, error);
    }
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /**
   * 同步落盘所有房间的快照（优雅退出时用）。
   *
   * 平时落库走 setImmediate（合并连发变更、不拖慢消息处理），但进程退出前
   * 事件循环可能不再跑 check 阶段 —— 这里同步补一次，把最后几步变更也存住。
   */
  flushSnapshots(): void {
    for (const room of this.rooms.values()) {
      try {
        this.database.saveRoomSnapshot(room.id, JSON.stringify(room.snapshot()));
      } catch (error) {
        console.error(`退出前保存房间 ${room.id} 的快照失败：`, error);
      }
    }
  }

  /**
   * 启动时从数据库恢复未结束的房间（「进行中房间持久化」的入口）。
   *
   * 恢复失败的快照直接删掉：留着不仅没用，还会每次启动都报一次同样的错。
   * 返回成功恢复的房间数，供启动日志打印。
   */
  restorePersistedRooms(): number {
    let restored = 0;
    let rows: ReturnType<GameDatabase['loadRoomSnapshots']> = [];
    try {
      rows = this.database.loadRoomSnapshots();
    } catch (error) {
      console.error('读取房间快照失败，跳过恢复：', error);
      return 0;
    }
    for (const row of rows) {
      let room: Room | null = null;
      try {
        room = Room.restore(this, row.roomId, row.payload);
      } catch (error) {
        console.error(`恢复房间 ${row.roomId} 的快照失败，已丢弃：`, error);
      }
      if (!room) {
        try {
          this.database.deleteRoomSnapshot(row.roomId);
        } catch {
          /* 删失败也不阻塞其余房间恢复 */
        }
        continue;
      }
      this.rooms.set(room.id, room);
      restored += 1;
    }
    return restored;
  }

  refreshHall(id: string): void {
    this.rooms.get(id)?.refreshHallData();
  }

  isHallActive(id: string): boolean {
    return this.rooms.has(id);
  }

  /** 清理长时间失联的会话与空房间 */
  sweep(maxIdleMs = 6 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.socket) continue;
      if (now - session.lastSeen < maxIdleMs) continue;
      // 对局中的座位不清理：等本人重连，游戏由定时器继续推进。
      // （清掉座位并不会把人从引擎里移除，只会让他永远连不回来 —— 对谁都没好处。）
      const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
      if (room?.playing) continue;
      this.leaveRoom(session);
      this.sessions.delete(token);
    }
    for (const [id, room] of this.rooms) {
      if (room.playerCount === 0 && !room.playing) {
        this.destroyRoom(id); // 顺带删掉快照，否则下次启动会复活一个空房间
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
