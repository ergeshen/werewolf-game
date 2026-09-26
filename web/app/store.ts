/**
 * 客户端状态与动作。
 *
 * 界面只做两件事：把服务端下发的个性化视图渲染出来、把用户的意图发回去。
 * 所有规则判断（能不能行动、能选谁、结果是什么）都在服务端，客户端不重复实现 ——
 * 这样小程序端复用时也不会出现「两端规则不一致」。
 */

import { computed, reactive } from '../vendor/vue.esm-browser.prod.js';

import type { GameView, RoomView, SeatView } from '../../src/shared/protocol.ts';
import { copyToClipboard, Net, type ConnStatus } from './net.ts';

const NICK_KEY = 'werewolf.nickname';

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

export interface ToastState {
  id: number;
  text: string;
  level: 'info' | 'warn' | 'error';
}

export const state = reactive({
  conn: 'connecting' as ConnStatus,
  nickname: readStored(NICK_KEY),
  roomCode: '',
  room: null as RoomView | null,
  game: null as GameView | null,
  /** 当前选中的座位（用于二次确认，避免误触把关键技能放空） */
  selected: null as number | null,
  toast: null as ToastState | null,
  /** 每 250ms 跳一次，用于渲染倒计时 */
  now: Date.now(),
  showRoleCard: true,
});

let toastSeq = 0;
let toastTimer: number | null = null;

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
  },
  onGame(game: GameView | null) {
    // 服务端视图是唯一事实来源，收到就清掉本地的乐观标记
    clearPending();
    state.game = game;
    // 阶段变了就清掉上一阶段的选择，避免「我明明选的是上一步的人」
    if (!game || !game.myTurn) state.selected = null;
  },
  onToast(text, level) {
    // 服务端拒绝操作时不会广播新的对局视图（状态没变），
    // 所以必须在这里清掉乐观标记 —— 否则按钮会永久停在
    // 「已提交，等待其他玩家…」，玩家再也没法重试。
    if (level === 'error') clearPending();
    showToast(text, level);
  },
  onStatus(status: ConnStatus) {
    state.conn = status;
  },
});

export type Screen = 'home' | 'lobby' | 'game' | 'result';

export const screen = computed<Screen>(() => {
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

// ─────────────────── 大厅动作 ───────────────────

export function createRoom(): void {
  const nickname = state.nickname.trim();
  if (!nickname) {
    showToast('请先填一个昵称', 'warn');
    return;
  }
  store(NICK_KEY, nickname);
  net.send({ t: 'room.create', nickname });
}

export function joinRoom(): void {
  const nickname = state.nickname.trim();
  if (!nickname) {
    showToast('请先填一个昵称', 'warn');
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
  state.selected = null;
}

export function toggleReady(): void {
  const me = mySeat.value;
  if (!me) return;
  net.send({ t: 'room.ready', ready: !me.ready });
}

export function startGame(): void {
  net.send({ t: 'game.start' });
}

export function restartGame(): void {
  net.send({ t: 'game.restart' });
}

export function forceAdvance(): void {
  net.send({ t: 'game.advance' });
}

export function pickSeat(seat: number): void {
  if (!canPick.value) return;
  const options = state.game?.myOptions ?? [];
  if (!options.includes(seat)) return;
  state.selected = state.selected === seat ? null : seat;
}

export function clearSelection(): void {
  state.selected = null;
}

// ─────────────────── 夜间 / 白天行动 ───────────────────

export function confirmSelection(): void {
  const game = state.game;
  const target = state.selected;
  if (!game || target === null || !game.myTurn || hasActed.value) return;

  switch (game.phase) {
    case 'NIGHT_WOLVES':
      net.send({ t: 'game.action', action: { kind: 'wolf', target } });
      break;
    case 'NIGHT_SEER':
      net.send({ t: 'game.action', action: { kind: 'seer', target } });
      break;
    case 'NIGHT_WITCH':
      net.send({ t: 'game.action', action: { kind: 'witch', save: false, poison: target } });
      break;
    case 'DAY_VOTE':
      net.send({ t: 'game.vote', target });
      break;
    case 'HUNTER_SHOOT':
      net.send({ t: 'game.hunterShoot', target });
      break;
    default:
      return;
  }
  markPending();
  state.selected = null;
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
      net.send({ t: 'game.action', action: { kind: 'witch', save: false, poison: null } });
      break;
    case 'DAY_VOTE':
      net.send({ t: 'game.vote', target: null });
      break;
    case 'HUNTER_SHOOT':
      net.send({ t: 'game.hunterShoot', target: null });
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
    if (document.visibilityState === 'visible') net.reconnectNow();
  });
  window.addEventListener('online', () => net.reconnectNow());

  net.connect();

  /**
   * 调试钩子：手机上没法开开发者工具，排查问题非常困难。
   * 在链接后面加 ?debug=1，就能在页面控制台里通过 window.__werewolf 查看当前状态。
   */
  if (window.location.search.includes('debug')) {
    const target = window as unknown as Record<string, unknown>;
    target['__werewolf'] = { state, screen, hasActed, canPick, net };
  }
}
