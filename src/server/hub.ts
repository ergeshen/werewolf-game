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
import {
  DEFAULT_ROOM_CONFIG,
  ERR,
  type ClientMsg,
  type NightAction,
  type RoomConfig,
  type RoomView,
  type SeatView,
  type ServerMsg,
} from '../shared/protocol.ts';
import { BOARD_12_NAME, BOARD_12_SUMMARY, PLAYER_COUNT } from '../shared/roles.ts';

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

export class Room {
  readonly id: string;
  readonly config: RoomConfig;
  readonly createdAt = Date.now();

  /**
   * 注意：这里不能用 TypeScript 的「参数属性」写法（constructor(private hub: Hub)）。
   * Node 的类型擦除（strip-only）不支持它，会在运行时直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
   */
  private readonly hub: Hub;
  /** index 0..11 对应座位 1..12，值为该座位玩家的 token */
  private seats: (string | null)[] = new Array<string | null>(PLAYER_COUNT).fill(null);
  private ready = new Set<string>();
  private hostToken: string;
  private game: Game | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(hub: Hub, id: string, hostToken: string) {
    this.hub = hub;
    this.id = id;
    this.hostToken = hostToken;
    this.config = { ...DEFAULT_ROOM_CONFIG, timeoutScale: DEFAULT_TIMEOUT_SCALE };
  }

  get playing(): boolean {
    return this.game !== null;
  }

  get playerCount(): number {
    return this.seats.filter((s) => s !== null).length;
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
    const free = this.seats.indexOf(null);
    if (free === -1) return fail(ERR.ROOM_FULL, `房间已满（${PLAYER_COUNT} 人）`);
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
    // 房主走了就移交给下一个在座玩家
    if (this.hostToken === token) {
      const next = this.seats.find((s): s is string => s !== null);
      if (next) this.hostToken = next;
    }
    // 游戏已经开始：玩家中途退出就交给引擎的定时器继续推进，不做替换
    this.afterChange();
  }

  takeSeat(token: string, seat: number): Reply {
    if (this.playing) return fail(ERR.ROOM_PLAYING, '游戏已经开始时不能换座位');
    if (!Number.isInteger(seat) || seat < 1 || seat > PLAYER_COUNT) {
      return fail(ERR.INVALID_TARGET, `座位号必须在 1-${PLAYER_COUNT} 之间`);
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
    if (ready) this.ready.add(token);
    else this.ready.delete(token);
    this.afterChange();
    return OK;
  }

  // ─────────────── 游戏流程 ───────────────

  startGame(byToken: string): Reply {
    if (this.game) return fail(ERR.BAD_PHASE, '游戏已经开始了');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以开始游戏');
    const occupied = this.seats.filter((s) => s !== null).length;
    if (occupied !== PLAYER_COUNT) {
      return fail(ERR.PLAYER_COUNT, `需要 ${PLAYER_COUNT} 名玩家才能开局，当前 ${occupied} 名`);
    }

    const seeds = this.seats.map((token, i) => {
      const session = this.hub.get(token!);
      return {
        id: token!,
        seat: i + 1,
        nickname: session?.nickname ?? `玩家${i + 1}`,
        avatar: session?.avatar ?? '',
        isHost: token === this.hostToken,
      };
    });

    this.game = new Game(this.id, seeds, { config: this.config });
    const res = this.game.start();
    if (!res.ok) {
      this.game = null;
      return fail(res.code ?? ERR.BAD_PHASE, res.message ?? '开局失败');
    }
    this.afterChange();
    return OK;
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

  submitHunterShoot(token: string, target: number | null): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    const res = this.game.submitHunterShoot(token, target);
    if (res.ok) this.afterChange();
    return res.ok ? OK : fail(res.code ?? ERR.BAD_PHASE, res.message ?? '开枪失败');
  }

  /** 手动跳过当前阶段（房主特权，也给定时器用） */
  forceAdvance(byToken: string | null): Reply {
    const game = this.game;
    if (!game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (byToken !== null && byToken !== this.hostToken) {
      return fail(ERR.NOT_HOST, '只有房主可以跳过当前阶段');
    }
    game.forceAdvance();
    this.afterChange();
    return OK;
  }

  revealAll(byToken: string): Reply {
    if (!this.game) return fail(ERR.BAD_PHASE, '游戏还没有开始');
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以公开全场身份');
    this.game.requestRevealAll();
    this.afterChange();
    return OK;
  }

  restart(byToken: string): Reply {
    if (byToken !== this.hostToken) return fail(ERR.NOT_HOST, '只有房主可以重新开局');
    if (this.game && this.game.phase !== 'GAME_OVER') {
      return fail(ERR.BAD_PHASE, '当前对局还没有结束');
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.game = null;
    this.ready.clear();
    this.afterChange();
    return OK;
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
      seats = this.seats.map((seatToken, i) => {
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

    return {
      roomId: this.id,
      hostId: this.hostToken,
      status: this.game ? 'PLAYING' : 'LOBBY',
      seats,
      playerCount: this.playerCount,
      canStart: !this.game && token === this.hostToken && this.playerCount === PLAYER_COUNT,
      config: this.config,
      shareHint: `把链接发给朋友，或让他们输入房间号 ${this.id}`,
    };
  }

  broadcast(): void {
    for (const token of this.seats) {
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
   * 所有状态变更的唯一出口：结算 → 重排定时器 → 广播。
   * 顺序很重要 —— deadline 必须在广播前算好，客户端才能拿到准确倒计时。
   */
  afterChange(): void {
    const game = this.game;
    if (game) game.settle();
    this.reschedule();
    this.broadcast();
  }

  private reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const game = this.game;
    if (!game) return;
    if (game.phase === 'GAME_OVER' || game.phase === 'WAITING') {
      game.deadline = null;
      return;
    }
    if (!this.config.autoTimeout) {
      game.deadline = null;
      return;
    }
    const base = PHASE_TIMEOUT_MS[game.phase];
    if (!Number.isFinite(base)) {
      game.deadline = null;
      return;
    }
    const ms = Math.max(150, Math.round(base * this.config.timeoutScale));
    game.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      const g = this.game;
      if (!g || g.phase === 'GAME_OVER') return;
      g.forceAdvance();
      this.afterChange();
    }, ms);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.game = null;
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
}

// ────────────────────────────────────────────────────────────────

export class Hub {
  private sessions = new Map<string, Session>();
  private rooms = new Map<string, Room>();

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
      nickname: '',
      avatar: '',
      roomId: null,
      socket: null,
      lastSeen: Date.now(),
    };
    this.sessions.set(fresh.token, fresh);
    return fresh;
  }

  attach(token: string, socket: WebSocket): Session {
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
    if (room) room.broadcast(); // 让其他人看到「离线」状态
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

      case 'room.create': {
        this.leaveRoom(session);
        session.nickname = sanitizeNickname(msg.nickname, '房主');
        if (typeof msg.avatar === 'string') session.avatar = msg.avatar.slice(0, 200);
        let id = makeRoomId();
        let guard = 0;
        while (this.rooms.has(id) && guard++ < 50) id = makeRoomId();
        const room = new Room(this, id, session.token);
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
        session.nickname = sanitizeNickname(msg.nickname, `玩家${room.playerCount + 1}`);
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
}

export { BOARD_12_NAME, BOARD_12_SUMMARY };
