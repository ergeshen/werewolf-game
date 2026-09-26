/**
 * 房间大厅：房间号、邀请链接、12 个座位、准备 / 开局。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import { SeatGrid } from '../components/SeatGrid.ts';
import { copyInvite, isHost, leaveRoom, mySeat, startGame, state, toggleReady } from '../store.ts';

export const LobbyView = defineComponent({
  name: 'LobbyView',
  components: { SeatGrid },
  setup() {
    const room = computed(() => state.room);

    const filled = computed(() => state.room?.playerCount ?? 0);
    const allReady = computed(() => {
      const seats = state.room?.seats ?? [];
      const occupied = seats.filter((s) => s.occupied);
      if (occupied.length < 12) return false;
      // 房主不需要点准备
      return occupied.every((s) => s.ready || s.isHost);
    });

    const readyLabel = computed(() => (mySeat.value?.ready ? '取消准备' : '我准备好了'));
    const canStart = computed(() => isHost.value && filled.value === 12);

    return {
      room,
      filled,
      allReady,
      readyLabel,
      canStart,
      isHost,
      mySeat,
      state,
      toggleReady,
      startGame,
      leaveRoom,
      copyInvite,
    };
  },
  template: `
    <div v-if="room">
      <div class="panel center">
        <div class="muted small">房间号（念给朋友听）</div>
        <div class="mono" style="font-size: 34px; font-weight: 700; letter-spacing: 8px; margin: 4px 0 10px;">
          {{ room.roomId }}
        </div>
        <div class="row" style="gap: 8px;">
          <button class="sm grow" @click="copyInvite">复制邀请链接</button>
          <button class="sm ghost" @click="leaveRoom">离开</button>
        </div>
        <div class="spacer"></div>
        <div class="tiny muted">
          把链接发到微信群，朋友点开就能直接进入本房间。
        </div>
      </div>

      <div class="panel">
        <div class="row-between">
          <h2 style="margin: 0;">座位</h2>
          <span class="badge" :class="filled === 12 ? 'good' : 'accent'">{{ filled }} / 12 人</span>
        </div>
        <div class="spacer"></div>
        <SeatGrid />
        <div class="spacer"></div>
        <div v-if="filled < 12" class="small muted">
          还差 {{ 12 - filled }} 个人。人数满 12 人后房主才能开始游戏。
        </div>
        <div v-else-if="!allReady" class="small muted">
          人已经齐了，等大家点「我准备好了」。
        </div>
        <div v-else class="small" style="color: var(--good);">
          全员到齐，房主可以开局了。
        </div>
      </div>

      <div class="panel">
        <button v-if="!isHost" :class="readyLabel === '取消准备' ? '' : 'primary'" @click="toggleReady">
          {{ readyLabel }}
        </button>
        <button v-else class="primary" :disabled="!canStart" @click="startGame">
          {{ filled === 12 ? '开始游戏（发牌）' : '还差 ' + (12 - filled) + ' 人' }}
        </button>
        <div v-if="isHost" class="spacer"></div>
        <div v-if="isHost" class="tiny muted center">
          你点击开始后，系统会给 12 个人随机发牌。
        </div>
      </div>
    </div>
  `,
});
