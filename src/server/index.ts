/**
 * 服务端入口
 *
 * 一个 Node 进程同时提供：
 *   1. WebSocket  (/ws)          —— 实时游戏通信
 *   2. 静态前端  (/)             —— web/ 目录
 *   3. TS 实时转译 (/app/*.ts)   —— 前端用 TypeScript 写，但不需要任何打包器
 *
 * 之所以自己转译而不是上 Vite：Node 24 内置了类型擦除（module.stripTypeScriptTypes），
 * 前端因此可以做到「零构建」—— 改完代码刷新浏览器即可，也让部署只需要 npm start。
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { GameDatabase } from './database.ts';
import { Hub } from './hub.ts';
import { createStaticHandler } from './static.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/**
 * 端口默认 5180。
 * 特意不读 PORT —— 很多环境（含 DSH 运行时）会把 PORT 预设成别的用途（例如 3080），
 * 直接继承会导致端口冲突。需要改端口时用 WEREWOLF_PORT。
 */
const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);
const HOST = process.env.WEREWOLF_HOST ?? '0.0.0.0';

const WEB_ROOT = resolve(import.meta.dirname, '../../web');
const APP_ROOT = join(WEB_ROOT, 'app');
const SHARED_ROOT = resolve(import.meta.dirname, '../shared');

/**
 * 允许浏览器直接加载的共用模块白名单。
 *
 * 前端需要 roles.ts 里的运行时常量（角色名、预设版型、版型计算），
 * 而这份文件本来就是设计成「前后端共用」的纯数据模块。
 * 用白名单而不是整个目录，是为了确保**engine.ts 之类的服务端逻辑不会被暴露出去**。
 */
const SHARED_ALLOWLIST = new Set(['roles.ts', 'protocol.ts']);

const database = new GameDatabase();
const hub = new Hub(database);
const serveStatic = createStaticHandler(WEB_ROOT);

const AUTH_RATE_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT = 12;
const authAttempts = new Map<string, { count: number; resetAt: number }>();

// ─────────────────── 前端 TS 实时转译 ───────────────────

interface CacheEntry {
  mtimeMs: number;
  code: string;
}
const tsCache = new Map<string, CacheEntry>();

/** 把 URL 映射到磁盘文件；不在允许范围内返回 null */
function resolveTsFile(urlPath: string): string | null {
  if (urlPath.startsWith('/app/')) {
    const rel = urlPath.slice('/app/'.length);
    if (rel.includes('..') || rel.includes('\0')) return null;
    if (extname(rel) !== '.ts') return null;
    return join(APP_ROOT, rel);
  }

  if (urlPath.startsWith('/src/shared/')) {
    const rel = urlPath.slice('/src/shared/'.length);
    if (rel.includes('/') || rel.includes('..') || rel.includes('\0')) return null;
    if (!SHARED_ALLOWLIST.has(rel)) return null;
    return join(SHARED_ROOT, rel);
  }

  return null;
}

function serveTranspiledTs(urlPath: string, res: import('node:http').ServerResponse): boolean {
  const file = resolveTsFile(urlPath);
  if (!file) return false;

  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  let code = tsCache.get(file)?.code;
  if (!code || tsCache.get(file)?.mtimeMs !== stat.mtimeMs) {
    const source = readFileSync(file, 'utf8');
    code = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: urlPath });
    tsCache.set(file, { mtimeMs: stat.mtimeMs, code });
  }

  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(code);
  return true;
}

// ─────────────────── HTTP ───────────────────

function json(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

function bearerToken(req: import('node:http').IncomingMessage): string {
  const value = req.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function forwardedAddress(req: import('node:http').IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(',')[0]?.trim() || String(req.headers['x-real-ip'] ?? '').trim();
}

function clientAddress(req: import('node:http').IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  // 只信任本机反向代理传来的来源头；公网直连时客户端可自行伪造这些头。
  return isLoopback(direct) ? forwardedAddress(req) || direct : direct;
}

function allowAuthAttempt(req: import('node:http').IncomingMessage): boolean {
  const key = clientAddress(req);
  const now = Date.now();
  if (authAttempts.size > 1_000) {
    for (const [address, entry] of authAttempts) {
      if (entry.resetAt <= now) authAttempts.delete(address);
    }
  }
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + AUTH_RATE_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= AUTH_RATE_LIMIT;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isDirectLoopback(req: import('node:http').IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && forwardedAddress(req) === '';
}

function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 16 * 1024) reject(new Error('请求内容过大'));
    });
    req.on('end', () => {
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new Error('请求格式不正确'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('请求不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  urlPath: string,
): Promise<boolean> {
  if (urlPath === '/api/health' && req.method === 'GET') {
    json(res, { ok: true, uptimeSec: Math.round(process.uptime()), ...hub.stats() });
    return true;
  }

  if (urlPath === '/api/auth/register' && req.method === 'POST') {
    if (!allowAuthAttempt(req)) {
      json(res, { ok: false, message: '操作过于频繁，请一分钟后再试' }, 429);
      return true;
    }
    const body = await readJsonBody(req);
    const result = database.register(body['username']);
    json(res, result.ok ? { ok: true, ...result.value } : result, result.ok ? 201 : 409);
    return true;
  }

  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    if (!allowAuthAttempt(req)) {
      json(res, { ok: false, message: '登录尝试过于频繁，请一分钟后再试' }, 429);
      return true;
    }
    const body = await readJsonBody(req);
    const result = database.login(body['username'], body['password']);
    json(res, result.ok ? { ok: true, ...result.value } : result, result.ok ? 200 : 401);
    return true;
  }

  if (urlPath === '/api/auth/me' && req.method === 'GET') {
    const user = database.authenticate(bearerToken(req));
    json(res, user ? { ok: true, user } : { ok: false, message: '登录已过期' }, user ? 200 : 401);
    return true;
  }

  if (urlPath === '/api/auth/change-password' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = database.changePassword(
      bearerToken(req),
      body['currentPassword'],
      body['newPassword'],
    );
    json(res, result.ok ? { ok: true, user: result.value } : result, result.ok ? 200 : 400);
    return true;
  }

  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    database.logout(bearerToken(req));
    json(res, { ok: true });
    return true;
  }

  const user = database.authenticate(bearerToken(req));
  if (!user || user.mustChangePassword) {
    json(res, { ok: false, message: user ? '请先修改初始密码' : '请先登录' }, 401);
    return true;
  }

  if (urlPath === '/api/lobby' && req.method === 'GET') {
    json(res, { ok: true, rooms: hub.lobbyRooms() });
    return true;
  }

  if (urlPath === '/api/matches' && req.method === 'GET') {
    json(res, { ok: true, matches: database.history(user.id) });
    return true;
  }

  const hallMatch = urlPath.match(/^\/api\/halls\/([A-Z0-9]{6})$/);
  if (hallMatch && req.method === 'GET') {
    const dashboard = database.hallDashboard(hallMatch[1]!, user.id);
    json(
      res,
      dashboard ? { ok: true, hall: dashboard } : { ok: false, message: '没有找到这个大厅' },
      dashboard ? 200 : 404,
    );
    return true;
  }

  const hallDelete = urlPath.match(
    /^\/api\/halls\/([A-Z0-9]{6})\/matches\/([0-9a-f-]{36})$/i,
  );
  if (hallDelete && req.method === 'DELETE') {
    const roomId = hallDelete[1]!.toUpperCase();
    const result = database.deleteHallMatch(roomId, hallDelete[2]!, user.id);
    if (result.ok) hub.refreshHall(roomId);
    json(res, result.ok ? { ok: true } : result, result.ok ? 200 : 403);
    return true;
  }

  return false;
}

const server = createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

  if (urlPath.startsWith('/api/')) {
    void handleApi(req, res, urlPath)
      .then((handled) => {
        if (!handled && !res.writableEnded) json(res, { ok: false, message: '接口不存在' }, 404);
      })
      .catch((error: unknown) => {
        if (!res.writableEnded) {
          json(res, { ok: false, message: error instanceof Error ? error.message : '请求失败' }, 400);
        }
      });
    return;
  }

  if (urlPath.startsWith('/app/') || urlPath.startsWith('/src/shared/')) {
    if (serveTranspiledTs(urlPath, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`找不到脚本: ${urlPath}`);
    return;
  }

  /**
   * 其它 /src/ 路径一律 404。
   *
   * 不能让它落到下面的静态处理里 —— 那会走 SPA 回退返回 index.html，
   * 浏览器把 HTML 当模块解析，报的是「Unexpected token '<'」这种完全看不懂的错误。
   * 明确 404 才能让人一眼看出是导入路径写错了。
   */
  if (urlPath.startsWith('/src/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`不允许访问: ${urlPath}`);
    return;
  }

  if (serveStatic(req, res)) return;

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// ─────────────────── WebSocket ───────────────────

// 客户端消息都是很小的 JSON。限制单帧大小，避免局域网里的异常客户端
// 一次发送几十 MB 数据拖垮进程。
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const awaitingPong = new WeakSet<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  let token = '';
  let authToken = '';
  let automation = false;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = url.pathname;
    token = url.searchParams.get('token') ?? '';
    authToken = url.searchParams.get('auth') ?? '';
    automation = url.searchParams.get('automation') === '1' && isDirectLoopback(req);
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = hub.attach(token, ws, database.authenticate(authToken), automation);

    const welcome: ServerMsg = {
      t: 'welcome',
      playerId: session.token,
      resumeToken: session.token,
    };
    ws.send(JSON.stringify(welcome));

    // 重连时立刻把当前房间/对局状态推回去 —— 微信切后台断线后必须能无缝恢复
    hub.resync(session.token);

    ws.on('message', (data: unknown) => {
      hub.handleMessage(session.token, typeof data === 'string' ? data : String(data));
    });
    ws.on('pong', () => awaitingPong.delete(ws));
    ws.on('close', () => hub.detach(session.token, ws));
    ws.on('error', () => hub.detach(session.token, ws));
  });
});

// 心跳：微信内置浏览器切后台会静默断开 TCP，靠心跳把僵尸连接清掉
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    // 上一次 ping 到现在仍没收到 pong，说明这是僵尸连接。浏览器会自动
    // 回应 WebSocket ping，不依赖页面 JavaScript 是否正在前台运行。
    if (awaitingPong.has(ws)) {
      ws.terminate();
      continue;
    }
    awaitingPong.add(ws);
    ws.ping();
  }
  hub.sweep();
}, 30_000);

// ─────────────────── 启动横幅 ───────────────────

function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

const line = '─'.repeat(58);
console.log(line);
console.log('  12 人狼人杀 · 服务端已启动');
console.log(line);
console.log(`  本机访问    http://localhost:${PORT}`);
for (const ip of lanAddresses()) {
  console.log(`  局域网访问  http://${ip}:${PORT}   ← 手机连同一个 WiFi 就能打开`);
}
console.log('');
console.log('  H5 测试：把上面的「局域网访问」地址发给其他玩家，');
console.log('  玩家用浏览器打开链接 → 注册/登录 → 从大厅进入房间即可。');
console.log('');
console.log('  手机打不开？八成是 Windows 防火墙拦了入站，先跑一次自检：');
console.log('      npm run doctor');
console.log('');
console.log(`  健康检查    http://localhost:${PORT}/api/health`);
console.log(line);

// ─────────────────── 优雅退出 ───────────────────

function shutdown(): void {
  console.log('\n正在关闭…');
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
  }
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1_500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST);
