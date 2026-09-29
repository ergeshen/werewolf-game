import assert from 'node:assert/strict';
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
  assert.equal('score' in guestView.players[0]!, false, '普通玩家不能收到积分字段');
  assert.equal('rank' in guestView.players[0]!, false, '普通玩家不能收到排名字段');
  assert.ok(
    guestView.matches.every((match) =>
      match.players.every((player) => !('score' in player)),
    ),
    '普通玩家连单场积分字段也不能收到',
  );
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
