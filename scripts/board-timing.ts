/**
 * 打印每个版型的「夜间总时长」。
 *
 * 为什么需要它：这个项目有一条铁律 —— **夜间每个阶段固定走完、绝不跳过**
 * （任何"因为某角色死了就省略"都会让时长携带信息）。代价是每加一个
 * **有夜间行动**的角色，所有人的夜晚就变长一截。
 *
 * 所以每次想加新角色时，先跑这个看看时长：被动型角色（不睁眼）不占夜间时段，
 * 加多少都不影响时长；有夜间行动的角色每加一个就是 +30~45 秒。
 *
 * 用法：npm run timing
 */
import { PHASE_TIMEOUT_MS } from '../src/shared/engine.ts';
import { NIGHT_PHASE_BY_ROLE } from '../src/shared/protocol.ts';
import { BOARD_PRESETS, ROLE_NAME, nightPlan } from '../src/shared/roles.ts';

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

function nightLength(roles: readonly string[]): number {
  const actions = roles.reduce((sum, role) => {
    const phase = NIGHT_PHASE_BY_ROLE[role as keyof typeof NIGHT_PHASE_BY_ROLE];
    return sum + (phase ? PHASE_TIMEOUT_MS[phase] : 0);
  }, 0);
  return actions + PHASE_TIMEOUT_MS.NIGHT_START + PHASE_TIMEOUT_MS.NIGHT_RESOLVE;
}

const rows = BOARD_PRESETS.map((preset) => {
  const plan = nightPlan(preset.board);
  return {
    id: preset.id,
    name: preset.name,
    first: nightLength(plan.firstNight),
    later: nightLength(plan.laterNights),
    nightRoles: plan.firstNight,
  };
}).sort((a, b) => b.first - a.first);

console.log('=== 各版型的夜间总时长（越短越轻松）===\n');
for (const row of rows) {
  console.log(`  ${row.name.padEnd(22)} 第一夜 ${fmt(row.first).padStart(7)}   之后每夜 ${fmt(row.later).padStart(7)}`);
  const names = row.nightRoles.map((r) => ROLE_NAME[r as keyof typeof ROLE_NAME]).join(' → ');
  console.log(`     夜间角色：${names || '（无）'}`);
}

console.log(`\n最长：${rows[0]?.name ?? '-'} ${fmt(rows[0]?.first ?? 0)}`);

console.log('\n=== 加角色时会增加多少（有夜间行动的角色）===\n');
const seen = new Set<string>();
for (const preset of BOARD_PRESETS) {
  for (const role of nightPlan(preset.board).firstNight) {
    if (seen.has(role)) continue;
    seen.add(role);
    const phase = NIGHT_PHASE_BY_ROLE[role as keyof typeof NIGHT_PHASE_BY_ROLE];
    const ms = phase ? PHASE_TIMEOUT_MS[phase] : 0;
    console.log(`  ${ROLE_NAME[role as keyof typeof ROLE_NAME].padEnd(10)} +${fmt(ms).padStart(7)}`);
  }
}

console.log('\n提示：被动型角色（石像鬼、熊、锈剑骑士、狼兄狼弟……）不睁眼，');
console.log('      不进夜间时段，加它们不会让夜晚变长。');
