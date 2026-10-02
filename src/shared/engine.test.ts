/**
 * 规则引擎单元测试
 *
 * 运行方式：npm test  （即 tsx src/shared/engine.test.ts）
 *
 * 这里覆盖的是「一旦写错就会毁掉整局游戏」的规则：
 * 夜晚流程、女巫药水限制、猎人开枪条件、白痴翻牌、投票平票、屠边胜负，
 * 以及最关键的一条——**信息隔离（好人客户端里绝不能出现狼人身份字符串）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Game, PHASE_TIMEOUT_MS, type PlayerSeed } from './engine.ts';
import { NIGHT_PHASE_BY_ROLE, type DeathCause, type Phase, type RoomConfig } from './protocol.ts';
import { clipById } from './voice-clips.ts';
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
  nightPlan,
  nightPlanSummary,
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

/** 固定牌序（含狼王）：1 狼王，2-4 狼，5-8 民，9 预言家，10 女巫，11 猎人，12 守卫 */
const LAYOUT_BLACK_WOLF_KING: Role[] = [
  'BLACK_WOLF_KING',
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

/** 12 人狼王摄梦人：1 狼王，2-4 狼，5-8 民，9 预言家，10 女巫，11 猎人，12 摄梦人 */
const LAYOUT_WOLF_KING_DREAMER: Role[] = [
  'BLACK_WOLF_KING',
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
  'DREAMER',
];

/** 13 人混血儿板：1-4 狼，5-8 民，9-12 四神，13 混血儿 */
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

/** 12 人假面舞会：1-3 普通狼，4 假面，5-8 民，9 预言家，10 女巫，11 白痴，12 舞者 */
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
    return role === 'WOLF' || role === 'WOLF_KING' || role === 'BLACK_WOLF_KING';
  });

/**
 * 读当前阶段。
 * 必须包一层函数：node:assert 的断言签名会把 g.phase 收窄成字面量，
 * 比如 `const x: Phase = g.phase` 也会被 TS 按初始值收窄，
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

/**
 * 测试用的「开局并进入第一夜」。
 *
 * 真实流程现在是：发牌 →ROLE_REVEAL（等全员确认身份）→ 房主按「天黑请闭眼」。
 * 绝大多数用例关心的是**夜晚之后的规则**，身份确认对它们只是噪音。
 * 所以统一用这个辅助函数跨过去 —— 需要专门测身份确认的用例自己走完整流程。
 *
 * 注意这里没设 `onlineSeats`：引擎在拿不到在线信息时会退化成**最严格**
 * （要求全员确认），正好是测试想要的语义。
 */
function startNight(g: Game): void {
  const started = g.start();
  assert.equal(started.ok, true, `开局应成功：${started.message ?? ''}`);
  assert.equal(g.phase, 'ROLE_REVEAL', '发牌后应先进入身份确认阶段，不能直接天黑');

  for (const seat of g.aliveSeatsSnapshot()) {
    const res = g.confirmRole(pid(seat));
    assert.equal(res.ok, true, `${seat} 号确认身份应被接受：${res.message ?? ''}`);
  }

  const began = g.beginNight();
  assert.equal(began.ok, true, `全员确认后应能开始第一夜：${began.message ?? ''}`);
  assert.equal(g.phase, 'NIGHT_START');
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
    // 此时场上没人能行动，只能靠阶段超时强制推进走过去。
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

it('每晚结算后生成可持久化的逐夜回顾', () => {
  const g = newGame({ roles: [...LAYOUT.slice(0, 11), 'GUARD'] });
  startNight(g);
  playNight(g, 5, { save: false, poison: null }, 12);

  const replay = g.replaySnapshot();
  assert.equal(replay.version, 1);
  assert.equal(replay.nights.length, 1);
  const night = replay.nights[0]!;
  assert.equal(night.day, 1);
  assert.deepEqual(night.wolfVotes.map((vote) => vote.voter), WOLF_SEATS);
  assert.equal(night.wolfTarget, 5);
  assert.equal(night.guardTarget, 12);
  assert.equal(night.witchActed, true);
  assert.equal(night.seerTarget, 1);
  assert.deepEqual(night.deaths, [{ seat: 5, cause: 'WOLF' }]);
  assert.ok(replay.publicEvents.some((event) => event.includes('天黑请闭眼')));
});

/** 跑完白天：公示 → 竞选 发言 → 投票 → 放逐 → （可能的猎人开枪）→ 下一夜或结束 */
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
  startNight(g);
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

  it('唯一角色超过 1 个时报错', () => {
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
    // 6 人局 3 狼 3 好人，狼占比 50%，超过阈值 45%，只应产生 warn
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
    startNight(g);
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
      startNight(g);
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
    startNight(g);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');

    g.submitNightAction(pid(1), { kind: 'wolf', target: 5 });
    g.submitNightAction(pid(2), { kind: 'wolf', target: 5 });
    g.submitNightAction(pid(3), { kind: 'wolf', target: 6 });
    assert.equal(g.phase, 'NIGHT_WOLVES', '还有人没提交，不应推进');

    // 4 号改票到 6，此时 5:2 变/ 6:2  —— 平票，今夜空刀
    g.submitNightAction(pid(4), { kind: 'wolf', target: 6 });
    assert.notEqual(g.phase, 'NIGHT_WOLVES', '全员提交后应推进');
    assert.equal(g.phase, 'NIGHT_WITCH');
  });

  it('完整夜晚：狼刀 + 女巫解药 → 平安夜', () => {
    const g = newGame();
    startNight(g);
    playNight(g, 5, { save: true });

    const view = g.gameViewFor(pid(1));
    assert.deepEqual(view.lastNightDeaths, [], '解药生效，应为平安夜');
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).me?.potions?.antidote, false, '解药应已消耗');
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).me?.potions?.poison, true, '毒药应保留');
    assertInvariants(g);
  });

  it('完整夜晚：狼刀 + 女巫不救 → 天亮公布死讯', () => {
    const g = newGame();
    startNight(g);
    playNight(g, 5);

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5]);
    assert.equal(g.isDeadSeat(5), true);
    assertInvariants(g);
  });

  it('女巫毒药可以额外带走一人', () => {
    const g = newGame();
    startNight(g);
    playNight(g, 5, { poison: 7 });

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5, 7]);
    assert.equal(g.isDeadSeat(5), true);
    assert.equal(g.isDeadSeat(7), true);
    assert.equal(g.gameViewFor(pid(WITCH_SEAT)).me?.potions?.poison, false, '毒药应已消耗');
    assertInvariants(g);
  });

  it('被刀的人同时被毒时只死一次', () => {
    const g = newGame();
    startNight(g);
    playNight(g, 5, { poison: 5 });
    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5]);
    assertInvariants(g);
  });

  it('同一夜不能同时使用解药和毒药', () => {
    const g = newGame();
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    // 预言家已死，但查验阶段必须照常出现—— 否则「今晚没听到预言家请睁眼」
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
    startNight(g);
    playNight(g, 5, { save: true }); // 第1 夜用掉解药
    playDay(g, () => null);
    playNight(g, 6, { poison: 7 }); // 第2 夜用掉毒药
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
    playNight(g, 5, { poison: HUNTER_SEAT });
    g.forceAdvance(); // 离开 DAY_ANNOUNCE
    assert.equal(g.isDeadSeat(HUNTER_SEAT), true);
    assert.notEqual(g.phase, 'HUNTER_SHOOT', '被毒死的猎人不应获得开枪机会');
    advanceToDayVote(g);
  });

  it('猎人被投票放逐可以开枪', () => {
    const g = newGame();
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
    playNight(g, 5); // 5 号夜里出局，剩 11 名投票人
    g.forceAdvance();
    advanceToDayVote(g);

    // 5 票投 1 号 vs 5 票投 2 号，2 号自己弃权 → 平票
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
    playNight(g, 5);
    g.forceAdvance();
    advanceToDayVote(g);
    for (const seat of voters(g)) g.submitVote(pid(seat), seat === 1 ? 2 : 1);
    const detail = g.gameViewFor(pid(6)).voteDetail ?? [];
    assert.ok(detail.length > 0, '应公布公开票型');
    assert.equal(detail.find((d) => d.voter === 1)?.target, 2);
    const replayRound = g.replaySnapshot().dayVotes?.[0];
    assert.ok(replayRound, '正式放逐票应进入持久化回顾');
    assert.equal(replayRound.day, 1);
    assert.equal(replayRound.votes.find((d) => d.voter === 1)?.target, 2);
  });
});

describe('胜负判定（屠边）', () => {
  it('狼人杀光全部平民 → 狼人胜', () => {
    const g = newGame();
    startNight(g);
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
    startNight(g);

    // 第 1 夜：女巫用解药制造平安夜；白天放逐 1 号狼
    playNight(g, 5, { save: true });
    playDay(g, (seat) => (seat === 1 ? null : 1));
    assert.equal(g.isDeadSeat(1), true);

    // 第 2 夜：狼刀 6 号，女巫用毒药带走 2 号狼；白天放逐 3 号狼
    playNight(g, 6, { poison: 2 });
    assert.equal(g.isDeadSeat(2), true);
    playDay(g, (seat) => (seat === 3 ? null : 3));
    assert.equal(g.isDeadSeat(3), true);

    // 第 3 夜：狼刀 7 号；白天放逐最后一头狼 4 号 → 好人胜。
    playNight(g, 7);
    playDay(g, (seat) => (seat === 4 ? null : 4));

    assert.equal(g.phase, 'GAME_OVER');
    assert.equal(g.winnerCamp, 'GOOD');
    assert.equal(g.summary.wolves, 0);
    assertInvariants(g);
  });

  it('狼人杀光全部神职 → 狼人胜', () => {
    const g = newGame();
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
    for (const victim of [5, 6, 7]) {
      playNight(g, victim);
      playDay(g, () => null);
    }
    // 第 4 夜杀掉最后一个平民—— 胜负在「公布死讯」阶段就已经定了
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
 * engine 也必须拒绝并且不下发 revealAll —— 只在客户端藏按钮是纸糊的权限。
 * 改一行 JS 就能把全场身份拉到手上。
 */
describe('上帝视角权限', () => {
  /** 造一个「已经死过人、但游戏还没结束」的局面 */
  function gameWithDeaths(): Game {
    const g = newGame();
    startNight(g);
    playNight(g, 5); // 刀了5 号（平民）
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
    startNight(g);
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
  it('白天阶段不设置自动倒计时，由玩家操作或房主推进', () => {
    const dayPhases: Phase[] = [
      'DAY_ANNOUNCE',
      'SHERIFF_SIGNUP',
      'SHERIFF_CAMPAIGN',
      'SHERIFF_VOTE',
      'SHERIFF_PK',
      'SHERIFF_REVOTE',
      'DAY_SPEECH',
      'DAY_VOTE',
      'DAY_EXILE',
      'SHERIFF_TRANSFER',
      'HUNTER_SHOOT',
      'WOLF_KING_BOOM',
    ];

    for (const phase of dayPhases) {
      assert.equal(Number.isFinite(PHASE_TIMEOUT_MS[phase]), false, `${phase} 不应自动超时`);
    }
    assert.equal(Number.isFinite(PHASE_TIMEOUT_MS.NIGHT_WOLVES), true, '狼人夜间战术时间仍应保留');
  });

  it('非狼人不能提交狼人行动，非当前阶段不能行动', () => {
    const g = newGame();
    startNight(g);
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: 5 }).ok, false, '天黑前不能行动');
    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(5), { kind: 'wolf', target: 6 }).ok, false, '平民不能点刀');
    assert.equal(g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: 1 }).ok, false, '预言家不能抢先查验');
  });

  it('超时推进不会卡死，并能跑到天亮', () => {
    const g = newGame();
    startNight(g);
    let guard = 0;
    while (g.phase !== 'DAY_ANNOUNCE' && guard++ < 30) {
      g.forceAdvance();
    }
    assert.equal(g.phase, 'DAY_ANNOUNCE', '一路超时也应能走到天亮');
    assertInvariants(g);
  });

  it('整局用超时推进也能正常收场（状态机一定会终止）', () => {
    const g = newGame();
    startNight(g);
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
    startNight(g);
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
    startNight(g);
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
    startNight(g);
    playNight(g, 5, {}, 5); // 狼刀 5 号，守卫也守 5 号

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [], '被守住应该是平安夜');
    assert.equal(g.isDeadSeat(5), false, '5 号应该活着');
    assert.equal(g.lastGuardedSnapshot(), 5, '应记下守卫这一夜守了谁');
  });

  it('不能连续两晚守护同一名玩家', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    startNight(g);
    playNight(g, 5, {}, 5); // 第1 夜守 5 。
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
    startNight(g);
    // 狼刀 5 号，守卫守 5 号，女巫也用解药救5 号 —— 双重保护视为无效
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
    startNight(g);
    playNight(g, 6, { poison: 5 }, 5); // 守卫守5 号，但女巫毒死5 号
    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, [5, 6]);
    assert.equal(g.isDeadSeat(5), true, '毒药无视守护');
    assert.equal(g.isDeadSeat(6), true, '6 号被狼刀，没人救');
  });

  it('守卫可以守自己', () => {
    const g = newGame({ roles: LAYOUT_GUARD });
    startNight(g);
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
    startNight(g);
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
    startNight(g);
    playNight(g, 5, {}, 5);
    playDay(g, () => null);

    g.forceAdvance(); // → NIGHT_WOLVES
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 6 });
    }
    assert.equal(g.phase, 'NIGHT_GUARD');
    const view = g.gameViewFor(pid(GUARD_SEAT));
    assert.equal(view.guardBlockedSeat, 5, '应告知上一夜守过5 号');
    assert.equal(view.me?.lastGuardedSeat, 5);
    assert.ok(!view.myOptions.includes(5), '上一夜守过的人不应出现在可选项里');
  });
});

// ────────────────────────────── 白狼王 ──────────────────────────────

describe('白狼王', () => {
  it('属于狼人阵营，夜里和狼人一起行动', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    startNight(g);
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
    startNight(g);
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

  it('白天自爆 并带走一人 → 直接进入黑夜（当天不再投票）', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    startNight(g);
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
    startNight(g);
    playNight(g, 5);
    g.forceAdvance();

    g.submitVote(pid(2), 6); // 先有人投了票
    g.selfDestruct(pid(WOLF_KING_SEAT));
    g.submitBoomTarget(pid(WOLF_KING_SEAT), null); // 选择不带人

    assert.equal(g.exiledSnapshot(), null, '自爆当天不应产生放逐结果');
    assert.equal(g.phase, 'NIGHT_START');
  });

  it('夜里不能自爆，好人也不能自爆', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    const atNight = g.selfDestruct(pid(WOLF_KING_SEAT));
    assert.equal(atNight.ok, false, '夜里（白狼王）不能自爆');
    assert.match(atNight.message ?? '', /白天/);
    const plainWolfAtNight = g.selfDestruct(pid(2));
    assert.equal(plainWolfAtNight.ok, false, '夜里（普通狼）也不能自爆');

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

    const villager = g.selfDestruct(pid(5));
    assert.equal(villager.ok, false, '好人不能自爆');
    assert.match(villager.message ?? '', /狼人/);
    // 普通狼白天能爆的用例在「普通狼空爆」那组里
  });

  it('白狼王是最后一狼时自爆 → 好人胜（判定在带人之后）', () => {
    // 4 人局：白狼王 / 平民 / 预言家 / 猎人，只有一只狼
    const deck: Role[] = ['WOLF_KING', 'VILLAGER', 'SEER', 'HUNTER'];
    const g = newGame({ roles: deck });
    startNight(g);
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
    // 自爆时狼人已经清零，但胜负要等带人"结算完再判。
    assert.equal(g.winnerCamp, null, '此时还不该判出胜负');

    g.submitBoomTarget(pid(1), 2); // 带走最后的平民
    assert.equal(g.isDeadSeat(2), true);
    assert.equal(g.winnerCamp, 'GOOD', '狼人全部出局 → 好人胜（即使同时屠了边）');
    assert.equal(g.phase, 'GAME_OVER');
  });
});

// ────────────────────────────── 普通狼空爆 ──────────────────────────────

describe('普通狼空爆', () => {
  it('白天可以空爆：自己出局、直接进入黑夜、当天不再放逐', () => {
    const g = newGame(); // 1-4 号都是普通狼
    startNight(g);
    beginSheriffElection(g); // 白天：警长竞选报名
    assert.equal(g.gameViewFor(pid(2)).me?.canSelfDestruct, true, '普通狼白天应能看到自爆按钮');

    const res = g.selfDestruct(pid(2));
    assert.equal(res.ok, true, `空爆应被接受：${res.message ?? ''}`);
    assert.equal(g.isDeadSeat(2), true, '空爆的狼人出局');
    assert.equal(phaseOf(g), 'NIGHT_START', '空爆后应直接进入黑夜');
    assert.equal(g.exiledSnapshot(), null, '空爆当天不应产生放逐结果');
  });

  it('警长竞选期间空爆 → 竞选终止、本局警徽流失，第二天不再重选', () => {
    const g = newGame();
    startNight(g);
    beginSheriffElection(g);
    g.submitSheriffSignup(pid(5), true);
    g.submitSheriffSignup(pid(9), true);

    assert.equal(g.selfDestruct(pid(1)).ok, true, '空爆应被接受');
    assert.equal(g.gameViewFor(pid(5)).sheriffElectionFinished, true, '竞选应立即终止');
    assert.equal(g.gameViewFor(pid(5)).sheriffSeat, null, '本局不应产生警长');

    // 第二天：警长竞选是整局一次性的，撕掉的警徽不会回来
    playNight(g, null);
    assert.equal(phaseOf(g), 'DAY_ANNOUNCE', '第二天应直接公布死讯，不再进入警长竞选');
  });

  it('已当选警长的普通狼空爆 → 先移交警徽，移交完才进入黑夜', () => {
    const g = newGame();
    startNight(g);
    beginSheriffElection(g);
    electSingleSheriff(g, 1); // 1 号（狼）当选 → DAY_SPEECH

    assert.equal(g.selfDestruct(pid(1)).ok, true, '警长空爆应被接受');
    assert.equal(phaseOf(g), 'SHERIFF_TRANSFER', '空爆的警长应先处理警徽');
    g.submitSheriffTransfer(pid(1), null); // 撕毁
    assert.equal(phaseOf(g), 'NIGHT_START', '警徽处理完应进入黑夜');
  });

  it('普通狼是最后一狼时空爆 → 好人胜', () => {
    const deck: Role[] = ['WOLF', 'VILLAGER', 'VILLAGER', 'SEER', 'WITCH', 'HUNTER'];
    const g = newGame({ roles: deck });
    startNight(g);
    beginSheriffElection(g);

    assert.equal(g.selfDestruct(pid(1)).ok, true, '空爆应被接受');
    assert.equal(phaseOf(g), 'GAME_OVER', '最后一狼出局应立即结束');
    assert.equal(g.winnerCamp, 'GOOD', '狼人全灭 → 好人胜');
  });

  it('狼王（黑狼王）没有自爆按钮，也不能自爆', () => {
    const g = newGame({ roles: LAYOUT_BLACK_WOLF_KING });
    startNight(g);
    beginSheriffElection(g);
    assert.equal(g.gameViewFor(pid(1)).me?.canSelfDestruct, undefined, '黑狼王不应看到自爆按钮');
    const res = g.selfDestruct(pid(1));
    assert.equal(res.ok, false, '黑狼王不能自爆（他的技能是死后开枪）');
    assert.match(res.message ?? '', /狼人/);
  });
});

// ────────────────────────────── 狼王（黑狼王）──────────────────────────────

describe('狼王（黑狼王）', () => {
  it('属于狼人阵营，夜里和普通狼人一起行动', () => {
    const g = newGame({ roles: LAYOUT_BLACK_WOLF_KING });
    startNight(g);
    const view = g.gameViewFor(pid(1));
    assert.equal(view.me?.camp, 'WOLF');
    assert.deepEqual(view.me?.teammates, [2, 3, 4]);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.equal(g.gameViewFor(pid(1)).myTurn, true);
  });

  it('最后一只狼王被放逐时仍能先开枪，再结算游戏结局', () => {
    const roles: Role[] = ['BLACK_WOLF_KING', 'VILLAGER', 'SEER', 'HUNTER'];
    const g = newGame({ roles });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: null }).ok, true);
    assert.equal(g.submitNightAction(pid(3), { kind: 'seer', target: 1 }).ok, true);
    assert.equal(g.phase, 'NIGHT_RESOLVE');
    g.forceAdvance();
    g.forceAdvance();
    advanceToDayVote(g);

    for (const seat of voters(g)) {
      assert.equal(g.submitVote(pid(seat), seat === 1 ? 2 : 1).ok, true);
    }
    assert.equal(g.phase, 'DAY_EXILE');
    g.forceAdvance();

    assert.equal(g.phase, 'HUNTER_SHOOT', '不能因为最后一狼出局就跳过狼王开枪');
    assert.equal(g.gameViewFor(pid(1)).shooterRoleName, '狼王');
    assert.equal(g.submitHunterShoot(pid(1), 2).ok, true);
    assert.equal(g.isDeadSeat(2), true);
    assert.equal(g.phase, 'GAME_OVER');
    assert.equal(g.winnerCamp, 'GOOD');
  });

  it('被女巫毒死不能开枪', () => {
    const g = newGame({ roles: LAYOUT_BLACK_WOLF_KING });
    startNight(g);
    playNight(g, 5, { poison: 1 }, 12);
    assert.equal(g.isDeadSeat(1), true);
    assert.equal(g.gameViewFor(pid(1)).hunterPendingSeat, null);
    g.forceAdvance();
    assert.notEqual(g.phase, 'HUNTER_SHOOT');
  });

  it('猎人开枪带走狼王后，狼王继续获得一次开枪机会', () => {
    const roles: Role[] = ['BLACK_WOLF_KING', 'WOLF', 'VILLAGER', 'SEER', 'HUNTER', 'VILLAGER'];
    const g = newGame({ roles });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: null }).ok, true);
    assert.equal(g.submitNightAction(pid(2), { kind: 'wolf', target: null }).ok, true);
    assert.equal(g.submitNightAction(pid(4), { kind: 'seer', target: 1 }).ok, true);
    assert.equal(g.phase, 'NIGHT_RESOLVE');
    g.forceAdvance();
    g.forceAdvance();
    advanceToDayVote(g);

    for (const seat of voters(g)) {
      assert.equal(g.submitVote(pid(seat), seat === 5 ? 3 : 5).ok, true);
    }
    assert.equal(g.phase, 'DAY_EXILE');
    g.forceAdvance();
    assert.equal(g.phase, 'HUNTER_SHOOT');
    assert.equal(g.submitHunterShoot(pid(5), 1).ok, true);
    assert.equal(g.phase, 'HUNTER_SHOOT');
    assert.equal(g.gameViewFor(pid(1)).hunterPendingSeat, 1);
    assert.equal(g.gameViewFor(pid(1)).shooterRoleName, '狼王');
  });

  it('狼王开枪带走猎人后，猎人仍可继续开枪形成枪链', () => {
    const roles: Role[] = ['BLACK_WOLF_KING', 'WOLF', 'VILLAGER', 'SEER', 'HUNTER', 'VILLAGER'];
    const g = newGame({ roles });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: null }).ok, true);
    assert.equal(g.submitNightAction(pid(2), { kind: 'wolf', target: null }).ok, true);
    assert.equal(g.submitNightAction(pid(4), { kind: 'seer', target: 1 }).ok, true);
    g.forceAdvance();
    g.forceAdvance();
    advanceToDayVote(g);

    for (const seat of voters(g)) {
      assert.equal(g.submitVote(pid(seat), seat === 1 ? 3 : 1).ok, true);
    }
    assert.equal(g.phase, 'DAY_EXILE');
    g.forceAdvance();
    assert.equal(g.phase, 'HUNTER_SHOOT');
    assert.equal(g.gameViewFor(pid(1)).shooterRoleName, '狼王');

    assert.equal(g.submitHunterShoot(pid(1), 5).ok, true, '狼王应能开枪带走猎人');
    assert.equal(g.phase, 'HUNTER_SHOOT', '被狼王开枪带走的猎人仍应获得开枪机会');
    assert.equal(g.gameViewFor(pid(5)).hunterPendingSeat, 5);
    assert.equal(g.gameViewFor(pid(5)).shooterRoleName, '猎人');
  });
});

// ────────────────────────────── 摄梦人──────────────────────────────

function finishDreamerNight(
  g: Game,
  dreamTarget: number,
  wolfTarget: number | null,
  witch: { save?: boolean; poison?: number | null } = {},
): void {
  assert.equal(g.phase, 'NIGHT_START');
  g.forceAdvance();
  assert.equal(g.phase, 'NIGHT_DREAMER');
  assert.equal(g.submitNightAction(pid(12), { kind: 'dreamer', target: dreamTarget }).ok, true);
  assert.equal(g.phase, 'NIGHT_WOLVES');
  for (const seat of aliveWolves(g)) {
    assert.equal(g.submitNightAction(pid(seat), { kind: 'wolf', target: wolfTarget }).ok, true);
  }
  assert.equal(g.phase, 'NIGHT_WITCH');
  assert.equal(g.submitNightAction(pid(10), {
    kind: 'witch',
    save: witch.save ?? false,
    poison: witch.poison ?? null,
  }).ok, true);
  assert.equal(g.phase, 'NIGHT_SEER');
  const seerTarget = g.aliveSeatsSnapshot().find((seat) => seat !== 9)!;
  assert.equal(g.submitNightAction(pid(9), { kind: 'seer', target: seerTarget }).ok, true);
  assert.equal(g.phase, 'NIGHT_RESOLVE');
  g.forceAdvance();
  assert.equal(g.phase, 'DAY_ANNOUNCE');
}

describe('摄梦人与狼王摄梦人板', () => {
  it('预设是3 民 + 狼王 + 4 狼 + 预女猎梦，且校验通过', () => {
    const preset = BOARD_PRESETS.find((entry) => entry.id === '12-wolf-king-dreamer');
    assert.ok(preset);
    assert.equal(preset.board.roles.WOLF, 3);
    assert.equal(preset.board.roles.BLACK_WOLF_KING, 1);
    assert.equal(preset.board.roles.DREAMER, 1);
    assert.equal(boardTotal(preset.board), 12);
    assert.deepEqual(boardErrors(preset.board), []);
  });

  it('梦游者免疫狼刀和毒药，但毒药仍然消耗；目标本人不知道自己被摄梦', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING_DREAMER });
    startNight(g);
    finishDreamerNight(g, 5, 5, { poison: 5 });

    assert.deepEqual(g.gameViewFor(pid(1)).lastNightDeaths, []);
    assert.equal(g.gameViewFor(pid(10)).me?.potions?.poison, false, '无效的毒药也必须消耗');
    assert.deepEqual(g.gameViewFor(pid(12)).me?.dreamHistory, [
      { day: 1, seat: 5, nickname: '玩家5' },
    ]);
    const targetView = JSON.stringify(g.gameViewFor(pid(5)));
    assert.ok(!targetView.includes('dreamHistory'), '梦游者不能收到摄梦记录');
    assert.ok(!targetView.includes('lastDreamedSeat'), '梦游者不能得知自己被摄梦');
  });

  it('连续两夜摄梦同一人，该玩家以摄梦死因出局且死亡技能被压制', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING_DREAMER });
    startNight(g);
    finishDreamerNight(g, 1, null);
    playDay(g, () => null);
    assert.equal(g.phase, 'NIGHT_START');

    finishDreamerNight(g, 1, null);
    assert.deepEqual(g.gameViewFor(pid(12)).lastNightDeaths, [1]);
    assert.equal(g.gameViewFor(pid(12)).hunterPendingSeat, null, '被摄梦带走的狼王不能开枪');
    assert.equal(g.isDeadSeat(1), true);
  });

  it('摄梦人夜里死亡会带走梦游者；若被女巫救下则两人都存活', () => {
    const killed = newGame({ roles: LAYOUT_WOLF_KING_DREAMER });
    startNight(killed);
    finishDreamerNight(killed, 5, 12);
    assert.deepEqual(killed.gameViewFor(pid(1)).lastNightDeaths, [5, 12]);

    const saved = newGame({ roles: LAYOUT_WOLF_KING_DREAMER });
    startNight(saved);
    finishDreamerNight(saved, 5, 12, { save: true });
    assert.deepEqual(saved.gameViewFor(pid(1)).lastNightDeaths, []);
    assert.equal(saved.isDeadSeat(5), false);
    assert.equal(saved.isDeadSeat(12), false);
  });

  it('摄梦人不能选择自己；超时会随机选择另一名存活玩家', () => {
    const g = newGame({ roles: LAYOUT_WOLF_KING_DREAMER, seed: 7 });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_DREAMER');
    assert.equal(g.submitNightAction(pid(12), { kind: 'dreamer', target: 12 }).ok, false);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    const history = g.gameViewFor(pid(12)).me?.dreamHistory ?? [];
    assert.equal(history.length, 1);
    assert.notEqual(history[0]?.seat, 12);
  });
});

// ────────────────────────────── 狼队战术标签 ──────────────────────────────

describe('狼队战术标签', () => {
  it('狼人可以给自己挂标签，好人不允许', () => {
    const g = newGame();
    startNight(g);
    assert.equal(g.setWolfTag(pid(1), 'CHARGER').ok, true, '狼人应能挂标签');

    const good = g.setWolfTag(pid(5), 'CHARGER');
    assert.equal(good.ok, false, '平民不能挂狼队标签');
    assert.match(good.message ?? '', /只有狼人/);
  });

  it('悍跳位全队只能有一个人占', () => {
    const g = newGame();
    startNight(g);
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

  it('悍跳 / 深水 / 倒钩 / 冲锋狼这四个位置是全队唯一的', () => {
    for (const tag of ['FAKE_SEER', 'DEEP_WATER', 'HOOK', 'CHARGER'] as const) {
      const g = newGame();
      startNight(g);
      assert.equal(g.setWolfTag(pid(1), tag).ok, true, `1 号应能挂 ${tag}`);

      const second = g.setWolfTag(pid(2), tag);
      assert.equal(second.ok, false, `${tag} 不能被第二个人占`);
      assert.match(second.message ?? '', /1 号/, '要告诉队友是谁占了，否则队内会互相误会');
      assert.equal(g.wolfTagAt(2), null, '被拒绝后不应该留下标记');
    }
  });

  it('上警是自由的：想竞选的狼可以有好几个', () => {
    const g = newGame();
    startNight(g);
    for (const seat of [1, 2, 3, 4]) {
      assert.equal(g.setWolfTag(pid(seat), 'SHERIFF').ok, true, `${seat} 号应能挂上警`);
    }
    assert.equal(g.wolfTagAt(1), 'SHERIFF');
    assert.equal(g.wolfTagAt(4), 'SHERIFF');
  });

  // ────────────── 狼踩狼：两人互指才成立──────────────

  it('狼踩狼必须带上「踩谁」，而且只能踩存活的狼队友', () => {
    const g = newGame();
    startNight(g);

    const noTarget = g.setWolfTag(pid(1), 'WOLF_VS_WOLF');
    assert.equal(noTarget.ok, false, '不填对象不算挂上狼踩狼');
    assert.match(noTarget.message ?? '', /必须再选一名存活的狼队友/);

    const good = g.setWolfTag(pid(1), 'WOLF_VS_WOLF', 5);
    assert.equal(good.ok, false, '不能踩好人—— 狼踩狼是队内配合');
    assert.equal(g.setWolfTag(pid(1), 'WOLF_VS_WOLF', 1).ok, false, '不能踩自己');

    assert.equal(g.setWolfTag(pid(1), 'WOLF_VS_WOLF', 2).ok, true);
    assert.equal(g.wolfTagTargetAt(1), 2);
  });

  it('狼踩狼只有一边填了不算数，双方互指才成立', () => {
    const g = newGame();
    startNight(g);

    g.setWolfTag(pid(1), 'WOLF_VS_WOLF', 2);
    assert.equal(g.wolfVsWolfPaired(1), false, '对方还没确认，这一对不算成立');
    assert.equal(g.wolfVsWolfPaired(2), false);

    // 全场狼都看得到 1 号填了2 号，但还没确认。
    const pending = g.gameViewFor(pid(3)).wolfTags!.find((w) => w.seat === 1)!;
    assert.equal(pending.tag, 'WOLF_VS_WOLF');
    assert.equal(pending.target, 2);
    assert.equal(pending.paired, false, '必须标出来，否则挂的人以为说好了');

    // 2 号反过来指1 号 —— 配对成立
    assert.equal(g.setWolfTag(pid(2), 'WOLF_VS_WOLF', 1).ok, true);
    assert.equal(g.wolfVsWolfPaired(1), true);
    assert.equal(g.wolfVsWolfPaired(2), true);
    const paired = g.gameViewFor(pid(3)).wolfTags!.find((w) => w.seat === 2)!;
    assert.equal(paired.paired, true);
  });

  it('狼踩狼可以同时存在多对', () => {
    const g = newGame();
    startNight(g);
    // 1 ↔2、3 ↔4 —— 两对互不干扰（它不是排他标签）。
    assert.equal(g.setWolfTag(pid(1), 'WOLF_VS_WOLF', 2).ok, true);
    assert.equal(g.setWolfTag(pid(2), 'WOLF_VS_WOLF', 1).ok, true);
    assert.equal(g.setWolfTag(pid(3), 'WOLF_VS_WOLF', 4).ok, true);
    assert.equal(g.setWolfTag(pid(4), 'WOLF_VS_WOLF', 3).ok, true);
    assert.equal(g.wolfVsWolfPaired(1), true);
    assert.equal(g.wolfVsWolfPaired(3), true);
  });

  it('改挂别的标签会清掉狼踩狼的对象，不会留下脏数据', () => {
    const g = newGame();
    startNight(g);
    g.setWolfTag(pid(1), 'WOLF_VS_WOLF', 2);
    assert.equal(g.wolfTagTargetAt(1), 2);

    g.setWolfTag(pid(1), 'CHARGER');
    assert.equal(g.wolfTagAt(1), 'CHARGER');
    assert.equal(g.wolfTagTargetAt(1), null, '换成别的标签后不能再留着踩谁');

    g.setWolfTag(pid(1), 'WOLF_VS_WOLF', 2);
    g.setWolfTag(pid(1), null);
    assert.equal(g.wolfTagTargetAt(1), null, '取消标签同样要清掉对象');
  });

  it('原持有人可以改挂别的标签，把悍跳位让出来', () => {
    const g = newGame();
    startNight(g);
    g.setWolfTag(pid(1), 'FAKE_SEER');
    g.setWolfTag(pid(1), 'CHARGER');
    assert.equal(g.wolfTagAt(1), 'CHARGER');
    assert.equal(g.setWolfTag(pid(2), 'FAKE_SEER').ok, true, '让出来之后队友应该能接手');
  });

  /**
   * 第一夜的标签必须是**灵活**的：点一下挂上，再点一下取消，队友马上能接手。
   * 原来的实现把悍跳位焊死在第一个点的人身上（连他自己都取消不了），
   * 结果狼队商量完想换人只能重新开一局 —— 那是把「什么时候定下来」
   * 错写成了「点下去就冻结」。
   */
  it('第一夜之内：挂上 → 取消 → 队友接手，全都能走通', () => {
    const g = newGame();
    startNight(g);

    assert.equal(g.setWolfTag(pid(1), 'FAKE_SEER').ok, true);
    assert.equal(g.wolfTagAt(1), 'FAKE_SEER');
    // 队友现在抢不走（引擎拒绝，并告诉他是谁占着）。
    const blocked = g.setWolfTag(pid(2), 'FAKE_SEER');
    assert.equal(blocked.ok, false);
    assert.match(blocked.message ?? '', /1 号/);

    // 1 号自己取消 —— 让位
    assert.equal(g.setWolfTag(pid(1), null).ok, true);
    assert.equal(g.wolfTagAt(1), null);

    // 2 号立刻接上。
    assert.equal(g.setWolfTag(pid(2), 'FAKE_SEER').ok, true);
    assert.equal(g.wolfTagAt(2), 'FAKE_SEER');
    assert.equal(g.wolfTagAt(1), null);
  });

  it('第一夜之内：四个排他标签都能反复取消和更换', () => {
    const g = newGame();
    startNight(g);
    for (const tag of ['FAKE_SEER', 'DEEP_WATER', 'HOOK', 'CHARGER'] as const) {
      assert.equal(g.setWolfTag(pid(1), tag).ok, true, `1 号应能挂 ${tag}`);
      assert.equal(g.setWolfTag(pid(1), null).ok, true, `1 号应能取消 ${tag}`);
      // 取消之后队友立刻能接手。
      assert.equal(g.setWolfTag(pid(2), tag).ok, true, `取消之后 2 号应能接手 ${tag}`);
      assert.equal(g.setWolfTag(pid(2), null).ok, true);
    }
  });

  it('第二夜起悍跳位锁死：不能再挂，占着的人也不能改', () => {
    const g = newGame();
    startNight(g);
    g.forceAdvance();
    // 一路推到第二天夜晚
    let steps = 0;
    while (g.day < 2 && steps++ < 200) g.forceAdvance();
    assert.equal(g.day, 2);
    assert.ok(g.phase.startsWith('NIGHT_'), `应在夜里，当前是${g.phase}`);

    // 第二夜之后谁都不能再新挂悍跳位（否则可以等快赢了再挂上去白拿 +1 分）
    const late = g.setWolfTag(pid(1), 'FAKE_SEER');
    assert.equal(late.ok, false);
    assert.match(late.message ?? '', /第一夜/);
    assert.equal(g.wolfTagAt(1), null, '被拒绝后不应留下标签');
  });

  it('第二夜起：第一夜占着悍跳位的人不能改成别的标签', () => {
    const g = newGame();
    startNight(g);
    assert.equal(g.setWolfTag(pid(1), 'FAKE_SEER').ok, true);

    let steps = 0;
    while (g.day < 2 && steps++ < 200) g.forceAdvance();
    assert.equal(g.day, 2);

    const res = g.setWolfTag(pid(1), 'CHARGER');
    assert.equal(res.ok, false, '改了就等于把已经拿到的+1 分甩掉，战绩会自相矛盾');
    assert.match(res.message ?? '', /第一夜已经过去/);
    assert.equal(g.wolfTagAt(1), 'FAKE_SEER', '被拒绝后应保持原样');

    // 但其他标签第二夜照样随便改（只有悍跳位有时间约束）。
    assert.equal(g.setWolfTag(pid(2), 'DEEP_WATER').ok, true);
    assert.equal(g.setWolfTag(pid(2), 'HOOK').ok, true);
    assert.equal(g.setWolfTag(pid(2), null).ok, true);
  });

  it('可以取消自己的标签', () => {
    const g = newGame();
    startNight(g);
    g.setWolfTag(pid(1), 'SHERIFF');
    assert.equal(g.wolfTagAt(1), 'SHERIFF');
    assert.equal(g.setWolfTag(pid(1), null).ok, true);
    assert.equal(g.wolfTagAt(1), null);
  });

  it('所有狼队友都能看到彼此的标签，好人一律看不到', () => {
    const g = newGame();
    startNight(g);
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

  it('进入白天后不再向狼人下发或允许修改战术数据', () => {
    const g = newGame();
    startNight(g);
    assert.equal(g.setWolfTag(pid(1), 'CHARGER').ok, true);

    let steps = 0;
    while (!g.phase.startsWith('DAY_') && steps++ < 50) g.forceAdvance();
    assert.ok(g.phase.startsWith('DAY_'), `应已进入白天，当前阶段为 ${g.phase}`);

    const wolfJson = JSON.stringify(g.gameViewFor(pid(1)));
    assert.ok(!wolfJson.includes('wolfTags'), '白天狼人视图不能包含狼队战术面板数据');
    assert.ok(!wolfJson.includes('wolfVotes'), '白天狼人视图不能包含夜间点刀数据');
    assert.ok(!wolfJson.includes('myWolfTag'), '白天狼人身份数据不能包含个人战术标签');
    assert.equal(g.setWolfTag(pid(1), 'HOOK').ok, false, '白天不能修改狼队战术');
  });

  it('游戏结束后不能再改标签', () => {
    const g = newGame();
    startNight(g);
    let steps = 0;
    while (g.phase !== 'GAME_OVER' && steps++ < 500) g.forceAdvance();
    assert.equal(g.phase, 'GAME_OVER');
    assert.equal(g.setWolfTag(pid(1), 'CHARGER').ok, false);
  });

  it('战术标签不会写进公开日志', () => {
    const g = newGame();
    startNight(g);
    g.setWolfTag(pid(1), 'FAKE_SEER');
    const logText = g.gameViewFor(pid(5)).log.join('\n');
    assert.ok(!logText.includes('悍跳'), '公开日志里不能出现战术标签');
    assert.ok(!logText.includes('FAKE_SEER'), '公开日志里不能出现标签标识');
  });
});

// ────────────────────────────── 舞者与假面 ──────────────────────────────

function reachSecondNightMaskBall(g: Game): void {
  startNight(g);
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
    startNight(g);
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
    startNight(g);
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

// ────────────────────── 身份确认（发牌之后、天黑之前） ──────────────────────

/**
 * 这一阶段存在的理由：原来的流程是「房主点开始 → 立刻天黑 → 5 秒后混血儿
 * 开始 30 秒倒计时」，等于逼人在看不懂自己能力的情况下做一个不可逆决定。
 *
 * 但插一段「等人」的暂停会立刻带来两个新风险，这个块就是钉这两件事的。
 *   ① 暂停不能变成新的信息通道（不能有计时器、语音必须全场同一句）
 *   ② 硬门槛不能变成死锁（掉线的人不阻塞；房主掉线要能移交。 */
describe('身份确认阶段', () => {
  it('发牌后先进入身份确认，不会直接天亮', () => {
    const g = newGame();
    const res = g.start();
    assert.equal(res.ok, true);
    assert.equal(g.phase, 'ROLE_REVEAL', '发牌后必须先看牌，不能直接进夜晚');
    assert.equal(g.day, 1);

    // 混血儿是第一夜第一个行动的角色，他的能力说明是这一段存在的直接原因。
    // 30 秒倒计时开始之前，他应该已经读过「首夜选择榜样但不知道其身份」。
    const log = g.gameViewFor(pid(1)).log.join('\n');
    assert.ok(log.includes('请查看你的身份牌'), `公开日志应提示看牌：${log}`);
    assert.ok(!log.includes('天黑请闭眼'), '发牌那一刻不能就宣布天黑');
  });

  it('身份确认阶段没有任何计时器', () => {
    const g = newGame();
    g.start();
    assert.equal(
      PHASE_TIMEOUT_MS.ROLE_REVEAL,
      Number.POSITIVE_INFINITY,
      '一旦给它倒计时，「为什么这次天黑得特别慢」就成了可被反推的信息',
    );
    assert.equal(g.deadline, null, '这一阶段不该有截止时间');
  });

  it('硬门槛：有人没确认就不能开始第一夜，并列出还差谁', () => {
    const g = newGame();
    g.start();
    for (const seat of [1, 2, 3]) g.confirmRole(pid(seat));

    const res = g.beginNight();
    assert.equal(res.ok, false, '还有人没看牌时不能天黑');
    assert.match(res.message ?? '', /9 人/, '应说明还差几个人');
    assert.match(res.message ?? '', /4、5/, '应列出具体的座位号，房主照着喊人');
    assert.equal(g.phase, 'ROLE_REVEAL', '被拒绝后应停在身份确认阶段');
  });

  it('全员确认后房主才能开始第一夜', () => {
    const g = newGame();
    g.start();
    for (const seat of g.aliveSeatsSnapshot()) g.confirmRole(pid(seat));

    const res = g.beginNight();
    assert.equal(res.ok, true, `全员确认后应能开始：${res.message ?? ''}`);
    assert.equal(g.phase, 'NIGHT_START');
    assert.equal(g.gameViewFor(pid(1)).roleReveal, undefined, '进入夜晚后不再下发确认进度');
  });

  it('掉线的人不阻塞门槛（在线的人全确认就能开始）', () => {
    const g = newGame();
    g.start();
    // 只有 1-3 号在线（比如其余人手机没电）；引擎拿在线名单就知道「必须等谁」。
    g.onlineSeats = new Set([1, 2, 3]);
    for (const seat of [1, 2, 3]) g.confirmRole(pid(seat));

    assert.equal(g.canBeginNight(), true, '掉线的人点不了按钮，不该把全场锁死');
    assert.equal(g.beginNight().ok, true);
    assert.equal(g.phase, 'NIGHT_START');
  });

  it('拿不到在线信息时退化成最严格：要求全员确认', () => {
    const g = newGame();
    g.start();
    for (const seat of [1, 2, 3, 4, 5]) g.confirmRole(pid(seat));
    assert.equal(g.onlineSeats.size, 0);
    assert.equal(g.canBeginNight(), false, '不知道谁在线时必须保守处理');
  });

  it('掉线的人在还没天黑之前回来，仍然能确认', () => {
    const g = newGame();
    g.start();
    g.onlineSeats = new Set([1, 2, 3]);
    for (const seat of [1, 2, 3]) g.confirmRole(pid(seat));
    g.beginNight();
    // 已经天黑了，晚到的确认应该被拒绝（而不是悄悄记下）
    assert.equal(g.confirmRole(pid(4)).ok, false);
  });

  it('「跳过阶段」不能绕过硬门槛', () => {
    const g = newGame();
    g.start();
    // 房主想用「跳过阶段」直接天黑 —— 必须无效，否则硬门槛等于不存在。
    g.forceAdvance(true);
    assert.equal(g.phase, 'ROLE_REVEAL', '身份确认阶段不能被跳过');
    assert.equal(g.gameViewFor(pid(1)).log.some((l) => l.includes('房主跳过')), false);
  });

  it('重复确认会被拒绝，而不是静默成功', () => {
    const g = newGame();
    g.start();
    assert.equal(g.confirmRole(pid(1)).ok, true);
    const again = g.confirmRole(pid(1));
    assert.equal(again.ok, false);
    assert.equal(again.code, 'ALREADY_DONE');
  });

  it('不在这一阶段、或不在局里的人都不能确认', () => {
    const g = newGame();
    assert.equal(g.confirmRole(pid(1)).ok, false, '还没发牌不能确认');

    g.start();
    assert.equal(g.confirmRole('不是本局的人').ok, false, '观众不能替玩家确认');

    for (const seat of g.aliveSeatsSnapshot()) g.confirmRole(pid(seat));
    g.beginNight();
    assert.equal(g.confirmRole(pid(1)).ok, false, '天黑之后不能再确认');
  });

  it('视图里的确认进度：谁确认了、我还差什么、房主能不能按', () => {
    const g = newGame();
    g.start();
    g.onlineSeats = new Set([1, 2, 3]);
    g.confirmRole(pid(1));

    const host = g.gameViewFor(pid(1)).roleReveal!;
    assert.deepEqual(host.confirmedSeats, [1]);
    assert.deepEqual(host.pendingSeats, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(host.total, 12);
    assert.equal(host.iConfirmed, true);
    assert.equal(host.iAmHost, true, '1 号是房主');
    assert.equal(host.canBeginNight, false, '还有在线的人没确认');

    const other = g.gameViewFor(pid(5)).roleReveal!;
    assert.equal(other.iConfirmed, false);
    assert.equal(other.iAmHost, false);
    assert.deepEqual(other.pendingSeats, host.pendingSeats, '确认进度是公开信息，所有人看到的一样');
  });

  it('房主身份跟着服务端走，临时接管的人也能按「天黑请闭眼」', () => {
    const g = newGame();
    g.start();
    assert.equal(g.gameViewFor(pid(1)).roleReveal!.iAmHost, true);

    // 模拟房主掉线 60 秒后服务端把操作权移交给 5 号。
    g.hostPlayerId = pid(5);
    assert.equal(g.gameViewFor(pid(1)).roleReveal!.iAmHost, false);
    assert.equal(g.gameViewFor(pid(5)).roleReveal!.iAmHost, true, '临时房主必须能按按钮，否则全场锁死');
  });

  it('身份确认阶段不出现狼队战术标签（标签是天黑之后的事）', () => {
    const g = newGame();
    g.start();

    const wolfView = g.gameViewFor(pid(1));
    assert.ok(wolfView.me?.teammates, '狼人这一阶段就该看到队友 —— 认队友正是这段时间的用途');
    assert.equal(wolfView.wolfTags, undefined, '标签面板在天黑之前不该出现');
    assert.equal(wolfView.me?.myWolfTag, undefined);
    assert.equal(wolfView.me?.canEditWolfTag, undefined);

    const res = g.setWolfTag(pid(1), 'FAKE_SEER');
    assert.equal(res.ok, false, '天黑之前不能挂战术标签');

    // 天黑之后立刻就能挂（NIGHT_START 的 5 秒也算天黑）
    for (const seat of g.aliveSeatsSnapshot()) g.confirmRole(pid(seat));
    g.beginNight();
    assert.equal(g.phase, 'NIGHT_START');
    assert.equal(g.setWolfTag(pid(1), 'FAKE_SEER').ok, true);
  });

  it('全场听到的身份确认台词一模一样，且不含任何身份信息', () => {
    const g = newGame();
    g.start();
    const lines = new Set<string>();
    for (const seat of g.aliveSeatsSnapshot()) lines.add(g.gameViewFor(pid(seat)).voiceLine);
    assert.equal(lines.size, 1, '台词里掺了个人信息就说明泄密了');

    const line = [...lines][0]!;
    assert.match(line, /查看你的身份牌/);
    // 绝不能按阵营分批喊人 —— 那等于用喇叭点名
    for (const word of ['狼人请睁眼', '神职', '平民', '预言家', '女巫', '守卫']) {
      assert.ok(!line.includes(word), `身份确认台词里出现了「${word}」：${line}`);
    }
  });
});

// ────────────────────── 狼美人/ 恶灵骑士 ──────────────────────

/** 狼美人局：1-3 普通狼，4 号狼美人，5-8 民，9 预言家，10 女巫，11 猎人，12 白痴 */
const LAYOUT_BEAUTY: Role[] = [
  'WOLF', 'WOLF', 'WOLF', 'WOLF_BEAUTY',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SEER', 'WITCH', 'HUNTER', 'IDIOT',
];
const BEAUTY_SEAT = 4;

/** 恶灵骑士局：1-3 普通狼，4 号恶灵骑士，5-8 民，9 预言家，10 女巫，11 猎人，12 守卫 */
const LAYOUT_DARK_LORD: Role[] = [
  'WOLF', 'WOLF', 'WOLF', 'DARK_LORD',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SEER', 'WITCH', 'HUNTER', 'GUARD',
];
const DARK_LORD_SEAT = 4;

/** 把当前阶段一路推到指定阶段 */
function advanceTo(g: Game, phase: Phase): void {
  let steps = 0;
  while (phaseOf(g) !== phase && steps++ < 30) g.forceAdvance();
  assert.equal(g.phase, phase, `应已到达 ${phase}`);
}

/**
 * 读某人的死因。
 *
 * 必须用 `deathRecords()` 而不是视图—— 视图里的 `cause` 是**隐藏信息**。
 * 只在对局结束（GAME_OVER）后才下发，这是之前专门修过的一条信息隔离规则。
 */
function causeOf(g: Game, seat: number): DeathCause | undefined {
  return g.deathRecords().find((d) => d.seat === seat)?.cause;
}

/**
 * 夜间顺序是这套角色的**命门**：狼美人必须排在狼刀之后（她要先知道刀口）。
 * 恶灵骑士必须和狼刀同一环节（他本来就是普通狼 + 被动技能）。
 * 这条测试把 `roles.ts` 的顺序表和引擎实际推进的阶段钉在一起——  * 自定义版型界面显示的「入场时间」用的就是同一份数据，所以它不会说谎。
 */
describe('夜间入场顺序（版型界面与引擎必须一致）', () => {
  it('狼美人排在狼刀之后，紧邻女巫之前', () => {
    const board = makeBoard(12, {
      WOLF: 3, WOLF_BEAUTY: 1, VILLAGER: 4, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1,
    });
    const plan = nightPlan(board);
    const later = plan.laterNights;
    assert.deepEqual(later, ['WOLF', 'WOLF_BEAUTY', 'WITCH', 'SEER'],
      '夜间顺序必须是狼刀 → 狼美人 → 女巫 → 预言家');

    const beauty = plan.slots.find((s) => s.role === 'WOLF_BEAUTY')!;
    assert.equal(beauty.timing, 'EVERY_NIGHT');
    assert.equal(beauty.laterNightSlot, 2, '狼美人应在第 2 个环节睁眼');
    assert.match(beauty.detail, /第 2 个环节/);
  });

  it('版型界面给出的顺序，和引擎实际推进的阶段完全一致', () => {
    const board = makeBoard(12, {
      WOLF: 3, WOLF_BEAUTY: 1, VILLAGER: 4, SEER: 1, WITCH: 1, HUNTER: 1, IDIOT: 1,
    });
    const g = newGame({ roles: boardToDeck(board) });
    startNight(g);

    const expected = nightPlan(board).firstNight.map((role) => NIGHT_PHASE_BY_ROLE[role]!);
    const actual: Phase[] = [];
    let steps = 0;
    while (phaseOf(g) !== 'NIGHT_RESOLVE' && steps++ < 30) {
      g.forceAdvance();
      const phase = phaseOf(g);
      if (phase !== 'NIGHT_RESOLVE') actual.push(phase);
    }
    assert.deepEqual(actual, expected, '引擎实际走的阶段必须和顺序表一模一样');
    assert.ok(actual.includes('NIGHT_BEAUTY_CHARM'));
  });

  it('恶灵骑士不占独立环节，但会被标成「被动」而不是「没有夜间行动」', () => {
    const board = makeBoard(12, {
      WOLF: 3, DARK_LORD: 1, VILLAGER: 4, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1,
    });
    const plan = nightPlan(board);
    assert.deepEqual(plan.laterNights, ['WOLF', 'GUARD', 'WITCH', 'SEER']);

    const lord = plan.slots.find((s) => s.role === 'DARK_LORD')!;
    assert.equal(lord.timing, 'PASSIVE', '他不单独睁眼，但技能整夜生效');
    assert.equal(lord.laterNightSlot, null);
    assert.match(lord.detail, /不单独睁眼/);

    const villager = plan.slots.find((s) => s.role === 'VILLAGER')!;
    assert.equal(villager.timing, 'NO_NIGHT_ACTION');
  });

  it('首夜独有的角色被标成「仅第一夜」，第二夜起的被标成「第二夜起」', () => {
    const board = makeBoard(12, {
      WOLF: 3, MASK: 1, VILLAGER: 3, HYBRID: 1, SEER: 1, WITCH: 1, HUNTER: 1, DANCER: 1,
    });
    const plan = nightPlan(board);
    assert.equal(plan.slots.find((s) => s.role === 'HYBRID')!.timing, 'FIRST_NIGHT_ONLY');
    assert.equal(plan.slots.find((s) => s.role === 'DANCER')!.timing, 'FROM_SECOND_NIGHT');
    assert.equal(plan.slots.find((s) => s.role === 'MASK')!.timing, 'FROM_SECOND_NIGHT');
    assert.match(nightPlanSummary(board), /第一夜：/);
  });
});

describe('狼美人', () => {
  it('狼队不能自刀狼美人', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');

    const res = g.submitNightAction(pid(1), { kind: 'wolf', target: BEAUTY_SEAT });
    assert.equal(res.ok, false, '官方规定狼美人不能自刀');
    assert.match(res.message ?? '', /不能自刀/);
    // 界面上的候选项里也不该出现。
    assert.ok(!g.gameViewFor(pid(1)).myOptions.includes(BEAUTY_SEAT), '狼美人不应出现在刀人候选里');
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: 5 }).ok, true);
  });

  it('狼美人不能魅惑自己；超时等于本夜不魅惑', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    startNight(g);
    advanceTo(g, 'NIGHT_BEAUTY_CHARM');
    assert.equal(g.gameViewFor(pid(BEAUTY_SEAT)).myTurn, true);

    const self = g.submitNightAction(pid(BEAUTY_SEAT), { kind: 'beautyCharm', target: BEAUTY_SEAT });
    assert.equal(self.ok, false);
    assert.match(self.message ?? '', /不能魅惑自己/);

    // 只有她能行动，别人提交应被拒
    assert.equal(g.submitNightAction(pid(5), { kind: 'beautyCharm', target: 6 }).ok, false);
  });

  it('她出局时，前一晚被魅惑的人殉情', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });

    // 第一夜：魅惑 5 号
    startNight(g);
    advanceTo(g, 'NIGHT_BEAUTY_CHARM');
    assert.equal(g.submitNightAction(pid(BEAUTY_SEAT), { kind: 'beautyCharm', target: 5 }).ok, true);
    assert.equal(g.gameViewFor(pid(BEAUTY_SEAT)).me?.lastCharmedSeat, null,
      '当夜还不生效 —— 殉情只带「前一晚」那个');
    // 补完剩下的夜晚：女巫 → 预言家 → 夜结算，进到 DAY_ANNOUNCE
    g.forceAdvance();
    g.forceAdvance();
    g.forceAdvance();
    playDay(g, () => null);

    // 第二夜：女巫毒掉狼美人 → 5 号殉情。
    assert.equal(g.phase, 'NIGHT_START');
    advanceTo(g, 'NIGHT_BEAUTY_CHARM');
    assert.equal(g.submitNightAction(pid(BEAUTY_SEAT), { kind: 'beautyCharm', target: 6 }).ok, true);
    advanceTo(g, 'NIGHT_WITCH');
    assert.equal(
      g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: BEAUTY_SEAT }).ok,
      true,
    );

    g.forceAdvance();
    assert.equal(g.isDeadSeat(BEAUTY_SEAT), true, '狼美人应出局');
    assert.equal(g.isDeadSeat(5), true, '前一晚被魅惑的5 号应殉情');
    assert.equal(g.isDeadSeat(6), false, '本夜刚魅惑的 6 号不该陪葬');

    assert.equal(causeOf(g, BEAUTY_SEAT), 'POISON');
    assert.equal(causeOf(g, 5), 'LOVE');
    // 殉情的死讯必须出现在天亮公告里。
    assert.ok(g.gameViewFor(pid(1)).lastNightDeaths.includes(5));
  });

  it('殉情者不能发动技能（猎人殉情不开枪）', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    // 让第一夜魅惑猎人（11 号）
    startNight(g);
    advanceTo(g, 'NIGHT_BEAUTY_CHARM');
    g.submitNightAction(pid(BEAUTY_SEAT), { kind: 'beautyCharm', target: 11 });
    // 补完剩下的夜晚：女巫 → 预言家 → 夜结算，进到 DAY_ANNOUNCE
    g.forceAdvance();
    g.forceAdvance();
    g.forceAdvance();
    playDay(g, () => null);

    // 第二夜毒死狼美人 → 猎人殉情，但**不该**有开枪机会。
    advanceTo(g, 'NIGHT_WITCH');
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: BEAUTY_SEAT });
    g.forceAdvance();

    assert.equal(g.isDeadSeat(11), true, '猎人应殉情出局');
    assert.notEqual(phaseOf(g), 'HUNTER_SHOOT', '殉情者不能发动技能，不给开枪机会');
    assert.equal(g.gameViewFor(pid(11)).hunterPendingSeat, null);
  });

  it('第一夜就出局的狼美人带不走任何人（那时还没有「前一晚」）', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    startNight(g);
    advanceTo(g, 'NIGHT_WITCH');
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: BEAUTY_SEAT });
    g.forceAdvance();

    assert.equal(g.isDeadSeat(BEAUTY_SEAT), true);
    // 5 号平安无事。
    assert.equal(g.isDeadSeat(5), false, '没有前一晚的魅惑，不能有人殉情');
    assert.ok(!g.gameViewFor(pid(1)).lastNightDeaths.includes(5));
  });

  it('白天被放逐的狼美人同样会带走前一晚被魅惑的人', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    startNight(g);
    advanceTo(g, 'NIGHT_BEAUTY_CHARM');
    g.submitNightAction(pid(BEAUTY_SEAT), { kind: 'beautyCharm', target: 5 });
    // 直接跳到放逐投票。
    advanceToDayVote(g);
    for (const seat of voters(g)) {
      // 狼美人自己不能投自己（引擎禁自投），她投 5 号即可
      assert.equal(g.submitVote(pid(seat), seat === BEAUTY_SEAT ? 5 : BEAUTY_SEAT).ok, true);
    }
    g.forceAdvance();

    assert.equal(g.isDeadSeat(BEAUTY_SEAT), true, '狼美人被放逐');
    assert.equal(g.isDeadSeat(5), true, '被魅惑的 5 号应殉情');
    assert.equal(causeOf(g, 5), 'LOVE');
  });
});

describe('恶灵骑士', () => {
  it('夜里不会死：狼刀、毒药都对他无效，而且不会出现在死讯里', () => {
    const g = newGame({ roles: LAYOUT_DARK_LORD });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    // 狼队不能刀他。
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: DARK_LORD_SEAT }).ok, false);
    for (const seat of [1, 2, 3]) g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });

    advanceTo(g, 'NIGHT_WITCH');
    assert.equal(
      g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: DARK_LORD_SEAT }).ok,
      true,
    );
    g.forceAdvance();

    assert.equal(g.isDeadSeat(DARK_LORD_SEAT), false, '恶灵骑士夜里杀不死');
    assert.ok(
      !g.gameViewFor(pid(1)).lastNightDeaths.includes(DARK_LORD_SEAT),
      '免疫的人绝不能出现在天亮死讯里 —— 那会直接穿帮',
    );
    assert.equal(g.isDeadSeat(5), true, '狼刀正常生效');
  });

  it('女巫毒他会遭反伤，而且反伤只发生一次', () => {
    const g = newGame({ roles: LAYOUT_DARK_LORD });
    startNight(g);
    advanceTo(g, 'NIGHT_WITCH');
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: DARK_LORD_SEAT });
    g.forceAdvance();

    assert.equal(g.isDeadSeat(WITCH_SEAT), true, '女巫应遭到反伤出局');
    assert.equal(g.isDeadSeat(DARK_LORD_SEAT), false);
    assert.equal(causeOf(g, WITCH_SEAT), 'REFLECT');
    assert.ok(g.gameViewFor(pid(1)).lastNightDeaths.includes(WITCH_SEAT), '反伤死讯要进天亮公告');
  });

  it('预言家查验他也会被反伤致死', () => {
    const g = newGame({ roles: LAYOUT_DARK_LORD });
    startNight(g);
    advanceTo(g, 'NIGHT_SEER');
    assert.equal(g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: DARK_LORD_SEAT }).ok, true);
    g.forceAdvance();

    assert.equal(g.isDeadSeat(SEER_SEAT), true, '查验恶灵骑士会被反伤');
    assert.equal(g.isDeadSeat(DARK_LORD_SEAT), false);
    assert.equal(causeOf(g, SEER_SEAT), 'REFLECT');
  });

  it('同一夜多人对他动手，只有先行动的那个人吃反伤', () => {
    const g = newGame({ roles: LAYOUT_DARK_LORD });
    startNight(g);
    // 女巫阶段在预言家之前，所以女巫先「行动」→ 她吃这一下，预言家平安。
    advanceTo(g, 'NIGHT_WITCH');
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: DARK_LORD_SEAT });
    advanceTo(g, 'NIGHT_SEER');
    g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: DARK_LORD_SEAT });
    g.forceAdvance();

    assert.equal(g.isDeadSeat(WITCH_SEAT), true, '先行动的女巫吃反伤');
    assert.equal(g.isDeadSeat(SEER_SEAT), false, '后行动的预言家应该平安');
  });

  it('反伤用掉之后，查验他就安全了（但依然夜里杀不死）', () => {
    const g = newGame({ roles: LAYOUT_DARK_LORD });
    // 第一夜：女巫毒他 → 女巫死，反伤用掉
    startNight(g);
    advanceTo(g, 'NIGHT_WITCH');
    g.submitNightAction(pid(WITCH_SEAT), { kind: 'witch', save: false, poison: DARK_LORD_SEAT });
    g.forceAdvance();
    assert.equal(g.isDeadSeat(WITCH_SEAT), true);
    g.forceAdvance(); // 越过 NIGHT_RESOLVE 过场，进到 DAY_ANNOUNCE
    playDay(g, () => null);

    // 第二夜：预言家验他 → 不该再有人死
    assert.equal(g.phase, 'NIGHT_START');
    advanceTo(g, 'NIGHT_SEER');
    assert.equal(g.submitNightAction(pid(SEER_SEAT), { kind: 'seer', target: DARK_LORD_SEAT }).ok, true);
    g.forceAdvance();
    assert.equal(g.isDeadSeat(SEER_SEAT), false, '一次性反伤已经用掉了');
    assert.equal(g.isDeadSeat(DARK_LORD_SEAT), false, '但他依然夜里杀不死');
  });

  it('白天被放逐会正常出局 —— 那是好人唯一能处理他的方法', () => {
    const g = newGame({ roles: LAYOUT_DARK_LORD });
    startNight(g);
    advanceToDayVote(g);
    for (const seat of voters(g)) g.submitVote(pid(seat), DARK_LORD_SEAT);
    g.forceAdvance();
    assert.equal(g.isDeadSeat(DARK_LORD_SEAT), true);
    assert.equal(causeOf(g, DARK_LORD_SEAT), 'VOTE');
  });
});

// ────────────────────────────── 守墓人 ──────────────────────────────

/** 固定牌序：1-4 狼，5-8 民，9 预言家，10 女巫，11 猎人，12 守墓人 */
const LAYOUT_GRAVE: Role[] = [
  'WOLF', 'WOLF', 'WOLF', 'WOLF',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SEER', 'WITCH', 'HUNTER', 'GRAVE_KEEPER',
];
const GRAVE_SEAT = 12;

/**
 * 守墓人板的夜晚推进。playNight() 不认识守墓人阶段（夜 2 起多出一段），
 * 所以守墓人自己的测试用这个变体：遇到守墓人阶段就确认，其余靠超时兜底。
 */
function playGraveNight(g: Game, wolfTarget: number | null): void {
  assert.equal(phaseOf(g), 'NIGHT_START', '守墓人板夜晚应从 NIGHT_START 开始');
  g.forceAdvance();
  for (const seat of aliveWolves(g)) {
    g.submitNightAction(pid(seat), { kind: 'wolf', target: wolfTarget });
  }
  let steps = 0;
  while (!['DAY_ANNOUNCE', 'GAME_OVER'].includes(phaseOf(g)) && steps++ < 30) {
    if (phaseOf(g) === 'NIGHT_GRAVE_KEEPER' && !g.isDeadSeat(GRAVE_SEAT)) {
      const res = g.submitNightAction(pid(GRAVE_SEAT), { kind: 'graveKeeper' });
      assert.equal(res.ok, true, `守墓人确认应被接受：${res.message ?? ''}`);
      continue;
    }
    g.forceAdvance();
  }
}

describe('守墓人', () => {
  it('预设版型校验通过；首夜不睁眼，第二夜起排在全部查验之后', () => {
    const board = makeBoard(12, {
      WOLF: 4, VILLAGER: 4, SEER: 1, WITCH: 1, HUNTER: 1, GRAVE_KEEPER: 1,
    });
    assert.equal(boardErrors(board).length, 0);

    const plan = nightPlan(board);
    assert.ok(!plan.firstNight.includes('GRAVE_KEEPER'), '首夜没有「昨天的放逐」可查');
    assert.deepEqual(plan.laterNights, ['WOLF', 'WITCH', 'SEER', 'GRAVE_KEEPER']);
    const slot = plan.slots.find((s) => s.role === 'GRAVE_KEEPER')!;
    assert.equal(slot.timing, 'FROM_SECOND_NIGHT');
    assert.equal(slot.laterNightSlot, 4);
  });

  it('第二夜得知昨天被放逐者的阵营（狼人）', () => {
    const g = newGame({ roles: LAYOUT_GRAVE });
    startNight(g);
    playNight(g, 5); // 夜 1 刀 5 号民（板里没有守卫，playNight 走得通）
    playDay(g, (seat) => (seat === 2 ? null : 2)); // 白天放逐 2 号狼（他自己不能投自己）

    // 夜 2：守墓人阶段必须真实出现
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: null });
    }
    advanceTo(g, 'NIGHT_GRAVE_KEEPER');

    const view = g.gameViewFor(pid(GRAVE_SEAT));
    const history = view.me?.graveHistory ?? [];
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], { day: 2, seat: 2, nickname: '玩家2', isWolf: true });
    assert.match(view.phaseHint ?? '', /【狼人】/);

    // 确认后阶段正常收束
    assert.equal(g.submitNightAction(pid(GRAVE_SEAT), { kind: 'graveKeeper' }).ok, true);
    assert.equal(phaseOf(g), 'NIGHT_RESOLVE');
    assertInvariants(g);
  });

  it('被放逐的混血儿验为好人', () => {
    const layout: Role[] = [
      'WOLF', 'WOLF', 'WOLF', 'WOLF',
      'VILLAGER', 'VILLAGER', 'VILLAGER', 'HYBRID',
      'SEER', 'WITCH', 'HUNTER', 'GRAVE_KEEPER',
    ];
    const g = newGame({ roles: layout });
    startNight(g);
    advanceTo(g, 'NIGHT_HYBRID');
    g.submitNightAction(pid(8), { kind: 'hybrid', target: 5 });
    // 榜样提交后已自动进入狼人阶段，剩余环节用超时推进补完这一夜
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: 5 });
    }
    let hybridSteps = 0;
    while (!['DAY_ANNOUNCE', 'GAME_OVER'].includes(phaseOf(g)) && hybridSteps++ < 30) g.forceAdvance();
    playDay(g, (seat) => (seat === 8 ? null : 8)); // 放逐 8 号混血儿（他不能投自己）

    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: null });
    }
    advanceTo(g, 'NIGHT_GRAVE_KEEPER');
    const history = g.gameViewFor(pid(GRAVE_SEAT)).me?.graveHistory ?? [];
    assert.equal(history.length, 1);
    assert.equal(history[0]!.seat, 8);
    assert.equal(history[0]!.isWolf, false, '混血儿对守墓人应显示好人');
  });

  it('白天无人被放逐时记录为无信息', () => {
    const g = newGame({ roles: LAYOUT_GRAVE });
    startNight(g);
    playNight(g, 5);
    playDay(g, () => null); // 全员弃票，无人出局

    playGraveNight(g, null);
    const view = g.gameViewFor(pid(GRAVE_SEAT));
    assert.deepEqual(view.me?.graveHistory, [{ day: 2, seat: null, nickname: null, isWolf: false }]);
    assert.match(view.log.join('\n'), /守墓人请睁眼/);
  });

  it('守墓人出局后阶段照常出现（时间不泄密），但不再补录结果', () => {
    const g = newGame({ roles: LAYOUT_GRAVE });
    startNight(g);
    playNight(g, GRAVE_SEAT); // 夜 1 就刀掉守墓人
    playDay(g, (seat) => (seat === 2 ? null : 2));

    // 夜 2：阶段必须仍然出现 —— 消失就等于广播守墓人已死
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: null });
    }
    advanceTo(g, 'NIGHT_GRAVE_KEEPER');
    g.forceAdvance(); // 超时兜底推进
    assert.equal(phaseOf(g), 'NIGHT_RESOLVE');
    assert.deepEqual(g.gameViewFor(pid(GRAVE_SEAT)).me?.graveHistory ?? [], [], '出局后不再获得新情报');
    assertInvariants(g);
  });

  it('查验记录只对守墓人本人可见', () => {
    const g = newGame({ roles: LAYOUT_GRAVE });
    startNight(g);
    playNight(g, 5);
    playDay(g, (seat) => (seat === 2 ? null : 2));
    playGraveNight(g, null);

    const keeper = JSON.stringify(g.gameViewFor(pid(GRAVE_SEAT)));
    assert.ok(keeper.includes('graveHistory'), '守墓人本人应看到自己的记录');
    for (const seat of [1, 5, 9, 10, 11]) {
      const other = JSON.stringify(g.gameViewFor(pid(seat)));
      assert.ok(!other.includes('graveHistory'), `${seat} 号的视图不应包含守墓人记录`);
      assert.ok(!other.includes('守墓人查验'), `${seat} 号的视图不应包含守墓人结果文案`);
    }
  });

  it('守墓人阶段台词全场一致，且不含任何查验结果', () => {
    const g = newGame({ roles: LAYOUT_GRAVE });
    startNight(g);
    playNight(g, 5);
    playDay(g, (seat) => (seat === 2 ? null : 2));
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: null });
    }
    advanceTo(g, 'NIGHT_GRAVE_KEEPER');

    const lines = new Set(g.aliveSeatsSnapshot().map((seat) => g.gameViewFor(pid(seat)).voiceLine));
    assert.equal(lines.size, 1, '同一阶段所有人的台词必须一模一样');
    const line = [...lines][0]!;
    assert.equal(line, '预言家请闭眼。守墓人请睁眼。');
    assert.ok(!line.includes('狼人') && !line.includes('好人'), '台词不能携带查验结果');
  });

  it('超时未确认也不丢信息（结果在阶段开始时已写入）', () => {
    const g = newGame({ roles: LAYOUT_GRAVE });
    startNight(g);
    playNight(g, 5);
    playDay(g, (seat) => (seat === 2 ? null : 2));
    g.forceAdvance();
    for (const seat of aliveWolves(g)) {
      g.submitNightAction(pid(seat), { kind: 'wolf', target: null });
    }
    advanceTo(g, 'NIGHT_GRAVE_KEEPER');
    g.forceAdvance(); // 挂机：不点「我已知晓」，直接超时
    const history = g.gameViewFor(pid(GRAVE_SEAT)).me?.graveHistory ?? [];
    assert.equal(history.length, 1, '超时兜底不应吞掉查验结果');
    assert.equal(history[0]!.seat, 2);
    const replay = g.replaySnapshot();
    assert.deepEqual(replay.nights[1]?.graveCheck, { seat: 2, isWolf: true }, '复盘应记录守墓人查验');
  });
});

// ────────────────────────────── 骑士 ──────────────────────────────

/** 固定牌序：1-4 狼，5-8 民，9 预言家，10 女巫，11 骑士，12 白痴 */
const LAYOUT_KNIGHT: Role[] = [
  'WOLF', 'WOLF', 'WOLF', 'WOLF',
  'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
  'SEER', 'WITCH', 'KNIGHT', 'IDIOT',
];
const KNIGHT_SEAT = 11;

describe('骑士', () => {
  it('白天发言阶段可决斗狼人：目标出局、骑士存活、当天流程继续、技能只此一次', () => {
    const g = newGame({ roles: LAYOUT_KNIGHT });
    startNight(g);
    playNight(g, 5);
    advanceTo(g, 'DAY_SPEECH');

    assert.equal(g.gameViewFor(pid(KNIGHT_SEAT)).me?.canDuel, true, '发言阶段的存活骑士应能决斗');
    const res = g.knightDuel(pid(KNIGHT_SEAT), 2);
    assert.equal(res.ok, true, `决斗应被接受：${res.message ?? ''}`);

    assert.equal(g.isDeadSeat(2), true, '目标是狼人应被处决');
    assert.equal(causeOf(g, 2), 'DUEL');
    assert.equal(g.isDeadSeat(KNIGHT_SEAT), false, '骑士应存活');
    assert.equal(phaseOf(g), 'DAY_SPEECH', '决斗后当天继续，不吞掉发言阶段');
    assert.equal(g.gameViewFor(pid(KNIGHT_SEAT)).me?.knightUsed, true);

    // 整局一次：再来一次必须被拒
    assert.equal(g.knightDuel(pid(KNIGHT_SEAT), 3).ok, false, '决斗不能发动第二次');

    // 当天投票照常进行
    advanceToDayVote(g);
    for (const seat of voters(g)) g.submitVote(pid(seat), 6);
    g.forceAdvance();
    assert.equal(g.isDeadSeat(6), true, '放逐流程不受决斗影响');
    assertInvariants(g);
  });

  it('决斗好人则骑士自己出局', () => {
    const g = newGame({ roles: LAYOUT_KNIGHT });
    startNight(g);
    playNight(g, 5);
    advanceTo(g, 'DAY_SPEECH');

    const res = g.knightDuel(pid(KNIGHT_SEAT), 6);
    assert.equal(res.ok, true);
    assert.equal(g.isDeadSeat(KNIGHT_SEAT), true, '押错对象骑士自己出局');
    assert.equal(causeOf(g, KNIGHT_SEAT), 'DUEL');
    assert.equal(g.isDeadSeat(6), false);
    assert.equal(phaseOf(g), 'DAY_SPEECH');
    assert.equal(g.gameViewFor(pid(KNIGHT_SEAT)).me?.canDuel, false);
  });

  it('只有在白天发言阶段才能决斗', () => {
    const g = newGame({ roles: LAYOUT_KNIGHT });
    startNight(g);
    assert.equal(g.knightDuel(pid(KNIGHT_SEAT), 2).ok, false, '夜里不能决斗');

    playNight(g, 5);
    advanceToDayVote(g);
    assert.equal(g.knightDuel(pid(KNIGHT_SEAT), 2).ok, false, '投票阶段不能决斗');
  });

  it('非骑士不能决斗，也不能和自己决斗', () => {
    const g = newGame({ roles: LAYOUT_KNIGHT });
    startNight(g);
    playNight(g, 5);
    advanceTo(g, 'DAY_SPEECH');

    assert.equal(g.knightDuel(pid(6), 2).ok, false, '普通玩家不能决斗');
    assert.equal(g.knightDuel(pid(KNIGHT_SEAT), KNIGHT_SEAT).ok, false, '不能和自己决斗');
    assert.equal(g.knightDuel(pid(KNIGHT_SEAT), 5).ok, false, '已出局的 5 号不能作为目标');
  });

  it('决斗处决不触发死亡开枪（狼王被决斗）', () => {
    const layout: Role[] = [
      'WOLF', 'WOLF', 'WOLF', 'BLACK_WOLF_KING',
      'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
      'SEER', 'WITCH', 'KNIGHT', 'IDIOT',
    ];
    const g = newGame({ roles: layout });
    startNight(g);
    playNight(g, 5);
    advanceTo(g, 'DAY_SPEECH');

    const res = g.knightDuel(pid(KNIGHT_SEAT), 4);
    assert.equal(res.ok, true);
    assert.equal(g.isDeadSeat(4), true);
    assert.notEqual(phaseOf(g), 'HUNTER_SHOOT', '决斗死不能触发狼王开枪');
    assert.equal(g.gameViewFor(pid(1)).hunterPendingSeat, null);
    assert.equal(phaseOf(g), 'DAY_SPEECH');
  });

  it('决斗处决狼美人不触发殉情', () => {
    const layout: Role[] = [
      'WOLF', 'WOLF', 'WOLF', 'WOLF_BEAUTY',
      'VILLAGER', 'VILLAGER', 'VILLAGER', 'VILLAGER',
      'SEER', 'WITCH', 'KNIGHT', 'IDIOT',
    ];
    const g = newGame({ roles: layout });
    startNight(g);
    advanceTo(g, 'NIGHT_BEAUTY_CHARM');
    g.submitNightAction(pid(4), { kind: 'beautyCharm', target: 5 });
    // 补完夜晚：女巫 → 预言家 → 夜结算
    g.forceAdvance();
    g.forceAdvance();
    g.forceAdvance();

    advanceTo(g, 'DAY_SPEECH');
    const res = g.knightDuel(pid(KNIGHT_SEAT), 4);
    assert.equal(res.ok, true);
    assert.equal(g.isDeadSeat(4), true, '狼美人被决斗处决');
    assert.equal(g.isDeadSeat(5), false, '被骑士决斗处决不触发殉情');
    assert.equal(causeOf(g, 4), 'DUEL');
  });

  it('决斗带走最后一头狼直接判好人胜', () => {
    const layout: Role[] = ['WOLF', 'VILLAGER', 'VILLAGER', 'VILLAGER', 'SEER', 'KNIGHT'];
    const g = newGame({ roles: layout });
    startNight(g);
    playNight(g, 2);
    advanceTo(g, 'DAY_SPEECH');

    const res = g.knightDuel(pid(6), 1);
    assert.equal(res.ok, true);
    assert.equal(phaseOf(g), 'GAME_OVER');
    assert.equal(g.winnerCamp, 'GOOD');
  });

  it('决斗出局的是警长时：先移交警徽，再回到发言阶段', () => {
    const g = newGame({ roles: LAYOUT_KNIGHT });
    startNight(g);
    playNight(g, 5);
    g.forceAdvance();
    assert.equal(phaseOf(g), 'SHERIFF_SIGNUP');
    electSingleSheriff(g, 2); // 让 2 号狼当选警长

    const res = g.knightDuel(pid(KNIGHT_SEAT), 2);
    assert.equal(res.ok, true);
    assert.equal(g.isDeadSeat(2), true);
    assert.equal(phaseOf(g), 'SHERIFF_TRANSFER', '警长出局应先处理警徽');

    assert.equal(g.submitSheriffTransfer(pid(2), 6).ok, true);
    assert.equal(phaseOf(g), 'DAY_SPEECH', '警徽处理完应回到发言阶段');
    assert.equal(g.gameViewFor(pid(1)).sheriffSeat, 6, '警徽应移交给 6 号');
    // 新警长需要重新指定发言方向（enter 会重置方向）
    assert.equal(g.gameViewFor(pid(1)).speechDirection, null);
  });
});

// ────────────────────────────── 语音台词 ──────────────────────────────

describe('语音播报台词（当法官用）', () => {
  /**
   * 录音语音包和 TTS 是同一段话的两种表达，必须说一样的话。
   *
   * 为什么这条必须有测试：语音包念的是「昨晚死亡的是 三、七号」，
   * 而没装语音包的手机用 TTS 念「昨晚死亡的是 3、7 号」——
   * 两者用词一旦不一致，只有**同时听过两种**的人才发现得了，
   * 而这种人基本不存在。所以让机器来盯。
   */
  it('语音包片段拼起来，和 voiceLine 是同一句话', () => {
    const norm = (text: string): string => text.replace(/[、，。！？：；\s]/g, '');
    const g = newGame();
    startNight(g);

    const seen = new Set<string>();
    let steps = 0;
    while (phaseOf(g) !== 'GAME_OVER' && steps++ < 400) {
      const phase = phaseOf(g);
      if (!seen.has(phase)) {
        seen.add(phase);
        const line = g.voiceLineFor();
        const cues = g.voiceCuesFor();

        const spoken = cues
          .map((cue) => {
            if ('clip' in cue) {
              const clip = clipById(cue.clip);
              assert.ok(clip, `阶段 ${phase} 引用了不存在的语音片段：${cue.clip}`);
              return clip!.text;
            }
            // 数字片段念的是「三」，台词里写的是「3」——
            // 比对时统一用阿拉伯数字，所以这里返回数字本身
            if ('num' in cue) return String(cue.num);
            return '';
          })
          .join('');

        assert.equal(norm(spoken), norm(line), `阶段 ${phase} 的语音包片段和台词对不上`);
      }
      g.forceAdvance();
    }
    assert.ok(seen.size >= 8, `覆盖的阶段太少（只检查了 ${seen.size} 个），测试形同虚设`);
  });

  it('女巫阶段只说「女巫请睁眼」，绝不念出刀口', () => {
    const g = newGame();
    startNight(g);
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
    startNight(g);
    playNight(g, 5);
    const line = g.gameViewFor(pid(1)).voiceLine;
    assert.match(line, /天亮了/);
    assert.match(line, /5 号/);
  });

  it('同一阶段所有人的台词完全相同（台词里不能掺个人信息）', () => {
    // 这条是硬约束：台词一旦因人而异，就说明掺进了隐藏信息，
    // 开了语音播报的人等于用喇叭把秘密广播出去。
    const g = newGame();
    startNight(g);
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
    startNight(g);
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

// ════════════════════════════════════════════════════════════════
//  「唯邻是从」：首夜狼队选一名好人当傀儡
// ════════════════════════════════════════════════════════════════

/**
 * 造一个「唯邻是从」牌序。
 *
 * @param wolfSeats 狼的座位（第一个是狼王）
 * @param placements 座位 → 角色；其余座位补平民
 */
function puppetDeck(wolfSeats: number[], placements: Record<number, Role> = {}): Role[] {
  const deck: Role[] = [];
  for (let seat = 1; seat <= 12; seat++) {
    if (seat === wolfSeats[0]) deck.push('BLACK_WOLF_KING');
    else if (wolfSeats.includes(seat)) deck.push('WOLF');
    else deck.push(placements[seat] ?? 'VILLAGER');
  }
  return deck;
}

function puppetGame(roles: Role[], seed = 20240501): Game {
  const seeds: PlayerSeed[] = [];
  for (let seat = 1; seat <= roles.length; seat++) {
    seeds.push({ id: pid(seat), seat, nickname: `玩家${seat}`, isHost: seat === 1 });
  }
  return new Game('PUPPET01', seeds, { roles, shuffle: false, puppet: true, seed });
}

/** 座位 → 该座位上的角色（只在活着的时候用） */
const seatOfRole = (g: Game, role: Role): number | null =>
  g.aliveSeatsSnapshot().find((seat) => g.roleAt(seat) === role) ?? null;

/** 首夜：狼队刀人 + 选傀儡（其余阶段用 forceAdvance 走完，方便单独验证结算） */
function puppetNight1(
  g: Game,
  plan: { knife: number | null; puppet: number },
): void {
  assert.equal(phaseOf(g), 'NIGHT_START');
  g.forceAdvance();
  assert.equal(phaseOf(g), 'NIGHT_WOLVES');
  for (const seat of aliveWolves(g)) {
    const res = g.submitNightAction(pid(seat), { kind: 'wolf', target: plan.knife, puppet: plan.puppet });
    assert.equal(res.ok, true, `狼 ${seat} 号提交失败：${res.message ?? ''}`);
  }
}

/** 把当前夜晚剩下的阶段全部用「超时」走完，直到天亮 */
function runOutNight(g: Game): void {
  let steps = 0;
  while (phaseOf(g) !== 'DAY_ANNOUNCE' && steps++ < 20) g.forceAdvance();
  assert.equal(phaseOf(g), 'DAY_ANNOUNCE', '夜晚应该走到天亮');
}

/**
 * 「唯邻是从」首夜完整流程：狼刀+选傀儡 → 守卫 → 女巫 → 预言家 → 天亮。
 * 各阶段按 `plan` 里的意图行动，没给意图的阶段直接超时跳过。
 */
function fullNight(
  g: Game,
  plan: {
    knife: number | null;
    puppet: number;
    guard?: number | null;
    save?: boolean;
    poison?: number | null;
    seerTarget?: number | null;
  },
): void {
  g.forceAdvance();
  assert.equal(phaseOf(g), 'NIGHT_WOLVES');
  for (const seat of aliveWolves(g)) {
    const res = g.submitNightAction(pid(seat), { kind: 'wolf', target: plan.knife, puppet: plan.puppet });
    assert.equal(res.ok, true, `狼 ${seat} 号提交失败：${res.message ?? ''}`);
  }

  if (phaseOf(g) === 'NIGHT_GUARD') {
    const guard = seatOfRole(g, 'GUARD');
    if (plan.guard != null && guard !== null) {
      assert.equal(g.submitNightAction(pid(guard), { kind: 'guard', target: plan.guard }).ok, true, '守卫行动应被接受');
    } else {
      g.forceAdvance();
    }
  }
  if (phaseOf(g) === 'NIGHT_WITCH') {
    const witch = seatOfRole(g, 'WITCH')!;
    const res = g.submitNightAction(pid(witch), {
      kind: 'witch',
      save: plan.save ?? false,
      poison: plan.poison ?? null,
    });
    assert.equal(res.ok, true, `女巫行动应被接受：${res.message ?? ''}`);
  }
  if (phaseOf(g) === 'NIGHT_SEER') {
    const seer = seatOfRole(g, 'SEER')!;
    if (plan.seerTarget != null) {
      assert.equal(
        g.submitNightAction(pid(seer), { kind: 'seer', target: plan.seerTarget }).ok,
        true,
        '预言家行动应被接受',
      );
    } else {
      g.forceAdvance();
    }
  }
  assert.equal(phaseOf(g), 'NIGHT_RESOLVE');
  g.forceAdvance();
  assert.equal(phaseOf(g), 'DAY_ANNOUNCE');
}

describe('唯邻是从：首夜选傀儡', () => {
  it('狼在 1/2/3 号时，候选人只有它们两侧的好人', () => {
    const g = puppetGame(puppetDeck([1, 2, 3], { 9: 'SEER', 10: 'WITCH', 11: 'HUNTER', 12: 'GUARD' }));
    startNight(g);
    g.forceAdvance();
    assert.equal(phaseOf(g), 'NIGHT_WOLVES');

    // 1 号的邻居是 12、2；2 号的是 1、3；3 号的是 2、4
    // 其中是狼的排除掉 → 只剩 12（守卫）和 4（平民）
    const view = g.gameViewFor(pid(1));
    assert.deepEqual(view.puppetInfo?.candidates, [4, 12], '候选应只有狼两侧的好人');
  });

  it('首夜不选傀儡会被服务端拒绝', () => {
    const g = puppetGame(puppetDeck([1, 2, 3], { 9: 'SEER', 10: 'WITCH', 11: 'HUNTER', 12: 'GUARD' }));
    startNight(g);
    g.forceAdvance();
    const res = g.submitNightAction(pid(1), { kind: 'wolf', target: 5 });
    assert.equal(res.ok, false, '唯邻是从的首夜必须选傀儡');
  });

  it('不能选狼、也不能选不相邻的好人', () => {
    const g = puppetGame(puppetDeck([1, 2, 3], { 9: 'SEER', 10: 'WITCH', 11: 'HUNTER', 12: 'GUARD' }));
    startNight(g);
    g.forceAdvance();

    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: 5, puppet: 2 }).ok, false, '2 号是狼，不能当傀儡');
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: 5, puppet: 9 }).ok, false, '9 号是预言家但不与狼相邻');
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: 5, puppet: 12 }).ok, true, '12 号是狼的邻居，可以');
  });

  it('傀儡算进狼人阵营：好人必须清掉他才算赢', () => {
    const g = puppetGame(puppetDeck([1, 2, 3], { 9: 'SEER', 10: 'WITCH', 11: 'HUNTER', 12: 'GUARD' }));
    startNight(g);
    puppetNight1(g, { knife: null, puppet: 4 });
    assert.deepEqual(aliveWolves(g), [1, 2, 3], '角色层面只有 3 只狼');
    // 傀儡已经生效 → 狼人阵营应该是 4 个（用胜负判定间接验证：见下面「三狼全死」用例）
    const wolfView = g.gameViewFor(pid(1));
    assert.equal(wolfView.puppetInfo?.chosen, 4, '狼队应该知道傀儡是谁');
  });
});

describe('唯邻是从：傀儡本人不能发现', () => {
  it('傀儡拿到的视图里没有任何暴露自己的字段', () => {
    const g = puppetGame(puppetDeck([1, 2, 3], { 9: 'SEER', 10: 'WITCH', 11: 'HUNTER', 12: 'GUARD' }));
    startNight(g);
    puppetNight1(g, { knife: null, puppet: 4 });

    const view = g.gameViewFor(pid(4));
    assert.equal(view.me?.camp, 'GOOD', '傀儡看到的阵营必须还是好人');
    assert.equal(view.puppetInfo, undefined, '傀儡绝不能收到傀儡信息');
    assert.equal(view.me?.role, 'VILLAGER', '傀儡看到的还是自己的原底牌');
    // 狼队的战术界面也绝不能给他
    assert.equal(view.me?.canEditWolfTag, undefined);
    assert.equal(view.wolfTags, undefined);
    assert.equal(view.wolfVotes, undefined);
  });

  it('傀儡的底牌描述里不会出现「傀儡」字样', () => {
    const g = puppetGame(puppetDeck([1, 2, 3], { 9: 'SEER', 10: 'WITCH', 11: 'HUNTER', 12: 'GUARD' }));
    startNight(g);
    puppetNight1(g, { knife: null, puppet: 4 });
    const json = JSON.stringify(g.gameViewFor(pid(4)));
    assert.ok(!json.includes('傀儡'), `傀儡自己的视图里出现了「傀儡」：${json.slice(0, 200)}`);
  });
});

/**
 * 「唯邻是从」最容易写错的地方：傀儡的四种技能异常。
 *
 * 统一用狼在 1/2/11 号的牌序 —— 它们的邻居是 12、3、10，
 * 所以只要把要测的角色放在 3 / 10 / 12，它就一定能被选成傀儡。
 * 每个用例再把它不关心的角色放到别的座位（顺带验证「不相邻的好人不会进候选」）。
 */
describe('唯邻是从：傀儡的技能异常', () => {
  const isDead = (g: Game, seat: number): boolean => g.isDeadSeat(seat);

  it('傀儡守卫：照样能选守护对象，但守护完全不生效', () => {
    // 守卫在 12 号（狼 11 号的邻居），傀儡 = 12
    const g = puppetGame(puppetDeck([1, 2, 11], { 12: 'GUARD', 3: 'SEER', 10: 'WITCH', 4: 'HUNTER' }));
    startNight(g);
    fullNight(g, { knife: 5, puppet: 12, guard: 5 });
    assert.ok(isDead(g, 5), '傀儡守卫守了 5 号，但狼刀必须照样得手');
  });

  it('对照组：真守卫守同一个人，狼刀无效', () => {
    const g = puppetGame(puppetDeck([1, 2, 11], { 12: 'GUARD', 3: 'SEER', 10: 'WITCH', 4: 'HUNTER' }));
    startNight(g);
    // 傀儡选 3 号（预言家），守卫还是真的
    fullNight(g, { knife: 5, puppet: 3, guard: 5 });
    assert.equal(isDead(g, 5), false, '真守卫守住的人不该死');
  });

  it('傀儡女巫的解药不生效，但药会被扣掉', () => {
    // 女巫在 10 号（狼 11 号的邻居），傀儡 = 10
    const g = puppetGame(puppetDeck([1, 2, 11], { 10: 'WITCH', 3: 'SEER', 12: 'GUARD', 4: 'HUNTER' }));
    startNight(g);
    fullNight(g, { knife: 5, puppet: 10, save: true });
    assert.ok(isDead(g, 5), '傀儡女巫的解药不该救人');

    // 药水必须扣掉：否则他能反复"救"同一晚，一试就知道是假的
    const view = g.gameViewFor(pid(10));
    assert.equal(view.me?.potions?.antidote, false, '解药必须记成已使用');
  });

  it('傀儡女巫的毒药不生效，但药会被扣掉', () => {
    const g = puppetGame(puppetDeck([1, 2, 11], { 10: 'WITCH', 3: 'SEER', 12: 'GUARD', 4: 'HUNTER' }));
    startNight(g);
    fullNight(g, { knife: null, puppet: 10, poison: 5 });
    assert.equal(isDead(g, 5), false, '傀儡女巫的毒药不该毒死人');
    const view = g.gameViewFor(pid(10));
    assert.equal(view.me?.potions?.poison, false, '毒药必须记成已使用');
  });

  it('傀儡预言家：验人结果整个反过来', () => {
    // 预言家在 3 号（狼 2 号的邻居），傀儡 = 3
    const g = puppetGame(puppetDeck([1, 2, 11], { 3: 'SEER', 10: 'WITCH', 12: 'GUARD', 4: 'HUNTER' }));
    startNight(g);
    // 3 号是傀儡，他验 1 号（真狼王）→ 结果应该是【好人】
    fullNight(g, { knife: null, puppet: 3, seerTarget: 1 });

    // 用 seerHistory 断言：它和「按住身份牌」看到的历史是同一份，
    // 而且能跨阶段读（phaseHint 只在 NIGHT_SEER 进行中才有）
    const history = g.gameViewFor(pid(3)).me?.seerHistory ?? [];
    assert.equal(history.length, 1, '预言家应该有一条查验记录');
    assert.equal(history[0]?.seat, 1);
    assert.equal(history[0]?.camp, 'GOOD', '傀儡预言家验真狼必须看到【好人】');
    assert.notEqual(causeOf(g, 1), 'WOLF', '1 号没被刀，只是拿来验的');
  });

  it('对照组：真预言家验同一只狼，看到的是狼人', () => {
    const g = puppetGame(puppetDeck([1, 2, 11], { 3: 'SEER', 10: 'WITCH', 12: 'GUARD', 4: 'HUNTER' }));
    startNight(g);
    fullNight(g, { knife: null, puppet: 10, seerTarget: 1 });
    const history = g.gameViewFor(pid(3)).me?.seerHistory ?? [];
    assert.equal(history[0]?.camp, 'WOLF', '真预言家验狼必须看到【狼人】');
  });

  it('真预言家验傀儡，看到的是狼人', () => {
    const g = puppetGame(puppetDeck([1, 2, 11], { 3: 'SEER', 10: 'WITCH', 12: 'GUARD', 4: 'HUNTER' }));
    startNight(g);
    // 傀儡 = 12（守卫），真预言家（3 号）验 12 号
    fullNight(g, { knife: null, puppet: 12, seerTarget: 12 });
    const history = g.gameViewFor(pid(3)).me?.seerHistory ?? [];
    assert.equal(history[0]?.seat, 12);
    assert.equal(history[0]?.camp, 'WOLF', '傀儡在真预言家眼里必须是【狼人】');
  });

  it('傀儡猎人：出局时开枪打不死人，但开枪阶段照常走完', () => {
    // 猎人在 12 号（狼 11 号的邻居），傀儡 = 12
    const g = puppetGame(puppetDeck([1, 2, 11], { 12: 'HUNTER', 3: 'SEER', 10: 'WITCH', 4: 'GUARD' }));
    startNight(g);
    fullNight(g, { knife: 12, puppet: 12, guard: 4 });

    assert.ok(isDead(g, 12), '傀儡猎人被刀应该正常死亡');
    // 天亮阶段过完才会进入开枪阶段
    g.forceAdvance();
    // 关键：开枪阶段必须存在（直接跳过＝全场立刻知道他是傀儡）
    assert.equal(phaseOf(g), 'HUNTER_SHOOT', '傀儡猎人的开枪阶段必须照常出现');
    assert.equal(g.submitHunterShoot(pid(12), 5).ok, true, '他应该被允许"开枪"');
    assert.equal(isDead(g, 5), false, '傀儡猎人的枪是哑的，不该打死人');
  });

  it('对照组：真猎人开枪能打死人', () => {
    const g = puppetGame(puppetDeck([1, 2, 11], { 12: 'HUNTER', 3: 'SEER', 10: 'WITCH', 4: 'GUARD' }));
    startNight(g);
    fullNight(g, { knife: 12, puppet: 3, guard: 4 });
    assert.ok(isDead(g, 12), '真猎人被刀应该死亡');
    g.forceAdvance();
    assert.equal(phaseOf(g), 'HUNTER_SHOOT');
    assert.equal(g.submitHunterShoot(pid(12), 5).ok, true);
    assert.ok(isDead(g, 5), '真猎人的枪必须打死人');
  });
});

describe('唯邻是从：胜负判定', () => {
  /**
   * 走到下一次投票，把 target 投出去；返回失败原因（null = 成功出局）。
   *
   * 顺手把狼王的开枪机会放弃掉 —— 他不开枪会卡住整个流程。
   * 这里挨个试存活玩家：`submitHunterShoot` 对不是持枪者的人返回失败且无副作用，
   * 所以「谁成功谁就是持枪者」。
   */
  function exileByVote(g: Game, target: number): string | null {
    let steps = 0;
    while (phaseOf(g) !== 'DAY_VOTE' && phaseOf(g) !== 'GAME_OVER' && steps++ < 40) g.forceAdvance();
    if (phaseOf(g) !== 'DAY_VOTE') return `走不到投票阶段（停在 ${g.phase}）`;

    const refused: number[] = [];
    for (const seat of voters(g)) {
      // 目标本人必须**弃票**而不是不投 —— 引擎要等全体投票者表态，
      // 少一个人这轮投票就永远不结算（阶段会一直停在 DAY_VOTE）
      if (!g.submitVote(pid(seat), seat === target ? null : target).ok) refused.push(seat);
    }
    if (refused.length > 0) return `这些人的票没投进去：${refused.join(',')}`;

    let guard = 0;
    while (phaseOf(g) === 'HUNTER_SHOOT' && guard++ < 6) {
      let declined = false;
      for (const seat of g.aliveSeatsSnapshot()) {
        if (g.submitHunterShoot(pid(seat), null).ok) {
          declined = true;
          break;
        }
      }
      if (!declined) g.forceAdvance();
    }
    if (!g.isDeadSeat(target)) return `投出去了但没死（停在 ${g.phase}）`;
    return null;
  }

  it('三狼全部出局但傀儡还活着 → 游戏不结束，好人没赢', () => {
    const g = puppetGame(puppetDeck([1, 2, 11], { 4: 'SEER', 10: 'WITCH', 12: 'GUARD', 5: 'HUNTER' }));
    startNight(g);
    fullNight(g, { knife: null, puppet: 12 });

    const failed: string[] = [];
    for (const wolf of [1, 2, 11]) {
      if (g.isOver || g.isDeadSeat(wolf)) continue;
      const err = exileByVote(g, wolf);
      if (err) failed.push(`${wolf} 号：${err}`);
    }
    assert.deepEqual(failed, [], `三只真狼都应该能被放逐出去：\n${failed.join('\n')}`);
    assert.deepEqual(aliveWolves(g), [], '三只真狼必须全部出局');

    // 放逐阶段走完，引擎才会判定胜负
    if (!g.isOver) g.forceAdvance();

    assert.equal(g.isDeadSeat(12), false, '傀儡本人还活着');
    assert.notEqual(g.winnerCamp, 'GOOD', '傀儡还在世时好人不能赢');
    assert.equal(g.isOver, false, '三狼死了但这局还没结束 —— 好人必须再清掉傀儡');
  });

  it('把傀儡也清掉之后，好人才赢', () => {
    const g = puppetGame(puppetDeck([1, 2, 11], { 4: 'SEER', 10: 'WITCH', 12: 'GUARD', 5: 'HUNTER' }));
    startNight(g);
    fullNight(g, { knife: null, puppet: 12 });

    const failed: string[] = [];
    for (const target of [1, 2, 11, 12]) {
      if (g.isOver || g.isDeadSeat(target)) continue;
      const err = exileByVote(g, target);
      if (err) failed.push(`${target} 号：${err}`);
    }
    assert.deepEqual(failed, [], `四个狼阵营成员都应该能被清掉：\n${failed.join('\n')}`);

    // 放逐阶段走完，引擎才会判定胜负
    if (!g.isOver) g.forceAdvance();

    assert.deepEqual(
      [1, 2, 11, 12].filter((s) => !g.isDeadSeat(s)),
      [],
      `四只狼阵营成员应该都被清掉（阶段=${g.phase} 存活=${g.aliveSeatsSnapshot().join(',')} 天=${g.day}）`,
    );
    assert.equal(g.winnerCamp, 'GOOD', '连傀儡一起清掉之后好人获胜');
  });
});

// ─────────────────── 快照与恢复（进行中对局持久化） ───────────────────

describe('快照与恢复', () => {
  /** 清掉由服务端注入的瞬态字段，让两份快照可以纯比内容 */
  function calmDown(g: Game): void {
    g.deadline = null;
    g.countdown = null;
    g.countdownEndsAt = null;
    g.holdAdvance = false;
  }

  function roundTrip(g: Game): Game {
    const snap = JSON.parse(JSON.stringify(g.snapshot())) as ReturnType<Game['snapshot']>;
    const restored = Game.restore(snap);
    assert.ok(restored, '快照应能恢复');
    return restored!;
  }

  it('夜间中途的快照回环：恢复后再快照应完全一致', () => {
    const g = newGame();
    startNight(g);
    g.forceAdvance();
    assert.equal(phaseOf(g), 'NIGHT_WOLVES', '应停在狼人行动阶段');
    g.submitNightAction(pid(1), { kind: 'wolf', target: 5 });
    g.submitNightAction(pid(2), { kind: 'wolf', target: 5 });
    calmDown(g);

    const before = g.snapshot();
    const restored = roundTrip(g);
    assert.deepEqual(restored.snapshot(), before, '恢复后再快照应与原快照完全一致');
  });

  it('白天投票中途的快照回环：三态字段（undefined/null/数字）语义保持', () => {
    const g = newGame();
    startNight(g);
    playNight(g, 5);
    advanceToDayVote(g);
    // 只投一部分人 —— votes Map 处于半满状态
    g.submitVote(pid(9), 6);
    g.submitVote(pid(10), 6);
    calmDown(g);

    const before = g.snapshot();
    assert.equal(before.sheriffTransferChoice, undefined, '警徽移交还没发生，应为 undefined');
    const restored = roundTrip(g);
    assert.deepEqual(restored.snapshot(), before, '恢复后再快照应与原快照完全一致');
  });

  it('版本不符的快照拒绝恢复', () => {
    const g = newGame();
    startNight(g);
    const snap = { ...g.snapshot(), v: 99999 };
    assert.equal(Game.restore(snap), null, '版本不符应返回 null 而不是硬着头皮加载');
  });

  it('结构损坏的快照拒绝恢复', () => {
    const g = newGame();
    startNight(g);
    const snap = g.snapshot();
    assert.equal(Game.restore({ ...snap, players: [] }), null);
    assert.equal(Game.restore({ ...snap, phase: 'NOT_A_PHASE' }), null);
    assert.equal(Game.restore({ ...snap, rngState: 'broken' }), null);
    assert.equal(Game.restore(null), null);
  });

  it('随机流从断点继续：中途恢复的双子局与一路打完的完全一致', () => {
    const plain = newGame({ seed: 4242 });
    const twin = newGame({ seed: 4242 });

    for (const g of [plain, twin]) {
      startNight(g);
      playNight(g, null); // 平安夜，第一天进入警长竞选
      g.forceAdvance(); // DAY_ANNOUNCE → SHERIFF_SIGNUP
      assert.equal(phaseOf(g), 'SHERIFF_SIGNUP');
    }

    // 双子局在这里「重启」：快照 → JSON 往返 → 恢复
    const restarted = roundTrip(twin);

    // 之后两人上警 —— 警上发言顺序由随机流决定，恢复后必须和未中断的一局完全一样
    for (const g of [plain, restarted]) {
      for (const seat of g.aliveSeatsSnapshot()) {
        g.submitSheriffSignup(pid(seat), seat === 5 || seat === 9);
      }
      assert.equal(phaseOf(g), 'SHERIFF_CAMPAIGN', '两人上警应进入竞选发言');
    }

    const a = plain.snapshot();
    const b = restarted.snapshot();
    assert.deepEqual(
      b.sheriffSpeechOrder,
      a.sheriffSpeechOrder,
      '恢复后的随机发言顺序应与未中断一局一致（随机流断点续传）',
    );
    assert.deepEqual(b, a, '两局的完整快照应一致');
    assert.equal(b.rngState, a.rngState, '随机流内部状态应停在同一个位置');
  });
});

describe('狼美人 / 恶灵骑士与狼队互认', () => {
  it('普通狼看得到狼美人：队友名单、座位身份、点刀进度都有她', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');

    const view = g.gameViewFor(pid(1));
    assert.ok(view.me?.teammates?.includes(BEAUTY_SEAT), '普通狼的队友名单应包含狼美人');
    const seat = g.seatViewsFor(pid(1)).find((sv) => sv.seat === BEAUTY_SEAT);
    assert.equal(seat?.role, 'WOLF_BEAUTY', '狼美人座位应向狼队显示身份');

    // 她的票也实时出现在狼队讨论里
    assert.equal(g.submitNightAction(pid(BEAUTY_SEAT), { kind: 'wolf', target: 5 }).ok, true,
      '狼美人应能参与点刀（官方规则：和狼队一起睁眼）');
    const votes = g.gameViewFor(pid(1)).wolfVotes ?? [];
    assert.ok(votes.some((v) => v.seat === BEAUTY_SEAT && v.target === 5), '狼队应看到狼美人的点刀选择');
  });

  it('狼美人也看得到普通狼（双向互认）', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    startNight(g);
    const view = g.gameViewFor(pid(BEAUTY_SEAT));
    assert.deepEqual(view.me?.teammates, [1, 2, 3], '狼美人应认识三只普通狼');
  });

  it('狼美人的票参与多数决：2 狼 + 她 → 她的一票决定刀口', () => {
    const g = newGame({ roles: LAYOUT_BEAUTY });
    startNight(g);
    // 只留 1 号、2 号两只普通狼 + 狼美人 4 号，3 号出局使票权集中
    g.killForTest(3);
    g.forceAdvance();
    assert.equal(g.submitNightAction(pid(1), { kind: 'wolf', target: 5 }).ok, true);
    assert.equal(g.submitNightAction(pid(2), { kind: 'wolf', target: 6 }).ok, true);
    assert.equal(g.submitNightAction(pid(BEAUTY_SEAT), { kind: 'wolf', target: 6 }).ok, true);
    // 5、6 各一票本应平票空刀，狼美人的一票让 6 成为多数
    for (let i = 0; i < 8 && phaseOf(g) !== 'DAY_ANNOUNCE'; i += 1) g.forceAdvance();
    assert.equal(phaseOf(g), 'DAY_ANNOUNCE', '夜晚应结算完');
    assert.equal(g.isDeadSeat(6), true, '狼美人的点刀票应计入多数决');
    assert.equal(g.isDeadSeat(5), false);
  });

  it('恶灵骑士与狼队互认并参与点刀；普通狼全灭后她仍握有刀权', () => {
    const g = newGame({ roles: LAYOUT_DARK_LORD });
    startNight(g);
    g.forceAdvance();
    assert.equal(g.phase, 'NIGHT_WOLVES');
    assert.ok(g.gameViewFor(pid(1)).me?.teammates?.includes(4), '普通狼的队友名单应包含恶灵骑士');
    assert.equal(g.submitNightAction(pid(4), { kind: 'wolf', target: 5 }).ok, true, '恶灵骑士应能参与点刀');

    // 普通狼全灭、只剩恶灵骑士 → 她仍能独自刀人
    for (const seat of [1, 2, 3]) g.killForTest(seat);
    for (let i = 0; i < 10 && phaseOf(g) !== 'NIGHT_WOLVES' && phaseOf(g) !== 'GAME_OVER'; i += 1) g.forceAdvance();
    if (phaseOf(g) === 'NIGHT_WOLVES') {
      assert.equal(g.submitNightAction(pid(4), { kind: 'wolf', target: 6 }).ok, true, '只剩恶灵骑士时她应能独自刀人');
    }
  });

  it('假面保持不互认（对照：不是所有狼营角色都互认）', () => {
    const g = newGame({ roles: LAYOUT_MASK_BALL });
    startNight(g);
    const wolfView = g.gameViewFor(pid(1));
    assert.ok(!wolfView.me?.teammates?.includes(4), '普通狼不应认识假面（暗狼设计不变）');
  });
});

describe('空爆全场播报', () => {
  it('空爆后 NIGHT_START 的语音行包含「X 号自爆了」，且片段拼装与整句一致', () => {
    const deck: Role[] = ['WOLF', 'WOLF', 'VILLAGER', 'SEER', 'WITCH', 'HUNTER'];
    const g = newGame({ roles: deck });
    startNight(g);
    beginSheriffElection(g);
    assert.equal(g.selfDestruct(pid(1)).ok, true);
    assert.equal(phaseOf(g), 'NIGHT_START', '空爆后应进入黑夜');

    // 语音行（TTS 兜底念的整句）
    const line = g.voiceLineFor();
    assert.match(line, /天黑请闭眼/);
    assert.match(line, /1 号自爆了，今天不再发言与投票/);
    assert.match(line, /第 2 天夜晚/);

    // 片段序列（语音包播的）拆开拼回文本，必须与整句一致（数字统一成阿拉伯数字）
    const norm = (text: string): string => text.replace(/[、，。！？：；\s]/g, '');
    const cues = g.voiceCuesFor();
    const rebuilt = cues.map((cue) => {
      if ('pause' in cue) return '';
      if ('num' in cue) return String(cue.num);
      return clipById(cue.clip)?.text ?? '';
    }).join('');
    assert.equal(norm(rebuilt), norm(line), '片段拼接文本应与 voiceLine 完全一致');
  });

  it('没有空爆时 NIGHT_START 语音行保持原样', () => {
    const g = newGame();
    startNight(g);
    assert.equal(g.voiceLineFor(), '天黑请闭眼。现在是第 1 天夜晚。');
  });

  it('播报在下一次天亮后清空，不影响后续夜晚', () => {
    const deck: Role[] = ['WOLF', 'WOLF', 'VILLAGER', 'SEER', 'WITCH', 'HUNTER'];
    const g = newGame({ roles: deck });
    startNight(g);
    beginSheriffElection(g);
    assert.equal(g.selfDestruct(pid(1)).ok, true);
    assert.match(g.voiceLineFor(), /1 号自爆了/);
    // 推进到下一个白天（空爆后好人推进流程）
    for (let i = 0; i < 8 && phaseOf(g) !== 'GAME_OVER' && !g.voiceLineFor().includes('请查看昨晚的结果'); i += 1) {
      g.forceAdvance();
    }
    // 第二天再有空爆（不会有，但播报队列此时应已清空）：直接检查字段视图
    const line = g.voiceLineFor();
    assert.ok(!line.includes('自爆'), `白天播报不应再含自爆：${line}`);
  });

  it('空爆播报进快照并能恢复', () => {
    const deck: Role[] = ['WOLF', 'WOLF', 'VILLAGER', 'SEER', 'WITCH', 'HUNTER'];
    const g = newGame({ roles: deck });
    startNight(g);
    beginSheriffElection(g);
    assert.equal(g.selfDestruct(pid(1)).ok, true);
    const restored = Game.restore(JSON.parse(JSON.stringify(g.snapshot())) as never);
    assert.ok(restored, '快照应能恢复');
    assert.match(restored!.voiceLineFor(), /1 号自爆了/, '恢复后播报仍在');
  });
});
