/**
 * 统一启动器。
 *
 * 存在的唯一理由：**Node 版本守卫必须在 .mjs 文件里**。
 *
 * 服务端和测试脚本用 Node 内置的 TypeScript 类型擦除直接运行 .ts，
 * 这个能力要 Node >= 22.18。如果版本不够，Node 连 .ts 文件都加载不了，
 * 报的是 ERR_UNKNOWN_FILE_EXTENSION 或者一堆语法错误——
 * 用户完全看不懂，也想不到是 Node 版本问题。
 *
 * 把这个检查放进 .mjs（任何 Node 都能跑），就能在加载 .ts 之前
 * 给出一句人能看懂的提示。
 *
 * 顺带把 TS 的 ExperimentalWarning 静音掉，这样 npm 脚本里
 * 不需要再写 --disable-warning 参数（老版本 Node 不认这个参数，
 * 反而会报 "bad option"）。
 *
 * 用法：node scripts/run.mjs <要运行的 .ts 文件> [传给它的参数...]
 */

const MIN_HINT = '22.18';

const current = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
const major = current[0] ?? 0;
const minor = current[1] ?? 0;

/**
 * 各版本线开始默认支持 TypeScript 类型擦除的起点：
 *   v22.18+   （backport）
 *   v23.6+
 *   v24+
 * 逐条写清楚而不是用 `major > 22`，是为了避免误拦：
 * 守卫判错的代价比没有守卫更大（会把能跑的版本挡住）。
 */
const supported =
  (major === 22 && minor >= 18) || (major === 23 && minor >= 6) || major >= 24;

if (!supported) {
  const line = '─'.repeat(64);
  console.error(`\n${line}`);
  console.error('  Node 版本太低，无法启动');
  console.error(line);
  console.error(`  当前版本: v${process.versions.node}`);
  console.error(`  需要版本: v${MIN_HINT} / v23.6 及以上 / v24+（推荐 v24 LTS）`);
  console.error('');
  console.error('  为什么需要这么新的版本：');
  console.error('  本项目的前后端都用 TypeScript 写，但**不需要编译**——');
  console.error('  直接靠 Node 内置的类型擦除功能运行 .ts 文件。');
  console.error(`  这个功能在 Node v${MIN_MAJOR}.${MIN_MINOR} 才默认开启。`);
  console.error('');
  console.error('  怎么升级（任选一种）：');
  console.error('    1) 官网下载安装包（最省事）：https://nodejs.org/zh-cn');
  console.error('    2) 用 nvm 管理多版本：');
  console.error('         nvm install 24');
  console.error('         nvm use 24');
  console.error('    3) 服务器上（Ubuntu/Debian）：');
  console.error('         curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -');
  console.error('         sudo apt-get install -y nodejs');
  console.error('');
  console.error('  升级后执行 node -v 确认版本，再重新运行。');
  console.error(`${line}\n`);
  process.exit(1);
}

// 静音 TypeScript 相关的实验性警告（不影响其它警告）
const originalEmit = process.emit.bind(process);
process.emit = function patchedEmit(event, ...rest) {
  if (event === 'warning') {
    const warning = rest[0];
    if (warning && typeof warning === 'object' && warning.name === 'ExperimentalWarning') {
      return false;
    }
  }
  return originalEmit(event, ...rest);
};

const args = process.argv.slice(2);
const target = args.shift();

if (!target) {
  console.error('用法: node scripts/run.mjs <要运行的 .ts 文件> [参数...]');
  console.error('例如: node scripts/run.mjs src/server/index.ts');
  process.exit(1);
}

// 让目标脚本看到的 process.argv 和直接运行它时一致，
// 这样 scripts/bots.ts 里的 process.argv[2] 拿到的仍然是房间号
process.argv = [process.argv[0] ?? 'node', target, ...args];

try {
  await import(new URL(`../${target}`, import.meta.url).href);
} catch (error) {
  // 把「模块找不到」这类错误翻译成人话
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) {
    console.error(`\n找不到要运行的文件：${target}`);
    console.error('请确认你在项目根目录下运行，且路径拼写正确。\n');
    process.exit(1);
  }
  throw error;
}
