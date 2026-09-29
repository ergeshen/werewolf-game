/**
 * WebSocket 客户端：连接、断线重连、消息分发。
 *
 * 移动端必须处理的两件事：
 * 1. 微信切后台 / 锁屏会静默掐断连接 —— 必须自动重连，并且用同一个 token 恢复座位与身份。
 * 2. 断线期间用户点的按钮不能丢 —— 未连上时先把消息排队，连上后补发。
 */

import type { ClientMsg, GameView, RoomView, ServerMsg } from '../../src/shared/protocol.ts';

export type ConnStatus = 'connecting' | 'open' | 'closed';

export interface NetHandlers {
  onRoom(room: RoomView | null): void;
  onGame(game: GameView | null): void;
  onToast(text: string, level: 'info' | 'warn' | 'error'): void;
  onStatus(status: ConnStatus): void;
}

const TOKEN_KEY = 'werewolf.token';
const RETRY_BASE_MS = 800;
const RETRY_CAP_MS = 6_000;
const RETRY_MAX = 40;
const RETRY_IDLE_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // 隐私模式下 localStorage 可能不可用
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export class Net {
  private socket: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUser = false;
  private queue: ClientMsg[] = [];
  private statusValue: ConnStatus = 'connecting';
  private readonly handlers: NetHandlers;
  private authToken = '';

  token: string;

  constructor(handlers: NetHandlers) {
    this.handlers = handlers;
    this.token = safeGet(TOKEN_KEY) ?? '';
  }

  get status(): ConnStatus {
    return this.statusValue;
  }

  private setStatus(next: ConnStatus): void {
    if (this.statusValue === next) return;
    this.statusValue = next;
    this.handlers.onStatus(next);
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    this.setStatus('closed');
  }

  private open(): void {
    this.setStatus('connecting');
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    if (this.token) params.set('token', this.token);
    if (this.authToken) params.set('auth', this.authToken);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const url = `${scheme}//${window.location.host}/ws${query}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      // 前后台切换时可能已经创建了更新的连接。旧连接即使稍后成功，
      // 也不能再接管状态，否则两条连接会在服务端互相顶掉。
      if (this.socket !== socket) {
        socket.close();
        return;
      }
      this.retryCount = 0;
      this.setStatus('open');
      this.startPing();
      this.flushQueue();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== 'string') return;
      this.receive(event.data);
    };

    socket.onclose = () => {
      // 被 reconnectNow() 主动替换的旧连接会延迟触发 close。
      // 忽略它，否则会额外排一个重连，造成连接风暴。
      if (this.socket !== socket) return;
      this.stopPing();
      this.socket = null;
      this.setStatus('closed');
      if (!this.closedByUser) this.scheduleRetry();
    };

    socket.onerror = () => {
      // 浏览器随后一定会触发 onclose，重连逻辑统一放在那里
    };
  }

  private receive(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'welcome':
        this.token = msg.resumeToken;
        safeSet(TOKEN_KEY, msg.resumeToken);
        return;
      case 'room':
        this.handlers.onRoom(msg.room);
        return;
      case 'game':
        this.handlers.onGame(msg.game);
        return;
      case 'toast':
        this.handlers.onToast(msg.text, msg.level);
        return;
      case 'error':
        this.handlers.onToast(msg.message, 'error');
        return;
      case 'pong':
        return;
      default:
        return;
    }
  }

  send(msg: ClientMsg): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
      return;
    }
    // 未连接：排队，连上后补发（最多留 20 条）
    this.queue.push(msg);
    if (this.queue.length > 20) this.queue.shift();
    if (!this.socket) this.connect();
  }

  private flushQueue(): void {
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) this.send(msg);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    // 前几分钟快速恢复；服务端长时间不可用后降低频率，但永不彻底放弃。
    // 否则网络恢复后页面仍会永久显示「正在重连」，除非用户手动刷新。
    const delay =
      this.retryCount >= RETRY_MAX
        ? RETRY_IDLE_MS
        : Math.min(RETRY_BASE_MS * 2 ** this.retryCount, RETRY_CAP_MS);
    this.retryCount += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ t: 'ping', ts: Date.now() } satisfies ClientMsg));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** 页面进入后台时主动断开，回到前台立刻重连 —— 比等 TCP 超时快得多 */
  reconnectNow(): void {
    if (this.closedByUser) return;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryCount = 0;
    const previous = this.socket;
    this.socket = null;
    this.stopPing();
    try {
      previous?.close();
    } catch {
      /* ignore */
    }
    this.open();
  }
}

export function copyToClipboard(text: string): Promise<boolean> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === 'function') {
    return clip
      .writeText(text)
      .then(() => true)
      .catch(() => false);
  }
  // 兜底：微信内置浏览器对 clipboard API 支持不稳定
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}
