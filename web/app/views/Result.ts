/**
 * 结算界面：胜负 + 全场身份公开 + 复盘用的死亡原因。
 * 只在 GAME_OVER 阶段显示，此时服务端才会下发 revealAll。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import { isHost, leaveRoom, nicknameOf, restartGame, state } from '../store.ts';

const DEATH_CAUSE_LABEL: Record<string, string> = {
  WOLF: '被狼人杀害',
  POISON: '被女巫毒杀',
  VOTE: '被投票放逐',
  SHOOT: '被猎人带走',
};

export const ResultView = defineComponent({
  name: 'ResultView',
  setup() {
    const game = computed(() => state.game);

    const headline = computed(() => {
      const outcome = state.game?.outcome;
      if (outcome === 'WOLF') return '狼人阵营胜利';
      if (outcome === 'GOOD') return '好人阵营胜利';
      if (outcome === 'DRAW') return '本局流局';
      return '对局结束';
    });

    const headlineClass = computed(() => {
      const outcome = state.game?.outcome;
      if (outcome === 'WOLF') return 'wolf';
      if (outcome === 'GOOD') return 'good';
      return '';
    });

    const myResult = computed(() => {
      const g = state.game;
      if (!g || !g.me) return '';
      const outcome = g.outcome;
      if (outcome === 'DRAW' || outcome === null) return '本局没有赢家。';
      const won = g.me.camp === outcome;
      return won ? '你是胜利方 🎉' : '你是失败方，下局再来。';
    });

    const rows = computed(() => {
      const reveal = state.game?.revealAll ?? [];
      return reveal.map((r) => ({
        ...r,
        cause: '',
      }));
    });

    const deathRows = computed(() => {
      const deaths = state.game?.deaths ?? [];
      return deaths.map((d) => ({
        seat: d.seat,
        nickname: d.nickname,
        cause: d.cause ? (DEATH_CAUSE_LABEL[d.cause] ?? d.cause) : '—',
      }));
    });

    return {
      state,
      game,
      headline,
      headlineClass,
      myResult,
      rows,
      deathRows,
      restartGame,
      leaveRoom,
      isHost,
      nicknameOf,
    };
  },
  template: `
    <div v-if="game">
      <div class="banner" :class="headlineClass" style="font-size: 18px; font-weight: 700; text-align: center; padding: 16px;">
        {{ headline }}
      </div>

      <div class="panel center">
        <div class="small muted">你的身份</div>
        <div style="font-size: 20px; font-weight: 700; margin: 4px 0;">
          {{ game.me ? game.me.roleName : '—' }}
          <span class="muted small">（{{ game.me ? game.me.seat : '-' }} 号）</span>
        </div>
        <div class="small">{{ myResult }}</div>
      </div>

      <div class="panel">
        <h3>全场身份</h3>
        <table class="reveal">
          <tr v-for="r in rows" :key="r.seat">
            <td class="mono" style="width: 42px;">{{ r.seat }}</td>
            <td class="ellipsis">{{ r.nickname }}</td>
            <td style="width: 78px;">
              <span class="badge" :class="r.camp === 'WOLF' ? 'wolf' : 'good'">{{ r.roleName }}</span>
            </td>
            <td style="width: 54px;" class="tiny muted">{{ r.alive ? '存活' : '出局' }}</td>
          </tr>
        </table>
      </div>

      <div v-if="deathRows.length" class="panel">
        <h3>死亡复盘</h3>
        <table class="reveal">
          <tr v-for="d in deathRows" :key="d.seat">
            <td class="mono" style="width: 42px;">{{ d.seat }}</td>
            <td class="ellipsis">{{ d.nickname }}</td>
            <td class="tiny muted">{{ d.cause }}</td>
          </tr>
        </table>
      </div>

      <div class="panel">
        <button v-if="isHost" class="primary" @click="restartGame">再来一局（重新发牌）</button>
        <div v-if="isHost" class="spacer"></div>
        <button class="ghost" @click="leaveRoom">离开房间</button>
        <div v-if="!isHost" class="spacer"></div>
        <div v-if="!isHost" class="tiny muted center">等房主开下一局。</div>
      </div>
    </div>
  `,
});
