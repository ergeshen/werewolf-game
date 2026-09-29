/**
 * 节奏实测：把「配置的秒数」和「真人实际感受到的秒数」对一遍。
 *
 * 为什么需要这个脚本：
 *
 * 夜间时长是这个项目最重要的公平性设计（时间不能携带信息），
 * 而「狼人到底有没有 90 秒」「最后 5 秒有没有真的倒数」这两件事
 * 靠 12 个人盯手机掐表来验证太贵了 —— 而且人手掐表本身就有 1-2 秒误差。
 *
 * 这里用一群机器人跑一局，在每个阶段切换的瞬间打时间戳，
 * 最后打一张「配置 vs 实测」的表。改完 PHASE_TIMEOUT_MS 跑一次就知道有没有到位。
 *
 * 它会自己建房、自己就绪、自己开局，不碰你浏览器里的房间。
 *
 * 用法（服务端要已经在跑）：
 *   npm run pace                        # 默认 12 人 · 五神全开（含守卫，四个夜间阶段都能测到）
 *   npm run pace -- 12 12-classic-white-idiot
 *   npm run pace -- 8 8-small
 */

import { PHASE_TIMEOUT_MS } from '../src/shared/engine.ts';
import type { Phase } from '../src/shared/protocol.ts';
import { cloneBoard, presetById } from '../src/shared/roles.ts';
import { BotClient } from './lib/bot.ts';

const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const players = Math.min(Math.max(Number(process.argv[2] ?? 12) || 12, 6), 12);

/**
 * 默认用「五神全开」而不是「预女猎白」。
 *
 * 因为预女猎白里**没有守卫**，测不到 NIGHT_GUARD —— 而守卫阶段恰好是
 * 之前被错误跳过、最需要盯着的那一个。四个夜间角色阶段要一次性全测到。
 */
const presetId = (process.argv[3] ?? '12-full-gods').trim();
const preset = presetById(presetId);
if (!preset) {
  console.error(`没有这个预设：${presetId}`);
  process.exit(1);
}

/** 测到这些阶段结束后就收工 —— 再往后是重复的夜晚，没有新信息 */
const STOP_AFTER: ReadonlySet<Phase> = new Set<Phase>(['DAY_EXILE']);

interface PhaseSpan {
  day: number;
  phase: Phase;
  enteredAt: number;
  leftAt: number | null;
}

const spans: PhaseSpan[] = [];
let current: PhaseSpan | null = null;

/** 夜间阶段里看到过的倒数值（验证最后 5 秒真的有倒数） */
const countdownsSeen = new Map<string, number[]>();

/**
 * 只让**一个**机器人当观察者。
 *
 * 踩过的坑：一开始让 12 个机器人各自打时间戳，结果每个客户端收到阶段切换
 * 都有几十毫秒的先后差 —— 观察者 A 还在 NIGHT_WOLVES、观察者 B 已经进了
 * NIGHT_WITCH，两边交替上报，看起来就像"阶段反复重来"，
 * 报告里刷出一百行 `NIGHT_WOLVES 实测 0.0s ← 偏差过大`。
 *
 * 从同一个客户端看整条时间线，才是玩家实际感受到的节奏。
 */
const bots: BotClient[] = [
  new BotClient('房主', {
    onUpdate: (self) => {
      const game = self.game;
      if (!game) return;
      observe(game.day, game.phase, game.countdown);
    },
  }),
];
for (let i = 2; i <= players; i++) {
  bots.push(new BotClient(`测量${i}`));
}

const host = bots[0]!;

function observe(day: number, phase: Phase, countdown: number | null): void {
  if (!current || current.phase !== phase || current.day !== day) {
    const now = Date.now();
    if (current && current.leftAt === null) current.leftAt = now;
    current = { day, phase, enteredAt: now, leftAt: null };
    spans.push(current);
  }
  if (countdown !== null) {
    const key = `${day}:${phase}`;
    const seen = countdownsSeen.get(key) ?? [];
    if (!seen.includes(countdown)) seen.push(countdown);
    countdownsSeen.set(key, seen);
  }
}

function cleanup(code: number): never {
  for (const bot of bots) bot.close();
  process.exit(code);
}

// 兜底：万一卡住了也要退出，别挂死终端
const watchdog = setTimeout(() => {
  console.error('\n❌ 超时：等了 12 分钟还没测完，先退出。');
  printReport(false);
  cleanup(1);
}, 12 * 60_000);
watchdog.unref();

console.log(`\n创建房间，塞进 ${players} 个机器人…`);

try {
  await Promise.all(bots.map((b) => b.connect(WS_URL)));
} catch (error) {
  console.error(
    `连接服务端失败（${WS_URL}）：${error instanceof Error ? error.message : String(error)}`,
  );
  console.error('先确认服务端在跑：npm start');
  cleanup(1);
}

host.send({ t: 'room.create', nickname: host.nickname });
await waitFor(() => host.room !== null, 8_000, '创建房间');

const roomId = host.room!.roomId;
console.log(`房间号 ${roomId}，其他人入座…`);

// 切成要测的版型（换版型会清空就绪状态，所以必须放在就绪之前）
host.send({ t: 'room.board', board: cloneBoard(preset.board) });
await waitFor(() => host.room?.boardErrors.length === 0, 8_000, '版型生效');
console.log(`版型：${host.room!.boardSummary}`);

for (const bot of bots.slice(1)) {
  bot.send({ t: 'room.join', roomId, nickname: bot.nickname });
}
await waitFor(() => bots.every((b) => b.seat !== null), 10_000, '全员入座');

for (const bot of bots.slice(1)) {
  bot.send({ t: 'room.ready', ready: true });
}
await waitFor(() => host.room?.canStart === true, 8_000, '全员就绪');

console.log('开局，开始计时……\n');
host.send({ t: 'game.start' });
await waitFor(() => bots.every((b) => b.game !== null), 8_000, '发牌');

// 等测完第一个白天
await waitFor(
  () => spans.some((s) => STOP_AFTER.has(s.phase) && s.leftAt !== null),
  11 * 60_000,
  '跑完第一个白天',
);

printReport(true);
cleanup(0);

// ────────────────────────── 工具 ──────────────────────────

function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待「${what}」超时（${(timeoutMs / 1000).toFixed(0)}s）`));
      }
    }, 100);
    timer.unref();
  });
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function printReport(complete: boolean): void {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(complete ? '  节奏实测结果' : '  节奏实测结果（未跑完，仅供参考）');
  console.log('──────────────────────────────────────────────────────────');
  console.log('  阶段                          配置      实测      误差');
  console.log('  ────────────────────────────  ────────  ────────  ────────');

  let worst = 0;
  for (const span of spans) {
    if (span.leftAt === null) continue;
    const actual = span.leftAt - span.enteredAt;
    const expected = PHASE_TIMEOUT_MS[span.phase];

    // 白天阶段是「行动齐了就推进」，本来就该比配置短；只有夜间阶段必须走满
    const mustMatch = Number.isFinite(expected) && span.phase.startsWith('NIGHT_');
    const diff = actual - expected;
    const bad = mustMatch && Math.abs(diff) > 1200;
    if (bad) worst = Math.max(worst, Math.abs(diff));

    const label = `第${span.day}天 ${span.phase}`;
    console.log(
      `  ${label.padEnd(30)}` +
        `${Number.isFinite(expected) ? fmt(expected).padStart(8) : '     n/a'}` +
        `${fmt(actual).padStart(10)}` +
        `${(mustMatch ? `${diff >= 0 ? '+' : ''}${fmt(diff)}` : '   —').padStart(10)}` +
        `${bad ? '  ← 偏差过大' : ''}`,
    );
  }

  console.log('\n  最后 5 秒倒数（夜间阶段应当出现 5、4、3、2、1）：');
  const nightCountdowns = [...countdownsSeen.entries()].filter(([key]) =>
    key.split(':')[1]!.startsWith('NIGHT_'),
  );
  if (nightCountdowns.length === 0) {
    console.log('    ⚠ 没有观察到任何倒数值 —— 倒数可能没生效');
    worst = Math.max(worst, 9999);
  }
  for (const [key, values] of nightCountdowns) {
    const sorted = values.slice().sort((a, b) => b - a);
    console.log(`    ${key.padEnd(22)} → ${sorted.join(' ')}`);
  }

  console.log('');
  if (worst === 0) {
    console.log('  ✅ 夜间阶段全部走满配置时长，倒数正常。');
  } else {
    console.log(`  ❌ 有阶段偏差超过 1.2 秒（最大 ${fmt(worst)}）—— 需要检查定时器。`);
  }

  // 一夜到底多久 —— 这是约人开局时必须知道的数字
  const nightPhases = spans.filter((s) => s.leftAt !== null && s.phase.startsWith('NIGHT_'));
  if (nightPhases.length > 0) {
    const nightTotal = nightPhases.reduce((sum, s) => sum + (s.leftAt! - s.enteredAt), 0);
    const byDay = new Map<number, number>();
    for (const s of nightPhases) {
      byDay.set(s.day, (byDay.get(s.day) ?? 0) + (s.leftAt! - s.enteredAt));
    }
    console.log(
      `\n  一个完整夜晚（天黑 → 天亮）= ${nightTotal / 1000}s` +
        ` ≈ ${Math.floor(nightTotal / 60_000)}分${Math.round((nightTotal % 60_000) / 1000)}秒`,
    );
    console.log(
      '  拆开看：' +
        [...byDay.entries()]
          .map(([day, ms]) => `第${day}天 ${fmt(ms)}`)
          .join('、') +
        '（不含白天）',
    );
    console.log('  ⚡ 房主确认「跳过阶段」可以提前收工，实际体验通常比这个短。');
  }
  console.log('──────────────────────────────────────────────────────────\n');
}
