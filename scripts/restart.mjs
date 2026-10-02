/**
 * 重启服务端。
 *
 * 为什么需要它：`npm start` **不是重启**，它只是再启动一个新进程。
 * 上一个服务端还在跑的时候，新进程会抢不到端口直接崩掉：
 *
 *     Error: listen EADDRINUSE: address already in use 0.0.0.0:5180
 *
 * 而且按 Ctrl+C 有时只杀掉 npm，真正的 node 子进程还活着继续占端口 ——
 * 终端看起来"已经退出了"，端口却还被占着。
 *
 * 停谁，按可信度分三级：
 *   ① 服务端自己写的 `.werewolf-server-<端口>.pid` → **精确停掉那一个**
 *   ② 没有 PID 文件（比如服务端是在这个功能之前启动的）→ 先探一下
 *      `/api/health` 确认端口上跑的就是本项目，再由系统查到占用者 PID
 *   ③ 探不出来 → **拒绝动手**，只打印排查命令
 *
 * 为什么这么小心：端口上是谁只能靠遍历进程去猜，猜错就会误杀别人的程序。
 * 所以每一步都要有"这确实是我们自己的服务端"的证据。
 *
 * 用法：
 *     npm run restart
 *     $env:WEREWOLF_PORT='5181'; npm run restart
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';

const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);
const PID_FILE = `.werewolf-server-${PORT}.pid`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid) {
  try {
    process.kill(pid, 0); // 信号 0 只探测存在性，不真发信号
    return true;
  } catch {
    return false;
  }
}

/** 探测端口上跑的是不是本项目的服务端（拿它自己的健康检查当身份证明） */
async function looksLikeWerewolfServer() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    // 这个响应特征足够独特：只有本项目的服务端会返回这些字段
    if (body && body.ok === true && typeof body.uptimeSec === 'number' && 'roomList' in body) return body;
    return null;
  } catch {
    return null;
  }
}

/**
 * 查某个端口被哪个 PID 占用（只用系统自带命令，best-effort）。
 * 拿不到就返回 null —— 调用方会退化成"只打印命令让用户自己动手"。
 *
 * 注意这里把输出**重定向到临时文件**，而不是用管道捕获：
 * `execFileSync` 默认走管道，而某些受限环境下不允许程序打开命名管道
 * （会直接 EPERM）。写文件则到处都能用。
 */
function findPortOwner(port) {
  const tmp = `.tmp-netstat-${process.pid}.txt`;
  let fd;
  try {
    fd = openSync(tmp, 'w');
    // stdout 直接接文件描述符，stderr 丢掉
    execFileSync('netstat', ['-ano'], { stdio: ['ignore', fd, 'ignore'], timeout: 8000 });
    closeSync(fd);
    fd = undefined;

    const output = readFileSync(tmp, 'utf8');
    for (const line of output.split('\n')) {
      if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // 拿不到就交给调用方降级，不在这里抛
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
  return null;
}

console.log(`准备重启服务端（端口 ${PORT}）…\n`);

let handled = false;

// ── ① 有 PID 文件就按它停 ──
if (existsSync(PID_FILE)) {
  let pid = 0;
  try {
    pid = Number(JSON.parse(readFileSync(PID_FILE, 'utf8')).pid);
  } catch {
    /* 文件坏了，往下走 ② */
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    if (processAlive(pid)) {
      console.log(`  按 PID 文件停止上一个服务端：${PID_FILE} → PID ${pid}`);
      try {
        process.kill(pid);
      } catch (error) {
        console.log(`  发停止信号失败：${error.message}`);
      }
      let gone = false;
      for (let i = 0; i < 40; i++) {
        await sleep(150);
        if (!processAlive(pid)) {
          gone = true;
          console.log(`  已退出（等了约 ${(((i + 1) * 150) / 1000).toFixed(1)} 秒）。`);
          break;
        }
      }
      if (!gone) {
        console.log(`  ⚠ ${pid} 没退出，强制结束。`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
        await sleep(600);
      }
      handled = true;
    } else {
      console.log(`  ${PID_FILE} 里的 PID ${pid} 已经不在运行了。`);
      handled = true;
    }
  }
}

// ── ② 没有 PID 文件：先确认是本项目的服务端，再查占用者 ──
if (!handled) {
  const health = await looksLikeWerewolfServer();
  if (health) {
    console.log(`  没有 ${PID_FILE}，但 ${PORT} 端口上确实是本项目的服务端：`);
    console.log(`      uptime ${health.uptimeSec}s，在线 ${health.online} 人，房间 ${health.rooms} 个`);
    console.log('     （通常是「写 PID 文件」这个功能之前启动的旧进程）');
    const owner = findPortOwner(PORT);
    if (owner && owner !== process.pid) {
      console.log(`\n  停止它：PID ${owner}`);
      try {
        process.kill(owner);
        for (let i = 0; i < 30; i++) {
          await sleep(150);
          if (!processAlive(owner)) break;
        }
        console.log('  已停止。');
        handled = true;
      } catch (error) {
        console.log(`\n  自动停止失败（${error.message}），请手动执行：`);
        console.log(`      taskkill /PID ${owner} /F`);
        console.log('  停掉之后再跑一次 npm run restart。');
        process.exit(1);
      }
    } else {
      console.log('\n  查不到占用者 PID，请手动停掉它（在它的终端窗口按 Ctrl+C），或执行：');
      console.log(`      netstat -ano | findstr :${PORT}    ← 最后一列是 PID`);
      console.log('      taskkill /PID <PID> /F');
      process.exit(1);
    }
  } else {
    // 端口上没东西 = 直接启动；真被别的程序占着的话，
    // 服务端自己会打印那段能照做的 EADDRINUSE 提示，不必在这里猜。
    console.log(`  没有 ${PID_FILE}，${PORT} 端口上也没有本项目的服务端响应，直接启动。`);
  }
}

// ── ③ 起来 ──
console.log('\n  启动新服务端…\n');
const child = spawn(process.execPath, ['scripts/run.mjs', 'src/server/index.ts'], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
