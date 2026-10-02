/**
 * 12 宫格座位盘。
 * 大厅和游戏中共用：座位号、昵称、生死、身份标签、可选中态都在这里统一渲染。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import { isWolfRole } from '../../../src/shared/roles.ts';
import { canPick, pickSeat, state } from '../store.ts';

export const SeatGrid = defineComponent({
  name: 'SeatGrid',
  props: {
    /** 对局中只有身份牌点开时才允许显示自己/狼队友等私密身份。 */
    revealPrivateIdentity: { type: Boolean, default: true },
  },
  setup(props) {
    const seats = computed(() => {
      const room = state.room;
      if (!room) return [];
      const game = state.game;
      const iAmWolf = game?.me?.camp === 'WOLF';
      const options = game?.myOptions ?? [];

      return room.seats.map((s) => {
        const dead = game ? s.alive === false : false;
        const wolfmate =
          props.revealPrivateIdentity && iAmWolf && s.role !== undefined && isWolfRole(s.role) && !s.isMe;
        const pickable = canPick.value && options.includes(s.seat);
        const selected = state.selected === s.seat || state.selectedMany.includes(s.seat);
        const revealedIdiot = s.idiotRevealed === true;

        let tag = '';
        let tagClass = 'muted';
        if (s.role && props.revealPrivateIdentity) {
          tag = s.roleName ?? '';
          tagClass = isWolfRole(s.role) ? 'wolf' : 'good';
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
          isSheriff: s.isSheriff === true,
          isSheriffCandidate: game?.sheriffCandidates.includes(s.seat) === true,
        };
      });
    });

    /**
     * 座位数据来自「房间视图」（`state.room.seats`），不是游戏视图。
     *
     * 所以房间视图一丢，座位盘就会**整片变空** —— 而它以前是静默变空，
     * 看起来就像「所有玩家都不见了」，玩家完全不知道发生了什么。
     * 现在把这种情况显式暴露出来，并提示客户端去重新同步。
     */
    const seatsMissing = computed(() => state.room === null);
    const gameRunning = computed(() => state.game !== null);

    return { seats, seatsMissing, gameRunning, pickSeat, state };
  },
  template: `
    <div>
      <!-- 房间信息丢了但牌局还在：这不该是「12 个空位」这种看不懂的画面 -->
      <div v-if="seatsMissing && gameRunning" class="banner warn">
        正在重新同步房间信息…牌局还在，稍等一下；如果一直是这样，请刷新页面。
      </div>

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
            <span v-if="s.isSheriff" title="警长">🚨</span>
            <span v-else-if="s.isSheriffCandidate" title="警长候选人">👮</span>
            {{ s.occupied ? s.nickname : '空位' }}
            <template v-if="s.isMe">（我）</template>
          </span>
          <span v-if="s.tag" class="tag" :class="'badge ' + (s.tagClass === 'muted' ? '' : s.tagClass)">{{ s.tag }}</span>
          <span v-else-if="s.occupied && !s.online" class="tag badge warn">离线</span>
        </div>
      </div>
    </div>
  `,
});
