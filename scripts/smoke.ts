/**
 * 端到端冒烟测试：12 个真实 WebSocket 客户端连上正在运行的服务端，打完一整局。
 *
 * 用法（需要服务端已经在跑，并且把阶段时间压短）：
 *   终端 A:  $env:WEREWOLF_TIMEOUT_SCALE='0.05'; npm start
 *   终端 B:  npm run smoke
 *
 * 它验证单元测试覆盖不到的那一层：
 *   - 房间创建 / 12 人入座 / 房主权限 / 房主开局
 *   - 断线重连后是否还能回到原来的座位（微信切后台的核心场景）
 *   - 每个客户端收到的个性化视图是否正确（信息隔离审计）
 *   - 阶段定时器能否把整局推到底
 *   - 结算时是否才公开全场身份
 */

import assert from 'node:assert/strict';

import { BotClient } from './lib/bot.ts';
import { cloneBoard, presetById, type Role } from '../src/shared/roles.ts';

const PORT = Number(process.env.WEREWOLF_PORT ?? 5180);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const PLAYER_COUNT = 12;
const GOD_ROLES: Role[] = ['SEER', 'WITCH', 'HUNTER', 'IDIOT'];

/**
 * 所有客户端放在模块作用域，保证失败时也能关闭它们。
 * 否则 Node 的 WebSocket 会一直吊着事件循环，进程不退出 ——
 * 表现就是「测试卡住」，而真正的报错被埋掉。
 */
const bots: BotClient[] = [];

function cleanup(): void {
  for (const bot of bots) bot.close();
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`等待超时（${label}，已等 ${Math.round((Date.now() - started) / 1000)}s）`));
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

function pass(label: string): void {
  console.log(`  \u2714 ${label}`);
}

async function main(): Promise<void> {
  console.log(`\n连接服务端 ${WS_URL}\n`);

  for (let i = 1; i <= PLAYER_COUNT; i++) {
    // wolfKingSelfDestruct 对普通狼人无效；只有真的拿到白狼王那张牌的机器人会自爆。
    // 这样第二个场景不用去猜谁是白狼王。
    bots.push(
      new BotClient(`玩家${i}`, {
        wolfKingSelfDestruct: true,
        // 玩家1 是房主：端到端测试里没人替他按按钮，得让机器人自己按，
        // 白天没有计时器的过场阶段也得由他推 —— 否则整局停在天亮。
        autoBeginNight: i === 1,
        autoAdvanceDay: i === 1,
      }),
    );
  }
  await Promise.all(bots.map((b) => b.connect(WS_URL)));
  pass(`${PLAYER_COUNT} 个客户端已连接`);

  // 阶段流转可视化：卡住时能立刻看出停在哪一步
  let lastTrail = '';
  const trailTimer = setInterval(() => {
    const g = bots[0]?.game;
    if (!g) return;
    const trail = `第${g.day}天 ${g.phase}`;
    if (trail === lastTrail) return;
    lastTrail = trail;
    console.log(`     · ${trail}（已出局 ${g.deaths.length} 人，日志 ${g.log.length} 条）`);
  }, 400);
  trailTimer.unref();

  // ① 建房
  const host = bots[0]!;
  host.send({ t: 'room.create', nickname: host.nickname });
  await waitFor(() => host.room !== null, 8_000, '创建房间');
  const roomId = host.room!.roomId;
  assert.equal(roomId.length, 6, '房间号应为 6 位');
  pass(`房间已创建：${roomId}`);

  // ② 其余 11 人加入
  for (const bot of bots.slice(1)) {
    bot.send({ t: 'room.join', roomId, nickname: bot.nickname });
  }
  await waitFor(
    () => bots.every((b) => b.room?.playerCount === PLAYER_COUNT),
    8_000,
    '12 人入座',
  );
  const seats = new Set(bots.map((b) => b.seat));
  assert.equal(seats.size, PLAYER_COUNT, '12 个人应该坐在 12 个不同座位上');
  assert.ok(!seats.has(null), '每个人都应该有座位号');
  pass('12 人入座，座位号互不重复（1-12）');

  // ②·四 版型校验：角色总数不对时必须拦住开局，并告诉房主差多少
  const badBoard = cloneBoard(presetById('12-classic-white-idiot')!.board);
  badBoard.roles.VILLAGER = 3; // 总数变成 11，比 12 人少 1
  host.send({ t: 'room.board', board: badBoard });
  await waitFor(() => (host.room?.boardErrors.length ?? 0) > 0, 5_000, '版型错误下发');
  assert.ok(
    host.room!.boardErrors.some((m) => /少了 1 人/.test(m)),
    `应提示「少了 1 人」，实际：${host.room!.boardErrors.join(' / ')}`,
  );
  assert.equal(host.room!.canStart, false, '版型不合法时不应允许开局');
  host.send({ t: 'game.start' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(host.game, null, '版型不合法时开局应失败');
  host.errors.length = 0;
  pass('版型校验：角色总数少 1 人 → 拦住开局并提示「少了 1 人」');

  // 非房主不能改版型
  bots[1]!.send({ t: 'room.board', board: badBoard });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(
    bots[1]!.errors.some((e) => e.startsWith('NOT_HOST')),
    '非房主改版型应被拒绝',
  );
  bots[1]!.errors.length = 0;
  pass('权限校验：非房主不能改版型（NOT_HOST）');

  // 改回合法版型
  host.send({ t: 'room.board', board: cloneBoard(presetById('12-classic-white-idiot')!.board) });
  await waitFor(() => (host.room?.boardErrors.length ?? 1) === 0, 5_000, '版型恢复合法');
  assert.ok(
    host.room!.boardSummary.includes('预言家'),
    `版型摘要应包含神职：${host.room!.boardSummary}`,
  );
  pass(`改回合法版型：${host.room!.boardSummary}`);

  // ②·五 全员就绪：现在「坐满」不等于「能开局」，还要除房主外所有人点就绪
  assert.equal(host.room!.canStart, false, '还没人就绪时房主不应该能开局');
  assert.ok(
    host.room!.notReadySeats.length === PLAYER_COUNT - 1,
    `应有 ${PLAYER_COUNT - 1} 人未就绪，实际 ${host.room!.notReadySeats.length}`,
  );

  // 先让一个人就绪，再验证房主仍然开不了局
  bots[1]!.send({ t: 'room.ready', ready: true });
  await waitFor(() => (host.room?.notReadySeats.length ?? 99) === PLAYER_COUNT - 2, 5_000, '1 人就绪');
  host.send({ t: 'game.start' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(host.game, null, '还有人没就绪时不应该能开局');
  assert.ok(
    host.errors.some((e) => e.startsWith('NOT_READY')),
    '未全员就绪时开局应收到 NOT_READY 错误',
  );
  host.errors.length = 0;
  pass('就绪校验：还有人没就绪时房主开不了局（NOT_READY）');

  // 剩下的人全部就绪
  for (const bot of bots.slice(2)) {
    bot.send({ t: 'room.ready', ready: true });
  }
  await waitFor(() => host.room?.canStart === true, 5_000, '全员就绪');
  pass('全员就绪后房主可以开局');

  // ③ 断线重连：验证 token 能把人放回原座位
  const reconnecting = bots[5]!;
  const seatBefore = reconnecting.seat;
  const tokenBefore = reconnecting.token;
  reconnecting.close();
  await new Promise((r) => setTimeout(r, 200));
  await reconnecting.connect(WS_URL, tokenBefore);
  await waitFor(() => reconnecting.seat === seatBefore, 8_000, '断线重连后回到原座位');
  assert.ok(tokenBefore.length > 0, '服务端应下发 resumeToken');
  pass(`断线重连：${reconnecting.nickname} 用原 token 回到了 ${seatBefore} 号座位`);

  // ④ 非房主不能开局
  bots[1]!.send({ t: 'game.start' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bots[1]!.game, null, '非房主不应能开始游戏');
  assert.ok(
    bots[1]!.errors.some((e) => e.startsWith('NOT_HOST')),
    '非房主开局应收到 NOT_HOST 错误',
  );
  bots[1]!.errors.length = 0; // 这条是预期内的，后面不再统计
  pass('权限校验：非房主开局被拒绝（NOT_HOST）');

  // ⑤ 房主开局
  host.send({ t: 'game.start' });
  await waitFor(() => bots.every((b) => b.game !== null), 8_000, '发牌');
  pass('房主开局，12 人收到各自的身份');

  // ⑥ 牌型与狼队协作信息
  const wolves = bots.filter((b) => b.game!.me?.role === 'WOLF');
  const villagers = bots.filter((b) => b.game!.me?.role === 'VILLAGER');
  const roles = new Set(bots.map((b) => b.game!.me?.role));
  assert.equal(wolves.length, 4, `应有 4 名狼人，实际 ${wolves.length}`);
  assert.equal(villagers.length, 4, `应有 4 名平民，实际 ${villagers.length}`);
  for (const r of GOD_ROLES) assert.ok(roles.has(r), `缺少神职 ${r}`);
  pass('牌型正确：4 狼 + 4 民 + 预言家/女巫/猎人/白痴');

  const wolfSeats = wolves.map((b) => b.game!.me!.seat).sort((a, b) => a - b);
  for (const w of wolves) {
    const expected = wolfSeats.filter((s) => s !== w.game!.me!.seat);
    assert.deepEqual(
      w.game!.me!.teammates?.slice().sort((a, b) => a - b),
      expected,
      '狼人应看到其余 3 名狼队友',
    );
  }
  pass(`狼队协作信息正确：狼人互见队友（${wolfSeats.join('、')} 号）`);

  // ⑦ 跑完整局
  await waitFor(
    () => bots.every((b) => b.game?.phase === 'GAME_OVER'),
    120_000,
    '整局跑到结束',
  );
  const finished = host.game!;
  assert.ok(finished.outcome !== null, '结束后应有 outcome');
  pass(`整局跑完：第 ${finished.day} 天结束，结果 ${finished.outcome}`);

  // ⑧ 复盘信息
  assert.ok(finished.revealAll, '结束后应下发全场身份');
  assert.equal(finished.revealAll!.length, PLAYER_COUNT, '复盘应有 12 行');
  assert.equal(
    finished.revealAll!.filter((r) => r.role === 'WOLF').length,
    4,
    '复盘里应有 4 名狼人',
  );
  pass('复盘已公开：12 行身份，其中 4 名狼人');

  // ⑨ 汇总审计结果
  const violations = bots.flatMap((b) => b.obs.roleVisibilityViolations);
  assert.deepEqual(violations, [], `身份隔离被破坏：\n${violations.join('\n')}`);

  assert.equal(bots.some((b) => b.obs.wolfVotesLeaked), false, '狼队点刀泄露给了非狼玩家');
  assert.equal(bots.some((b) => b.obs.witchInfoLeaked), false, '女巫刀口泄露给了非女巫玩家');
  pass('信息隔离通过：非狼看不到狼队点刀，非女巫看不到刀口');

  assert.ok(bots.some((b) => b.obs.witchSawTarget), '女巫理应看到过至少一次刀口');
  assert.ok(bots.some((b) => b.obs.seerGotResult), '预言家理应至少查验成功一次');
  pass('角色能力生效：女巫看到过刀口，预言家拿到过查验结果');

  const seen = new Set<string>();
  for (const b of bots) for (const p of b.obs.phasesSeen) seen.add(p);
  const required = [
    'NIGHT_WOLVES',
    'NIGHT_WITCH',
    'NIGHT_SEER',
    'NIGHT_RESOLVE',
    'DAY_ANNOUNCE',
    'DAY_VOTE',
    'DAY_EXILE',
    'GAME_OVER',
  ];
  const missing = required.filter((p) => !seen.has(p));
  assert.deepEqual(missing, [], `这些阶段没出现过：${missing.join(',')}`);
  pass(`全部阶段都跑到过（共 ${seen.size} 个阶段）`);

  const maxDeadline = Math.max(...bots.map((b) => b.obs.maxDeadlineGapMs));
  assert.ok(maxDeadline > 0, '阶段应有倒计时 deadline');
  pass(`倒计时生效：最长剩余 ${(maxDeadline / 1000).toFixed(1)}s`);

  const unexpected = bots.flatMap((b) => b.errors);
  assert.deepEqual(unexpected, [], `出现预期外的错误：\n${unexpected.join('\n')}`);
  pass('全程没有出现预期外的协议错误');

  // ⑩ 第二个场景：白狼王局 —— 把「切版型 + 守卫阶段 + 白狼王自爆带人」的完整链路跑一遍
  console.log('\n  ── 场景二：12 人白狼王局 ──');

  // 保存第一场并回到同一个大厅；下一次开局应自动成为第 2 场。
  host.send({ t: 'room.closeMatch' });
  await waitFor(() => host.room?.status === 'LOBBY', 8_000, '回到大厅');

  host.send({ t: 'room.board', board: cloneBoard(presetById('12-wolf-king')!.board) });
  await waitFor(() => (host.room?.board.roles.WOLF_KING ?? 0) === 1, 8_000, '切换为白狼王版型');
  assert.equal(host.room!.board.playerCount, 12);
  assert.deepEqual(host.room!.boardErrors, [], '白狼王预设不应有校验错误');
  assert.ok(
    host.room!.boardSummary.includes('白狼王'),
    `版型摘要应含白狼王：${host.room!.boardSummary}`,
  );
  pass(`版型已切换到白狼王局：${host.room!.boardSummary}`);

  // 换版型会清空就绪状态，需要所有人重新确认（这是有意的：版型都变了）
  assert.equal(host.room!.canStart, false, '换版型后应需要重新就绪');
  for (const bot of bots.slice(1)) {
    bot.send({ t: 'room.ready', ready: true });
  }
  await waitFor(() => host.room?.canStart === true, 8_000, '第二局全员就绪');
  pass('换版型后重新就绪 → 房主可以开局');

  // 只看第二局的观察数据
  for (const bot of bots) {
    bot.obs.phasesSeen.clear();
    bot.errors.length = 0;
  }

  host.send({ t: 'game.start' });
  await waitFor(() => bots.every((b) => b.game !== null), 8_000, '第二局发牌');

  const kingBot = bots.find((b) => b.game?.me?.role === 'WOLF_KING');
  const guardBot = bots.find((b) => b.game?.me?.role === 'GUARD');
  assert.ok(kingBot, '白狼王局里必须有一名白狼王');
  assert.ok(guardBot, '白狼王版型里必须有守卫');
  assert.equal(kingBot.game!.me!.camp, 'WOLF', '白狼王必须是狼人阵营');
  pass(
    `第二局牌型抽查：白狼王=${kingBot.nickname}（${kingBot.game!.me!.seat} 号），守卫=${guardBot.nickname}`,
  );

  await waitFor(
    () => bots.every((b) => b.game?.phase === 'GAME_OVER'),
    120_000,
    '第二局跑完',
  );

  const finisher = host.game!;
  const seen2 = new Set<string>();
  for (const b of bots) for (const p of b.obs.phasesSeen) seen2.add(p);

  /**
   * 守卫阶段不一定出现：如果守卫第 1 夜就被狼刀死，引擎会**正确地**跳过它。
   * 所以断言写成「要么出现过守卫阶段，要么守卫确实第 1 夜就出局了」——
   * 只断言「必须出现」会变成偶发失败（这个坑我踩过一次）。
   */
  const guardSeat = guardBot.game!.me!.seat;
  const guardDiedNight1 = finisher.deaths.some((d) => d.seat === guardSeat && d.day === 1);
  if (seen2.has('NIGHT_GUARD')) {
    pass('第二局出现过守卫阶段');
  } else {
    assert.ok(
      guardDiedNight1,
      `既没看到守卫阶段，守卫（${guardSeat} 号）也不是第 1 天出局的 —— 说明守卫阶段被错误跳过了`,
    );
    pass(`守卫（${guardSeat} 号）第 1 天就出局，守卫阶段被正确跳过`);
  }

  // 诊断信息：万一白狼王没炸成，得能一眼看出是「没活到投票」还是「炸了但被拒」
  const kingSeat = kingBot.game!.me!.seat;
  const kingDeath = finisher.deaths.find((d) => d.seat === kingSeat);
  const kingErrors = kingBot.errors.filter((e) => !e.startsWith('BAD_PHASE'));

  assert.ok(
    seen2.has('WOLF_KING_BOOM'),
    `第二局应该出现白狼王自爆阶段，实际出现：${[...seen2].sort().join(', ')}\n` +
      `  白狼王：${kingSeat} 号\n` +
      `  出局情况：${kingDeath ? `第 ${kingDeath.day} 天 ${kingDeath.cause}` : '（从未出局）'}\n` +
      `  该机器人收到的非 BAD_PHASE 错误：${kingErrors.length > 0 ? kingErrors.join(' | ') : '（无）'}`,
  );
  pass('第二局白狼王自爆阶段真实发生过');
  pass('第二局跑完：版型切换、就绪、守卫、自爆带人链路都验证到了');

  assert.ok(finisher.revealAll, '第二局结束后应下发全场身份');
  assert.equal(finisher.revealAll!.length, 12);
  const boomRecords = finisher.deaths.filter((d) => d.cause === 'EXPLODE' || d.cause === 'BLAST');
  assert.ok(boomRecords.length >= 1, '战报里应有「自爆」或「被白狼王带走」的记录');
  assert.ok(
    boomRecords.every((d) => typeof d.day === 'number'),
    '复盘里每条死亡记录都应带「第几天」',
  );
  pass(
    `白狼王链路验证：${boomRecords.length} 条自爆/带走记录（` +
      boomRecords.map((d) => `${d.seat}号@第${d.day}天`).join('、') +
      '）',
  );

  // 第二局里其他玩家可能在自爆之后才提交投票，那是相位已变的正常拒绝
  const leftover = bots
    .flatMap((b) => b.errors)
    .filter((e) => !e.startsWith('BAD_PHASE') && !e.startsWith('ALREADY_DONE'));
  assert.deepEqual(leftover, [], `第二局出现预期外的错误：\n${leftover.join('\n')}`);
  pass('第二局没有出现预期外的协议错误（自爆引起的 BAD_PHASE 属正常）');

  clearInterval(trailTimer);
  cleanup();
  console.log('\n\u2728 端到端冒烟测试全部通过\n');
}

// 总看门狗：任何一步卡住都要能退出并把日志留下来
const watchdog = setTimeout(() => {
  console.error('\n\u274c 冒烟测试总超时（180s），强制退出');
  cleanup();
  process.exit(1);
}, 180_000);
watchdog.unref();

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('\n\u274c 冒烟测试失败：');
    console.error(error instanceof Error ? error.message : error);
    cleanup();
    process.exit(1);
  });
