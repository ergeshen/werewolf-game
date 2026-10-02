/**
 * 客户端状态与动作。
 *
 * 界面只做两件事：把服务端下发的个性化视图渲染出来、把用户的意图发回去。
 * 所有规则判断（能不能行动、能选谁、结果是什么）都在服务端，客户端不重复实现 ——
 * 这样小程序端复用时也不会出现「两端规则不一致」。
 */

import { computed, reactive, watch } from '../vendor/vue.esm-browser.prod.js';

import type { GameMode, GameView, MatchReplay, RoomView, SeatView, WolfTag } from '../../src/shared/protocol.ts';
import type { BoardConfig, Role } from '../../src/shared/roles.ts';
import { copyToClipboard, Net, type ConnStatus } from './net.ts';
import {
  announce,
  isVoiceSupported,
  loadVoicePack,
  playSound,
  resetVoiceCache,
  selectVoicePack,
  stopVoice,
  unlockVoice,
  voicePackStatus,
} from './voice.ts';

const NICK_KEY = 'werewolf.nickname';
const VOICE_KEY = 'werewolf.voice';
const AUTH_KEY = 'werewolf.auth';
/** '1' 开 / '0' 关 / '' 还没选过 */
const VOICE_STORED = readStored(VOICE_KEY);

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export interface ToastState {
  id: number;
  text: string;
  level: 'info' | 'warn' | 'error';
}

export interface AccountUserView {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt: number;
}

export interface LobbyRoomView {
  roomId: string;
  hostName: string;
  playerCount: number;
  capacity: number;
  boardSummary: string;
  createdAt: number;
}

export interface OwnedHallView {
  roomId: string;
  createdAt: number;
  updatedAt: number;
  matchCount: number;
  completedCount: number;
  relation: 'OWNER' | 'PARTICIPANT';
  ownerName: string;
  active: boolean;
}

export interface MatchHistoryView {
  id: string;
  roomId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: 'WOLF' | 'GOOD' | 'DRAW' | null;
  day: number | null;
  boardSummary: string;
  seat: number;
  role: Role;
  roleName: string;
  camp: 'WOLF' | 'GOOD';
  won: boolean | null;
  status: 'COMPLETED' | 'ABORTED';
  score: number;
  matchNumber: number;
  endedPhase: string | null;
  mode: GameMode;
}

export interface HallMatchPlayerView {
  userId: string | null;
  nickname: string;
  seat: number;
  role: Role;
  roleName: string;
  camp: 'WOLF' | 'GOOD';
  won: boolean | null;
  /** 只有厅主能收到该场积分。 */
  score?: number;
  fakeSeer: boolean;
}

export interface HallMatchView {
  id: string;
  displayNumber: number;
  status: 'COMPLETED' | 'ABORTED';
  startedAt: number;
  endedAt: number;
  outcome: 'WOLF' | 'GOOD' | 'DRAW' | null;
  day: number | null;
  endedPhase: string | null;
  boardSummary: string;
  mode: GameMode;
  players: HallMatchPlayerView[];
  replay: MatchReplay | null;
}

export interface HallPlayerStatsView {
  userId: string | null;
  nickname: string;
  wins: number;
  losses: number;
  wolfCount: number;
  godCount: number;
  villagerCount: number;
  score?: number;
  rank?: number;
  goodScore?: number;
  wolfScore?: number;
  hexWins: number;
  hexLosses: number;
  hexScore?: number;
  exileCorrect: number;
  exileVotes: number;
  exileAccuracy: number;
  exileEligible: boolean;
}

export interface HallDashboardView {
  roomId: string;
  isOwner: boolean;
  scoresRevealed: boolean;
  matches: HallMatchView[];
  players: HallPlayerStatsView[];
}

export const state = reactive({
  authReady: false,
  authToken: readStored(AUTH_KEY),
  user: null as AccountUserView | null,
  authUsername: '',
  authPassword: '',
  currentPassword: '1',
  newPassword: '',
  confirmPassword: '',
  authBusy: false,
  lobbyRooms: [] as LobbyRoomView[],
  matchHistory: [] as MatchHistoryView[],
  ownedHalls: [] as OwnedHallView[],
  hallDashboard: null as HallDashboardView | null,
  /** 首页是否正在查看某个历史大厅。 */
  hallHistoryOpen: false,
  /** 从首页点击的具体场次；用于让回顾面板准确展开该场，而不是只打开大厅。 */
  hallSelectedMatchId: null as string | null,
  hallLoading: false,
  lobbyLoading: false,
  conn: 'connecting' as ConnStatus,
  nickname: readStored(NICK_KEY),
  roomCode: '',
  room: null as RoomView | null,
  game: null as GameView | null,
  /** 当前选中的座位（用于二次确认，避免误触把关键技能放空） */
  selected: null as number | null,
  /** 舞者一次要选择三个座位。 */
  selectedMany: [] as number[],
  /**
   * 「唯邻是从」首夜狼队选的傀儡（本地选择，还没提交）。
   * 提交时和刀口一起走 `{kind:'wolf', target, puppet}`。
   */
  selectedPuppet: null as number | null,
  toast: null as ToastState | null,
  /** 每 250ms 跳一次，用于渲染倒计时 */
  now: Date.now(),
  /** 语音播报：房主默认开，其他人默认关（12 台手机一起念会很吵） */
  voiceEnabled: VOICE_STORED === '1',
  voiceDecided: VOICE_STORED !== '',
  voiceSupported: isVoiceSupported(),
  /**
   * 有没有装录音语音包（异步探测，就绪后置 true）。
   * 「能不能播报」= TTS 支持 **或** 语音包可用 —— 有些设备没有中文 TTS，
   * 但语音包是纯音频文件，照样能播。
   */
  voicePackReady: false,
  /**
   * 语音包状态的「版本号」。
   *
   * 为什么需要它：语音包的清单和当前选择存在 `voice.ts` 的**模块级变量**里
   * （不是响应式数据），Vue 追踪不到 —— 直接写
   * `computed(() => voicePackStatus())` 会永远算出第一次那个空结果。
   * 所以在改动语音包状态的地方把这个数字加一，界面的 computed 只要读它一下，
   * 就能在换包/加载完成后重新计算。
   */
  voiceRevision: 0,
  /**
   * 服务端有没有下发语音片段序列（`null` = 还没进过对局，不知道）。
   * 语音包就绪但这里是 `false`，说明**服务端跑的还是旧代码，需要重启**。
   */
  voiceCueSupport: null as boolean | null,
  /**
   * 版型编辑草稿。
   *
   * 为什么需要它：版型是「点一下改一个字段」，如果每次都从 state.room.board
   * 重新算，那么快速连点两下「+」时第二下读到的还是旧值，等于只加了一次；
   * 套用预设（要连改 9 个字段）更是会被后发的消息整个覆盖掉，等于白点。
   * 所以编辑期间以本地草稿为准，等服务端确认后再交回去。
   */
  boardDraft: null as BoardConfig | null,
  /** 确认弹窗（不用 window.confirm —— 微信内置浏览器对它支持不稳定） */
  confirm: null as ConfirmState | null,
});

export interface ConfirmState {
  id: number;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
}

let confirmSeq = 0;
let confirmCallback: ((ok: boolean) => void) | null = null;

/**
 * 弹一个确认框。
 *
 * 刻意不用 window.confirm：微信内置浏览器对原生弹窗的支持时好时坏，
 * 而且原生弹窗在这个深色界面里非常突兀。
 */
export function askConfirm(
  options: { title: string; message: string; confirmText: string; cancelText?: string; danger?: boolean },
  onDone: (ok: boolean) => void,
): void {
  confirmSeq += 1;
  confirmCallback = onDone;
  state.confirm = {
    id: confirmSeq,
    title: options.title,
    message: options.message,
    confirmText: options.confirmText,
    cancelText: options.cancelText ?? '取消',
    danger: options.danger === true,
  };
}

export function resolveConfirm(ok: boolean): void {
  const callback = confirmCallback;
  confirmCallback = null;
  state.confirm = null;
  callback?.(ok);
}

/** 上一次发给服务端的版型（JSON 串），用于判断服务端是否已确认 */
let lastSentBoard: string | null = null;

/** 界面上应该显示的版型：编辑期间用草稿，否则用服务端版本 */
export const boardView = computed<BoardConfig | null>(
  () => state.boardDraft ?? state.room?.board ?? null,
);

let toastSeq = 0;
let toastTimer: number | null = null;
let hallRequestSerial = 0;

export function showToast(text: string, level: ToastState['level'] = 'info'): void {
  toastSeq += 1;
  state.toast = { id: toastSeq, text, level };
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    toastTimer = null;
  }, 3_200);
}

export const net = new Net({
  onRoom(room: RoomView | null) {
    state.room = room;
    if (!room) {
      state.boardDraft = null;
      lastSentBoard = null;
      state.hallDashboard = null;
      if (state.user && !state.user.mustChangePassword) void refreshLobby();
      return;
    }
    // 服务端回显的版型和「我们最后发出的」一致 → 说明已被接受，交回服务端作为唯一事实来源
    if (lastSentBoard !== null && JSON.stringify(room.board) === lastSentBoard) {
      state.boardDraft = null;
      lastSentBoard = null;
    }
  },
  onGame(game: GameView | null) {
    // 服务端视图是唯一事实来源，收到就清掉本地的乐观标记
    clearPending();
    state.game = game;
    /**
     * 服务端到底有没有下发语音片段序列？
     *
     * 这是个**部署自检**：`voiceCues` 是引擎算出来的，而引擎代码是
     * 进程启动时载入内存的。所以「改了 speech 相关代码但没重启服务端」
     * 会出现一种很难听出来的故障 —— 语音包装好了，却一直听到系统机械音，
     * 因为服务端压根没下发片段序列，前端只能回退 TTS。
     * 记下这个事实，界面就能直接告诉玩家「去重启服务端」，而不是让人瞎猜。
     */
    if (game) {
      state.voiceCueSupport = Array.isArray(game.voiceCues) && game.voiceCues.length > 0;
    }
    if (game?.phase === 'GAME_OVER') {
      void refreshMatchHistory();
      void refreshOwnedHalls();
    }
    if (!game && state.room && !state.room.hexDraft) void refreshHallDashboard(state.room.roomId);
    // 阶段变了就清掉上一阶段的选择，避免「我明明选的是上一步的人」
    if (!game || !game.myTurn) {
      state.selected = null;
      state.selectedMany = [];
    }
  },
  onToast(text, level) {
    // 服务端拒绝操作时不会广播新的对局视图（状态没变），
    // 所以必须在这里清掉乐观标记 —— 否则按钮会永久停在
    // 「已提交，等待其他玩家…」，玩家再也没法重试。
    if (level === 'error') {
      clearPending();
      // 版型修改被拒绝（例如人数改得比已占座位还小）→ 丢掉草稿，回到服务端版本
      state.boardDraft = null;
      lastSentBoard = null;
    }
    showToast(text, level);
  },
  onStatus(status: ConnStatus) {
    state.conn = status;
  },
});

export type Screen = 'loading' | 'auth' | 'changePassword' | 'home' | 'lobby' | 'game' | 'result';

export const screen = computed<Screen>(() => {
  if (!state.authReady) return 'loading';
  if (!state.user) return 'auth';
  if (state.user.mustChangePassword) return 'changePassword';
  if (state.game) {
    return state.game.phase === 'GAME_OVER' ? 'result' : 'game';
  }
  return state.room ? 'lobby' : 'home';
});

/**
 * 已提交但服务端还没回视图的阶段键（day:phase）。
 * 玩家点完确认后立刻据此禁用按钮 —— 否则从点击到收到服务端视图之间有一小段窗口，
 * 连点两下就会收到「你已经投过票了」这种无意义的报错。
 */
const pending = reactive({ keys: new Set<string>() });

function phaseKey(): string {
  const g = state.game;
  return g ? `${g.day}:${g.phase}` : '';
}

function markPending(): void {
  const key = phaseKey();
  if (key) pending.keys.add(key);
}

function clearPending(): void {
  pending.keys.clear();
}

/** 我是否已经提交了本阶段的行动 */
export const hasActed = computed<boolean>(() => {
  const game = state.game;
  if (!game) return false;
  // 假面是同一阶段内的两步行动：查验回显不代表整个阶段已经完成。
  if (game.phase === 'NIGHT_MASK' && game.mySubmitted && typeof game.mySubmitted === 'object' && game.mySubmitted.kind === 'maskInspect') {
    return false;
  }
  if (game.mySubmitted !== undefined) return true;
  return pending.keys.has(`${game.day}:${game.phase}`);
});

export const canPick = computed<boolean>(() => {
  const game = state.game;
  if (!game) return false;
  return game.myTurn && !hasActed.value && game.myOptions.length > 0;
});

export const remainingMs = computed<number | null>(() => {
  const deadline = state.game?.deadline;
  if (deadline === null || deadline === undefined) return null;
  return Math.max(0, deadline - state.now);
});

export const isHost = computed<boolean>(() => {
  const room = state.room;
  if (!room) return false;
  return room.seats.some((s) => s.isMe && s.isHost);
});

export const mySeat = computed<SeatView | null>(() => {
  return state.room?.seats.find((s) => s.isMe) ?? null;
});

/**
 * 能不能改语音播报。
 *
 * 需求：天黑期间谁都不能改，防止「夜里临时开语音」这类场外因素。
 * 大厅（就绪界面）和白天可以改。
 */
export const canChangeVoice = computed<boolean>(() => {
  const phase = state.game?.phase;
  if (!phase || phase === 'GAME_OVER') return true; // 大厅里可以改
  return !phase.startsWith('NIGHT');
});

// ─────────────────── 账号 / 大厅 / 场次 ───────────────────

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (state.authToken) headers.set('authorization', `Bearer ${state.authToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = (await response.json()) as { message?: string } & T;
  if (!response.ok) throw new Error(body.message ?? '请求失败');
  return body;
}

function acceptAuth(token: string, user: AccountUserView): void {
  state.authToken = token;
  state.user = user;
  state.nickname = user.username;
  store(AUTH_KEY, token);
  store(NICK_KEY, user.username);
  state.authPassword = '';
  if (!user.mustChangePassword) {
    net.setAuthToken(token);
    net.connect();
    void refreshLobby();
    void refreshMatchHistory();
    void refreshOwnedHalls();
  }
}

export async function loginAccount(): Promise<void> {
  const username = state.authUsername.trim();
  if (!username || !state.authPassword) {
    showToast('请填写用户名和密码', 'warn');
    return;
  }
  state.authBusy = true;
  try {
    const result = await api<{ token: string; user: AccountUserView }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password: state.authPassword }),
    });
    acceptAuth(result.token, result.user);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '登录失败', 'error');
  } finally {
    state.authBusy = false;
  }
}

export async function registerAccount(): Promise<void> {
  const username = state.authUsername.trim();
  if (username.length < 2) {
    showToast('用户名至少需要 2 个字符', 'warn');
    return;
  }
  state.authBusy = true;
  try {
    const result = await api<{ token: string; user: AccountUserView }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
    acceptAuth(result.token, result.user);
    state.currentPassword = '1';
    showToast('账号已创建，请先修改初始密码', 'info');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '注册失败', 'error');
  } finally {
    state.authBusy = false;
  }
}

export async function changeInitialPassword(): Promise<void> {
  if (state.newPassword !== state.confirmPassword) {
    showToast('两次输入的新密码不一致', 'warn');
    return;
  }
  state.authBusy = true;
  try {
    const result = await api<{ user: AccountUserView }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: state.currentPassword,
        newPassword: state.newPassword,
      }),
    });
    state.user = result.user;
    state.currentPassword = '';
    state.newPassword = '';
    state.confirmPassword = '';
    net.setAuthToken(state.authToken);
    net.connect();
    await Promise.all([refreshLobby(), refreshMatchHistory(), refreshOwnedHalls()]);
    showToast('密码修改成功', 'info');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '修改密码失败', 'error');
  } finally {
    state.authBusy = false;
  }
}

export async function logoutAccount(): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // 即使服务器暂时不可用，也要允许清掉本机登录状态。
  }
  net.disconnect();
  state.authToken = '';
  state.user = null;
  state.room = null;
  state.game = null;
  state.lobbyRooms = [];
  state.matchHistory = [];
  state.ownedHalls = [];
  state.hallDashboard = null;
  state.hallHistoryOpen = false;
  state.hallSelectedMatchId = null;
  state.authPassword = '';
  state.authReady = true;
  removeStored(AUTH_KEY);
}

export async function refreshLobby(): Promise<void> {
  if (!state.user || state.user.mustChangePassword) return;
  state.lobbyLoading = true;
  try {
    const result = await api<{ rooms: LobbyRoomView[] }>('/api/lobby');
    state.lobbyRooms = result.rooms;
  } catch (error) {
    showToast(error instanceof Error ? error.message : '大厅刷新失败', 'warn');
  } finally {
    state.lobbyLoading = false;
  }
}

export async function refreshMatchHistory(): Promise<void> {
  if (!state.user || state.user.mustChangePassword) return;
  try {
    const result = await api<{ matches: MatchHistoryView[] }>('/api/matches');
    state.matchHistory = result.matches;
  } catch {
    // 战绩是次要信息，不让短暂失败打断对局。
  }
}

export async function refreshOwnedHalls(): Promise<void> {
  if (!state.user || state.user.mustChangePassword) return;
  try {
    const result = await api<{ halls: OwnedHallView[] }>('/api/hall-records');
    state.ownedHalls = result.halls;
  } catch {
    // 大厅列表加载失败不应阻断创建或加入实时房间。
  }
}

export async function hideHallRecord(roomId: string): Promise<void> {
  try {
    await api(`/api/hall-records/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
    state.ownedHalls = state.ownedHalls.filter((hall) => hall.roomId !== roomId);
    if (state.hallDashboard?.roomId === roomId) closeHallHistory();
    showToast('已从你的大厅记录中移除，不影响大厅原始数据', 'info');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '移除大厅记录失败', 'error');
  }
}

export async function refreshHallDashboard(roomId = state.room?.roomId ?? ''): Promise<void> {
  if (!roomId || !state.user || state.user.mustChangePassword) return;
  const requestId = ++hallRequestSerial;
  state.hallLoading = true;
  try {
    const result = await api<{ hall: HallDashboardView }>(`/api/halls/${encodeURIComponent(roomId)}`);
    if (requestId !== hallRequestSerial) return;
    state.hallDashboard = result.hall;
    if (
      state.hallSelectedMatchId !== null &&
      !result.hall.matches.some((match) => match.id === state.hallSelectedMatchId)
    ) {
      state.hallSelectedMatchId = null;
    }
  } catch (error) {
    if (requestId !== hallRequestSerial) return;
    showToast(error instanceof Error ? error.message : '大厅战绩刷新失败', 'warn');
  } finally {
    if (requestId === hallRequestSerial) state.hallLoading = false;
  }
}

export async function openHallHistory(roomId: string, matchId: string | null = null): Promise<void> {
  state.hallHistoryOpen = true;
  state.hallSelectedMatchId = matchId;
  if (state.hallDashboard?.roomId !== roomId) state.hallDashboard = null;
  await refreshHallDashboard(roomId);
  window.requestAnimationFrame(() => {
    const target = matchId
      ? document.getElementById(`hall-match-${matchId}`)
      : document.getElementById('hall-history');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

export function closeHallHistory(): void {
  state.hallHistoryOpen = false;
  state.hallSelectedMatchId = null;
  if (!state.room) state.hallDashboard = null;
}

export async function deleteHallMatch(matchId: string, roomId = state.hallDashboard?.roomId ?? ''): Promise<void> {
  if (!roomId || !state.hallDashboard?.isOwner) return;
  try {
    await api(`/api/halls/${encodeURIComponent(roomId)}/matches/${encodeURIComponent(matchId)}`, {
      method: 'DELETE',
    });
    await Promise.all([refreshHallDashboard(roomId), refreshMatchHistory(), refreshOwnedHalls()]);
    showToast('场次已删除，统计和积分已重新计算', 'info');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除场次失败', 'error');
  }
}

export async function revealHallScores(roomId = state.hallDashboard?.roomId ?? ''): Promise<void> {
  if (!roomId || !state.hallDashboard?.isOwner) return;
  try {
    await api(`/api/halls/${encodeURIComponent(roomId)}/reveal-scores`, { method: 'POST' });
    await refreshHallDashboard(roomId);
    showToast('最终积分已经向所有人公开', 'info');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '公开积分失败', 'error');
  }
}

export function joinPublicRoom(roomId: string): void {
  state.roomCode = roomId;
  joinRoom();
}

// ─────────────────── 语音播报 ───────────────────

/**
 * 房主默认为「开」，其他玩家默认为「关」。
 * 只在玩家自己没选过的时候套用默认值，选过就尊重玩家的选择。
 */
watch(
  () => [state.room?.roomId, state.game !== null] as const,
  () => {
    if (state.voiceDecided) return;
    const room = state.room;
    if (!room || room.status !== 'LOBBY') return;
    if (!room.seats.some((s) => s.isMe && s.isHost)) return;
    state.voiceEnabled = true;
    state.voiceDecided = true;
    store(VOICE_KEY, '1');
  },
  { immediate: true },
);

/**
 * 「牌局还在、房间视图却丢了」→ 自动重新同步。
 *
 * 座位盘的数据来自房间视图（`state.room.seats`），所以房间视图一丢，
 * 整片座位就会变空 —— 这就是玩家看到的「所有人都不见了」。
 * 服务端只在一种情况下会主动把房间置空：它不认识你这个连接属于哪个房间
 * （典型场景是**服务端重启过**，会话是内存态、重启即丢；或你的连接被同 token 的
 * 新连接顶掉）。这时重连一次就能拿回状态；拿不回来说明房间真的没了，
 * 那就该干净地回大厅，而不是留一个 12 个空位的怪画面。
 */
let roomResyncTried = false;
watch(
  () => (state.room === null ? 'no-room' : 'room') + '|' + (state.game === null ? 'no-game' : 'game'),
  () => {
    const missing = state.room === null && state.game !== null;
    if (!missing) {
      roomResyncTried = false;
      return;
    }
    if (roomResyncTried) return;
    roomResyncTried = true;
    showToast('房间信息丢失，正在重新同步…', 'warn');
    net.reconnectNow();
  },
);

/**
 * 启动时就把语音包清单拉下来。
 *
 * 为什么不等玩家点语音开关：清单就绪之后，开关那一下点击里就能
 * **同步**播一段真音频来完成 iOS 解锁（playClipNow 是同步的），
 * 比让 TTS 去念一句话可靠得多。
 */
void loadVoicePack().then((ok) => {
  state.voicePackReady = ok;
  state.voiceRevision++;
  if (ok) {
    const info = voicePackStatus();
    console.info(
      `[语音] 录音语音包已就绪：当前「${info.label}」，共 ${info.packs.length} 套可选（${info.count} 个片段）`,
    );
  }
});

/**
 * 换一套法官音色（只影响本机播放）。
 *
 * 包一层是为了在换完之后把 `voiceRevision` 加一 ——
 * 语音包状态不在响应式系统里，不主动通知的话界面不会更新。
 */
export async function chooseVoicePack(packId: string): Promise<boolean> {
  const ok = await selectVoicePack(packId);
  state.voiceRevision++;
  return ok;
}

/**
 * 阶段变化时朗读法官台词。
 *
 * 去重键包含「天 + 阶段」，因为「女巫请睁眼」这类台词每晚都会合法地重复出现。
 * 台词由服务端生成，且**只包含公开信息** —— 这一点在引擎里有测试兜底。
 */
watch(
  () => {
    const g = state.game;
    if (!g) return '';
    return `${g.day}|${g.phase}|${g.voiceLine}`;
  },
  (key) => {
    if (!key || !state.voiceEnabled) return;
    const g = state.game;
    if (!g?.voiceLine) return;
    // 有录音语音包就按片段序列播（音色统一、带停顿）；
    // 没有就自动退回 TTS 念整句 —— 见 voice.ts 的 playVoiceCues
    announce(key, g.voiceLine, g.voiceCues ?? []);
  },
);

/** 新警长当选或警徽移交成功时，播放仪式音效。 */
watch(
  () => state.game?.sheriffSeat ?? null,
  (seat, previous) => {
    if (seat === null || seat === previous || !state.voiceEnabled) return;
    playSound('goldenLegend');
  },
);

let badgeLossAnnounced = false;
watch(
  () => {
    const g = state.game;
    return g ? `${g.phase}|${g.sheriffSeat ?? 'none'}|${g.sheriffElectionFinished}` : '';
  },
  () => {
    const g = state.game;
    if (!g) {
      badgeLossAnnounced = false;
      return;
    }
    if (g.sheriffSeat !== null) {
      badgeLossAnnounced = false;
      return;
    }
    const settledPhase = g.phase === 'DAY_SPEECH' || g.phase === 'NIGHT_START';
    if (!g.sheriffElectionFinished || !settledPhase || badgeLossAnnounced) return;
    badgeLossAnnounced = true;
    if (state.voiceEnabled) {
      announce(`badge-lost|${state.room?.roomId ?? ''}|${g.day}`, '本局没有警徽。', [
        { clip: 'sheriff.none' },
      ]);
    }
  },
);

/**
 * 回合倒数时把数字念出来（5、4、3、2、1）。
 *
 * 服务端每秒广播一次新的倒数值，这里按「天 + 阶段 + 数字」去重，
 * 所以重连或重渲染都不会把同一个数字念两遍。
 */
watch(
  () => {
    const g = state.game;
    if (!g || g.countdown === null) return '';
    return `${g.day}|${g.phase}|cd|${g.countdown}`;
  },
  (key) => {
    if (!key || !state.voiceEnabled) return;
    const value = state.game?.countdown;
    if (value === null || value === undefined) return;
    // 倒数也用同一个语音包的数字片段 —— 音色和全场的播报一致
    announce(key, String(value), [{ num: value }]);
  },
);

// ─────────────────── 大厅动作 ───────────────────

export function createRoom(): void {
  const nickname = state.user?.username ?? '';
  if (!nickname) {
    showToast('请先登录', 'warn');
    return;
  }
  store(NICK_KEY, nickname);
  net.send({ t: 'room.create', nickname });
}

export function enterHall(roomId: string): void {
  net.send({ t: 'hall.open', roomId });
}

export function joinRoom(): void {
  const nickname = state.user?.username ?? '';
  if (!nickname) {
    showToast('请先登录', 'warn');
    return;
  }
  const roomId = state.roomCode.trim().toUpperCase();
  if (roomId.length !== 6) {
    showToast('房间号是 6 位字符', 'warn');
    return;
  }
  store(NICK_KEY, nickname);
  net.send({ t: 'room.join', roomId, nickname });
}

export function leaveRoom(): void {
  net.send({ t: 'room.leave' });
  state.room = null;
  state.game = null;
  state.hallDashboard = null;
  state.selected = null;
  resetVoiceCache();
}

export function toggleReady(): void {
  const me = mySeat.value;
  if (!me) return;
  net.send({ t: 'room.ready', ready: !me.ready });
}

export function startGame(): void {
  net.send({ t: 'game.start' });
}

export function setGameMode(mode: GameMode): void {
  net.send({ t: 'room.mode', mode });
}

export function setRoleWish(role: Role | null): void {
  net.send({ t: 'room.roleWish', role });
}

export function chooseHexRole(role: Role): void {
  net.send({ t: 'room.hexChoose', role });
}

export function skipHexDraft(): void {
  net.send({ t: 'room.hexSkip' });
}

/**
 * 房主修改版型。
 *
 * 编辑期间本地草稿是事实来源（见 state.boardDraft 的说明），
 * 每次调用都会把**完整的**版型发给服务端 —— 不做「只发改动字段」的增量更新，
 * 否则并发修改会互相覆盖。
 */
export function setBoard(board: BoardConfig): void {
  /**
   * 必须整体展开 `...board`，不能只挑 playerCount + roles：
   * 版型级开关（「唯邻是从」的 `puppet`）会被丢掉，
   * 于是选了那个板子却玩成普通局，而且界面上完全看不出来。
   */
  const normalized: BoardConfig = { ...board, roles: { ...board.roles } };
  state.boardDraft = normalized;
  lastSentBoard = JSON.stringify(normalized);
  net.send({ t: 'room.board', board: normalized });
}

/** 一次套用整套预设（预设要改 8-9 个字段，必须一次发完） */
export function applyPresetBoard(board: BoardConfig): void {
  setBoard(board);
}

/** 只改人数，角色数量保持不变（总数不对时服务端会提示还差几个） */
export function setPlayerCount(playerCount: number): void {
  const base = boardView.value;
  if (!base) return;
  setBoard({ ...base, playerCount, roles: base.roles });
}

/** 改某个角色的数量 */
export function setRoleCount(role: Role, count: number): void {
  const base = boardView.value;
  if (!base) return;
  setBoard({ ...base, roles: { ...base.roles, [role]: Math.max(0, count) } });
}

/** 狼人自爆：白狼王带一人，普通狼空爆（服务端按角色区分） */
export function selfDestruct(): void {
  const game = state.game;
  if (!game || !game.me?.canSelfDestruct) return;
  net.send({ t: 'game.selfDestruct' });
  markPending();
  state.selected = null;
}

export function sheriffSignup(candidate: boolean): void {
  if (state.game?.phase !== 'SHERIFF_SIGNUP' || !state.game.myTurn || hasActed.value) return;
  net.send({ t: 'game.sheriffSignup', candidate });
  markPending();
}

export function sheriffWithdraw(): void {
  if (!state.game || !['SHERIFF_CAMPAIGN', 'SHERIFF_PK'].includes(state.game.phase)) return;
  net.send({ t: 'game.sheriffWithdraw' });
}

export function setSpeechDirection(direction: 'FORWARD' | 'REVERSE'): void {
  if (state.game?.phase !== 'DAY_SPEECH') return;
  net.send({ t: 'game.speechDirection', direction });
}

/** 白狼王指定带走谁（null = 不带人） */
export function submitBoomTarget(target: number | null): void {
  const game = state.game;
  if (!game || game.phase !== 'WOLF_KING_BOOM') return;
  net.send({ t: 'game.boomTarget', target });
  markPending();
  state.selected = null;
}

/**
 * 给自己挂/取消狼队战术标签。
 *
 * 「狼踩狼」是配对标签，还必须带上「踩谁」—— 只有双方互指，这一对才算成立。
 * 没传 target 时服务端会拒绝，并把可选的狼队友列回来。
 */
export function setWolfTag(tag: WolfTag | null, target: number | null = null): void {
  const game = state.game;
  if (!game || !game.me?.canEditWolfTag) return;
  net.send({ t: 'game.wolfTag', tag, target });
}

/**
 * 「我已看清我的身份牌」。
 *
 * 客户端只能表达「我点过了」，服务端也无法验证人是不是真看了牌 ——
 * 这是刻意的：这个阶段的价值是**给时间**，不是**做审查**。
 */
export function confirmRole(): void {
  const view = state.game?.roleReveal;
  if (!view || view.iConfirmed) return;
  net.send({ t: 'game.confirmRole' });
}

/**
 * 房主按下「天黑请闭眼」。
 *
 * 硬门槛由服务端判定，客户端只是不把不可能成功的按钮显示成可点。
 * 万一状态过期点了下去，服务端会回一条「还有 N 人没确认身份：…号」，如实弹出来即可。
 */
export function beginNight(): void {
  const view = state.game?.roleReveal;
  if (!view || !view.iAmHost || !view.canBeginNight) return;
  net.send({ t: 'game.beginNight' });
}

/** 进入/退出上帝视角（只影响自己；调用前应当先 askConfirm） */
export function setGodView(active: boolean): void {
  net.send({ t: 'game.godView', active });
}

/** 房主：保存本场（未分胜负则记提前结束）并返回当前大厅 */
export function closeMatch(): void {
  net.send({ t: 'room.closeMatch' });
}

/**
 * 房主点「离开」时的询问。
 * 需求：退出前要问要不要重开一局 —— 免得手滑把一屋子人解散了。
 */
export function leaveWithConfirm(): void {
  const inMatch = state.game !== null;
  if (!isHost.value || !inMatch) {
    askConfirm(
      { title: '离开房间', message: '离开后就退出这个房间了，确定吗？', confirmText: '离开', danger: true },
      (ok) => {
        if (ok) leaveRoom();
      },
    );
    return;
  }

  askConfirm(
    {
      title: '房主离开',
      message: '你是房主。要让当前第 N 场作废并重新发牌，还是保存为提前结束并返回大厅？',
      confirmText: '重新发牌',
      cancelText: '保存并回大厅',
    },
    (restart) => {
      if (restart) {
        restartGame();
      } else {
        closeMatch();
      }
    },
  );
}

/** 开关语音播报 */
export function toggleVoice(): void {
  if (!canChangeVoice.value) {
    showToast('天黑期间不能调整语音播报（防止场外因素），天亮后可以改', 'warn');
    return;
  }
  // 能不能播报 = TTS 支持 **或** 录音语音包可用。
  // 有些手机/浏览器没有中文 TTS 语音（以前这里是完全无声的死路），
  // 但语音包是纯音频文件，一样能播。
  if (!state.voiceSupported && !state.voicePackReady) {
    showToast('这个浏览器既没有语音合成、也加载不到语音包，暂时播报不了', 'warn');
    return;
  }
  state.voiceEnabled = !state.voiceEnabled;
  state.voiceDecided = true;
  store(VOICE_KEY, state.voiceEnabled ? '1' : '0');

  if (state.voiceEnabled) {
    // 必须在用户点击时解锁，否则 iOS / 微信里后面阶段切换时念不出声
    const ok = unlockVoice();
    if (!ok) {
      state.voiceEnabled = false;
      store(VOICE_KEY, '0');
      showToast('语音解锁失败，请再点一次试试', 'warn');
    }
  } else {
    stopVoice();
  }
}

export function restartGame(): void {
  resetVoiceCache();
  net.send({ t: 'game.restart' });
}

export function forceAdvance(): void {
  if (!isHost.value || !state.game) return;
  askConfirm(
    {
      title: '跳过当前阶段',
      message: '尚未完成的行动会由系统按本阶段规则自动处理。此操作会立即推进游戏，确定吗？',
      confirmText: '确认跳过',
      cancelText: '继续等待',
      danger: true,
    },
    (ok) => {
      if (ok) net.send({ t: 'game.advance' });
    },
  );
}

export function pickSeat(seat: number): void {
  if (!canPick.value) return;
  const options = state.game?.myOptions ?? [];
  if (!options.includes(seat)) {
    // 之前这里是静默忽略 —— 狼队点狼美人/恶灵骑士（不能自刀）时完全没反应，
    // 玩家以为界面坏了。点不动本身不是秘密（可选座位本来就有可点样式），
    // 把原因说清楚只是把隐晦的信号变成一句话，不新增任何泄露。
    const phase = state.game?.phase;
    if (phase === 'NIGHT_WOLVES') {
      showToast(`${seat} 号不能被刀（狼美人和恶灵骑士不能被狼队自刀）`, 'warn');
    } else {
      showToast(`${seat} 号不在本次可选目标里`, 'warn');
    }
    return;
  }
  if (state.game?.phase === 'NIGHT_DANCER') {
    const index = state.selectedMany.indexOf(seat);
    if (index >= 0) state.selectedMany.splice(index, 1);
    else if (state.selectedMany.length < 3) state.selectedMany.push(seat);
    return;
  }
  state.selected = state.selected === seat ? null : seat;
}

export function clearSelection(): void {
  state.selected = null;
  state.selectedMany = [];
  state.selectedPuppet = null;
}

/**
 * 「唯邻是从」：选一名傀儡。
 *
 * 和 `pickSeat` 分开，因为傀儡**不是本阶段的行动目标** ——
 * 刀口仍然走座位盘，傀儡走狼队面板上那排候选人按钮。
 */
export function pickPuppet(seat: number): void {
  const info = state.game?.puppetInfo;
  if (!info || !info.candidates.includes(seat)) return;
  state.selectedPuppet = state.selectedPuppet === seat ? null : seat;
}

// ─────────────────── 夜间 / 白天行动 ───────────────────

export function confirmSelection(): void {
  const game = state.game;
  const target = state.selected;
  if (!game || !game.myTurn || hasActed.value) return;
  if (game.phase === 'NIGHT_DANCER') {
    if (state.selectedMany.length !== 3) return;
    net.send({ t: 'game.action', action: { kind: 'dancer', targets: state.selectedMany.slice() } });
    markPending();
    clearSelection();
    return;
  }
  if (target === null) return;

  switch (game.phase) {
    case 'NIGHT_HYBRID':
      net.send({ t: 'game.action', action: { kind: 'hybrid', target } });
      break;
    case 'NIGHT_MECHANICAL':
      net.send({ t: 'game.action', action: { kind: 'mechanicalLearn', target } });
      break;
    case 'NIGHT_MASK':
      net.send({
        t: 'game.action',
        action: game.me?.maskNeedsDisguise
          ? { kind: 'mask', target }
          : { kind: 'maskInspect', target },
      });
      break;
    case 'NIGHT_DREAMER':
      net.send({ t: 'game.action', action: { kind: 'dreamer', target } });
      break;
    case 'NIGHT_WOLVES':
      /**
       * 「唯邻是从」首夜：刀口和傀儡要一起提交。
       * 傀儡没选的话服务端会直接拒绝（首夜必须选），所以这里必须带上。
       */
      net.send({
        t: 'game.action',
        action: state.selectedPuppet === null
          ? { kind: 'wolf', target }
          : { kind: 'wolf', target, puppet: state.selectedPuppet },
      });
      break;
    case 'NIGHT_GUARD':
      net.send({
        t: 'game.action',
        action: game.me?.role === 'MECHANICAL_WOLF'
          ? { kind: 'mechanicalSkill', skill: 'guard', target }
          : { kind: 'guard', target },
      });
      break;
    case 'NIGHT_SEER':
      net.send({
        t: 'game.action',
        action: game.me?.role === 'MECHANICAL_WOLF'
          ? { kind: 'mechanicalSkill', skill: 'seer', target }
          : { kind: 'seer', target },
      });
      break;
    case 'NIGHT_SPIRIT_SEER':
      net.send({
        t: 'game.action',
        action: game.me?.role === 'MECHANICAL_WOLF'
          ? { kind: 'mechanicalSkill', skill: 'spiritSeer', target }
          : { kind: 'spiritSeer', target },
      });
      break;
    case 'NIGHT_WITCH':
      net.send({
        t: 'game.action',
        action: game.me?.role === 'MECHANICAL_WOLF'
          ? { kind: 'mechanicalSkill', skill: 'poison', target }
          : { kind: 'witch', save: false, poison: target },
      });
      break;
    case 'DAY_VOTE':
      net.send({ t: 'game.vote', target });
      break;
    case 'SHERIFF_VOTE':
    case 'SHERIFF_REVOTE':
      net.send({ t: 'game.sheriffVote', target });
      break;
    case 'SHERIFF_TRANSFER':
      net.send({ t: 'game.sheriffTransfer', target });
      break;
    case 'HUNTER_SHOOT':
      net.send({ t: 'game.hunterShoot', target });
      break;
    case 'WOLF_KING_BOOM':
      net.send({ t: 'game.boomTarget', target });
      break;
    default:
      return;
  }
  markPending();
  clearSelection();
}

/** 放弃 / 空刀 / 弃票 / 不开枪 */
export function skipAction(): void {
  const game = state.game;
  if (!game || !game.myTurn || hasActed.value) return;

  switch (game.phase) {
    case 'NIGHT_WOLVES':
      net.send({ t: 'game.action', action: { kind: 'wolf', target: null } });
      break;
    case 'NIGHT_WITCH':
      net.send({
        t: 'game.action',
        action: game.me?.role === 'MECHANICAL_WOLF'
          ? { kind: 'mechanicalSkill', skill: 'poison', target: null }
          : { kind: 'witch', save: false, poison: null },
      });
      break;
    case 'DAY_VOTE':
      net.send({ t: 'game.vote', target: null });
      break;
    case 'SHERIFF_VOTE':
    case 'SHERIFF_REVOTE':
      net.send({ t: 'game.sheriffVote', target: null });
      break;
    case 'SHERIFF_TRANSFER':
      net.send({ t: 'game.sheriffTransfer', target: null });
      break;
    case 'HUNTER_SHOOT':
      net.send({ t: 'game.hunterShoot', target: null });
      break;
    case 'WOLF_KING_BOOM':
      net.send({ t: 'game.boomTarget', target: null });
      break;
    default:
      return;
  }
  markPending();
  state.selected = null;
}

/** 女巫使用解药（不需要选择目标） */
export function useAntidote(): void {
  const game = state.game;
  if (!game || game.phase !== 'NIGHT_WITCH' || !game.myTurn || hasActed.value) return;
  if (!game.witchInfo?.canSave) return;
  net.send({ t: 'game.action', action: { kind: 'witch', save: true, poison: null } });
  markPending();
  state.selected = null;
}

/** 守墓人确认已看到放逐查验结果（不需要选择目标） */
export function acknowledgeGraveCheck(): void {
  const game = state.game;
  if (!game || game.phase !== 'NIGHT_GRAVE_KEEPER' || !game.myTurn || hasActed.value) return;
  net.send({ t: 'game.action', action: { kind: 'graveKeeper' } });
  markPending();
}

/** 骑士翻牌决斗（目标由界面选好并二次确认后才走到这里） */
export function knightDuel(target: number): void {
  net.send({ t: 'game.knightDuel', target });
  markPending();
}

// ─────────────────── 展示辅助 ───────────────────

export function phaseAccentClass(): string {
  const game = state.game;
  if (!game) return '';
  switch (game.phase) {
    case 'NIGHT_START':
    case 'NIGHT_WOLVES':
    case 'NIGHT_WITCH':
    case 'NIGHT_SEER':
    case 'NIGHT_RESOLVE':
      return 'wolf';
    case 'GAME_OVER':
      return game.outcome === 'WOLF' ? 'wolf' : 'good';
    default:
      return 'good';
  }
}

export function roleAccentClass(): string {
  return state.game?.me?.camp === 'WOLF' ? 'wolf' : 'good';
}

export function formatClock(ms: number | null): string {
  if (ms === null) return '--';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function seatLabel(seat: number | null | undefined): string {
  return seat === null || seat === undefined ? '—' : `${seat} 号`;
}

export function nicknameOf(seat: number | null | undefined): string {
  if (seat === null || seat === undefined) return '—';
  return state.room?.seats.find((s) => s.seat === seat)?.nickname ?? `${seat} 号`;
}

export function inviteLink(): string {
  const roomId = state.room?.roomId ?? '';
  return `${window.location.origin}/?room=${roomId}`;
}

export function copyInvite(): void {
  const link = inviteLink();
  void copyToClipboard(link).then((ok) => {
    showToast(ok ? '邀请链接已复制，粘贴到微信群即可' : `复制失败，请手动发送房间号 ${state.room?.roomId ?? ''}`, ok ? 'info' : 'warn');
  });
}

// ─────────────────── 启动 ───────────────────

export function bootstrap(): void {
  // 分享链接里带的房间号：?room=ABC123
  try {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) state.roomCode = roomParam.trim().toUpperCase().slice(0, 6);
  } catch {
    /* ignore */
  }

  window.setInterval(() => {
    state.now = Date.now();
  }, 250);

  // 微信里切回前台时立刻重连，不用等 TCP 超时
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && !state.user.mustChangePassword) {
      net.reconnectNow();
      void refreshLobby();
    }
  });
  window.addEventListener('online', () => {
    if (state.user && !state.user.mustChangePassword) net.reconnectNow();
  });

  void (async () => {
    if (!state.authToken) {
      state.authReady = true;
      return;
    }
    try {
      const result = await api<{ user: AccountUserView }>('/api/auth/me');
      acceptAuth(state.authToken, result.user);
    } catch {
      state.authToken = '';
      state.user = null;
      removeStored(AUTH_KEY);
    } finally {
      state.authReady = true;
    }
  })();

  /**
   * 调试钩子：手机上没法开开发者工具，排查问题非常困难。
   * 在链接后面加 ?debug=1，就能在页面控制台里通过 window.__werewolf 查看当前状态。
   */
  if (window.location.search.includes('debug')) {
    const target = window as unknown as Record<string, unknown>;
    target['__werewolf'] = { state, screen, hasActed, canPick, net };
  }
}
