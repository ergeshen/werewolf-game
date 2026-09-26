/**
 * 机器人填房：给指定房间塞进指定数量的机器人。
 *
 * 用途：你一个人也能把 12 人局跑起来，先把流程、界面、定时器都验证一遍，
 * 确认没问题了再喊 11 个朋友进来。
 *
 * 用法：
 *   1) 先在浏览器里创建房间，记下 6 位房间号
 *   2) 终端执行：  npm run bots -- AB3D7K        （默认 11 个机器人）
 *                   npm run bots -- AB3D7K 5      （只要 5 个）
 *   3) 回到浏览器点「开始游戏」
 *
 * 机器人会自动出牌（狼刀、女巫不用药、预言家验人、白天投票），
 * 所以整局会自己往前推进。按 Ctrl+C 退出。
 */

import { BotClient } from './lib/bot.ts';

const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const roomId = (process.argv[2] ?? '').trim().toUpperCase();
const count = Math.min(Math.max(Number(process.argv[3] ?? 11) || 11, 1), 11);

if (roomId.length !== 6) {
  console.error('用法: npm run bots -- <6位房间号> [机器人数量，1-11]');
  console.error('示例: npm run bots -- AB3D7K 11');
  process.exit(1);
}

console.log(`\n给房间 ${roomId} 加入 ${count} 个机器人…\n`);

const bots: BotClient[] = [];
let lastTrail = '';

for (let i = 1; i <= count; i++) {
  const bot = new BotClient(`机器人${i}`, {
    onUpdate: (self) => {
      const game = self.game;
      if (!game) return;
      const trail = `第${game.day}天 ${game.phase}`;
      if (trail === lastTrail) return;
      lastTrail = trail;
      console.log(`  [${trail}] ${game.phaseTitle} —— ${game.phaseHint}`);
    },
  });
  bots.push(bot);
}

try {
  await Promise.all(bots.map((b) => b.connect(WS_URL)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

for (const bot of bots) {
  bot.send({ t: 'room.join', roomId, nickname: bot.nickname });
}

// 等一会儿让入座结果稳定下来
await new Promise((r) => setTimeout(r, 1_200));

const seated = bots.filter((b) => b.seat !== null).length;
const failed = bots.filter((b) => b.seat === null);

if (seated === 0) {
  console.error(`\n没有任何机器人进入房间 ${roomId}。`);
  console.error('可能原因：房间号打错了、房间已经满员、或者游戏已经开始。');
  for (const bot of bots) bot.close();
  process.exit(1);
}

console.log(`\n已入座 ${seated} / ${count} 个机器人（座位 ${bots.map((b) => b.seat).filter((s) => s !== null).join('、')}）`);
if (failed.length > 0) {
  console.log(`有以下 ${failed.length} 个没进去：${failed.map((b) => b.nickname).join('、')}`);
  console.log('通常是房间已经满 12 人 —— 剩下的位置留给真人就好。');
}
console.log('\n现在回到浏览器点「开始游戏」。机器人会自动出牌。');
console.log('按 Ctrl+C 结束。\n');

function shutdown(): void {
  console.log('\n正在断开机器人…');
  for (const bot of bots) bot.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
