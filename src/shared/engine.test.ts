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
import {
  BOARD_PRESETS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  boardErrors,
  boardSummary,
  boardToDeck,
  boardTotal,
  boardWarnings,
  defaultBoard,
  makeBoard,
  validateBoard,
  type BoardConfig,
  type Role,
} from './roles.ts';

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

/** 固定牌序（含守卫）：1-4 狼，5-8 民，9 预言家，10 女巫，11 猎人，12 守卫 */
const LAYOUT_GUARD: Role[] = [
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
  'GUARD',
];

/** 固定牌序（含白狼王）：1 白狼王，2-4 狼，5-8 民，9 预言家，10 女巫，11 猎人，12 守卫 */
const LAYOUT_WOLF_KING: Role[] = [
  'WOLF_KING',
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
  'GUARD',
];

/** 13 人混血儿板：1-4 狼，5-8 民，9-12 四神，13 混血儿。 */
const LAYOUT_HYBRID: Role[] = [
  'WOLF', 'WOLF', 'WOLF', 'WOLF',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SEER', 'WITCH', 'HUNTER', 'IDIOT', 'HYBRID',
];

/** 12 人机械狼通灵师板：机械狼不与 2-4 号普通狼互认。 */
const LAYOUT_MECHANICAL_SPIRIT: Role[] = [
  'MECHANICAL_WOLF', 'WOLF', 'WOLF', 'WOLF',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SPIRIT_SEER', 'WITCH', 'HUNTER', 'GUARD',
];

/** 被动技能测试板：用白痴替换守卫。 */
const LAYOUT_MECHANICAL_IDIOT: Role[] = [
  'MECHANICAL_WOLF', 'WOLF', 'WOLF', 'WOLF',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SPIRIT_SEER', 'WITCH', 'HUNTER', 'IDIOT',
];

/** 12 人假面舞会：1-3 普通狼，4 假面，5-8 民，9 预言家，10 女巫，11 白痴，12 舞者。 */
const LAYOUT_MASK_BALL: Role[] = [
  'WOLF', 'WOLF', 'WOLF', 'MASK',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SEER', 'WITCH', 'IDIOT', 'DANCER',
];

const WOLF_SEATS = [1, 2, 3, 4];
const SEER_SEAT = 9;
const WITCH_SEAT = 10;
const HUNTER_SEAT = 11;
const IDIOT_SEAT = 12;
const GUARD_SEAT = 12;
const WOLF_KING_SEAT = 1;

const pid = (seat: number): string => `p${seat}`;
const aliveWolvesOf = (g: Game): number[] =>
  g.aliveSeatsSnapshot().filter((s) => {
    const role = g.roleAt(s);
    return role === 'WOLF' || role === 'WOLF_KING';
  });

/**
 * 读当前阶段。
 * 必须包一层函数：node:assert 的断言签名会把 g.phase 收窄成字面量，
 * 连 `const x: Phase = g.phase` 也会被 TS 按初始值收窄，
 * 于是后面拿它跟别的阶段比较就会误报 "no overlap"。
 */
const phaseOf = (g: Game): Phase => g.phase;

function newGame(
  options: { roles?: Role[]; config?: Partial<RoomConfig>; seed?: number } = {},
): Game {
  const deck = options.roles ?? LAYOUT;
  const seeds: PlayerSeed[] = [];
  for (let seat = 1; seat <= deck.length; seat++) {
    seeds.push({ id: pid(seat), seat, nickname: `玩家${seat}`, isHost: seat === 1 });
  }
  return new Game('TEST01', seeds, {
    roles: deck,
    shuffle: false,
    config: options.config,
    seed: options.seed ?? 20240501,
  });
}

function aliveWolves(g: Game): number[] {
  return aliveWolvesOf(g);
}

/** 有投票权的玩家座位（存活且未翻牌的白痴） */
function voters(g: Game): number[] {
  return g.aliveSeatsSnapshot().filter((seat) => g.gameViewFor(pid(seat)).me?.canVote === true);
}

/** 跑完一个完整的夜晚：天黑 → 狼刀 →（守卫）→ 女巫 → 预言家 → 天亮 */
function playNight(
  g: Game,
  wolfTarget: number | null,
  witch: { save?: boolean; poison?: number | null } = {},
  guardTarget: number | null = null,
): void {
  assert.equal(g.phase, 'NIGHT_START', '夜晚应从 NIGHT_START 开始');
  g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_WOLVES');

  for (const seat of aliveWolves(g)) {
    g.submitNightAction(pid(seat), { kind: 'wolf', target: wolfTarget });
  }

  if (g.phase === 'NIGHT_GUARD') {
    // 守卫可能已经出局 —— 出局后这一阶段**依然存在**（固定时长是防火墙），
    // 此时场上没人能行动，只能靠阶段超时/强制推进走过去。
    if (g.isDeadSeat(GUARD_SEAT)) {
      g.forceAdvance();
    } else {
      // 默认守自己（GUARD_SEAT），这样调用方不传 guardTarget 时也能推进
      const res = g.submitNightAction(pid(GUARD_SEAT), {
        kind: 'guard',
        target: guardTarget ?? GUARD_SEAT,
      });
      assert.equal(res.ok, true, `守卫行动应被接受：${res.message ?? ''}`);
      assert.notEqual(g.phase, 'NIGHT_GUARD', '守卫提交后应离开守卫阶段');
    }
  }

  if (g.phase === 'NIGHT_WITCH') {
    if (g.isDeadSeat(WITCH_SEAT)) {
      g.forceAdvance();
    } else {
      const res = g.submitNightAction(pid(WITCH_SEAT), {
        kind: 'witch',
        save: witch.save ?? false,
        poison: witch.poison ?? null,
      });
      assert.equal(res.ok, true, `女巫行动应被接受：${res.message ?? ''}`);
      assert.notEqual(g.phase, 'NIGHT_WITCH', '女巫提交后应离开女巫阶段');
    }
  }

  if (g.phase === 'NIGHT_SEER') {
    if (g.isDeadSeat(SEER_SEAT)) {
      g.forceAdvance();
    } else {
      const target = g.aliveSeatsSnapshot().find((s) => s !== SEER_SEAT);
      assert.ok(target, '应存在可查验目标');
      const res = g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target });
      assert.equal(res.ok, true, `预言家行动应被接受：${res.message ?? ''}`);
    }
  }

  assert.equal(g.phase, 'NIGHT_RESOLVE');
  g.forceAdvance();
  assert.equal(g.phase, 'DAY_ANNOUNCE');
}

/** 从天亮后的任意公开阶段推进到正式放逐投票。旧测试默认无人上警。 */
function advanceToDayVote(g: Game): void {
  let guard = 0;
  while (phaseOf(g) !== 'DAY_VOTE' && phaseOf(g) !== 'GAME_OVER' && guard++ < 12) {
    if (phaseOf(g) === 'HUNTER_SHOOT') {
      const res = g.submitHunterShoot(pid(HUNTER_SEAT), null);
      assert.equal(res.ok, true, `猎人放弃开枪应被接受：${res.message ?? ''}`);
      continue;
    }
    g.forceAdvance();
  }
  if (phaseOf(g) !== 'GAME_OVER') assert.equal(g.phase, 'DAY_VOTE');
}

function beginSheriffElection(g: Game): void {
  playNight(g, null);
  g.forceAdvance();
  assert.equal(g.phase, 'SHERIFF_SIGNUP');
}

function electSingleSheriff(g: Game, sheriffSeat: number): void {
  for (const seat of g.aliveSeatsSnapshot()) {
    assert.equal(g.submitSheriffSignup(pid(seat), seat === sheriffSeat).ok, true);
  }
  assert.equal(g.phase, 'DAY_SPEECH');
  assert.equal(g.gameViewFor(pid(1)).sheriffSeat, sheriffSeat);
}

/** 跑完白天：公布 → 竞选/发言 → 投票 → 放逐 → （可能的猎人开枪）→ 下一夜或结束 */
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

  advanceToDayVote(g);
  if (phaseOf(g) === 'GAME_OVER') return;
  for (const seat of voters(g)) {
    const res = g.submitVote(pid(seat), decide(seat));
    assert.equal(res.ok, true, `${seat} 号投票应被接受：${res.message ?? ''}`);
  }
  assert.equal(g.phase, 'DAY_EXILE');
  g.forceAdvance();
}

/** 让机械狼首夜完成学习，并以全员弃票进入第二夜、越过固定机械狼阶段。 */
function activateMechanicalForSecondNight(g: Game, learnTarget: number): void {
  g.start();
  g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_MECHANICAL');
  assert.equal(g.submitNightAction(pid(1), { kind: 'mechanicalLearn', target: learnTarget }).ok, true);

  let guard = 0;
  while (phaseOf(g) !== 'NIGHT_RESOLVE' && guard++ < 12) g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_RESOLVE');
  g.forceAdvance();
  assert.equal(g.phase, 'DAY_ANNOUNCE');
  playDay(g, () => null);
  assert.equal(g.phase, 'NIGHT_START');

  g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_MECHANICAL');
  assert.equal(g.gameViewFor(pid(1)).me?.mechanicalSkillActive, true);
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

describe('版型配置与开局', () => {
  it('默认版型是 12 人预女猎白：4 狼 4 民 + 预言家/女巫/猎人/白痴', () => {
    const board = defaultBoard();
    const deck = boardToDeck(board);
    assert.equal(board.playerCount, 12);
    assert.equal(deck.length, 12);
    const counts = new Map<Role, number>();
    for (const r of deck) counts.set(r, (counts.get(r) ?? 0) + 1);
    assert.equal(counts.get('WOLF'), 4);
    assert.equal(counts.get('VILLAGER'), 4);
    assert.equal(counts.get('SEER'), 1);
    assert.equal(counts.get('WITCH'), 1);
    assert.equal(counts.get('HUNTER'), 1);
    assert.equal(counts.get('IDIOT'), 1);
  });

  it('所有内置预设版型的角色总数都恰好等于人数', () => {
    for (const preset of BOARD_PRESETS) {
      const total = boardTotal(preset.board);
      assert.equal(
        total,
        preset.board.playerCount,
        `预设「${preset.name}」总数为 ${total}，与人数 ${preset.board.playerCount} 不符`,
      );
      assert.deepEqual(boardErrors(preset.board), [], `预设「${preset.name}」不应有校验错误`);
    }
  });

  it('角色总数少了 → 报错并说明差几个', () => {
    const board = makeBoard(12, { WOLF: 4, VILLAGER: 4, SEER: 1, WITCH: 1 });
    const errors = boardErrors(board);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /少了 2 人/);
  });

  it('角色总数多了 → 报错并说明多几个', () => {
    const board = makeBoard(12, { WOLF: 5, VILLAGER: 5, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1 });
    const errors = boardErrors(board);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /多了 2 人/);
  });

  it('唯一角色超过 1 个 → 报错', () => {
    const board = makeBoard(12, { WOLF: 4, VILLAGER: 4, SEER: 2, WITCH: 1, HUNTER: 1 });
    const errors = boardErrors(board);
    assert.ok(
      errors.some((e) => /预言家 最多只能选 1 个/.test(e.message)),
      `应有「预言家最多 1 个」的错误，实际：${errors.map((e) => e.message).join(' / ')}`,
    );
  });

  it('没有狼人 → 报错', () => {
    const board = makeBoard(12, { VILLAGER: 8, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1 });
    assert.ok(boardErrors(board).some((e) => /至少要有一名狼人/.test(e.message)));
  });

  it('没有好人 → 报错', () => {
    const board = makeBoard(12, { WOLF: 12 });
    assert.ok(boardErrors(board).some((e) => /至少要有一名好人/.test(e.message)));
  });

  it('人数超出 6-18 范围 → 报错', () => {
    assert.ok(boardErrors(makeBoard(MIN_PLAYERS - 1, { WOLF: 2, VILLAGER: 3 })).length > 0);
    assert.ok(boardErrors(makeBoard(MAX_PLAYERS + 1, { WOLF: 2 })).length > 0);
  });

  it('狼人占比过高只是警告，不阻止开局', () => {
    // 6 人局 3 狼 3 好人是 50%，超过阈值 → 只应产生 warn
    const board = makeBoard(6, { WOLF: 3, VILLAGER: 2, SEER: 1 });
    assert.deepEqual(boardErrors(board), [], '平衡性问题不应阻止开局');
    assert.ok(boardWarnings(board).length > 0, '应给出平衡性警告');
  });

  it('版型摘要把数量和唯一角色分开表述', () => {
    const text = boardSummary(defaultBoard());
    assert.match(text, /4 狼人/);
    assert.match(text, /4 平民/);
    assert.match(text, /预言家/);
  });

  it('人数与牌堆不一致时不能开局', () => {
    const seeds: PlayerSeed[] = [];
    for (let seat = 1; seat <= 11; seat++) {
      seeds.push({ id: pid(seat), seat, nickname: `玩家${seat}` });
    }
    // 11 个人，却给了 12 张牌
    const g = new Game('TEST02', seeds, { roles: LAYOUT, shuffle: false, seed: 1 });
    const res = g.start();
    assert.equal(res.ok, false);
    assert.match(res.message ?? '', /牌堆有 12 张牌/);
    assert.equal(g.phase, 'WAITING');
  });

  it('8 人局也能正常开局（引擎不写死 12 人）', () => {
    const deck: Role[] = ['WOLF', 'WOLF', 'VILLAGER', 'VILLAGER', 'VILLAGER', 'SEER', 'WITCH', 'HUNTER'];
    const g = newGame({ roles: deck });
    assert.equal(g.playerCount, 8);
    assert.equal(g.start().ok, true);
    assert.equal(g.phase, 'NIGHT_START');
    assert.equal(aliveWolves(g).length, 2);
  });

  it('随机发牌也满足板子数量（跑 50 次）', () => {
    for (let i = 0; i < 50; i++) {
      const seeds: PlayerSeed[] = [];
      for (let seat = 1; seat <= 12; seat++) {
        seeds.push({ id: pid(seat), seat, nickname: `玩家${seat}` });
      }
      const g = new Game('TEST01', seeds, { roles: LAYOUT, shuffle: true, seed: i + 1 });
      g.start();
      let wolves = 0;
      for (let seat = 1; seat <= 12; seat++) {
        if (g.roleAt(seat) === 'WOLF') wolves++;
      }
      assert.equal(wolves, 4, `第 ${i + 1} 次发牌狼人数不对`);
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

  it('预言家出局后依然进入查验阶段（固定时长，不靠阶段消失泄密）', () => {
    const g = newGame();
    g.start();
    playNight(g, SEER_SEAT); // 第一夜刀掉预言家
    playDay(g, () => null);
    assert.equal(g.isDeadSeat(SEER_SEAT), true);

    g.forceAdvance(); // → NIGHT_WOLVES
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    if (phaseOf(g) === 'NIGHT_GUARD') g.forceAdvance();
    // 走到查验阶段为止（中间可能还有女巫阶段）
    let hops = 0;
    while (phaseOf(g) !== 'NIGHT_SEER' && phaseOf(g) !== 'NIGHT_RESOLVE' && hops++ < 4) {
      g.forceAdvance();
    }
    // 预言家已死，但查验阶段必须照常出现 —— 否则「今晚没听到预言家请睁眼」
    // 就等于向全场公布了预言家的死讯。
    assert.equal(g.phase, 'NIGHT_SEER', '预言家出局也必须保留查验阶段');
    const res = g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: 5 });
    assert.equal(res.ok, false, '出局玩家不应能查验');
  });

  /**
   * 这条以前叫「两瓶药都用完后跳过女巫阶段」，断言的是一个**信息漏洞**：
   * 女巫没药 → 阶段消失 → 全场从阶段时长就能推断出女巫已经空手了。
   * 现在的规则是：只要板子里有女巫，女巫阶段就一定完整存在、走满固定时长。
   */
  it('两瓶药都用完，女巫阶段依然完整走完（不靠时长泄密）', () => {
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
    // 走过守卫阶段
    if (phaseOf(g) === 'NIGHT_GUARD') g.forceAdvance();

    assert.equal(g.phase, 'NIGHT_WITCH', '无药可用也必须保留女巫阶段');
    // 模拟服务端的固定时长：按住引擎，女巫提交「什么都不做」后阶段也不许提前关闭。
    g.holdAdvance = true;
    const res = g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    assert.equal(res.ok, true, '空手女巫仍可提交「不使用」（否则她永远走不掉这一轮）');
    assert.equal(g.phase, 'NIGHT_WITCH', '按住期间阶段必须停满时长，不能提前关闭');
    assert.equal(g.actionsComplete(), true, '服务端应能据此开始最后 5 秒倒数');
  });
});

describe('混血儿、通灵师与机械狼', () => {
  it('混血儿首夜选择榜样但不知道阵营，预言家仍查验为好人，结算阵营跟随榜样', () => {
    const g = newGame({ roles: LAYOUT_HYBRID });
    g.start();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_HYBRID');

    assert.equal(g.submitNightAction(pid(13), { kind: 'hybrid', target: 1 }).ok, true);
    const hybridView = g.gameViewFor(pid(13));
    assert.equal(hybridView.me?.hybridModelSeat, 1);
    assert.equal('camp' in (hybridView.me ?? {}), true, '混血儿仍只看到自己的牌面阵营，不收到榜样阵营字段');
    assert.equal(hybridView.phaseHint.includes('阵营'), false, '提示中不能泄露榜样阵营');

    for (const seat of [1, 2, 3, 4]) {
      assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: null }).ok, true);
    }
    assert.equal(g.submitNightAction(pid(10), { kind: 'witch', save: false, poison: null }).ok, true);
    assert.equal(g.phase, 'NIGHT_SEER');
    assert.equal(g.submitNightAction(pid(9), { kind: 'seer', target: 13 }).ok, true);
    assert.equal(g.gameViewFor(pid(9)).me?.seerHistory?.at(-1)?.camp, 'GOOD');
    assert.equal(g.revealRows().find((row) => row.seat === 13)?.camp, 'WOLF');
  });

  it('混血儿属于民边：普通平民死光时不会提前判狼胜，混血儿也死亡才算屠民', () => {
    const roles: Role[] = ['WOLF', 'WOLF', 'VILLAGER', 'HYBRID', 'SEER', 'HUNTER'];
    const g = newGame({ roles });
    g.start();
    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(4), { kind: 'hybrid', target: 1 }).ok, true);
    for (const seat of [1, 2]) {
      assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: 3 }).ok, true);
    }
    assert.equal(g.submitNightAction(pid(5), { kind: 'seer', target: 1 }).ok, true);
    assert.equal(g.phase, 'NIGHT_RESOLVE');
    g.forceAdvance();
    assert.equal(g.phase, 'DAY_ANNOUNCE');
    assert.equal(g.winnerCamp, null, '混血儿仍存活，民边尚未被屠尽');
    assert.equal(g.summary.villagers, 1);

    playDay(g, () => null);
    assert.equal(g.phase, 'NIGHT_START');
    g.forceAdvance();
    for (const seat of [1, 2]) {
      assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: 4 }).ok, true);
    }
    assert.equal(g.submitNightAction(pid(5), { kind: 'seer', target: 1 }).ok, true);
    g.forceAdvance();
    assert.equal(g.winnerCamp, 'WOLF');
    assert.equal(g.summary.villagers, 0);
  });

  it('通灵师查验得到具体身份，结果只进入自己的历史', () => {
    const roles: Role[] = ['WOLF', 'WOLF', 'VILLAGER', 'VILLAGER', 'SPIRIT_SEER', 'HUNTER'];
    const g = newGame({ roles });
    g.start();
    g.forceAdvance();
    for (const seat of [1, 2]) {
      assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: null }).ok, true);
    }
    assert.equal(g.phase, 'NIGHT_SPIRIT_SEER');
    assert.equal(g.submitNightAction(pid(5), { kind: 'spiritSeer', target: 1 }).ok, true);
    const result = g.gameViewFor(pid(5)).me?.spiritHistory?.at(-1);
    assert.deepEqual({ seat: result?.seat, role: result?.role, roleName: result?.roleName }, {
      seat: 1,
      role: 'WOLF',
      roleName: '狼人',
    });
    assert.equal(g.gameViewFor(pid(3)).me?.spiritHistory, undefined);
  });

  it('机械狼首夜与狼队隔离，复制守卫后从第二夜起独立守护', () => {
    const g = newGame({ roles: LAYOUT_MECHANICAL_SPIRIT });
    g.start();
    const wolfView = g.gameViewFor(pid(2));
    assert.equal(wolfView.me?.teammates?.includes(1), false);
    assert.equal(g.seatViewsFor(pid(2)).find((seat) => seat.seat === 1)?.role, undefined);
    assert.equal(g.gameViewFor(pid(1)).me?.teammates, undefined);

    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(1), { kind: 'mechanicalLearn', target: 12 }).ok, true);
    assert.equal(g.gameViewFor(pid(1)).me?.mechanicalLearnedRole, 'GUARD');
    assert.equal(g.gameViewFor(pid(1)).me?.mechanicalSkillActive, false);
    while (phaseOf(g) !== 'NIGHT_RESOLVE') g.forceAdvance();
    g.forceAdvance();
    playDay(g, () => null);
    g.forceAdvance();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_GUARD');

    assert.equal(g.submitNightAction(pid(1), { kind: 'mechanicalSkill', skill: 'guard', target: 5 }).ok, true);
    assert.equal(g.phase, 'NIGHT_GUARD', '普通守卫尚未行动时不能提前推进');
    assert.equal(g.submitNightAction(pid(12), { kind: 'guard', target: 6 }).ok, true);
    for (const seat of [2, 3, 4]) {
      assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 }).ok, true);
    }
    assert.equal(g.submitNightAction(pid(10), { kind: 'witch', save: false, poison: null }).ok, true);
    assert.equal(g.submitNightAction(pid(9), { kind: 'spiritSeer', target: 2 }).ok, true);
    g.forceAdvance();
    assert.equal(g.isDeadSeat(5), false, '机械狼复制的守护应能挡住狼刀');
  });

  it('机械狼学习狼人后第二夜加入狼刀并与普通狼人互认', () => {
    const g = newGame({ roles: LAYOUT_MECHANICAL_SPIRIT });
    activateMechanicalForSecondNight(g, 2);
    assert.equal(g.phase, 'NIGHT_GUARD');
    const mechanic = g.gameViewFor(pid(1));
    const wolf = g.gameViewFor(pid(2));
    assert.deepEqual(mechanic.me?.teammates, [2, 3, 4]);
    assert.equal(wolf.me?.teammates?.includes(1), true);
    assert.equal(g.seatViewsFor(pid(2)).find((seat) => seat.seat === 1)?.role, 'MECHANICAL_WOLF');
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.equal(g.gameViewFor(pid(1)).myTurn, true);
  });

  it('机械狼复制通灵师后可从第二夜查验具体身份', () => {
    const g = newGame({ roles: LAYOUT_MECHANICAL_SPIRIT });
    activateMechanicalForSecondNight(g, 9);
    assert.equal(g.phase, 'NIGHT_GUARD');
    g.forceAdvance();
    g.forceAdvance();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_SPIRIT_SEER');
    assert.equal(g.submitNightAction(pid(1), { kind: 'mechanicalSkill', skill: 'spiritSeer', target: 2 }).ok, true);
    assert.equal(g.phase, 'NIGHT_SPIRIT_SEER', '原通灵师尚未行动时不能提前推进');
    assert.equal(g.submitNightAction(pid(9), { kind: 'spiritSeer', target: 5 }).ok, true);
    assert.equal(g.gameViewFor(pid(1)).me?.spiritHistory?.at(-1)?.role, 'WOLF');
  });

  it('机械狼复制猎人后，从第二夜起死亡可以开枪', () => {
    const g = newGame({ roles: LAYOUT_MECHANICAL_SPIRIT });
    activateMechanicalForSecondNight(g, 11);
    g.forceAdvance();
    for (const seat of [2, 3, 4]) {
      assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: 1 }).ok, true);
    }
    assert.equal(g.submitNightAction(pid(10), { kind: 'witch', save: false, poison: null }).ok, true);
    assert.equal(g.submitNightAction(pid(9), { kind: 'spiritSeer', target: 2 }).ok, true);
    g.forceAdvance();
    assert.equal(g.phase, 'DAY_ANNOUNCE');
    g.forceAdvance();
    assert.equal(g.phase, 'HUNTER_SHOOT');
    assert.equal(g.gameViewFor(pid(1)).hunterPendingSeat, 1);
    assert.equal(g.submitHunterShoot(pid(1), null).ok, true);
  });

  it('机械狼复制白痴后，从第二天起被放逐会翻牌免死并失去投票权', () => {
    const g = newGame({ roles: LAYOUT_MECHANICAL_IDIOT });
    activateMechanicalForSecondNight(g, 12);
    assert.equal(g.phase, 'NIGHT_WOLVES');
    g.forceAdvance();
    g.forceAdvance();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_RESOLVE');
    g.forceAdvance();
    playDay(g, (seat) => (seat === 1 ? null : 1));
    assert.equal(g.isDeadSeat(1), false);
    assert.equal(g.gameViewFor(pid(1)).me?.idiotRevealed, true);
    assert.equal(g.gameViewFor(pid(1)).me?.canVote, false);
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
    advanceToDayVote(g);
    assertInvariants(g);
  });

  it('猎人被女巫毒死不能开枪', () => {
    const g = newGame();
    g.start();
    playNight(g, 5, { poison: HUNTER_SEAT });
    g.forceAdvance(); // 离开 DAY_ANNOUNCE
    assert.equal(g.isDeadSeat(HUNTER_SEAT), true);
    assert.notEqual(g.phase, 'HUNTER_SHOOT', '被毒死的猎人不应获得开枪机会');
    advanceToDayVote(g);
  });

  it('猎人被投票放逐可以开枪', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);

    g.forceAdvance();
    advanceToDayVote(g);
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
    advanceToDayVote(g);

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
    advanceToDayVote(g);
    const res = g.submitVote(pid(1), IDIOT_SEAT);
    assert.equal(res.ok, false, '已翻牌的白痴不应能再被投票');
  });
});

describe('警长与警徽', () => {
  it('单人上警自动当选，座位公开警徽，警长决定方向并最后发言', () => {
    const g = newGame();
    g.start();
    beginSheriffElection(g);
    electSingleSheriff(g, 5);

    const seat = g.seatViewsFor(pid(6)).find((s) => s.seat === 5);
    assert.equal(seat?.isSheriff, true, '所有玩家都应看到公开警徽');
    assert.equal(g.setSpeechDirection(pid(6), 'FORWARD').ok, false, '非警长不能指定方向');
    assert.equal(g.setSpeechDirection(pid(5), 'REVERSE').ok, true);
    const order = g.gameViewFor(pid(6)).speechOrder ?? [];
    assert.equal(order.at(-1), 5, '警长应最后发言并归票');
    g.forceAdvance();
    assert.equal(g.phase, 'DAY_VOTE');
  });

  it('首轮平票进入 PK，候选人可退水；PK 再次平票则警徽流失', () => {
    const g = newGame();
    g.start();
    beginSheriffElection(g);
    for (const seat of g.aliveSeatsSnapshot()) {
      g.submitSheriffSignup(pid(seat), [1, 2, 3].includes(seat));
      if (seat === 1) assert.deepEqual(g.gameViewFor(pid(4)).sheriffCandidates, [1], '上警名单应实时公开');
    }
    assert.equal(g.phase, 'SHERIFF_CAMPAIGN');
    assert.equal(g.gameViewFor(pid(4)).speechOrder?.length, 3, '应生成警上发言顺序');
    assert.equal(g.withdrawSheriff(pid(3)).ok, true);
    g.forceAdvance();
    assert.equal(g.phase, 'SHERIFF_VOTE');
    assert.equal(g.submitSheriffVote(pid(1), 2).ok, false, '候选人不能参加警下投票');

    const firstVoters = g.aliveSeatsSnapshot().filter((s) => ![1, 2].includes(s));
    firstVoters.forEach((seat, i) => g.submitSheriffVote(pid(seat), i < firstVoters.length / 2 ? 1 : 2));
    assert.equal(g.phase, 'SHERIFF_PK');
    assert.equal(g.gameViewFor(pid(4)).voteDetail?.length, firstVoters.length, '警长票型应在结算后公开');
    g.forceAdvance();
    assert.equal(g.phase, 'SHERIFF_REVOTE');
    const secondVoters = g.aliveSeatsSnapshot().filter((s) => ![1, 2].includes(s));
    secondVoters.forEach((seat, i) => g.submitSheriffVote(pid(seat), i < secondVoters.length / 2 ? 1 : 2));
    const view = g.gameViewFor(pid(4));
    assert.equal(g.phase, 'DAY_SPEECH');
    assert.equal(view.sheriffSeat, null);
    assert.equal(view.sheriffElectionFinished, true);
  });

  it('警长放逐票按 1.5 票计算并在票型中公开', () => {
    const g = newGame();
    g.start();
    beginSheriffElection(g);
    electSingleSheriff(g, 1);
    assert.equal(g.setSpeechDirection(pid(1), 'FORWARD').ok, true);
    g.forceAdvance();

    for (const seat of voters(g)) {
      const target = seat === 1 ? 2 : seat === 4 ? 3 : null;
      assert.equal(g.submitVote(pid(seat), target).ok, true);
    }
    assert.equal(g.phase, 'DAY_EXILE');
    assert.equal(g.exiledSnapshot()?.seat, 2, '警长的 1.5 票应击败一张普通票');
    const sheriffVote = g.gameViewFor(pid(6)).voteDetail?.find((v) => v.voter === 1);
    assert.equal(sheriffVote?.weight, 1.5);
  });

  it('警长出局后可以移交警徽，也可以撕毁', () => {
    const g = newGame();
    g.start();
    beginSheriffElection(g);
    electSingleSheriff(g, 1);
    g.setSpeechDirection(pid(1), 'FORWARD');
    g.forceAdvance();
    for (const seat of voters(g)) g.submitVote(pid(seat), seat === 1 ? null : 1);
    assert.equal(g.phase, 'DAY_EXILE');
    g.forceAdvance();
    assert.equal(g.phase, 'SHERIFF_TRANSFER');
    assert.equal(g.submitSheriffTransfer(pid(2), 3).ok, false, '非出局警长不能处理警徽');
    assert.equal(g.submitSheriffTransfer(pid(1), 2).ok, true);
    assert.equal(g.gameViewFor(pid(4)).sheriffSeat, 2);
    assert.equal(g.phase, 'NIGHT_START');
  });

  it('警长夜间死亡会在天亮后先处理警徽，选择撕毁后继续白天', () => {
    const g = newGame();
    g.start();
    beginSheriffElection(g);
    electSingleSheriff(g, 5);
    g.setSpeechDirection(pid(5), 'FORWARD');
    g.forceAdvance();
    for (const seat of voters(g)) g.submitVote(pid(seat), null);
    assert.equal(g.phase, 'DAY_EXILE');
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_START');

    playNight(g, 5);
    g.forceAdvance();
    assert.equal(g.phase, 'SHERIFF_TRANSFER');
    assert.equal(g.submitSheriffTransfer(pid(5), null).ok, true);
    assert.equal(g.gameViewFor(pid(6)).sheriffSeat, null);
    assert.equal(g.phase, 'DAY_SPEECH');
  });

  it('白狼王在警长竞选期间自爆会终止竞选并使警徽流失', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    g.start();
    beginSheriffElection(g);
    assert.equal(g.selfDestruct(pid(WOLF_KING_SEAT)).ok, true);
    assert.equal(g.phase, 'WOLF_KING_BOOM');
    g.submitBoomTarget(pid(WOLF_KING_SEAT), null);
    assert.equal(g.gameViewFor(pid(5)).sheriffElectionFinished, true);
    assert.equal(g.gameViewFor(pid(5)).sheriffSeat, null);
  });
});

describe('投票', () => {
  it('平票时无人出局', () => {
    const g = newGame();
    g.start();
    playNight(g, 5); // 5 号夜里出局，剩 11 名投票人
    g.forceAdvance();
    advanceToDayVote(g);

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
    advanceToDayVote(g);
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
    advanceToDayVote(g);
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
    advanceToDayVote(g);
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
    advanceToDayVote(g);

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

/**
 * 上帝视角的权限边界。
 *
 * 这里是**服务端权威**：活着的玩家即使自己伪造一个 game.godView 请求，
 * engine 也必须拒绝并且不下发 revealAll —— 只在客户端藏按钮是纸糊的权限，
 * 改一行 JS 就能把全场身份拉到手上。
 */
describe('上帝视角权限', () => {
  /** 造一个「已经死过人、但游戏还没结束」的局面 */
  function gameWithDeaths(): Game {
    const g = newGame();
    g.start();
    playNight(g, 5); // 刀掉 5 号（平民）
    assert.equal(g.isDeadSeat(5), true);
    assert.notEqual(phaseOf(g), 'GAME_OVER');
    return g;
  }

  it('活着的玩家拿不到上帝视角，即使主动请求', () => {
    const g = gameWithDeaths();
    const alive = g.aliveSeatsSnapshot()[0]!;
    assert.equal(g.gameViewFor(pid(alive)).godViewAvailable, undefined, '活人不应看到按钮');

    g.setGodView(pid(alive), true); // 伪造请求
    const view = g.gameViewFor(pid(alive));
    assert.ok(!view.godViewActive, '活人的请求必须被拒绝');
    assert.equal(view.revealAll, undefined, '活人绝不能收到全场身份');
  });

  it('已出局的玩家可以打开上帝视角', () => {
    const g = gameWithDeaths();
    assert.equal(g.gameViewFor(pid(5)).godViewAvailable, true, '出局玩家应看到按钮');

    g.setGodView(pid(5), true);
    const view = g.gameViewFor(pid(5));
    assert.equal(view.godViewActive, true);
    assert.ok(view.revealAll, '出局后应能查看全场身份');
    assert.equal(view.revealAll?.filter((r) => r.role === 'WOLF').length, 4);
  });

  it('上帝视角是「各自一份」，不会把别人的视角一起打开', () => {
    const g = gameWithDeaths();
    g.setGodView(pid(5), true);
    assert.equal(g.gameViewFor(pid(5)).godViewActive, true);
    // 另一个活人不受影响
    const alive = g.aliveSeatsSnapshot()[0]!;
    assert.ok(!g.gameViewFor(pid(alive)).godViewActive);
    assert.equal(g.gameViewFor(pid(alive)).revealAll, undefined);
  });

  it('游戏结束后人人可见，不需要再单独申请', () => {
    const g = newGame();
    g.start();
    for (const victim of [5, 6, 7]) {
      playNight(g, victim);
      playDay(g, () => null);
    }
    playNight(g, 8);
    if (phaseOf(g) !== 'GAME_OVER') playDay(g, () => null);
    assert.equal(g.phase, 'GAME_OVER');
    assert.ok(g.gameViewFor(pid(5)).revealAll, '结束后死人也可见');
    const stillStanding = g.aliveSeatsSnapshot()[0];
    if (stillStanding !== undefined) {
      assert.ok(g.gameViewFor(pid(stillStanding)).revealAll, '结束后活着的人也可见');
    }
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

  it('有守卫时阶段顺序是「狼 → 守卫 → 女巫 → 预言家」', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    const seen: Phase[] = [];

    g.forceAdvance();
    seen.push(g.phase);
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    seen.push(g.phase);
    g.submitNightAction(pid(GUARD_SEAT), { kind: 'guard', target: 5 });
    seen.push(g.phase);
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    seen.push(g.phase);

    assert.deepEqual(seen, ['NIGHT_WOLVES', 'NIGHT_GUARD', 'NIGHT_WITCH', 'NIGHT_SEER']);
  });
});

// ────────────────────────────── 守卫 ──────────────────────────────

describe('守卫', () => {
  it('守住狼刀目标 → 平安夜', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    playNight(g, 5, {}, 5); // 狼刀 5 号，守卫也守 5 号

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [], '被守住应该是平安夜');
    assert.equal(g.isDeadSeat(5), false, '5 号应该活着');
    assert.equal(g.lastGuardedSnapshot(), 5, '应记下守卫这一夜守了谁');
  });

  it('不能连续两晚守护同一名玩家', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    playNight(g, 5, {}, 5); // 第 1 夜守 5 号
    playDay(g, () => null);

    g.forceAdvance(); // → NIGHT_WOLVES
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 6 });
    }
    assert.equal(g.phase, 'NIGHT_GUARD');

    const bad = g.submitNightAction(pid(GUARD_SEAT), { kind: 'guard', target: 5 });
    assert.equal(bad.ok, false, '连续两晚守同一人应被拒绝');
    assert.match(bad.message ?? '', /不能连续两晚/);

    const good = g.submitNightAction(pid(GUARD_SEAT), { kind: 'guard', target: 6 });
    assert.equal(good.ok, true, `改守别人应被接受：${good.message ?? ''}`);
  });

  it('同守同救 → 该玩家依然死亡', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    // 狼刀 5 号，守卫守 5 号，女巫也用解药救 5 号 → 双重保护视为无效
    playNight(g, 5, { save: true }, 5);

    assert.deepEqual(
      g.gameViewFor(pid(1)).lastNightDeaths,
      [5],
      '同守同救时该玩家依然死亡（主流规则）',
    );
    assert.equal(g.isDeadSeat(5), true);
    // 解药照样被消耗掉
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).me?.potions?.antidote, false);
  });

  it('守护挡不住女巫的毒药', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    playNight(g, 6, { poison: 5 }, 5); // 守卫守 5 号，但女巫毒了 5 号

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5, 6]);
    assert.equal(g.isDeadSeat(5), true, '毒药无视守护');
    assert.equal(g.isDeadSeat(6), true, '6 号被狼刀，没人救');
  });

  it('守卫可以守自己', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    playNight(g, 5, {}, GUARD_SEAT);

    assert.equal(g.lastGuardedSnapshot(), GUARD_SEAT);
    assert.equal(g.isDeadSeat(GUARD_SEAT), false);
  });

  /**
   * 这条以前断言「守卫出局后跳过守护阶段」—— 那也是漏洞：
   * 阶段一消失，全场就都知道守卫死了。守卫的死讯本来就该由白天的死讯公布，
   * 而不是靠「今晚语音里没念到守卫」被反推出来。
   */
  it('守卫出局后依然进入守护阶段（固定时长，不靠阶段消失泄密）', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    playNight(g, GUARD_SEAT, {}, 5); // 第 1 夜狼刀守卫（守卫守 5 号，救不了自己）
    assert.equal(g.isDeadSeat(GUARD_SEAT), true);
    playDay(g, () => null);

    g.forceAdvance(); // → NIGHT_WOLVES
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    assert.equal(g.phase, 'NIGHT_GUARD', '守卫已出局，阶段仍然必须出现');
    // 已出局的守卫不能再行动，阶段只能空转
    const res = g.submitNightAction(pid(GUARD_SEAT), { kind: 'guard', target: 6 });
    assert.equal(res.ok, false, '出局玩家不应能行动');
    assert.equal(g.phase, 'NIGHT_GUARD', '没人能行动时阶段必须停满时长');
  });

  it('视图里会告知守卫「本夜不能再守的人」', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    g.start();
    playNight(g, 5, {}, 5);
    playDay(g, () => null);

    g.forceAdvance(); // → NIGHT_WOLVES
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 6 });
    }
    assert.equal(g.phase, 'NIGHT_GUARD');
    const view = g.gameViewFor(pid(GUARD_SEAT));
    assert.equal(view.guardBlockedSeat, 5, '应告知上一夜守过 5 号');
    assert.equal(view.me?.lastGuardedSeat, 5);
    assert.ok(!view.myOptions.includes(5), '上一夜守过的人不应出现在可选项里');
  });
});

// ────────────────────────────── 白狼王 ──────────────────────────────

describe('白狼王', () => {
  it('属于狼人阵营，夜里和狼人一起行动', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    g.start();
    assert.equal(g.roleAt(WOLF_KING_SEAT), 'WOLF_KING');

    const view = g.gameViewFor(pid(WOLF_KING_SEAT));
    assert.equal(view.me?.camp, 'WOLF', '白狼王应算狼人阵营');
    assert.deepEqual(view.me?.teammates, [2, 3, 4], '应看到其余狼队友');

    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.equal(g.gameViewFor(pid(WOLF_KING_SEAT)).myTurn, true, '白狼王应该和狼一起点刀');
  });

  it('预言家查验白狼王得到「狼人」', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    g.start();
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    if (g.phase === 'NIGHT_GUARD') {
      g.submitNightAction(pid(GUARD_SEAT), { kind: 'guard', target: 5 });
    }
    if (g.phase === 'NIGHT_WITCH') {
      g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    }
    assert.equal(g.phase, 'NIGHT_SEER');
    g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: WOLF_KING_SEAT });

    const history = g.gameViewFor(pid(SEER_SEAT)).me?.seerHistory ?? [];
    assert.equal(history.length, 1);
    assert.equal(history[0]?.camp, 'WOLF', '白狼王在预言家眼里必须是狼人');
  });

  it('白天自爆 → 带走一人 → 直接进入黑夜（当天不再投票）', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    g.start();
    playNight(g, 5);
    g.forceAdvance(); // 离开 DAY_ANNOUNCE
    advanceToDayVote(g);

    const res = g.selfDestruct(pid(WOLF_KING_SEAT));
    assert.equal(res.ok, true, `自爆应被接受：${res.message ?? ''}`);
    assert.equal(g.phase, 'WOLF_KING_BOOM', '应进入「指定带走谁」阶段');
    assert.equal(g.isDeadSeat(WOLF_KING_SEAT), true, '自爆的白狼王出局');
    assert.equal(g.boomPendingSnapshot(), WOLF_KING_SEAT);

    const boom = g.submitBoomTarget(pid(WOLF_KING_SEAT), 7);
    assert.equal(boom.ok, true, `指定目标应被接受：${boom.message ?? ''}`);
    assert.equal(g.isDeadSeat(7), true, '被带走的 7 号应出局');

    assert.equal(g.phase, 'NIGHT_START', '自爆后应直接进入黑夜，不经过放逐投票');
    assert.equal(g.day, 2, '应进入第 2 天');
    assertInvariants(g);
  });

  it('自爆后不再统计当天票型（跳过放逐）', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    g.start();
    playNight(g, 5);
    g.forceAdvance();

    g.submitVote(pid(2), 6); // 先有人投了票
    g.selfDestruct(pid(WOLF_KING_SEAT));
    g.submitBoomTarget(pid(WOLF_KING_SEAT), null); // 选择不带人

    assert.equal(g.exiledSnapshot(), null, '自爆当天不应产生放逐结果');
    assert.equal(g.phase, 'NIGHT_START');
  });

  it('夜里不能自爆，普通狼人也不能自爆', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    g.start();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    const atNight = g.selfDestruct(pid(WOLF_KING_SEAT));
    assert.equal(atNight.ok, false, '夜里不能自爆');
    assert.match(atNight.message ?? '', /白天/);

    // 推进到白天（用 phaseOf 读阶段，避免断言签名把 g.phase 收窄成字面量）
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    if (phaseOf(g) === 'NIGHT_GUARD') {
      g.submitNightAction(pid(GUARD_SEAT), { kind: 'guard', target: GUARD_SEAT });
    }
    if (phaseOf(g) === 'NIGHT_WITCH') {
      g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: null });
    }
    if (phaseOf(g) === 'NIGHT_SEER') {
      g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: 2 });
    }
    g.forceAdvance();
    g.forceAdvance();
    advanceToDayVote(g);

    const notKing = g.selfDestruct(pid(2));
    assert.equal(notKing.ok, false, '普通狼人不能自爆');
    assert.match(notKing.message ?? '', /不是白狼王/);
  });

  it('白狼王是最后一狼时自爆 → 好人胜（判定在带人之后）', () => {
    // 4 人局：白狼王 / 平民 / 预言家 / 猎人，只有一只狼
    const deck: Role[] = ['WOLF_KING', 'VILLAGER', 'SEER', 'HUNTER'];
    const g = newGame({ roles: deck });
    g.start();
    g.forceAdvance(); // → NIGHT_WOLVES
    // 空刀，避免夜里死人，方便把注意力集中在自爆逻辑上
    g.submitNightAction(pid(1), { kind: 'wolf', target: null });
    if (g.phase === 'NIGHT_SEER') {
      g.submitNightAction(pid(3), { kind: 'seer', target: 2 });
    }
    assert.equal(g.phase, 'NIGHT_RESOLVE');
    g.forceAdvance(); // → DAY_ANNOUNCE
    g.forceAdvance();
    advanceToDayVote(g);

    assert.equal(g.selfDestruct(pid(1)).ok, true);
    // 自爆时狼人已经清零，但胜负要等"带人"结算完再判
    assert.equal(g.winnerCamp, null, '此时还不该判出胜负');

    g.submitBoomTarget(pid(1), 2); // 带走最后的平民
    assert.equal(g.isDeadSeat(2), true);
    assert.equal(g.winnerCamp, 'GOOD', '狼人全部出局 → 好人胜（即使同时屠了边）');
    assert.equal(g.phase, 'GAME_OVER');
  });
});

// ────────────────────────────── 狼队战术标签 ──────────────────────────────

describe('狼队战术标签', () => {
  it('狼人可以给自己挂标签，好人不允许', () => {
    const g = newGame();
    g.start();
    assert.equal(g.setWolfTag(pid(1), 'CHARGER').ok, true, '狼人应能挂标签');

    const good = g.setWolfTag(pid(5), 'CHARGER');
    assert.equal(good.ok, false, '平民不能挂狼队标签');
    assert.match(good.message ?? '', /只有狼人/);
  });

  it('悍跳位全队只能有一个人占', () => {
    const g = newGame();
    g.start();
    assert.equal(g.setWolfTag(pid(1), 'FAKE_SEER').ok, true);
    assert.equal(g.wolfTagAt(1), 'FAKE_SEER');

    // 第二个人来抢 → 拒绝，并且要告诉他是谁占了（否则队友之间会互相误解）
    const second = g.setWolfTag(pid(2), 'FAKE_SEER');
    assert.equal(second.ok, false, '悍跳位不能被第二个人占');
    assert.match(second.message ?? '', /1 号/);
    assert.equal(g.wolfTagAt(2), null, '被拒绝后不应该留下标签');

    // 第一个人重复设置同一个标签是允许的（幂等）
    assert.equal(g.setWolfTag(pid(1), 'FAKE_SEER').ok, true);
  });

  it('非排他标签可以多人同时占', () => {
    const g = newGame();
    g.start();
    for (const seat of [1, 2, 3, 4]) {
      assert.equal(g.setWolfTag(pid(seat), 'HOOK').ok, true, `${seat} 号应能挂倒钩`);
    }
    assert.equal(g.wolfTagAt(1), 'HOOK');
    assert.equal(g.wolfTagAt(4), 'HOOK');
  });

  it('原持有人可以改挂别的标签，把悍跳位让出来', () => {
    const g = newGame();
    g.start();
    g.setWolfTag(pid(1), 'FAKE_SEER');
    g.setWolfTag(pid(1), 'CHARGER');
    assert.equal(g.wolfTagAt(1), 'CHARGER');
    assert.equal(g.setWolfTag(pid(2), 'FAKE_SEER').ok, true, '让出来之后队友应该能接手');
  });

  it('可以取消自己的标签', () => {
    const g = newGame();
    g.start();
    g.setWolfTag(pid(1), 'SHERIFF');
    assert.equal(g.wolfTagAt(1), 'SHERIFF');
    assert.equal(g.setWolfTag(pid(1), null).ok, true);
    assert.equal(g.wolfTagAt(1), null);
  });

  it('所有狼队友都能看到彼此的标签，好人一律看不到', () => {
    const g = newGame();
    g.start();
    g.setWolfTag(pid(1), 'FAKE_SEER');
    g.setWolfTag(pid(3), 'HOOK');

    const wolfView = g.gameViewFor(pid(2));
    assert.ok(wolfView.wolfTags, '狼人应该拿到 wolfTags');
    assert.equal(wolfView.wolfTags!.length, 4, '应该列出全部 4 名狼人');
    const bySeat = new Map(wolfView.wolfTags!.map((w) => [w.seat, w.tag]));
    assert.equal(bySeat.get(1), 'FAKE_SEER');
    assert.equal(bySeat.get(3), 'HOOK');
    assert.equal(bySeat.get(2), null, '没挂标签的队友显示为 null');
    assert.equal(wolfView.me?.myWolfTag, null, '自己还没挂');
    assert.equal(wolfView.me?.canEditWolfTag, true);

    // 好人视图：整个 JSON 里不能出现标签相关字段
    const villagerJson = JSON.stringify(g.gameViewFor(pid(5)));
    assert.ok(!villagerJson.includes('wolfTags'), `平民视图泄露了狼队战术：${villagerJson.slice(0, 200)}`);
    assert.ok(!villagerJson.includes('FAKE_SEER'), '平民视图不能出现标签值');
    assert.ok(!villagerJson.includes('myWolfTag'), '平民视图不能出现狼队标签字段');
  });

  it('游戏结束后不能再改标签', () => {
    const g = newGame();
    g.start();
    let steps = 0;
    while (g.phase !== 'GAME_OVER' && steps++ < 500) g.forceAdvance();
    assert.equal(g.phase, 'GAME_OVER');
    assert.equal(g.setWolfTag(pid(1), 'CHARGER').ok, false);
  });

  it('战术标签不会写进公开日志', () => {
    const g = newGame();
    g.start();
    g.setWolfTag(pid(1), 'FAKE_SEER');
    const logText = g.gameViewFor(pid(5)).log.join('\n');
    assert.ok(!logText.includes('悍跳'), '公开日志里不能出现战术标签');
    assert.ok(!logText.includes('FAKE_SEER'), '公开日志里不能出现标签标识');
  });
});

// ────────────────────────────── 舞者与假面 ──────────────────────────────

function reachSecondNightMaskBall(g: Game): void {
  g.start();
  g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_WOLVES', '首夜不应出现舞者或假面阶段');
  for (const seat of [1, 2, 3]) assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: null }).ok, true);
  assert.equal(g.submitNightAction(pid(10), { kind: 'witch', save: false, poison: null }).ok, true);
  assert.equal(g.submitNightAction(pid(9), { kind: 'seer', target: 4 }).ok, true);
  assert.equal(g.gameViewFor(pid(9)).me?.seerHistory?.at(-1)?.camp, 'WOLF', '预言家应把假面验为狼人');
  g.forceAdvance();
  playDay(g, () => null);
  assert.equal(g.phase, 'NIGHT_START');
  g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_DANCER');
}

describe('舞者与假面', () => {
  it('首夜不行动，第二夜按舞者 → 假面 → 狼人推进，面具只反转舞池结算', () => {
    const g = newGame({ roles: LAYOUT_MASK_BALL });
    reachSecondNightMaskBall(g);

    assert.equal(g.submitNightAction(pid(12), { kind: 'dancer', targets: [1, 5, 6] }).ok, true);
    assert.equal(g.phase, 'NIGHT_MASK');
    g.holdAdvance = true; // 模拟服务端为角色阶段保留完整操作时间
    assert.equal(g.submitNightAction(pid(4), { kind: 'maskInspect', target: 5 }).ok, true);
    assert.deepEqual(g.gameViewFor(pid(4)).me?.maskInspect, { seat: 5, inDance: true });
    assert.equal(g.phase, 'NIGHT_MASK', '查验后必须留在同一假面阶段完成第二步');
    assert.equal(g.submitNightAction(pid(4), { kind: 'mask', target: 6 }).ok, true);
    assert.equal(g.phase, 'NIGHT_MASK', '完整操作时间内，提交完成也应等待房主或超时推进');
    assert.equal(g.gameViewFor(pid(4)).me?.maskHistory?.length, 1);
    g.forceAdvance(true);
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.equal(g.gameViewFor(pid(4)).me?.maskHistory?.length, 1, '强制推进不能重复写入假面历史');

    for (const seat of [1, 2, 3]) assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: null }).ok, true);
    assert.equal(g.submitNightAction(pid(10), { kind: 'witch', save: false, poison: null }).ok, true);
    assert.equal(g.submitNightAction(pid(9), { kind: 'seer', target: 4 }).ok, true);
    g.forceAdvance();

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5], '6 号被面具反转为狼后，5 号应成为唯一好人并舞池出局');
    assert.deepEqual(g.gameViewFor(pid(12)).me?.danceHistory, [{ day: 2, seats: [1, 5, 6] }]);
    assert.equal(g.gameViewFor(pid(4)).me?.maskHistory?.at(-1)?.maskSeat, 6);
    const villagerJson = JSON.stringify(g.gameViewFor(pid(7)));
    assert.ok(!villagerJson.includes('danceHistory') && !villagerJson.includes('maskHistory'), '普通玩家不得获得舞池或面具历史');
  });

  it('舞者自入池保护三人免疫狼刀；舞者与假面免疫毒药但仍消耗毒药', () => {
    const g = newGame({ roles: LAYOUT_MASK_BALL });
    reachSecondNightMaskBall(g);

    assert.equal(g.submitNightAction(pid(12), { kind: 'dancer', targets: [12, 5, 6] }).ok, true);
    assert.equal(g.submitNightAction(pid(4), { kind: 'maskInspect', target: 12 }).ok, true);
    assert.equal(g.submitNightAction(pid(4), { kind: 'mask', target: 7 }).ok, true);
    for (const seat of [1, 2, 3]) assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 }).ok, true);
    assert.equal(g.submitNightAction(pid(10), { kind: 'witch', save: false, poison: 12 }).ok, true);
    assert.equal(g.submitNightAction(pid(9), { kind: 'seer', target: 4 }).ok, true);
    g.forceAdvance();

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [], '舞池保护应挡住狼刀，舞者应免疫毒药');
    assert.equal(g.gameViewFor(pid(10)).me?.potions?.poison, false, '被免疫的毒药仍应消耗');
  });

  it('假面不认识普通狼；普通狼出局后从下一次狼刀阶段继承刀权', () => {
    const roles: Role[] = ['WOLF', 'MASK', 'VILLAGER', 'VILLAGER', 'VILLAGER', 'SEER'];
    const g = newGame({ roles });
    g.start();
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.equal(g.gameViewFor(pid(2)).myTurn, false, '普通狼仍存活时假面没有刀权');
    assert.equal(g.gameViewFor(pid(2)).me?.teammates, undefined, '假面不得看见普通狼身份');
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: null }).ok, true);
    assert.equal(g.submitNightAction(pid(6), { kind: 'seer', target: 2 }).ok, true);
    g.forceAdvance();
    advanceToDayVote(g);
    for (const seat of voters(g)) assert.equal(g.submitVote(pid(seat), seat === 1 ? null : 1).ok, true);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_START');
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_MASK');
    assert.equal(g.submitNightAction(pid(2), { kind: 'maskInspect', target: 2 }).ok, true);
    assert.equal(g.submitNightAction(pid(2), { kind: 'mask', target: 2 }).ok, true);
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.equal(g.gameViewFor(pid(2)).myTurn, true, '最后一名普通狼白天出局后，假面当夜应接刀');
    assert.equal(g.gameViewFor(pid(2)).me?.teammates, undefined, '接刀后也不补发普通狼历史或队友信息');
  });

  it('夜间行动进度只发给当前角色，房主没有额外秘密权限', () => {
    const g = newGame({ roles: LAYOUT_MASK_BALL });
    g.start();
    g.forceAdvance();
    assert.ok(g.gameViewFor(pid(1)).progress, '普通狼应看到狼队行动进度');
    assert.equal(g.gameViewFor(pid(5)).progress, undefined, '平民不应看到狼队进度');
    for (const seat of [1, 2, 3]) g.submitNightAction(pid(seat), { kind: 'wolf', target: null });
    assert.equal(g.phase, 'NIGHT_WITCH');
    assert.equal(g.gameViewFor(pid(1)).progress, undefined, '房主是狼人也不能看到女巫是否行动');
    assert.ok(g.gameViewFor(pid(10)).progress, '女巫只能看到自己的回合进度');

    g.forceAdvance(true);
    assert.ok(g.gameViewFor(pid(5)).log.some((line) => line.includes('房主跳过了')), '房主跳过应写入公开日志');
  });
});

// ────────────────────────────── 语音台词 ──────────────────────────────

describe('语音播报台词（当法官用）', () => {
  it('女巫阶段只说「女巫请睁眼」，绝不念出刀口', () => {
    const g = newGame();
    g.start();
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    assert.equal(g.phase, 'NIGHT_WITCH');

    const line = g.gameViewFor(pid(WITCH_SEAT)).voiceLine;
    assert.match(line, /女巫请睁眼/);
    assert.ok(!line.includes('5'), `台词里不能出现刀口座位号：${line}`);
  });

  it('天亮时朗读死亡名单（这是公开信息）', () => {
    const g = newGame();
    g.start();
    playNight(g, 5);
    const line = g.gameViewFor(pid(1)).voiceLine;
    assert.match(line, /天亮了/);
    assert.match(line, /5 号/);
  });

  it('同一阶段所有人的台词完全相同（台词里不能掺个人信息）', () => {
    // 这条是硬约束：台词一旦因人而异，就说明掺进了隐藏信息，
    // 开了语音播报的人等于用喇叭把秘密广播出去。
    const g = newGame();
    g.start();
    let steps = 0;
    while (g.phase !== 'GAME_OVER' && steps++ < 500) {
      const lines = new Set(g.aliveSeatsSnapshot().map((s) => g.gameViewFor(pid(s)).voiceLine));
      assert.equal(
        lines.size,
        1,
        `第 ${g.day} 天 ${g.phase} 的台词因人而异：${[...lines].join(' || ')}`,
      );
      g.forceAdvance();
    }
    assert.equal(g.phase, 'GAME_OVER');
  });

  it('整局台词里不出现死因、药水等隐藏信息', () => {
    const g = newGame();
    g.start();
    let steps = 0;
    while (g.phase !== 'GAME_OVER' && steps++ < 500) {
      const line = g.gameViewFor(pid(1)).voiceLine;
      assert.ok(
        !/被狼人杀害|被女巫毒杀|解药|毒药|守护/.test(line),
        `第 ${g.day} 天 ${g.phase} 的台词泄露了隐藏信息：${line}`,
      );
      g.forceAdvance();
    }
  });
});
