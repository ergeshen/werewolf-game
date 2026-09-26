/**
 * 规则引擎单元测试
 *
 * 运行方式：npm test  （即 tsx src/shared/engine.test.ts）
 *
 * 这里覆盖的是「一旦写错就会毁掉整局游戏」的规则：
 * 夜晚流程、女巫药水限制、猎人开枪条件、白痴翻牌、投票平票、屠边胜负，
 * 以及最关键的一条 —— 信息隔离（好人客户端里绝不能出现狼人身份字符串）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Game, type PlayerSeed } from './engine.ts';
import type { Phase, RoomConfig } from './protocol.ts';
import { BOARD_12, type Role } from './roles.ts';

/** 固定牌序：1-4 狼，5-8 民，9 预言家，10 女巫，11 猎人，12 白痴 */
const LAYOUT: Role[] = [
  'WOLF',
  'WOLF',
  'WOLF',
  'WOLF',
  'VILLAGER',
  'VILLAGER',
  'VILLAGER',
  'VILLAGER',
  'SEER',
  'WITCH',
  'HUNTER',
  'IDIOT',
];

const WOLF_SEATS = [1, 2, 3, 4];
const SEER_SEAT = 9;
const WITCH_SEAT = 10;
const HUNTER_SEAT = 11;
const IDIOT_SEAT = 12;

const pid = (seat: number): string => `p${seat}`;

/**
 * 读当前阶段。
 * 必须包一层函数：node:assert 的断言签名会把 g.phase 收窄成字面量，
 * 连 `const x: Phase = g.phase` 也会被 TS 按初始值收窄，
 * 于是后面拿它跟别的阶段比较就会误报 "no overlap"。
 */
const phaseOf = (g: Game): Phase => g.phase;

function newGame(options: { roles?: Role[]; config?: Partial<RoomConfig> } = {}): Game {
  const seeds: PlayerSeed[] = [];
  for (let seat = 1; seat <= 12; seat++) {
    seeds.push({ id: pid(seat), seat, nickname: `玩家${seat}`, isHost: seat === 1 });
  }
  return new Game('TEST01', seeds, {
    forcedRoles: options.roles ?? LAYOUT,
    config: options.config,
    seed: 20240501,
  });
}

function aliveWolves(g: Game): number[] {
  return g.aliveSeatsSnapshot().filter((s) => g.roleAt(s) === 'WOLF');
}

/** 有投票权的玩家座位（存活且未翻牌的白痴） */
function voters(g: Game): number[] {
  return g.aliveSeatsSnapshot().filter((seat) => g.gameViewFor(pid(seat)).me?.canVote === true);
}

/** 跑完一个完整的夜晚：天黑 → 狼刀 → 女巫 → 预言家 → 天亮 */
function playNight(
  g: Game,
  wolfTarget: number | null,
  witch: { save?: boolean; poison?: number | null } = {},
): void {
  assert.equal(g.phase, 'NIGHT_START', '夜晚应从 NIGHT_START 开始');
  g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_WOLVES');

  for (const seat of aliveWolves(g)) {
    g.submitNightAction(pid(seat), { kind: 'wolf', target: wolfTarget });
  }

  if (g.phase === 'NIGHT_WITCH') {
    const res = g.submitNightAction(pid(WITCH_SEAT), {
      kind: 'witch',
      save: witch.save ?? false,
      poison: witch.poison ?? null,
    });
    assert.equal(res.ok, true, `女巫行动应被接受：${res.message ?? ''}`);
  }
  assert.notEqual(g.phase, 'NIGHT_WITCH', '女巫阶段应已结束');

  if (g.phase === 'NIGHT_SEER') {
    const target = g.aliveSeatsSnapshot().find((s) => s !== SEER_SEAT);
    assert.ok(target, '应存在可查验目标');
    const res = g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target });
    assert.equal(res.ok, true, `预言家行动应被接受：${res.message ?? ''}`);
  }

  assert.equal(g.phase, 'NIGHT_RESOLVE');
  g.forceAdvance();
  assert.equal(g.phase, 'DAY_ANNOUNCE');
}

/** 跑完白天：公布 → 投票 → 放逐 → （可能的猎人开枪）→ 下一夜或结束 */
function playDay(g: Game, decide: (seat: number) => number | null): void {
  assert.equal(g.phase, 'DAY_ANNOUNCE');
  g.forceAdvance();

  // 用 phaseOf() 读取，避免 node:assert 的断言签名把 g.phase 收窄成字面量
  const afterAnnounce = phaseOf(g);
  if (afterAnnounce === 'GAME_OVER') return;

  if (afterAnnounce === 'HUNTER_SHOOT') {
    const res = g.submitHunterShoot(pid(HUNTER_SEAT), null);
    assert.equal(res.ok, true, `猎人放弃开枪应被接受：${res.message ?? ''}`);
  }
  if (phaseOf(g) === 'GAME_OVER') return;

  assert.equal(g.phase, 'DAY_VOTE');
  for (const seat of voters(g)) {
    const res = g.submitVote(pid(seat), decide(seat));
    assert.equal(res.ok, true, `${seat} 号投票应被接受：${res.message ?? ''}`);
  }
  assert.equal(g.phase, 'DAY_EXILE');
  g.forceAdvance();
}

/** 每一步之后都该成立的不变量 */
function assertInvariants(g: Game): void {
  const alive = g.aliveSeatsSnapshot().length;
  const dead = g.deathRecords().length;
  assert.equal(alive + dead, 12, `存活(${alive}) + 死亡(${dead}) 应等于 12`);
  assert.ok(g.day >= 1, '天数应从 1 开始');
}

// ────────────────────────────────────────────────────────────────

describe('板子与开局', () => {
  it('12 人板子恰好是 4 狼 4 民 + 预言家/女巫/猎人/白痴', () => {
    const counts = new Map<Role, number>();
    for (const r of BOARD_12) counts.set(r, (counts.get(r) ?? 0) + 1);
    assert.equal(BOARD_12.length, 12);
    assert.equal(counts.get('WOLF'), 4);
    assert.equal(counts.get('VILLAGER'), 4);
    assert.equal(counts.get('SEER'), 1);
    assert.equal(counts.get('WITCH'), 1);
    assert.equal(counts.get('HUNTER'), 1);
    assert.equal(counts.get('IDIOT'), 1);
  });

  it('未满 12 人不能开局', () => {
    const seeds: PlayerSeed[] = [];
    for (let seat = 1; seat <= 11; seat++) {
      seeds.push({ id: pid(seat), seat, nickname: `玩家${seat}` });
    }
    const g = new Game('TEST02', seeds, { seed: 1 });
    assert.equal(g.start().ok, false);
    assert.equal(g.phase, 'WAITING');
  });

  it('随机发牌也满足板子数量（跑 50 次）', () => {
    for (let i = 0; i < 50; i++) {
      const g = newGame({ roles: undefined });
      g.start();
      let wolves = 0;
      for (let seat = 1; seat <= 12; seat++) {
        if (g.roleAt(seat) === 'WOLF') wolves++;
      }
      assert.equal(wolves, 4);
    }
  });
});

describe('夜晚流程', () => {
  it('狼人全部提交后才推进，且多数票决定刀口', () => {
    const g = newGame();
    g.start();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');

    g.submitNightAction(pid(1), { kind: 'wolf', target: 5 });
    g.submitNightAction(pid(2), { kind: 'wolf', target: 5 });
    g.submitNightAction(pid(3), { kind: 'wolf', target: 6 });
    assert.equal(g.phase, 'NIGHT_WOLVES', '还有人没提交，不应推进');

    // 4 号改票到 6，此时 5:2 票 / 6:2 票 —— 平票，今夜空刀
    g.submitNightAction(pid(4), { kind: 'wolf', target: 6 });
    assert.notEqual(g.phase, 'NIGHT_WOLVES', '全员提交后应推进');
    assert.equal(g.phase, 'NIGHT_WITCH');
  });

  it('完整夜晚：狼刀 + 女巫解药 → 平安夜', () => {
    const g = newGame();
    g.start();
    playNight(g, 5, { save: true });

    const view = g.gameViewFor(pid(1));
    assert.deepEqual(view.lastNightDeaths, [], '解药生效，应为平安夜');
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).me?.potions?.antidote, false, '解药应已消耗');
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).me?.potions?.poison, true, '毒药应保留');
    assertInvariants(g);
  });

  it('完整夜晚：狼刀 + 女巫不救 → 天亮公布死讯', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5]);
    assert.equal(g.isDeadSeat(5), true);
    assertInvariants(g);
  });

  it('女巫毒药可以额外带走一人', () => {
    const g = newGame();
    g.start();
    playNight(g, 5, { poison: 7 });

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5, 7]);
    assert.equal(g.isDeadSeat(5), true);
    assert.equal(g.isDeadSeat(7), true);
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).me?.potions?.poison, false, '毒药应已消耗');
    assertInvariants(g);
  });

  it('被刀的人同时被毒时只死一次', () => {
    const g = newGame();
    g.start();
    playNight(g, 5, { poison: 5 });
    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5]);
    assertInvariants(g);
  });

  it('同一夜不能同时使用解药和毒药', () => {
    const g = newGame();
    g.start();
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    assert.equal(g.phase, 'NIGHT_WITCH');
    const res = g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: true, poison: 7 });
    assert.equal(res.ok, false);
    assert.match(res.message ?? '', /不能同时/);
  });

  it('女巫不能自救（默认规则）', () => {
    const g = newGame();
    g.start();
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: WITCH_SEAT });
    }
    assert.equal(g.phase, 'NIGHT_WITCH');
    const res = g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: true, poison: null });
    assert.equal(res.ok, false);
    assert.match(res.message ?? '', /自救/);
  });

  it('允许自救的配置下女巫可以救自己', () => {
    const g = newGame({ config: { witchCanSelfSave: true } });
    g.start();
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: WITCH_SEAT });
    }
    const res = g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: true, poison: null });
    assert.equal(res.ok, true);
    g.forceAdvance();
    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, []);
  });

  it('解药已用完时不能再用', () => {
    const g = newGame();
    g.start();
    playNight(g, 5, { save: true }); // 消耗解药
    playDay(g, () => null); // 全员弃票，进入第二夜
    assert.equal(g.phase, 'NIGHT_START');

    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 6 });
    }
    assert.equal(g.phase, 'NIGHT_WITCH');
    const res = g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: true, poison: null });
    assert.equal(res.ok, false);
    assert.match(res.message ?? '', /解药已经用过/);
  });

  it('预言家查验结果正确，且只有预言家自己看得到', () => {
    const g = newGame();
    g.start();
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    assert.equal(g.phase, 'NIGHT_SEER');

    g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: 1 }); // 1 号是狼
    g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: 2 }); // 重复提交应失败
    const history = g.gameViewFor(pid(SEER_SEAT)).me?.seerHistory ?? [];
    assert.equal(history.length, 1, '重复查验不应写入历史');
    assert.equal(history[0]?.camp, 'WOLF');

    // 村民的视图里不能出现任何验人信息
    const villagerJson = JSON.stringify(g.gameViewFor(pid(5)));
    assert.ok(!villagerJson.includes('seerHistory'), '村民视图不应包含 seerHistory');
  });

  it('预言家出局后不再进入查验阶段', () => {
    const g = newGame();
    g.start();
    playNight(g, SEER_SEAT); // 第一夜刀掉预言家
    playDay(g, () => null);
    assert.equal(g.isDeadSeat(SEER_SEAT), true);

    g.forceAdvance(); // → NIGHT_WOLVES
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    // 预言家已死，女巫行动完应直接进入结算，不出现 NIGHT_SEER
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    assert.equal(g.phase, 'NIGHT_RESOLVE');
  });

  it('两瓶药都用完后跳过女巫阶段', () => {
    const g = newGame();
    g.start();
    playNight(g, 5, { save: true }); // 第 1 夜用掉解药
    playDay(g, () => null);
    playNight(g, 6, { poison: 7 }); // 第 2 夜用掉毒药
    playDay(g, () => null);

    const me = g.gameViewFor(pid(WITCH_SEAT)).me;
    assert.equal(me?.potions?.antidote, false);
    assert.equal(me?.potions?.poison, false);

    g.forceAdvance(); // → NIGHT_WOLVES
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 8 });
    }
    assert.notEqual(g.phase, 'NIGHT_WITCH', '无药可用时不应停留在女巫阶段');
  });
});

describe('猎人与白痴', () => {
  it('猎人被狼刀死可以开枪', () => {
    const g = newGame();
    g.start();
    playNight(g, HUNTER_SEAT);
    assert.equal(g.isDeadSeat(HUNTER_SEAT), true);

    g.forceAdvance(); // 离开 DAY_ANNOUNCE
    assert.equal(g.phase, 'HUNTER_SHOOT', '被刀死的猎人应获得开枪机会');

    const res = g.submitHunterShoot(pid(HUNTER_SEAT), 3);
    assert.equal(res.ok, true);
    assert.equal(g.isDeadSeat(3), true, '被带走的 3 号应出局');
    assert.equal(g.phase, 'DAY_VOTE', '开枪后应继续白天投票');
    assertInvariants(g);
  });

  it('猎人被女巫毒死不能开枪', () => {
    const g = newGame();
    g.start();
    playNight(g, 5, { poison: HUNTER_SEAT });
    g.forceAdvance(); // 离开 DAY_ANNOUNCE
    assert.equal(g.isDeadSeat(HUNTER_SEAT), true);
    assert.notEqual(g.phase, 'HUNTER_SHOOT', '被毒死的猎人不应获得开枪机会');
    assert.equal(g.phase, 'DAY_VOTE');
  });

  it('猎人被投票放逐可以开枪', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);

    g.forceAdvance(); // → DAY_VOTE
    assert.equal(g.phase, 'DAY_VOTE');
    for (const seat of voters(g)) {
      const res = g.submitVote(pid(seat), seat === HUNTER_SEAT ? null : HUNTER_SEAT);
      assert.equal(res.ok, true, res.message);
    }
    assert.equal(g.phase, 'DAY_EXILE');
    g.forceAdvance();
    assert.equal(g.phase, 'HUNTER_SHOOT');

    g.submitHunterShoot(pid(HUNTER_SEAT), 2);
    assert.equal(g.isDeadSeat(2), true);
    assert.equal(g.phase, 'NIGHT_START', '放逐阶段开枪后应进入下一夜');
    assert.equal(g.day, 2);
  });

  it('白痴被投票放逐时翻牌免死并失去投票权', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);
    g.forceAdvance();

    for (const seat of voters(g)) {
      const res = g.submitVote(pid(seat), seat === IDIOT_SEAT ? null : IDIOT_SEAT);
      assert.equal(res.ok, true, res.message);
    }
    assert.equal(g.phase, 'DAY_EXILE');
    g.forceAdvance();

    assert.equal(g.isDeadSeat(IDIOT_SEAT), false, '白痴翻牌不应死亡');
    const me = g.gameViewFor(pid(IDIOT_SEAT)).me;
    assert.equal(me?.idiotRevealed, true);
    assert.equal(me?.canVote, false, '翻牌后应失去投票权');
    assert.equal(g.phase, 'NIGHT_START', '白痴不应触发猎人开枪');

    // 第二天轮次：白痴不再出现在投票人中
    assert.ok(!voters(g).includes(IDIOT_SEAT));
    // 白痴也不能再被投票
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 8 });
    }
    if (g.phase === 'NIGHT_WITCH') {
      g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    }
    if (g.phase === 'NIGHT_SEER') {
      g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: 3 });
    }
    g.forceAdvance();
    g.forceAdvance();
    assert.equal(g.phase, 'DAY_VOTE');
    const res = g.submitVote(pid(1), IDIOT_SEAT);
    assert.equal(res.ok, false, '已翻牌的白痴不应能再被投票');
  });
});

describe('投票', () => {
  it('平票时无人出局', () => {
    const g = newGame();
    g.start();
    playNight(g, 5); // 5 号夜里出局，剩 11 名投票人
    g.forceAdvance();
    assert.equal(g.phase, 'DAY_VOTE');

    // 5 票投 1 号 vs 5 票投 2 号，2 号自己弃票 → 平票
    for (const s of [3, 4, 6, 7, 8]) assert.equal(g.submitVote(pid(s), 1).ok, true);
    for (const s of [1, 9, 10, 11, 12]) assert.equal(g.submitVote(pid(s), 2).ok, true);
    assert.equal(g.submitVote(pid(2), null).ok, true);

    assert.equal(g.phase, 'DAY_EXILE');
    const before = g.aliveSeatsSnapshot().length;
    g.forceAdvance();
    assert.equal(g.aliveSeatsSnapshot().length, before, '平票不应有人出局');
    assert.equal(g.phase, 'NIGHT_START');
    assert.equal(g.day, 2);
  });

  it('全员弃票时无人出局', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);
    g.forceAdvance();
    const before = g.aliveSeatsSnapshot().length;
    for (const seat of voters(g)) g.submitVote(pid(seat), null);
    g.forceAdvance();
    assert.equal(g.aliveSeatsSnapshot().length, before);
    assert.equal(g.phase, 'NIGHT_START');
  });

  it('不能投自己，也不能投已出局的人', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);
    g.forceAdvance();
    assert.equal(g.submitVote(pid(1), 1).ok, false, '不能投自己');
    assert.equal(g.submitVote(pid(1), 5).ok, false, '不能投已出局的人');
    assert.equal(g.submitVote(pid(5), 1).ok, false, '出局的人不能投票');
    assert.equal(g.submitVote(pid(1), 2).ok, true);
    assert.equal(g.submitVote(pid(1), 3).ok, false, '重复投票应被拒绝');
  });

  it('投票明细在放逐公布时下发给所有人', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);
    g.forceAdvance();
    for (const seat of voters(g)) g.submitVote(pid(seat), seat === 1 ? 2 : 1);
    const detail = g.gameViewFor(pid(6)).voteDetail ?? [];
    assert.ok(detail.length > 0, '应公布公开票型');
    assert.equal(detail.find((d) => d.voter === 1)?.target, 2);
  });
});

describe('胜负判定（屠边）', () => {
  it('狼人杀光全部平民 → 狼人胜', () => {
    const g = newGame();
    g.start();
    for (const victim of [5, 6, 7, 8]) {
      if (g.phase !== 'NIGHT_START') break;
      playNight(g, victim);
      if (g.winnerCamp) break;
      playDay(g, () => null);
    }
    if (g.phase !== 'GAME_OVER') g.forceAdvance();
    assert.equal(g.phase, 'GAME_OVER');
    assert.equal(g.winnerCamp, 'WOLF');
    assert.equal(g.summary.villagers, 0);
    assertInvariants(g);
  });

  it('狼人全部出局 → 好人胜', () => {
    const g = newGame();
    g.start();

    // 第 1 夜：女巫用解药制造平安夜；白天放逐 1 号狼
    playNight(g, 5, { save: true });
    playDay(g, (seat) => (seat === 1 ? null : 1));
    assert.equal(g.isDeadSeat(1), true);

    // 第 2 夜：狼刀 6 号，女巫用毒药带走 2 号狼；白天放逐 3 号狼
    playNight(g, 6, { poison: 2 });
    assert.equal(g.isDeadSeat(2), true);
    playDay(g, (seat) => (seat === 3 ? null : 3));
    assert.equal(g.isDeadSeat(3), true);

    // 第 3 夜：狼刀 7 号；白天放逐最后一头狼 4 号 → 好人胜
    playNight(g, 7);
    playDay(g, (seat) => (seat === 4 ? null : 4));

    assert.equal(g.phase, 'GAME_OVER');
    assert.equal(g.winnerCamp, 'GOOD');
    assert.equal(g.summary.wolves, 0);
    assertInvariants(g);
  });

  it('狼人杀光全部神职 → 狼人胜', () => {
    const g = newGame();
    g.start();
    for (const victim of [SEER_SEAT, WITCH_SEAT, HUNTER_SEAT, IDIOT_SEAT]) {
      if (g.phase !== 'NIGHT_START') break;
      playNight(g, victim);
      if (g.winnerCamp) break;
      playDay(g, () => null); // 村民全程弃票，狼人不会被放逐
    }
    if (g.phase !== 'GAME_OVER') g.forceAdvance();
    assert.equal(g.phase, 'GAME_OVER');
    assert.equal(g.winnerCamp, 'WOLF');
    assert.equal(g.summary.gods, 0);
    assertInvariants(g);
  });
});

describe('信息隔离（防作弊的关键）', () => {
  it('平民的整个视图里不出现 "WOLF" 字样', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);
    g.forceAdvance();
    assert.equal(g.phase, 'DAY_VOTE');

    const json = JSON.stringify(g.gameViewFor(pid(5)));
    assert.ok(!json.includes('"WOLF"'), `平民视图泄露了狼人信息：${json}`);
    assert.ok(!json.includes('seerHistory'), '平民视图不应包含验人历史');
    assert.ok(!json.includes('wolfVotes'), '平民视图不应包含狼队投票');
    assert.ok(!json.includes('potions'), '平民视图不应包含女巫药水');
  });

  it('座位列表里只有自己（或狼队友）带身份', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);

    const villagerSeats = g.seatViewsFor(pid(6));
    const withRole = villagerSeats.filter((s) => s.role !== undefined).map((s) => s.seat);
    assert.deepEqual(withRole, [6], '平民只能看到自己的身份');

    const wolfSeats = g.seatViewsFor(pid(1));
    const wolfWithRole = wolfSeats.filter((s) => s.role !== undefined).map((s) => s.seat);
    assert.deepEqual(wolfWithRole, WOLF_SEATS, '狼人能看到全部狼队友');
  });

  it('狼人视图包含狼队友座位', () => {
    const g = newGame();
    g.start();
    g.forceAdvance();
    g.submitNightAction(pid(1), { kind: 'wolf', target: 5 });
    const view = g.gameViewFor(pid(1));
    assert.deepEqual(view.me?.teammates, [2, 3, 4]);
    assert.deepEqual(
      view.wolfVotes?.map((v) => v.seat),
      [1],
      '狼队点刀进度只含已提交的狼人',
    );
  });

  it('女巫只能在女巫阶段看到刀口', () => {
    const g = newGame();
    g.start();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).witchInfo, undefined, '狼人阶段不应看到刀口');

    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    assert.equal(g.phase, 'NIGHT_WITCH');
    const info = g.gameViewFor(pid(WITCH_SEAT)).witchInfo;
    assert.equal(info?.wolfTargetSeat, 5);
    assert.equal(info?.canSave, true);

    // 其他人（含预言家）都拿不到刀口
    assert.equal(g.gameViewFor(pid(SEER_SEAT)).witchInfo, undefined);
    assert.equal(g.gameViewFor(pid(6)).witchInfo, undefined);
  });

  it('游戏结束时才下发全场身份', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);
    assert.equal(g.gameViewFor(pid(6)).revealAll, undefined, '游戏未结束不应公开身份');

    for (const victim of [6, 7, 8]) {
      playDay(g, () => null);
      if (phaseOf(g) === 'GAME_OVER') break;
      playNight(g, victim);
      if (phaseOf(g) === 'GAME_OVER') break;
    }
    if (phaseOf(g) !== 'GAME_OVER') playDay(g, () => null);

    assert.equal(g.phase, 'GAME_OVER');
    const reveal = g.gameViewFor(pid(6)).revealAll;
    assert.ok(reveal, '结束后应能查看全场身份');
    assert.equal(reveal.length, 12);
    assert.equal(reveal.filter((r) => r.role === 'WOLF').length, 4);
  });

  it('胜负已定但仍在过场阶段时，不提前下发死因与全场身份', () => {
    const g = newGame();
    g.start();
    for (const victim of [5, 6, 7]) {
      playNight(g, victim);
      playDay(g, () => null);
    }
    // 第 4 夜杀掉最后一个平民 —— 胜负在「公布死讯」阶段就已经定了
    playNight(g, 8);
    assert.equal(g.winnerCamp, 'WOLF', '此时胜负已定');
    assert.equal(g.phase, 'DAY_ANNOUNCE', '但还停在公布死讯的过场阶段');

    const view = g.gameViewFor(pid(6));
    assert.equal(view.outcome, null, '过场阶段不应提前下发胜负结果');
    assert.equal(view.revealAll, undefined, '过场阶段不应提前下发全场身份');
    assert.ok(
      view.deaths.every((d) => d.cause === undefined),
      '过场阶段不应下发死因（会被改过的客户端提前读到）',
    );

    g.forceAdvance();
    assert.equal(g.phase, 'GAME_OVER');
    const final = g.gameViewFor(pid(6));
    assert.equal(final.outcome, 'WOLF');
    assert.ok(final.revealAll, '进入 GAME_OVER 后才公开全场身份');
  });
});

describe('健壮性', () => {
  it('非狼人不能提交狼人行动，非当前阶段不能行动', () => {
    const g = newGame();
    g.start();
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: 5 }).ok, false, '天黑前不能行动');
    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(5), { kind: 'wolf', target: 6 }).ok, false, '平民不能点刀');
    assert.equal(g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: 1 }).ok, false, '预言家不能抢先查验');
  });

  it('超时推进不会卡死，并能跑到天亮', () => {
    const g = newGame();
    g.start();
    let guard = 0;
    while (g.phase !== 'DAY_ANNOUNCE' && guard++ < 30) {
      g.forceAdvance();
    }
    assert.equal(g.phase, 'DAY_ANNOUNCE', '一路超时也应能走到天亮');
    assertInvariants(g);
  });

  it('整局用超时推进也能正常收场（状态机一定会终止）', () => {
    const g = newGame();
    g.start();
    let guard = 0;
    while (g.phase !== 'GAME_OVER' && guard++ < 500) {
      g.forceAdvance();
    }
    assert.equal(g.phase, 'GAME_OVER', `未能在有限步内结束（已走 ${guard} 步）`);
    // 全员挂机时无人死亡，最终由 MAX_DAYS 安全阀判流局
    assert.equal(g.outcome(), 'DRAW');
    assert.equal(g.winnerCamp, null);
    assertInvariants(g);
  });

  it('阶段顺序符合「狼 → 女巫 → 预言家」', () => {
    const g = newGame();
    g.start();
    const seen: Phase[] = [];
    const original = g.phase;
    assert.equal(original, 'NIGHT_START');

    g.forceAdvance();
    seen.push(g.phase);
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    seen.push(g.phase);
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    seen.push(g.phase);

    assert.deepEqual(seen, ['NIGHT_WOLVES', 'NIGHT_WITCH', 'NIGHT_SEER']);
  });
});
