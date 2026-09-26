/**
 * 12 宫格座位盘。
 * 大厅和游戏中共用：座位号、昵称、生死、身份标签、可选中态都在这里统一渲染。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import { canPick, pickSeat, state } from '../store.ts';

export const SeatGrid = defineComponent({
  name: 'SeatGrid',
  setup() {
    const seats = computed(() => {
      const room = state.room;
      if (!room) return [];
      const game = state.game;
      const iAmWolf = game?.me?.camp === 'WOLF';
      const options = game?.myOptions ?? [];

      return room.seats.map((s) => {
        const dead = game ? s.alive === false : false;
        const wolfmate = iAmWolf && s.role === 'WOLF' && !s.isMe;
        const pickable = canPick.value && options.includes(s.seat);
        const selected = state.selected === s.seat;
        const revealedIdiot = s.idiotRevealed === true;

        let tag = '';
        let tagClass = 'muted';
        if (s.role) {
          tag = s.roleName ?? '';
          tagClass = s.role === 'WOLF' ? 'wolf' : 'good';
        } else if (revealedIdiot) {
          tag = '白痴·已翻牌';
          tagClass = 'gold';
        } else if (dead) {
          tag = '已出局';
        } else if (game) {
          tag = '';
        } else if (s.isHost) {
          tag = '房主';
        } else if (s.ready) {
          tag = '已准备';
          tagClass = 'good';
        } else if (s.occupied) {
          tag = '未准备';
        }

        return {
          seat: s.seat,
          occupied: s.occupied,
          nickname: s.nickname,
          isMe: s.isMe,
          isHost: s.isHost,
          online: s.online,
          dead,
          wolfmate,
          pickable,
          selected,
          tag,
          tagClass,
          revealedIdiot,
        };
      });
    });

    return { seats, pickSeat, state };
  },

  template: `
    <div class="seats">
      <div
        v-for="s in seats"
        :key="s.seat"
        class="seat"
        :class="{
          empty: !s.occupied,
          me: s.isMe,
          dead: s.dead,
          wolfmate: s.wolfmate,
          pickable: s.pickable,
          selected: s.selected,
          'idiot-revealed': s.revealedIdiot,
        }"
        @click="s.pickable && pickSeat(s.seat)"
      >
        <span class="no">{{ s.seat }}</span>
        <span class="name">
          {{ s.occupied ? s.nickname : '空位' }}
          <template v-if="s.isMe">（我）</template>
        </span>
        <span v-if="s.tag" class="tag" :class="'badge ' + (s.tagClass === 'muted' ? '' : s.tagClass)">{{ s.tag }}</span>
        <span v-else-if="s.occupied && !s.online" class="tag badge warn">离线</span>
      </div>
    </div>
  `,
});
