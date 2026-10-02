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
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// 在开始监听之前把上次没打完的房间接回来：客户端重连时老 token 直接落回原座位。
// 恢复失败（版本过旧 / 数据损坏）的房间会被丢弃并删除快照，不影响其余房间。
const restoredRooms = hub.restorePersistedRooms();
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
    json(res, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      database: database.mode,
      ...hub.stats(),
    });
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

  if (urlPath === '/api/halls' && req.method === 'GET') {
    json(res, { ok: true, halls: database.ownedHalls(user.id) });
    return true;
  }

  if (urlPath === '/api/hall-records' && req.method === 'GET') {
    const halls = database.hallRecords(user.id).map((hall) => ({
      ...hall,
      active: hub.isHallActive(hall.roomId),
    }));
    json(res, { ok: true, halls });
    return true;
  }

  const hiddenHall = urlPath.match(/^\/api\/hall-records\/([A-Z0-9]{6})$/);
  if (hiddenHall && req.method === 'DELETE') {
    const result = database.hideHallRecord(hiddenHall[1]!, user.id);
    json(res, result.ok ? { ok: true } : result, result.ok ? 200 : 404);
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

  const revealScores = urlPath.match(/^\/api\/halls\/([A-Z0-9]{6})\/reveal-scores$/);
  if (revealScores && req.method === 'POST') {
    const roomId = revealScores[1]!.toUpperCase();
    const result = database.setHallScoresRevealed(roomId, user.id);
    if (result.ok) hub.refreshHall(roomId);
    json(res, result.ok ? { ok: true } : result, result.ok ? 200 : 403);
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

/**
 * 横幅必须在**真的监听成功之后**才打印。
 *
 * 以前它是写在 listen() 之前的：端口被占用时会先刷出一整套
 * 「服务端已启动 + 局域网地址」，然后才报启动失败 ——
 * 玩家很容易以为已经起来了，转头去手机上试才发现打不开。
 */
function printBanner(): void {
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
  console.log(`  数据库存储  ${database.mode === 'turso' ? 'Turso 云数据库' : '本地 SQLite'}`);
  if (restoredRooms > 0) {
    console.log(`  已恢复      ${restoredRooms} 个未结束的房间（玩家重连即可回到原座位继续）`);
  }
  console.log(line);
}

// ─────────────────── 优雅退出 ───────────────────

/**
 * 把本进程的 PID 写到文件里，供 `npm run restart` 使用。
 *
 * 为什么需要它：`npm start` 不是「重启」，只是再启动一个新进程。
 * 上一个服务端还活着的时候，新进程会抢不到端口直接崩掉（EADDRINUSE）。
 * 而「谁占着端口」在没有 PID 文件时只能靠遍历进程去猜 —— 猜错就会误杀
 * 别人的程序。所以服务端自己留下身份，重启脚本就能精确地只杀自己。
 *
 * **文件名必须带端口**：同时开 5180 和 5181 两个服务端是常事，
 * 共用一个文件名会互相覆盖，结果 restart 可能把另一个端口的服务端杀掉。
 */
const PID_FILE = join(process.cwd(), `.werewolf-server-${PORT}.pid`);

/** 只有真正写出 PID 文件的进程才有资格清理它 */
let pidFileWritten = false;

function writePidFile(): void {
  try {
    writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }));
    pidFileWritten = true;
  } catch {
    // 写不了不影响服务端运行，只是 restart 的时候要多花点功夫找进程
  }
}

/**
 * 清理 PID 文件。
 *
 * **必须满足两个条件才删**，否则会踩到一个很隐蔽的坑：
 *   ① 本进程确实写过它 —— 抢端口失败后 `process.exit(1)` 的进程也会走到
 *      `exit` 事件，如果不加判断，它会把**正在运行的那个服务端**的 PID 文件删掉，
 *      于是 `npm run restart` 就找不到该停谁了。
 *   ② 文件里记的还是自己 —— 万一已经被新服务端接管，不能把新的记录删了。
 */
function removePidFile(): void {
  if (!pidFileWritten) return;
  try {
    const info = JSON.parse(readFileSync(PID_FILE, 'utf8')) as { pid?: number };
    if (info.pid !== process.pid) return;
    rmSync(PID_FILE, { force: true });
    pidFileWritten = false;
  } catch {
    /* ignore */
  }
}

function shutdown(): void {
  console.log('\n正在关闭…');
  removePidFile();
  clearInterval(heartbeat);
  // 关连接前把每个房间的最新状态存住 —— 重启后玩家能接着打这一局
  try {
    hub.flushSnapshots();
  } catch {
    /* 单个房间落盘失败不阻塞退出 */
  }
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
process.on('exit', removePidFile);

/**
 * 端口被占用时给一句能照做的话，而不是抛一段 Node 内部堆栈。
 *
 * 以前这里是未处理的 'error' 事件：玩家看到的是
 * `throw er; // Unhandled 'error' event` 加一堆 node:net 的行号，
 * 完全不知道该怎么办 —— 而实际原因通常只是「上一个服务端没退干净」。
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ✘ 端口 ${PORT} 已经被占用了，服务端起不来。`);
    console.error('');
    console.error('    最常见的误会：npm start 不是「重启」，它只是再启动一个新进程 ——');
    console.error('    上一个服务端还在跑（有时 Ctrl+C 只杀掉了 npm，node 子进程还活着）。');
    console.error('');
    console.error('    一条命令解决：');
    console.error('        npm run restart');
    console.error('');
    console.error('    想自己查是谁占着：');
    console.error(`        netstat -ano | findstr :${PORT}`);
    console.error('');
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  writePidFile();
  printBanner();
});
