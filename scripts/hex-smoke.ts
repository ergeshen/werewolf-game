/** 海克斯大乱斗的真实 WebSocket 冒烟测试。服务端需先启动。 */
import assert from 'node:assert/strict';

import { BotClient } from './lib/bot.ts';

const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const bots = Array.from({ length: 12 }, (_, index) =>
  new BotClient(`海克斯${index + 1}`, { autoPlay: false }),
);

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`等待超时：${label}`));
      setTimeout(tick, 30);
    };
    tick();
  });
}

try {
  await Promise.all(bots.map((bot) => bot.connect(WS_URL)));
  const host = bots[0]!;
  host.send({ t: 'room.create', nickname: host.nickname });
  await waitFor(() => host.room !== null, 5_000, '创建大厅');
  const roomId = host.room!.roomId;
  for (const bot of bots.slice(1)) bot.send({ t: 'room.join', roomId, nickname: bot.nickname });
  await waitFor(() => bots.every((bot) => bot.room?.playerCount === 12), 5_000, '12 人加入');

  host.send({ t: 'room.mode', mode: 'HEX_CHAOS' });
  await waitFor(() => bots.every((bot) => bot.room?.mode === 'HEX_CHAOS'), 5_000, '模式切换');
  assert.match(host.room!.boardSummary, /海克斯大乱斗/);
  assert.equal(host.room!.roleWish.paused, true);

  for (const bot of bots.slice(1)) bot.send({ t: 'room.ready', ready: true });
  await waitFor(() => host.room?.canStart === true, 5_000, '全员就绪');
  host.send({ t: 'game.start' });
  await waitFor(() => bots.every((bot) => bot.room?.hexDraft !== null), 5_000, '私密三选一');
  assert.ok(bots.every((bot) => bot.room!.hexDraft!.options.length === 3));
  const offered = new Set(bots.flatMap((bot) => bot.room!.hexDraft!.options));
  assert.ok(offered.has('MECHANICAL_WOLF') && offered.has('MASK'), '海克斯狼池应包含机械狼与假面');

  bots[1]!.send({ t: 'room.hexSkip' });
  await waitFor(() => bots[1]!.errors.some((error) => error.startsWith('NOT_HOST')), 3_000, '非房主跳过被拒绝');

  for (const bot of bots) {
    bot.send({ t: 'room.hexChoose', role: bot.room!.hexDraft!.options[0]! });
  }
  await waitFor(() => bots.every((bot) => Boolean(bot.game?.me)), 8_000, '海克斯发牌');
  const wolfCount = bots.filter((bot) => bot.game!.me!.camp === 'WOLF').length;
  assert.ok(wolfCount >= 3, `至少应有 3 狼，实际 ${wolfCount}`);
  assert.ok(wolfCount < bots.length / 2, `狼人必须少于总人数一半，实际 ${wolfCount}`);
  assert.ok(bots.every((bot) => bot.room?.mode === 'HEX_CHAOS'));
  console.log(`  ✔ 12 人均收到私密三选一，最终 ${wolfCount} 狼（范围 3–5）`);
  console.log('  ✔ 非房主不能提前结束选牌，海克斯冻结普通连败愿望');
  console.log('\n✨ 海克斯大乱斗冒烟测试通过\n');
} finally {
  for (const bot of bots) bot.close();
}
