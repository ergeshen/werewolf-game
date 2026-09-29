import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

type TimerEntry = { id: number; delay: number; callback: () => void };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

let nextTimerId = 1;
let timers: TimerEntry[] = [];

const fakeWindow = {
  location: { protocol: 'http:', host: 'localhost:5180' },
  localStorage: {
    getItem: () => null,
    setItem: () => undefined,
  },
  setTimeout(callback: () => void, delay: number): number {
    const id = nextTimerId++;
    timers.push({ id, delay, callback });
    return id;
  },
  clearTimeout(id: number): void {
    timers = timers.filter((timer) => timer.id !== id);
  },
  setInterval: () => nextTimerId++,
  clearInterval: () => undefined,
};

Object.assign(globalThis, {
  window: fakeWindow,
  WebSocket: FakeWebSocket,
});

const { Net } = await import('./net.ts');

beforeEach(() => {
  FakeWebSocket.instances = [];
  timers = [];
  nextTimerId = 1;
});

afterEach(() => {
  timers = [];
});

function makeNet(statuses: string[]): InstanceType<typeof Net> {
  return new Net({
    onRoom: () => undefined,
    onGame: () => undefined,
    onToast: () => undefined,
    onStatus: (status) => statuses.push(status),
  });
}

test('主动重连后忽略旧连接的延迟关闭事件', () => {
  const statuses: string[] = [];
  const net = makeNet(statuses);
  net.connect();
  const first = FakeWebSocket.instances[0]!;

  net.reconnectNow();
  const second = FakeWebSocket.instances[1]!;
  assert.equal(first.readyState, FakeWebSocket.CLOSED);
  assert.equal(FakeWebSocket.instances.length, 2);

  second.open();
  first.emitClose();

  assert.equal(statuses.at(-1), 'open');
  assert.equal(timers.length, 0, '旧连接关闭不应再排一次重连');
});

test('达到快速重试上限后仍以低频继续恢复', () => {
  const net = makeNet([]);
  const internal = net as unknown as {
    retryCount: number;
    scheduleRetry(): void;
  };
  internal.retryCount = 40;
  internal.scheduleRetry();

  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 30_000);
});
