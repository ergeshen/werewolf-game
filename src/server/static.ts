/**
 * 极简静态文件服务器：托管 vite 构建产物（public/）。
 * 目的只有一个 —— 让「一个 Node 进程 = 一个可分享的 URL」，
 * 局域网联调时不用再起第二个服务、也不会有跨域问题。
 */

import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const NOT_BUILT = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>客户端还没构建</title>
<style>
 body{background:#0b0d17;color:#e8e9f3;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;
      padding:32px 20px;line-height:1.75}
 code{background:#1c2030;padding:2px 6px;border-radius:4px;color:#8ee6c8}
 pre{background:#151827;padding:14px;border-radius:8px;overflow:auto}
</style></head><body>
<h2>客户端还没构建</h2>
<p>服务端已经跑起来了，但 <code>public/</code> 目录里还没有前端产物。</p>
<p>在项目根目录执行一次：</p>
<pre>npm run build:client</pre>
<p>然后刷新本页即可。</p>
</body></html>`;

function safeResolve(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const full = resolve(join(root, rel));
  // 防止 ../ 穿越到工作区之外
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 返回一个 handler；命中并处理后返回 true。
 */
export function createStaticHandler(rootDir: string) {
  const root = resolve(rootDir);

  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const target = safeResolve(root, req.url ?? '/');
    if (target === null) {
      res.writeHead(400).end('bad request');
      return true;
    }

    let filePath = target;
    if (!isFile(filePath) && isFile(join(filePath, 'index.html'))) {
      filePath = join(filePath, 'index.html');
    }

    // SPA 回退：未知路径交给前端路由
    if (!isFile(filePath)) {
      const index = join(root, 'index.html');
      if (!isFile(index)) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' }).end(NOT_BUILT);
        return true;
      }
      filePath = index;
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    // 前端产物带 hash 的可以长缓存；index.html 必须每次校验
    const isHtml = type.startsWith('text/html');
    res.writeHead(200, {
      'content-type': type,
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
  };
}
