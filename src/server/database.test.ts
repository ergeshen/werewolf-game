import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { GameDatabase } from './database.ts';
import { defaultBoard } from '../shared/roles.ts';

let db: GameDatabase;

beforeEach(() => {
  db = new GameDatabase(':memory:');
});

afterEach(() => db.close());

test('新账号初始密码为 1，并强制首次修改', () => {
  const registered = db.register('测试玩家');
  assert.equal(registered.ok, true);
  if (!registered.ok) return;
  assert.equal(registered.value.user.mustChangePassword, true);

  assert.equal(db.login('测试玩家', '错了').ok, false);
  const login = db.login('测试玩家', '1');
  assert.equal(login.ok, true);
  if (!login.ok) return;

  const changed = db.changePassword(login.value.token, '1', 'safe1234');
  assert.equal(changed.ok, true);
  assert.equal(changed.ok && changed.value.mustChangePassword, false);
  assert.equal(db.login('测试玩家', '1').ok, false);
  assert.equal(db.login('测试玩家', 'safe1234').ok, true);
});

test('用户名忽略大小写且不能重复注册', () => {
  assert.equal(db.register('PlayerOne').ok, true);
  assert.equal(db.register('playerone').ok, false);
  assert.equal(db.login('PLAYERONE', '1').ok, true);
});

test('用户名超过 12 个字符时明确拒绝，不静默截断', () => {
  const result = db.register('1234567890123');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /最多 12/);
});

test('旧场次缺少大厅记录时仍能完成迁移并保留个人战绩', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'werewolf-orphan-migration-'));
  const file = join(tempDir, 'legacy.db');
  let legacy: GameDatabase | null = null;
  let reopened: GameDatabase | null = null;

  try {
    legacy = new GameDatabase(file);
    const registered = legacy.register('旧场次玩家');
    assert.equal(registered.ok, true);
    if (!registered.ok) return;

    const matchId = legacy.startMatch('MISSING', defaultBoard(), '旧版孤立场次', [
      {
        userId: registered.value.user.id,
        nickname: '旧场次玩家',
        seat: 1,
        role: 'VILLAGER',
        camp: 'GOOD',
      },
    ]);
    legacy.finishMatch(matchId, 'GOOD', 1, null);
    legacy.close();
    legacy = null;

    reopened = new GameDatabase(file);
    assert.equal(reopened!.history(registered.value.user.id).length, 1, '孤立场次仍保留在个人战绩中');
    assert.equal(reopened!.hallRecords(registered.value.user.id).length, 0, '不存在的大厅不应伪造为大厅记录');
  } finally {
    legacy?.close();
    reopened?.close();
    // Windows 上原生 SQLite 句柄释放到文件系统可见会有极短延迟。
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('完成的对局会进入对应账号的历史记录', () => {
  const registered = db.register('历史玩家');
  assert.equal(registered.ok, true);
  if (!registered.ok) return;

  const matchId = db.startMatch('ABC123', defaultBoard(), '测试版型', [
    {
      userId: registered.value.user.id,
      nickname: '历史玩家',
      seat: 1,
      role: 'WOLF',
      camp: 'WOLF',
    },
  ]);
  db.finishMatch(matchId, 'WOLF', 3, registered.value.user.id);

  const history = db.history(registered.value.user.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.roomId, 'ABC123');
  assert.equal(history[0]!.roleName, '狼人');
  assert.equal(history[0]!.won, true);
  assert.equal(history[0]!.score, 4, '狼人胜 3 分，悍跳获胜额外 1 分');
});

test('大厅按多场结果统计胜负、身份次数和厅主积分', () => {
  const owner = db.register('厅主玩家');
  const god = db.register('神职玩家');
  const villager = db.register('平民玩家');
  assert.ok(owner.ok && god.ok && villager.ok);
  if (!owner.ok || !god.ok || !villager.ok) return;

  const hallId = 'HALL01';
  db.createHall(hallId, owner.value.user.id);
  const first = db.startMatch(hallId, defaultBoard(), '第一场', [
    { userId: owner.value.user.id, nickname: '厅主玩家', seat: 1, role: 'WOLF', camp: 'WOLF' },
    { userId: god.value.user.id, nickname: '神职玩家', seat: 2, role: 'SEER', camp: 'GOOD' },
    { userId: villager.value.user.id, nickname: '平民玩家', seat: 3, role: 'VILLAGER', camp: 'GOOD' },
  ]);
  db.finishMatch(first, 'WOLF', 3, owner.value.user.id);

  const second = db.startMatch(hallId, defaultBoard(), '第二场', [
    { userId: owner.value.user.id, nickname: '厅主玩家', seat: 1, role: 'WOLF', camp: 'WOLF' },
    { userId: god.value.user.id, nickname: '神职玩家', seat: 2, role: 'WITCH', camp: 'GOOD' },
    { userId: villager.value.user.id, nickname: '平民玩家', seat: 3, role: 'VILLAGER', camp: 'GOOD' },
  ]);
  db.finishMatch(second, 'GOOD', 4, null);

  const ownerView = db.hallDashboard(hallId, owner.value.user.id)!;
  assert.equal(ownerView.matches.length, 2);
  assert.equal(ownerView.isOwner, true);
  const ownerStats = ownerView.players.find((row) => row.userId === owner.value.user.id)!;
  assert.deepEqual(
    { wins: ownerStats.wins, losses: ownerStats.losses, wolves: ownerStats.wolfCount, score: ownerStats.score },
    { wins: 1, losses: 1, wolves: 2, score: 4.5 },
  );
  const godStats = ownerView.players.find((row) => row.userId === god.value.user.id)!;
  assert.deepEqual(
    { wins: godStats.wins, losses: godStats.losses, gods: godStats.godCount, score: godStats.score },
    { wins: 1, losses: 1, gods: 2, score: 1.5 },
  );
  const villagerStats = ownerView.players.find((row) => row.userId === villager.value.user.id)!;
  assert.deepEqual(
    {
      wins: villagerStats.wins,
      losses: villagerStats.losses,
      villagers: villagerStats.villagerCount,
      score: villagerStats.score,
    },
    { wins: 1, losses: 1, villagers: 2, score: 1.5 },
  );

  const guestView = db.hallDashboard(hallId, god.value.user.id)!;
  assert.equal(guestView.isOwner, false);
  assert.equal(guestView.scoresRevealed, false);
  assert.equal(
    guestView.players.find((row) => row.userId === owner.value.user.id)!.score,
    undefined,
    '积分未公开时不能收到其他人的总积分',
  );
  assert.equal(
    typeof guestView.players.find((row) => row.userId === god.value.user.id)!.score,
    'number',
    '玩家仍能私下查看自己的积分',
  );
  assert.ok(
    guestView.players.filter((row) => row.userId !== god.value.user.id).every((row) => row.rank === undefined),
    '积分未公开时也不能通过 rank 字段泄露其他人的排名',
  );
  assert.ok(
    guestView.matches.every((match) =>
      match.players.filter((player) => player.userId !== god.value.user.id).every((player) => !('score' in player)),
    ),
    '普通玩家不能收到其他人的单场积分',
  );
  assert.equal(db.setHallScoresRevealed(hallId, god.value.user.id).ok, false, '参与者不能公开积分');
  assert.equal(db.setHallScoresRevealed(hallId, owner.value.user.id).ok, true);
  const revealed = db.hallDashboard(hallId, god.value.user.id)!;
  assert.equal(revealed.scoresRevealed, true);
  assert.ok(revealed.players.every((row) => typeof row.score === 'number'));

  const owned = db.ownedHalls(owner.value.user.id);
  assert.equal(owned.length, 1);
  assert.deepEqual(
    { roomId: owned[0]!.roomId, matchCount: owned[0]!.matchCount, completedCount: owned[0]!.completedCount },
    { roomId: hallId, matchCount: 2, completedCount: 2 },
  );
  assert.equal(db.ownedHalls(god.value.user.id).length, 0, '参与者不能把别人的大厅当成自己创建的大厅');
});

test('普通模式连败触发愿望，抽中或获胜重置；海克斯完全冻结', () => {
  const player = db.register('愿望玩家');
  assert.ok(player.ok);
  if (!player.ok) return;
  const userId = player.value.user.id;

  const finish = (role: 'VILLAGER' | 'SEER', won: boolean, mode: 'STANDARD' | 'HEX_CHAOS' = 'STANDARD') => {
    const id = db.startMatch('WISH01', defaultBoard(), '愿望测试', [
      { userId, nickname: '愿望玩家', seat: 1, role, camp: 'GOOD' },
    ], mode);
    db.finishMatch(id, won ? 'GOOD' : 'WOLF', 2, null);
  };

  finish('VILLAGER', false);
  finish('VILLAGER', false);
  assert.equal(db.roleWishState(userId).lossStreak, 2);
  assert.equal(db.setRoleWish(userId, 'SEER').ok, true);

  finish('VILLAGER', false, 'HEX_CHAOS');
  assert.deepEqual(db.roleWishState(userId), { lossStreak: 2, role: 'SEER' });
  finish('SEER', false);
  assert.deepEqual(db.roleWishState(userId), { lossStreak: 0, role: null }, '抽中愿望角色后即使失败也重置');

  finish('VILLAGER', false);
  finish('VILLAGER', false);
  assert.equal(db.setRoleWish(userId, 'SEER').ok, true);
  finish('VILLAGER', true);
  assert.deepEqual(db.roleWishState(userId), { lossStreak: 0, role: null }, '未抽中但获胜也重置');
});

test('混血儿按榜样阵营结算胜负，但大厅身份次数仍计入平民', () => {
  const owner = db.register('混血厅主');
  const hybrid = db.register('混血玩家');
  assert.ok(owner.ok && hybrid.ok);
  if (!owner.ok || !hybrid.ok) return;

  const hallId = 'HYBRID';
  db.createHall(hallId, owner.value.user.id);
  const matchId = db.startMatch(hallId, defaultBoard(), '混血儿结算', [
    { userId: owner.value.user.id, nickname: '混血厅主', seat: 1, role: 'WOLF', camp: 'WOLF' },
    // 开局牌面属于好人，但最终阵营会由引擎按榜样改写为狼人。
    { userId: hybrid.value.user.id, nickname: '混血玩家', seat: 2, role: 'HYBRID', camp: 'GOOD' },
  ]);
  db.finishMatch(matchId, 'WOLF', 2, null, [
    { seat: 1, camp: 'WOLF' },
    { seat: 2, camp: 'WOLF' },
  ]);

  const dashboard = db.hallDashboard(hallId, owner.value.user.id)!;
  const row = dashboard.players.find((player) => player.userId === hybrid.value.user.id)!;
  assert.deepEqual(
    { wins: row.wins, losses: row.losses, villagers: row.villagerCount, wolves: row.wolfCount, score: row.score },
    { wins: 1, losses: 0, villagers: 1, wolves: 0, score: 3 },
  );
  const history = db.history(hybrid.value.user.id)[0]!;
  assert.equal(history.won, true);
  assert.equal(history.roleName, '混血儿');
  assert.equal(history.score, 3);
});

test('只有厅主能删除场次，删除后所有玩家历史和大厅统计同步回退', () => {
  const owner = db.register('删除厅主');
  const player = db.register('删除玩家');
  assert.ok(owner.ok && player.ok);
  if (!owner.ok || !player.ok) return;
  const hallId = 'DELETE';
  db.createHall(hallId, owner.value.user.id);
  const matchId = db.startMatch(hallId, defaultBoard(), '待删除', [
    { userId: owner.value.user.id, nickname: '删除厅主', seat: 1, role: 'WOLF', camp: 'WOLF' },
    { userId: player.value.user.id, nickname: '删除玩家', seat: 2, role: 'SEER', camp: 'GOOD' },
  ]);
  db.finishMatch(matchId, 'WOLF', 2, null);

  assert.equal(db.deleteHallMatch(hallId, matchId, player.value.user.id).ok, false);
  assert.equal(db.history(player.value.user.id).length, 1);
  assert.equal(db.deleteHallMatch(hallId, matchId, owner.value.user.id).ok, true);
  assert.equal(db.history(owner.value.user.id).length, 0);
  assert.equal(db.history(player.value.user.id).length, 0);
  assert.equal(db.hallDashboard(hallId, owner.value.user.id)!.matches.length, 0);
  assert.equal(db.hallDashboard(hallId, owner.value.user.id)!.players.length, 0);
  assert.equal(db.nextMatchNumber(hallId), 1, '删除后显示场次号应重新连续编号');
});

test('提前结束会保存回顾但不进入胜负、身份次数和积分统计', () => {
  const owner = db.register('提前厅主');
  assert.equal(owner.ok, true);
  if (!owner.ok) return;
  const hallId = 'ABORT1';
  db.createHall(hallId, owner.value.user.id);
  const matchId = db.startMatch(hallId, defaultBoard(), '提前结束', [
    { userId: owner.value.user.id, nickname: '提前厅主', seat: 1, role: 'WOLF', camp: 'WOLF' },
  ]);
  db.abortMatch(matchId, 2, 'DAY_VOTE');

  const dashboard = db.hallDashboard(hallId, owner.value.user.id)!;
  assert.equal(dashboard.matches[0]!.status, 'ABORTED');
  assert.equal(dashboard.matches[0]!.endedPhase, 'DAY_VOTE');
  assert.equal(dashboard.players.length, 0);
  const history = db.history(owner.value.user.id);
  assert.equal(history[0]!.status, 'ABORTED');
  assert.equal(history[0]!.score, 0);

  const redeal = db.startMatch(hallId, defaultBoard(), '重新发牌', [
    { userId: owner.value.user.id, nickname: '提前厅主', seat: 1, role: 'SEER', camp: 'GOOD' },
  ]);
  db.discardMatch(redeal);
  assert.equal(db.hallDashboard(hallId, owner.value.user.id)!.matches.length, 1);
});

test('新场次保存逐夜回顾，厅主和参赛者可见，旧场次保持兼容', () => {
  const owner = db.register('回顾厅主');
  const player = db.register('回顾玩家');
  const outsider = db.register('场外玩家');
  assert.ok(owner.ok && player.ok && outsider.ok);
  if (!owner.ok || !player.ok || !outsider.ok) return;

  const hallId = 'REPLAY';
  db.createHall(hallId, owner.value.user.id);
  const oldMatch = db.startMatch(hallId, defaultBoard(), '旧场次', [
    { userId: owner.value.user.id, nickname: '回顾厅主', seat: 1, role: 'WOLF', camp: 'WOLF' },
  ]);
  db.finishMatch(oldMatch, 'WOLF', 1, null);

  const replayMatch = db.startMatch(hallId, defaultBoard(), '新场次', [
    { userId: owner.value.user.id, nickname: '回顾厅主', seat: 1, role: 'WOLF', camp: 'WOLF' },
    { userId: player.value.user.id, nickname: '回顾玩家', seat: 2, role: 'SEER', camp: 'GOOD' },
  ]);
  const replay = {
    version: 1 as const,
    nights: [{
      day: 1,
      wolfVotes: [{ voter: 1, target: 2 }],
      wolfTarget: 2,
      guardTarget: null,
      mechanicalGuardTarget: null,
      witchActed: false,
      witchSave: false,
      witchPoison: null,
      mechanicalPoison: null,
      seerTarget: 1,
      seerCamp: 'WOLF' as const,
      mechanicalSeerTarget: null,
      mechanicalSeerCamp: null,
      spiritTarget: null,
      spiritRole: null,
      mechanicalSpiritTarget: null,
      mechanicalSpiritRole: null,
      dancerTargets: [],
      maskInspectTarget: null,
      maskInspectResult: null,
      maskTarget: null,
      dreamerTarget: null,
      deaths: [{ seat: 2, cause: 'WOLF' as const }],
    }],
    dayVotes: [{
      day: 1,
      votes: [
        { voter: 1, target: 2, weight: 1 },
        { voter: 2, target: 1, weight: 1 },
      ],
    }],
    publicEvents: ['天黑请闭眼'],
    secretEvents: ['今晚 2 号被狼人杀害'],
  };
  db.finishMatch(replayMatch, 'WOLF', 1, null, [], replay);

  const ownerView = db.hallDashboard(hallId, owner.value.user.id)!;
  assert.equal(ownerView.matches[0]!.replay, null, '更新前场次没有回放也应正常显示');
  assert.deepEqual(ownerView.matches[1]!.replay, replay);
  assert.deepEqual(db.hallDashboard(hallId, player.value.user.id)!.matches[1]!.replay, replay);
  const replayStats = ownerView.players.find((entry) => entry.userId === player.value.user.id)!;
  assert.deepEqual(
    {
      correct: replayStats.exileCorrect,
      votes: replayStats.exileVotes,
      accuracy: replayStats.exileAccuracy,
      eligible: replayStats.exileEligible,
    },
    { correct: 1, votes: 1, accuracy: 100, eligible: false },
  );
  assert.equal(
    db.hallDashboard(hallId, outsider.value.user.id)!.matches[1]!.replay,
    null,
    '未参赛者不能读取隐藏夜间行动',
  );
});

test('个人大厅记录区分创建与参加，移除只影响当前用户并可在再次进入后恢复', () => {
  const owner = db.register('记录厅主');
  const guest = db.register('记录访客');
  assert.ok(owner.ok && guest.ok);
  if (!owner.ok || !guest.ok) return;

  const hallId = 'PERSON';
  db.createHall(hallId, owner.value.user.id);
  db.recordHallVisit(hallId, guest.value.user.id);

  const ownerRecord = db.hallRecords(owner.value.user.id)[0]!;
  const guestRecord = db.hallRecords(guest.value.user.id)[0]!;
  assert.equal(ownerRecord.relation, 'OWNER');
  assert.equal(ownerRecord.matchCount, 0, '没有实际场次的大厅应保持为空大厅');
  assert.equal(guestRecord.relation, 'PARTICIPANT');
  assert.equal(guestRecord.ownerName, '记录厅主');

  assert.equal(db.hideHallRecord(hallId, guest.value.user.id).ok, true);
  assert.equal(db.hallRecords(guest.value.user.id).length, 0);
  assert.equal(db.hallRecords(owner.value.user.id).length, 1, '访客移除记录不能影响厅主');
  assert.ok(db.hallDashboard(hallId, owner.value.user.id), '个人移除不能删除大厅原始数据');

  db.recordHallVisit(hallId, guest.value.user.id);
  assert.equal(db.hallRecords(guest.value.user.id).length, 1, '再次进入大厅后记录应重新出现');
});
