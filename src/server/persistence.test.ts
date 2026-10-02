/**
 * 进行中房间持久化测试：模拟「服务端重启」后房间与对局能否原样继续。
 *
 * 覆盖的是一旦写错就会毁掉整个特性的地方：
 * - 重启后房间、座位、token 映射原样恢复，老 token 重连落回原座位
 * - 每个玩家的视图在恢复前后**完全一致**（信息隔离不因持久化被破坏）
 * - 停机期间到点的阶段按超时结算，之后的阶段重新计时
 * - 海克斯选牌阶段同样可恢复；到点则按超时自动随机开局
 * - 恢复的对局能继续打到分出胜负，并正常写入场次战绩
 * - 空房间销毁后快照被清理，不会下次启动复活空壳
 *
 * 视图断言走**真实广播链路**：给会话挂一个假 WebSocket，resync 之后解析
 * 它收到的 room/game 消息 —— 和真客户端看到的一字不差。
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { WebSocket as WsType } from 'ws';

import { Hub, type Reply } from './hub.ts';
import { GameDatabase } from './database.ts';
import type { GameMode } from '../shared/protocol.ts';
import type { BoardConfig, Role } from '../shared/roles.ts';

const db = new GameDatabase(':memory:');

after(() => {
  db.close();
});

interface TestPlayer {
  token: string;
  userId: string;
  /** 登录会话 token：重连（attach）时用它重新核定身份 */
  auth: string;
  inbox: string[];
}

let userSeq = 0;

/** 注册一个真实账号并建好自动化会话（不经过真实网络） */
function makeSession(hub: Hub, name: string): TestPlayer {
  const reg = db.register(`快照${userSeq += 1}_${name}`);
  assert.ok(reg.ok, `注册 ${name} 应成功`);
  const changed = db.changePassword(reg.value.token, '1', 'test-password');
  assert.ok(changed.ok, `改密 ${name} 应成功`);
  const session = hub.ensureSession(undefined);
  session.userId = reg.value.user.id;
  session.nickname = reg.value.user.username;
  session.automation = true;
  return { token: session.token, userId: reg.value.user.id, auth: reg.value.token, inbox: [] };
}

/** 给会话挂假 WebSocket —— 捕获服务端推给「这个客户端」的一切消息 */
function attachFake(hub: Hub, player: TestPlayer): void {
  const inbox = player.inbox;
  const fake = {
    readyState: 1,
    send: (data: unknown) => inbox.push(String(data)),
    close: () => {},
    on: () => {},
  } as unknown as WsType;
  hub.attach(player.token, fake, db.authenticate(player.auth));
}

function mustOk(res: Reply, what: string): void {
  assert.ok(res.ok, `${what} 应成功：${res.message ?? ''}`);
}

function send(hub: Hub, token: string, msg: object): void {
  hub.handleMessage(token, JSON.stringify(msg));
}

/** 6 人最小局：2 狼 + 预女 + 2 民 */
function miniBoard(): BoardConfig {
  return { playerCount: 6, roles: { WOLF: 2, SEER: 1, WITCH: 1, VILLAGER: 2 } } as BoardConfig;
}

/** 建一间房：第一个人是房主；setMode（会清就绪）先于就绪执行 */
function setupRoom(
  hub: Hub,
  players: TestPlayer[],
  board: BoardConfig,
  mode: GameMode = 'STANDARD',
): string {
  send(hub, players[0]!.token, { t: 'room.create', nickname: '房主' });
  const roomId = hub.get(players[0]!.token)!.roomId!;
  for (let i = 1; i < players.length; i += 1) {
    send(hub, players[i]!.token, { t: 'room.join', roomId, nickname: `玩家${i + 1}` });
  }
  const room = hub.getRoom(roomId)!;
  room.config.autoTimeout = false; // 测试里手动推进，不让定时器插手
  mustOk(room.setBoard(players[0]!.token, board), '改版型');
  if (mode !== 'STANDARD') mustOk(room.setMode(players[0]!.token, mode), '切模式');
  for (let i = 1; i < players.length; i += 1) mustOk(room.setReady(players[i]!.token, true), '就绪');
  return roomId;
}

/** 开局 → 全员确认 → 天黑 → 推进到狼人行动阶段 */
function reachWolfPhase(room: ReturnType<Hub['getRoom']> & object, players: TestPlayer[]): void {
  const r = room as NonNullable<ReturnType<Hub['getRoom']>>;
  mustOk(r.startGame(players[0]!.token), '开局');
  for (const player of players) mustOk(r.confirmRole(player.token), '确认身份');
  mustOk(r.beginNight(players[0]!.token), '天黑');
  mustOk(r.forceAdvance(null), '过天黑过场');
  assert.equal(r.stats().phase, 'NIGHT_WOLVES', '应停在狼人行动阶段');
}

/** 等待 setImmediate 排队的快照落库 */
async function waitForSnapshot(expect: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (db.loadRoomSnapshots().length >= expect) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(db.loadRoomSnapshots().length, expect, '快照应已落库');
}

/** resync 一次，取这个客户端最近收到的 room / game 视图（清掉服务端注入的瞬态字段） */
function capturedView(player: TestPlayer): { room: unknown; game: unknown } {
  const msgs = player.inbox.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  const room = structuredClone(msgs.filter((m) => m.t === 'room').at(-1)?.room ?? null);
  const game = structuredClone(msgs.filter((m) => m.t === 'game').at(-1)?.game ?? null);
  if (game && typeof game === 'object') {
    delete (game as Record<string, unknown>).deadline;
    delete (game as Record<string, unknown>).countdown;
    delete (game as Record<string, unknown>).countdownEndsAt;
  }
  player.inbox.length = 0;
  return { room, game };
}

/** 全员挂上假连接并 resync，收集每个人的视图 */
function captureAllViews(hub: Hub, players: TestPlayer[]): Array<{ room: unknown; game: unknown }> {
  for (const player of players) {
    if (!hub.get(player.token)!.socket) attachFake(hub, player);
    else player.inbox.length = 0;
  }
  for (const player of players) hub.resync(player.token);
  return players.map((player) => capturedView(player));
}

describe('进行中房间持久化', () => {
  it('重启后房间原样恢复：座位、token、每人视图一致，对局能打完并计入场次', async () => {
    const hub1 = new Hub(db);
    const players = ['甲', '乙', '丙', '丁', '戊', '己'].map((name) => makeSession(hub1, name));
    const roomId = setupRoom(hub1, players, miniBoard());
    const room1 = hub1.getRoom(roomId)!;
    reachWolfPhase(room1, players);

    // 找到狼，刀 4 号，停在半路 —— 此时「重启」
    const viewsForRole = captureAllViews(hub1, players);
    const wolfIndices = viewsForRole
      .map((view, index) => ({ index, role: (view.game as { me?: { role?: Role } } | null)?.me?.role }))
      .filter((entry) => entry.role === 'WOLF')
      .map((entry) => entry.index);
    assert.ok(wolfIndices.length >= 1, '应至少有一名狼人');
    mustOk(room1.submitAction(players[wolfIndices[0]!]!.token, { kind: 'wolf', target: 4 }), '狼人点刀');

    // 好人（非狼）的视图里绝不能出现狼身份 —— 持久化不能破坏信息隔离
    for (const [index, view] of viewsForRole.entries()) {
      if (wolfIndices.includes(index)) continue;
      const dump = JSON.stringify(view);
      assert.ok(
        !/"role":"WOLF"/.test(dump) && !/"roleName":"狼人"/.test(dump),
        `好人 ${index + 1} 号的视图不应包含狼身份`,
      );
    }

    const before = captureAllViews(hub1, players);
    await waitForSnapshot(1);

    // ─── 「重启」：同一个数据库，全新的 Hub ───
    const hub2 = new Hub(db);
    assert.equal(hub2.restorePersistedRooms(), 1, '应恢复出 1 个房间');
    const room2 = hub2.getRoom(roomId)!;
    assert.ok(room2, '房间应按原房间号恢复');
    assert.equal(room2.stats().phase, 'NIGHT_WOLVES', '未到点的阶段应原样停着');

    // 座位与 token 映射原样恢复：老 token 重连即落回原座位
    for (const [index, player] of players.entries()) {
      assert.ok(hub2.get(player.token), `token ${index + 1} 的会话应已恢复`);
      assert.equal(room2.seatOf(player.token), room1.seatOf(player.token), `${index + 1} 号座位应不变`);
      assert.equal(hub2.get(player.token)!.roomId, roomId, '会话应指回恢复的房间');
    }

    // 每个玩家的视图与重启前完全一致（信息裁剪不因恢复而变化）
    const after = captureAllViews(hub2, players);
    assert.deepEqual(after, before, '每个玩家的视图在恢复前后应完全一致');

    // 恢复后的对局继续打到分出胜负（手动推进；安全阀保证有限步内收场）
    let guard = 0;
    while (room2.stats().phase !== 'GAME_OVER' && guard++ < 600) {
      const res = room2.forceAdvance(null);
      if (!res.ok) break;
    }
    assert.equal(room2.stats().phase, 'GAME_OVER', `对局应能打完（推进 ${guard} 步）`);

    // 战绩应写进数据库
    mustOk(room2.closeMatch(players[0]!.token), '结束并保存本场');
    const dashboard = db.hallDashboard(roomId, players[0]!.userId);
    assert.ok(dashboard, '大厅战绩应可读');
    assert.equal(dashboard!.matches.length, 1, '应记录 1 个场次');
    assert.equal(dashboard!.matches[0]!.status, 'COMPLETED', '恢复后的对局打完应记为 COMPLETED');

    // 销毁房间后快照必须清掉，否则下次启动会复活一个空壳
    hub2.destroyRoom(roomId);
    hub1.destroyRoom(roomId);
    assert.equal(db.loadRoomSnapshots().length, 0, '房间销毁后快照应被删除');
  });

  it('停机期间到点的阶段按超时结算，不能原样停着', async () => {
    const hub1 = new Hub(db);
    const players = ['甲2', '乙2', '丙2', '丁2', '戊2', '己2'].map((name) => makeSession(hub1, name));
    const roomId = setupRoom(hub1, players, miniBoard());
    const room1 = hub1.getRoom(roomId)!;
    reachWolfPhase(room1, players);

    // 伪造「狼人阶段在停机期间已经到点」：把快照里的 deadline 改成过去
    const snap = room1.snapshot();
    snap.game!.deadline = Date.now() - 60_000;
    db.saveRoomSnapshot(roomId, JSON.stringify(snap));

    const hub2 = new Hub(db);
    assert.equal(hub2.restorePersistedRooms(), 1, '应恢复出房间');
    const room2 = hub2.getRoom(roomId)!;
    assert.notEqual(room2.stats().phase, 'NIGHT_WOLVES', '已到点的阶段应按超时结算推进');
    hub2.destroyRoom(roomId);
    hub1.destroyRoom(roomId);
  });

  it('海克斯选牌阶段可恢复：候选保留、选牌照常、到点自动随机开局', async () => {
    // ① 未到点：恢复后续接，每人候选与已选状态保留
    const hub1 = new Hub(db);
    const players = Array.from({ length: 9 }, (_, i) => makeSession(hub1, `海${i + 1}`));
    const hexBoard = { playerCount: 9, roles: { VILLAGER: 5, WOLF: 4 } } as BoardConfig;
    const roomId = setupRoom(hub1, players, hexBoard, 'HEX_CHAOS');
    const room1 = hub1.getRoom(roomId)!;
    mustOk(room1.startGame(players[0]!.token), '开始选牌');
    assert.ok(room1.roomViewFor(players[0]!.token).hexDraft, '应进入海克斯选牌阶段');

    await waitForSnapshot(1);
    const hub2 = new Hub(db);
    assert.equal(hub2.restorePersistedRooms(), 1, '应恢复出房间');
    const room2 = hub2.getRoom(roomId)!;
    assert.ok(room2.roomViewFor(players[3]!.token).hexDraft, '恢复后应仍在选牌阶段');
    for (const [index, player] of players.entries()) {
      const before = room1.roomViewFor(player.token).hexDraft!;
      const after = room2.roomViewFor(player.token).hexDraft!;
      assert.deepEqual(after.options, before.options, `玩家 ${index + 1} 的私密候选牌应原样恢复`);
    }
    const pick = room2.roomViewFor(players[1]!.token).hexDraft!.options[0]!;
    mustOk(room2.submitHexChoice(players[1]!.token, pick), '恢复后提交选牌');
    assert.equal(room2.roomViewFor(players[1]!.token).hexDraft!.selected, pick, '已选状态应生效');

    // ② 到点：恢复瞬间按超时自动随机并开局
    const snap = room1.snapshot();
    assert.ok(snap.hexDraft, '选牌阶段应已开始');
    snap.hexDraftDeadline = Date.now() - 1_000;
    db.saveRoomSnapshot(roomId, JSON.stringify(snap));
    const hub3 = new Hub(db);
    assert.equal(hub3.restorePersistedRooms(), 1, '应恢复出房间');
    const room3 = hub3.getRoom(roomId)!;
    assert.equal(room3.stats().phase, 'ROLE_REVEAL', '到点的选牌应自动随机并发牌进入身份确认');
    assert.equal(room3.roomViewFor(players[0]!.token).hexDraft, null, '选牌阶段应已结束');

    hub1.destroyRoom(roomId);
    hub2.destroyRoom(roomId);
    hub3.destroyRoom(roomId);
    assert.equal(db.loadRoomSnapshots().length, 0, '全部销毁后快照应清空');
  });

  it('版本过旧的快照被丢弃，不影响其余房间恢复', async () => {
    const hub1 = new Hub(db);
    const playersA = ['旧甲', '旧乙', '旧丙', '旧丁', '旧戊', '旧己'].map((name) => makeSession(hub1, name));
    const roomA = setupRoom(hub1, playersA, miniBoard());
    const playersB = ['新甲', '新乙', '新丙', '新丁', '新戊', '新己'].map((name) => makeSession(hub1, name));
    const roomB = setupRoom(hub1, playersB, miniBoard());
    await waitForSnapshot(2);

    // 把 A 房间的快照改成「未来版本」 —— 模拟旧格式
    const stale = db.loadRoomSnapshots().find((row) => row.roomId === roomA)!;
    const payload = JSON.parse(stale.payload) as { v: number };
    payload.v = 99999;
    db.saveRoomSnapshot(roomA, JSON.stringify(payload));

    const hub2 = new Hub(db);
    assert.equal(hub2.restorePersistedRooms(), 1, '只有 B 房间应恢复成功');
    assert.ok(hub2.getRoom(roomB), 'B 房间应恢复');
    assert.equal(hub2.getRoom(roomA), undefined, 'A 房间应被丢弃');
    assert.equal(
      db.loadRoomSnapshots().some((row) => row.roomId === roomA),
      false,
      '被丢弃房间的快照应被删除',
    );
    hub1.destroyRoom(roomA);
    hub1.destroyRoom(roomB);
    hub2.destroyRoom(roomB);
  });
});
