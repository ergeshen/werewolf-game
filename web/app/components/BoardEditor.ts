/**
 * 版型配置（需求 1 的核心界面）
 *
 * 交互设计：
 * - 先定人数，再配角色。狼人和平民用 +/- 调数量，神职和白狼王用勾选。
 * - 实时显示「当前 X 人 / 目标 Y 人」，总数不对就把开局按钮锁住并说清差几个。
 * - 状态完全以**服务端回显的版型**为准，客户端不自己算账 ——
 *   这样「谁能开局」永远只有一套判定，不会出现界面说可以、服务端说不行。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import {
  BOARD_PRESETS,
  COUNTED_ROLES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROLE_CAMP,
  ROLE_DESC,
  ROLE_NAME,
  SINGLE_ROLES,
  boardTotal,
  type BoardConfig,
  type Role,
} from '../../../src/shared/roles.ts';

import { applyPresetBoard, boardView, isHost, setPlayerCount, setRoleCount, state } from '../store.ts';

interface RoleRow {
  role: Role;
  name: string;
  desc: string;
  camp: 'WOLF' | 'GOOD';
  count: number;
  single: boolean;
  /** 勾选类的角色：选中 = 1 */
  checked: boolean;
}

export const BoardEditor = defineComponent({
  name: 'BoardEditor',
  setup() {
    // 用 boardView（编辑期间是本地草稿），而不是 state.room.board ——
    // 否则快速连点会读到未更新的旧值
    const board = boardView;

    const wolfRows = computed<RoleRow[]>(() => buildRows(['WOLF', 'WOLF_KING', 'MECHANICAL_WOLF', 'MASK']));
    const villagerRows = computed<RoleRow[]>(() => buildRows(['VILLAGER', 'HYBRID']));
    const godRows = computed<RoleRow[]>(() =>
      buildRows(['SEER', 'SPIRIT_SEER', 'WITCH', 'HUNTER', 'IDIOT', 'GUARD', 'DANCER']),
    );

    function buildRows(roles: Role[]): RoleRow[] {
      const b = board.value;
      if (!b) return [];
      return roles.map((role) => {
        const count = b.roles[role] ?? 0;
        return {
          role,
          name: ROLE_NAME[role],
          desc: ROLE_DESC[role],
          camp: ROLE_CAMP[role],
          count,
          single: SINGLE_ROLES.includes(role),
          checked: count > 0,
        };
      });
    }

    const total = computed(() => (board.value ? boardTotal(board.value) : 0));
    const target = computed(() => board.value?.playerCount ?? 0);
    const diff = computed(() => target.value - total.value);

    /** 当前配置是否正好等于某个预设 */
    const activePresetId = computed(() => {
      const b = board.value;
      if (!b) return '';
      for (const preset of BOARD_PRESETS) {
        if (preset.board.playerCount !== b.playerCount) continue;
        const same = Object.keys(preset.board.roles).every(
          (key) => preset.board.roles[key as Role] === b.roles[key as Role],
        );
        if (same) return preset.id;
      }
      return '';
    });

    const canMinusCount = computed(() => target.value > MIN_PLAYERS);
    const canPlusCount = computed(() => target.value < MAX_PLAYERS);

    function changePlayerCount(delta: number): void {
      if (!isHost.value) return;
      setPlayerCount(target.value + delta);
    }

    /**
     * 增减某个角色的数量。
     *
     * 注意：**不能**用 row.count —— 那是渲染时的快照。
     * 套用预设之后 DOM 还没重渲染，row.count 仍是旧版型的数字，
     * 此时点一下「+」会基于旧值计算，表现出来就是「点一下跳了好几个」。
     * 所以每次都从当前草稿里重新取值。
     */
    function inc(row: RoleRow, delta: number): void {
      if (!isHost.value) return;
      const current = board.value?.roles[row.role] ?? 0;
      setRoleCount(row.role, Math.max(0, current + delta));
    }

    /** 勾选类的角色：同理，基于当前草稿而不是渲染快照 */
    function toggleSingle(row: RoleRow): void {
      if (!isHost.value) return;
      const current = board.value?.roles[row.role] ?? 0;
      setRoleCount(row.role, current > 0 ? 0 : 1);
    }

    function applyPreset(id: string): void {
      if (!isHost.value) return;
      const preset = BOARD_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      // 一次把整套版型发出去。分 9 次发会被后发的消息覆盖掉，等于白点。
      applyPresetBoard({ playerCount: preset.board.playerCount, roles: { ...preset.board.roles } });
    }

    return {
      state,
      isHost,
      board,
      wolfRows,
      villagerRows,
      godRows,
      total,
      target,
      diff,
      activePresetId,
      canMinusCount,
      canPlusCount,
      changePlayerCount,
      inc,
      toggleSingle,
      applyPreset,
      presets: BOARD_PRESETS,
      countedRoles: COUNTED_ROLES,
      MIN_PLAYERS,
      MAX_PLAYERS,
    };
  },
  template: `
    <div class="panel" v-if="board">
      <div class="row-between">
        <h2 style="margin: 0;">版型配置</h2>
        <span class="badge" :class="isHost ? 'accent' : ''">{{ isHost ? '房主可改' : '房主设定' }}</span>
      </div>

      <!-- 人数 -->
      <div class="spacer"></div>
      <div class="row-between">
        <span class="small">人数</span>
        <div class="row">
          <button class="sm" :disabled="!isHost || !canMinusCount" @click="changePlayerCount(-1)">−</button>
          <span class="mono" style="font-size: 22px; font-weight: 700; min-width: 44px; text-align: center;">
            {{ target }}
          </span>
          <button class="sm" :disabled="!isHost || !canPlusCount" @click="changePlayerCount(1)">+</button>
        </div>
      </div>
      <div class="tiny muted" style="margin-top: 4px;">
        可选范围 {{ MIN_PLAYERS }} - {{ MAX_PLAYERS }} 人
      </div>

      <!-- 预设 -->
      <template v-if="isHost">
        <div class="spacer"></div>
        <h3>快速套用预设</h3>
        <div class="row wrap" style="gap: 6px;">
          <button
            v-for="p in presets"
            :key="p.id"
            class="sm"
            :class="activePresetId === p.id ? 'primary' : ''"
            @click="applyPreset(p.id)"
          >{{ p.name }}</button>
        </div>
      </template>

      <!-- 狼营 -->
      <div class="spacer"></div>
      <h3>狼人阵营</h3>
      <div v-for="row in wolfRows" :key="row.role" class="role-config-row">
        <div class="grow">
          <div class="small" style="font-weight: 600;">{{ row.name }}</div>
          <div class="tiny muted">{{ row.desc }}</div>
        </div>
        <template v-if="row.single">
          <button
            class="sm"
            :class="row.checked ? 'danger' : ''"
            :disabled="!isHost"
            @click="toggleSingle(row)"
          >{{ row.checked ? '已选 1' : '不选' }}</button>
        </template>
        <template v-else>
          <button class="sm" :disabled="!isHost || row.count === 0" @click="inc(row, -1)">−</button>
          <span class="mono" style="min-width: 26px; text-align: center; font-weight: 700;">{{ row.count }}</span>
          <button class="sm" :disabled="!isHost" @click="inc(row, 1)">+</button>
        </template>
      </div>

      <!-- 平民 -->
      <div class="spacer"></div>
      <h3>平民</h3>
      <div v-for="row in villagerRows" :key="row.role" class="role-config-row">
        <div class="grow">
          <div class="small" style="font-weight: 600;">{{ row.name }}</div>
          <div class="tiny muted">{{ row.desc }}</div>
        </div>
        <button class="sm" :disabled="!isHost || row.count === 0" @click="inc(row, -1)">−</button>
        <span class="mono" style="min-width: 26px; text-align: center; font-weight: 700;">{{ row.count }}</span>
        <button class="sm" :disabled="!isHost" @click="inc(row, 1)">+</button>
      </div>

      <!-- 神职 -->
      <div class="spacer"></div>
      <h3>神职（每个最多 1 个）</h3>
      <div v-for="row in godRows" :key="row.role" class="role-config-row">
        <div class="grow">
          <div class="small" style="font-weight: 600;">{{ row.name }}</div>
          <div class="tiny muted">{{ row.desc }}</div>
        </div>
        <button
          class="sm"
          :class="row.checked ? 'good' : ''"
          :disabled="!isHost"
          @click="toggleSingle(row)"
        >{{ row.checked ? '已选' : '不选' }}</button>
      </div>

      <!-- 汇总 -->
      <div class="spacer"></div>
      <div class="banner" :class="diff === 0 ? 'good' : 'wolf'" style="margin-bottom: 0;">
        <div class="row-between">
          <span>角色总数 <b class="mono">{{ total }}</b> / 目标 <b class="mono">{{ target }}</b></span>
          <span v-if="diff === 0">刚好 ✓</span>
          <span v-else-if="diff > 0">还差 {{ diff }} 个</span>
          <span v-else>多了 {{ -diff }} 个</span>
        </div>
        <div class="spacer"></div>
        <div class="small">{{ state.room ? state.room.boardSummary : '' }}</div>
      </div>

      <!-- 服务端下发的校验结果 -->
      <template v-if="state.room && state.room.boardErrors.length">
        <div class="spacer"></div>
        <div v-for="(msg, i) in state.room.boardErrors" :key="i" class="banner wolf" style="margin-bottom: 6px;">
          ⚠ {{ msg }}
        </div>
      </template>
      <template v-if="state.room && state.room.boardWarnings.length">
        <div class="spacer"></div>
        <div v-for="(msg, i) in state.room.boardWarnings" :key="i" class="banner warn" style="margin-bottom: 6px;">
          {{ msg }}
        </div>
      </template>
    </div>
  `,
});
