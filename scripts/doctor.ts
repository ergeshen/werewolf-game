/**
 * 环境自检：`npm run doctor`
 *
 * 解决一个非常具体、非常浪费时间的失败模式：
 * 服务端明明跑起来了，自己电脑能打开，但**手机连不上**，浏览器一直转圈，
 * 而且不给任何原因。绝大多数情况下是 Windows 防火墙拦掉了入站连接。
 *
 * 这个命令把「手机能不能连上」的每一项前提都查一遍，并给出可直接执行的修复命令。
 */

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  evaluateInboundAccess,
  parseActiveProfile,
  parseFirewallOn,
  parseNetshRules,
} from './lib/firewall.ts';

const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

function ok(text: string): void {
  console.log(`  ${GREEN}\u2714${RESET} ${text}`);
}
function bad(text: string): void {
  console.log(`  ${RED}\u2716${RESET} ${text}`);
}
function warn(text: string): void {
  console.log(`  ${YELLOW}!${RESET} ${text}`);
}
function info(text: string): void {
  console.log(`    ${DIM}${text}${RESET}`);
}
function title(text: string): void {
  console.log(`\n${text}`);
}

/**
 * 跑 netsh 并拿到输出。
 *
 * 刻意把 stdout/stderr 重定向到**文件**而不是默认的管道：
 * 受管/沙箱环境常常禁止子进程使用命名管道（spawn 会直接 EPERM），
 * 而重定向到文件不走管道，能正常工作。这样即使在这种环境里也能自检。
 */
function runNetsh(args: string[]): string | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'werewolf-doctor-'));
    const outFile = join(dir, 'out.txt');
    const errFile = join(dir, 'err.txt');
    const fdOut = openSync(outFile, 'w');
    const fdErr = openSync(errFile, 'w');
    let result;
    try {
      result = spawnSync('netsh', args, {
        stdio: ['ignore', fdOut, fdErr],
        windowsHide: true,
      });
    } finally {
      closeSync(fdOut);
      closeSync(fdErr);
    }
    if (result.error) return null;
    const out = readFileSync(outFile, 'utf8');
    const err = readFileSync(errFile, 'utf8');
    if (out.trim()) return out;
    if (err.trim()) return err;
    return null;
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

async function fetchOk(url: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // 远程模式：npm run doctor -- --url https://你的域名
  const urlFlagIndex = process.argv.indexOf('--url');
  const remoteUrl = urlFlagIndex >= 0 ? process.argv[urlFlagIndex + 1] : undefined;
  if (remoteUrl) {
    await checkRemote(remoteUrl);
    return;
  }

  console.log('\n狼人杀 · 环境自检');
  console.log('='.repeat(60));

  // ── 1. 服务端 ──
  title('1. 服务端');
  const localOk = await fetchOk(`http://127.0.0.1:${PORT}/api/health`);
  if (localOk) {
    ok(`服务端在 127.0.0.1:${PORT} 正常响应`);
  } else {
    bad(`127.0.0.1:${PORT} 没有响应 —— 服务端还没启动`);
    info('先执行:  npm start');
  }

  // ── 2. 局域网地址 ──
  title('2. 局域网地址（要发给朋友的就是这个）');
  const addresses = lanAddresses();
  if (addresses.length === 0) {
    bad('没有找到任何局域网 IPv4 地址 —— 可能没连 WiFi/网线');
  }
  const reachable: string[] = [];
  for (const ip of addresses) {
    const url = `http://${ip}:${PORT}`;
    const alive = await fetchOk(`${url}/api/health`);
    if (alive) {
      ok(`${url}  可访问`);
      reachable.push(url);
    } else {
      warn(`${url}  无响应（服务端未启动，或被防火墙拦了）`);
    }
  }
  if (reachable.length > 0) {
    info('注意：从本机访问自己的局域网地址**不经过防火墙入站规则**，');
    info('所以这一步通过不代表手机一定能连上，还要看下面的防火墙检查。');
  }

  // ── 3. 防火墙 ──
  title('3. Windows 防火墙（手机连不上的头号原因）');
  const profileRaw = runNetsh(['advfirewall', 'monitor', 'show', 'currentprofile']);
  const stateRaw = runNetsh(['advfirewall', 'show', 'allprofiles', 'state']);
  const rulesRaw = runNetsh(['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in']);

  let firewallVerdict: string = 'unknown';

  if (!profileRaw || !stateRaw || !rulesRaw) {
    warn('无法自动检测防火墙（当前环境不允许调用 netsh）');
    info('请手动在**管理员** PowerShell 里执行下面这行，然后重试：');
    console.log(
      `\n    New-NetFirewallRule -DisplayName "狼人杀 ${PORT}" -Direction Inbound -Protocol TCP -LocalPort ${PORT} -Action Allow -Profile Any\n`,
    );
    info('（这条命令是幂等的：重复执行只会报「已存在」，不会有副作用）');
    firewallVerdict = 'unknown';
  } else {
    const activeProfile = parseActiveProfile(profileRaw);
    const rules = parseNetshRules(rulesRaw);
    info(`解析到 ${rules.length} 条入站规则`);

    if (!activeProfile) {
      warn('无法识别当前生效的网络配置（Domain / Private / Public）');
      firewallVerdict = 'unknown';
    } else {
      const firewallOn = parseFirewallOn(stateRaw, activeProfile);
      info(`当前生效配置: ${activeProfile}${firewallOn === null ? '' : '，防火墙: ' + (firewallOn ? '开启' : '关闭')}`);

      const verdict = evaluateInboundAccess({
        rules,
        activeProfile,
        port: PORT,
        firewallOn: firewallOn !== false,
      });

      if (verdict.allowed) {
        ok(verdict.reason);
        firewallVerdict = 'allowed';
      } else {
        bad(verdict.reason);
        firewallVerdict = 'blocked';
        if (verdict.fix) {
          console.log(`\n    ${DIM}在**管理员** PowerShell 里执行下面这行即可修复：${RESET}`);
          console.log(`\n    ${verdict.fix}\n`);
        }
      }
    }
  }

  // ── 4. 结论 ──
  title('4. 结论');
  if (localOk && reachable.length > 0 && firewallVerdict === 'allowed') {
    ok('环境看起来没问题，可以让朋友用下面的地址试了：');
    for (const url of reachable) console.log(`\n      ${url}\n`);
    info('把地址发到微信群 → 大家点开填昵称 → 用同一个房间号进入。');
    info('如果手机还是打不开，按顺序排查：');
    info('  1) 手机和电脑是不是同一个 WiFi（注意别一个连 5G 一个连 2.4G 的不同网段）');
    info('  2) 路由器有没有开「AP 隔离 / 客户端隔离」—— 开了的话设备之间不能互访');
    info('  3) 电脑上是不是有 VPN / 代理软件在改路由表');
  } else if (!localOk) {
    bad('服务端没启动，先执行 npm start');
  } else if (firewallVerdict === 'blocked') {
    bad('防火墙会拦掉手机的连接 —— 请先执行上面给出的那条管理员命令');
  } else if (firewallVerdict === 'unknown') {
    warn('无法完全确认防火墙状态 —— 建议先按上面的命令放行一次，再让朋友试');
  } else {
    warn('没有可用的局域网地址，朋友只能通过内网穿透或公网服务器访问');
  }

  console.log(`\n${DIM}提示：局域网方式只适合同一个 WiFi。`);
  console.log('想让不在身边的朋友玩，需要用内网穿透（cpolar/natapp/frp）或直接部署到云服务器。');
  console.log(`内网穿透是**出站**连接，不受本机防火墙入站规则影响，所以能绕开上面这个问题。${RESET}\n`);

  process.exit(0);
}

/**
 * 远程检测：npm run doctor -- --url https://你的域名
 *
 * 为什么需要单独做这个：部署到服务器后，浏览器里"页面能打开"**不代表游戏能玩**。
 * 反向代理（Nginx 等）如果没正确转发 WebSocket 的 Upgrade 头，
 * 页面会正常显示，但玩家一进房间就连不上，而且没有任何报错提示 ——
 * 这是自建部署最常见的失败，且最难自己想到原因。
 *
 * 所以这里直接发起一次真实的 WebSocket 握手，用「服务器是否回 welcome 消息」作为判据。
 */
/** /api/health 的响应体 */
interface HealthBody {
  ok?: boolean;
  rooms?: number;
  online?: number;
}

async function checkRemote(rawUrl: string): Promise<void> {
  const base = rawUrl.trim().replace(/\/+$/, '');
  console.log('\n狼人杀 · 线上部署自检');
  console.log('='.repeat(60));
  console.log(`  目标: ${base}\n`);

  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    bad(`不是合法的网址: ${base}`);
    info('正确写法示例:  npm run doctor -- --url https://werewolf.example.com');
    process.exit(1);
  }

  const isHttps = parsed.protocol === 'https:';
  let allOk = true;

  // ── 1. HTTP 健康检查 ──
  title('1. 页面与接口');
  const healthUrl = `${base}/api/health`;
  let health: { ok?: boolean; rooms?: number; online?: number } | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as HealthBody;
      health = body;
      ok(`${healthUrl}  正常响应`);
      info(`服务端自述: ok=${body.ok} 房间数=${body.rooms} 在线连接=${body.online}`);
    } else {
      bad(`${healthUrl}  返回 HTTP ${res.status}`);
      allOk = false;
    }
  } catch (error) {
    bad(`${healthUrl}  请求失败: ${error instanceof Error ? error.message : String(error)}`);
    info('检查：服务端在跑吗？防火墙/安全组放行了 80、443 吗？域名解析对了吗？');
    allOk = false;
  }

  // ── 2. 真正的 WebSocket 握手（最容易被反向代理配错的一环） ──
  title('2. WebSocket（游戏实时通信，最关键）');
  const wsScheme = isHttps ? 'wss' : 'ws';
  const wsUrl = `${wsScheme}://${parsed.host}/ws`;
  info(`尝试连接 ${wsUrl}`);

  // 先取出布尔值，避免 TS 在下面的分支里对 health 的收窄失效
  const httpReachable = health !== null;

  const wsResult = await tryWebSocket(wsUrl);
  if (wsResult.ok) {
    ok(`握手成功，并收到服务端消息（${wsResult.detail}）`);
  } else {
    bad(`连接失败：${wsResult.detail}`);
    allOk = false;
    if (httpReachable) {
      info('页面接口是通的但 WebSocket 不通 —— 这几乎可以确定是**反向代理没转发 WebSocket**。');
      info('Nginx 需要这三行（缺一行都会静默失败）：');
      console.log('');
      console.log('        proxy_http_version 1.1;');
      console.log('        proxy_set_header Upgrade $http_upgrade;');
      console.log('        proxy_set_header Connection "upgrade";');
      console.log('');
      info('完整配置见 docs/部署指南.md');
    }
  }

  // ── 3. HTTPS 检查 ──
  title('3. 协议与证书');
  if (isHttps) {
    ok('用的是 HTTPS —— 微信内置浏览器和小程序都要求这个');
  } else {
    warn('用的是 HTTP。微信内置浏览器对 http 的拦截情况没有官方明文，');
    info('但以后要做小程序**必须** HTTPS（且域名要 ICP 备案），建议现在就配上免费证书。');
  }

  // ── 4. 结论 ──
  title('4. 结论');
  if (allOk) {
    ok('部署没问题，可以把链接发给朋友了：');
    console.log(`\n      ${base}\n`);
    info('别忘了：小范围私聊发给 12 个朋友风险最低；');
    info('不要公开推广、不要发大群裂变、不要用公众号导流。');
  } else {
    bad('部署还有问题，先按上面的提示修掉再发给朋友。');
  }
  console.log('');

  process.exit(allOk ? 0 : 1);
}

interface WsProbe {
  ok: boolean;
  detail: string;
}

/** 发起一次真实的 WebSocket 连接，等服务器回一条消息就算通 */
function tryWebSocket(wsUrl: string): Promise<WsProbe> {
  return new Promise<WsProbe>((resolve) => {
    let settled = false;
    const finish = (result: WsProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, detail: '10 秒内没有完成握手（超时）' });
    }, 10_000);

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      finish({ ok: false, detail: `无法发起连接: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    socket.addEventListener('open', () => {
      info('TCP + WebSocket 握手已完成，等待服务端回执…');
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      const raw = String(event.data);
      try {
        const msg = JSON.parse(raw) as { t?: string };
        finish({ ok: true, detail: `收到 ${msg.t ?? '未知'} 消息` });
      } catch {
        finish({ ok: true, detail: '收到消息（非 JSON，但连接是通的）' });
      }
    });

    socket.addEventListener('error', () => {
      finish({
        ok: false,
        detail: '连接被拒绝或中断（常见原因：反向代理没转发 Upgrade 头 / 证书无效 / 端口没放行）',
      });
    });

    socket.addEventListener('close', (event: { code?: number }) => {
      finish({ ok: false, detail: `连接被关闭（code=${event.code ?? '?'}）` });
    });
  });
}

main().catch((error: unknown) => {
  console.error('\n自检脚本出错：');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
