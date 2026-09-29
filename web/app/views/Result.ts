/**
 * 结算界面：胜负 + 全场身份公开 + 复盘用的死亡原因。
 * 只在 GAME_OVER 阶段显示，此时服务端才会下发 revealAll。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import { askConfirm, closeMatch, isHost, leaveRoom, restartGame, state } from '../store.ts';

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
        when: d.day ? '第 ' + d.day + ' 天' : '—',
        cause: d.cause ? (DEATH_CAUSE_LABEL[d.cause] ?? d.cause) : '—',
      }));
    });

    const playerCapacity = computed(() => state.room?.board.playerCount ?? 0);

    /** 保存正常结算结果，返回同一个大厅开始下一场。 */
    function endMatch(): void {
      askConfirm(
        {
          title: '保存并返回大厅',
          message: `第 ${state.room?.matchNumber ?? '?'} 场结果会保存，所有 ${playerCapacity.value} 名玩家返回大厅，之后可发起下一场。`,
          confirmText: '保存并回大厅',
          cancelText: '再想想',
          danger: true,
        },
        (ok) => {
          if (ok) closeMatch();
        },
      );
    }

    function redeal(): void {
      askConfirm(
        {
          title: '本场作废并重新发牌',
          message: '刚结束的结果会被删除，不计胜负、身份次数和积分，并以同一个场次号立即重新发牌。',
          confirmText: '确认作废并重发',
          cancelText: '保留结果',
          danger: true,
        },
        (ok) => {
          if (ok) restartGame();
        },
      );
    }

    return {
      state,
      game,
      headline,
      headlineClass,
      myResult,
      rows,
      deathRows,
      playerCapacity,
      restartGame,
      redeal,
      endMatch,
      leaveRoom,
      isHost,
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
            <td class="tiny muted" style="width: 60px;">{{ d.when }}</td>
            <td class="tiny muted">{{ d.cause }}</td>
          </tr>
        </table>
      </div>

      <div class="panel">
        <template v-if="isHost">
          <button @click="redeal">本场作废并重新发牌</button>
          <div class="spacer"></div>
          <button class="primary" @click="endMatch">保存结果并返回大厅</button>
          <div class="spacer"></div>
          <div class="tiny muted center">
            重新发牌＝本场结果作废；返回大厅＝保存本场并准备第 {{ (state.room?.matchNumber || 0) + 1 }} 场。
          </div>
        </template>
        <template v-else>
          <button class="ghost" @click="leaveRoom">离开房间</button>
          <div class="spacer"></div>
          <div class="tiny muted center">等房主决定是重开还是结束本场。</div>
        </template>
      </div>
    </div>
  `,
});
