/**
 * 账号 + WebSocket 鉴权 + 公开大厅的轻量集成测试。
 *
 * 用法：先启动服务端，再执行 `npm run smoke:auth`。
 */

import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import type { ServerMsg } from '../src/shared/protocol.ts';

const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

function connect(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, headers ? { headers } : undefined);
    const timer = setTimeout(() => reject(new Error(`连接超时：${url}`)), 5_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextMessage(socket: WebSocket, predicate: (message: ServerMsg) => boolean): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('等待 WebSocket 消息超时'));
    }, 5_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(String(raw)) as ServerMsg;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function api<T>(path: string, init: RequestInit = {}, token = ''): Promise<T> {
  const response = await fetch(`${HTTP_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T & { message?: string };
  assert.ok(response.ok, body.message ?? `${path} 返回 ${response.status}`);
  return body;
}

const sockets: WebSocket[] = [];
try {
  const anonymous = await connect(WS_URL);
  sockets.push(anonymous);
  const denied = nextMessage(anonymous, (message) => message.t === 'error');
  anonymous.send(JSON.stringify({ t: 'room.create', nickname: '绕过登录' }));
  const deniedMessage = await denied;
  assert.equal(deniedMessage.t, 'error');
  assert.match(deniedMessage.message, /登录/);
  console.log('  ✔ 未登录客户端不能绕过页面直接创建房间');

  const proxiedAutomation = await connect(`${WS_URL}?automation=1`, {
    'x-forwarded-for': '203.0.113.8',
  });
  sockets.push(proxiedAutomation);
  const proxyDenied = nextMessage(proxiedAutomation, (message) => message.t === 'error');
  proxiedAutomation.send(JSON.stringify({ t: 'room.create', nickname: '反代绕过' }));
  const proxyDeniedMessage = await proxyDenied;
  assert.equal(proxyDeniedMessage.t, 'error');
  assert.match(proxyDeniedMessage.message, /登录/);
  console.log('  ✔ 经反向代理访问时不能冒充本机自动化客户端');

  const automationHost = await connect(`${WS_URL}?automation=1`);
  sockets.push(automationHost);
  const created = nextMessage(automationHost, (message) => message.t === 'room' && message.room !== null);
  automationHost.send(JSON.stringify({ t: 'room.create', nickname: '本机测试房主' }));
  const roomMessage = await created;
  assert.equal(roomMessage.t, 'room');
  assert.ok(roomMessage.room);
  const roomId = roomMessage.room.roomId;

  const username = `测试${Date.now().toString().slice(-8)}`;
  const registered = await api<{ token: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  await api(
    '/api/auth/change-password',
    { method: 'POST', body: JSON.stringify({ currentPassword: '1', newPassword: 'test1234' }) },
    registered.token,
  );

  const lobby = await api<{ rooms: Array<{ roomId: string }> }>('/api/lobby', {}, registered.token);
  assert.ok(lobby.rooms.some((room) => room.roomId === roomId));
  console.log('  ✔ 登录用户能在公开大厅看到等待中的房间');

  const player = await connect(`${WS_URL}?auth=${encodeURIComponent(registered.token)}`);
  sockets.push(player);
  const joined = nextMessage(player, (message) => message.t === 'room' && message.room?.roomId === roomId);
  player.send(JSON.stringify({ t: 'room.join', roomId, nickname: '伪造昵称' }));
  const joinedMessage = await joined;
  assert.equal(joinedMessage.t, 'room');
  const me = joinedMessage.room?.seats.find((seat) => seat.isMe);
  assert.equal(me?.nickname, username, '房间昵称必须使用登录账号名，不能由客户端伪造');
  console.log('  ✔ 登录用户能加入公开房间，房间昵称以账号为准');

  console.log('\n✨ 账号与大厅集成测试通过\n');
} finally {
  for (const socket of sockets) socket.close();
}
