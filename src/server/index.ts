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

const hub = new Hub();
const serveStatic = createStaticHandler(WEB_ROOT);

// ─────────────────── 前端 TS 实时转译 ───────────────────

interface CacheEntry {
  mtimeMs: number;
  code: string;
}
const tsCache = new Map<string, CacheEntry>();

function resolveAppFile(urlPath: string): string | null {
  const rel = urlPath.replace(/^\/app\//, '');
  if (rel.includes('..') || rel.includes('\0')) return null;
  if (extname(rel) !== '.ts') return null;
  return join(APP_ROOT, rel);
}

function serveTranspiledTs(urlPath: string, res: import('node:http').ServerResponse): boolean {
  const file = resolveAppFile(urlPath);
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

const server = createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

  if (urlPath === '/api/health') {
    json(res, { ok: true, uptimeSec: Math.round(process.uptime()), ...hub.stats() });
    return;
  }

  if (urlPath.startsWith('/app/')) {
    if (serveTranspiledTs(urlPath, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`找不到客户端脚本: ${urlPath}`);
    return;
  }

  if (serveStatic(req, res)) return;

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// ─────────────────── WebSocket ───────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  let token = '';
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = url.pathname;
    token = url.searchParams.get('token') ?? '';
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = hub.attach(token, ws);

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
    ws.on('close', () => hub.detach(session.token, ws));
    ws.on('error', () => hub.detach(session.token, ws));
  });
});

// 心跳：微信内置浏览器切后台会静默断开 TCP，靠心跳把僵尸连接清掉
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
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
console.log('  微信里测试：把上面的「局域网访问」地址发到微信群，');
console.log('  12 个人用手机点开链接 → 输昵称 → 输同一个房间号即可。');
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST);
