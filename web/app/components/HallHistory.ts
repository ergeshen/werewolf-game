import { computed, defineComponent, ref } from '../../vendor/vue.esm-browser.prod.js';

import { DEATH_CAUSE_LABEL } from '../../../src/shared/protocol.ts';
import { ROLE_NAME } from '../../../src/shared/roles.ts';
import {
  askConfirm,
  closeHallHistory,
  deleteHallMatch,
  refreshHallDashboard,
  revealHallScores,
  state,
  type HallMatchView,
} from '../store.ts';

export const HallHistory = defineComponent({
  name: 'HallHistory',
  props: {
    closable: { type: Boolean, default: false },
    section: { type: String, default: 'all' },
  },
  setup() {
    const sortKey = ref<'TOTAL' | 'GOOD' | 'WOLF' | 'HEX' | 'WINS' | 'ACCURACY'>('WINS');
    const canSeeAllScores = computed(() => Boolean(
      state.hallDashboard?.isOwner || state.hallDashboard?.scoresRevealed,
    ));
    const myStats = computed(() =>
      state.hallDashboard?.players.find((player) => player.userId === state.user?.id) ?? null,
    );
    const sortedPlayers = computed(() => {
      const players = [...(state.hallDashboard?.players ?? [])];
      return players.sort((a, b) => {
        if (sortKey.value === 'GOOD') return (b.goodScore ?? -1) - (a.goodScore ?? -1) || (b.score ?? -1) - (a.score ?? -1);
        if (sortKey.value === 'WOLF') return (b.wolfScore ?? -1) - (a.wolfScore ?? -1) || (b.score ?? -1) - (a.score ?? -1);
        if (sortKey.value === 'HEX') return (b.hexScore ?? -1) - (a.hexScore ?? -1) || b.hexWins - a.hexWins;
        if (sortKey.value === 'ACCURACY') {
          return Number(b.exileEligible) - Number(a.exileEligible) ||
            b.exileAccuracy - a.exileAccuracy || b.exileVotes - a.exileVotes || b.wins - a.wins;
        }
        if (sortKey.value === 'TOTAL') return (b.score ?? -1) - (a.score ?? -1) || b.wins - a.wins;
        return b.wins - a.wins || a.losses - b.losses;
      });
    });

    function metricTitle(): string {
      if (sortKey.value === 'GOOD') return '好人积分';
      if (sortKey.value === 'WOLF') return '狼人积分';
      if (sortKey.value === 'HEX') return '海克斯积分';
      if (sortKey.value === 'ACCURACY') return '投狼准确率';
      if (sortKey.value === 'WINS') return '普通胜场';
      return '总积分';
    }

    function metricValue(player: (typeof sortedPlayers.value)[number]): string {
      if (sortKey.value === 'GOOD') return String(player.goodScore);
      if (sortKey.value === 'WOLF') return String(player.wolfScore);
      if (sortKey.value === 'HEX') return String(player.hexScore ?? '未公开');
      if (sortKey.value === 'ACCURACY') {
        if (player.exileVotes === 0) return '暂无投票';
        const base = `${player.exileCorrect}/${player.exileVotes} · ${player.exileAccuracy}%`;
        return player.exileEligible ? base : `${base}（样本不足）`;
      }
      if (sortKey.value === 'WINS') return String(player.wins);
      return player.score === undefined ? '仅本人可见' : String(player.score);
    }
    function matchResult(match: HallMatchView): string {
      if (match.status === 'ABORTED') return '提前结束 · 不计分';
      if (match.outcome === 'WOLF') return '狼人阵营胜利';
      if (match.outcome === 'GOOD') return '好人阵营胜利';
      return '流局 · 不计分';
    }

    function seatLabel(match: HallMatchView, seat: number | null): string {
      if (seat === null) return '空过';
      const player = match.players.find((entry) => entry.seat === seat);
      return `${seat}号${player ? `（${player.nickname}）` : ''}`;
    }

    function wolfVotes(match: HallMatchView, votes: Array<{ voter: number; target: number | null }>): string {
      if (votes.length === 0) return '无人提交';
      return votes.map((vote) => `${seatLabel(match, vote.voter)} → ${seatLabel(match, vote.target)}`).join('；');
    }

    function roleName(role: keyof typeof ROLE_NAME | null): string {
      return role ? ROLE_NAME[role] : '未查验';
    }

    function removeMatch(match: HallMatchView): void {
      const hall = state.hallDashboard;
      if (!hall?.isOwner) return;
      askConfirm(
        {
          title: `删除第 ${match.displayNumber} 场`,
          message: '该场会从所有玩家的历史中消失，胜负、身份次数、积分和排名都会重新计算。确定删除吗？',
          confirmText: '确认删除',
          cancelText: '取消',
          danger: true,
        },
        (ok) => {
          if (ok) void deleteHallMatch(match.id, hall.roomId);
        },
      );
    }

    function toggleReplay(matchId: string): void {
      state.hallSelectedMatchId = state.hallSelectedMatchId === matchId ? null : matchId;
    }

    return {
      state,
      sortKey,
      sortedPlayers,
      canSeeAllScores,
      myStats,
      metricTitle,
      metricValue,
      matchResult,
      seatLabel,
      wolfVotes,
      roleName,
      removeMatch,
      toggleReplay,
      closeHallHistory,
      refreshHallDashboard,
      revealHallScores,
      DEATH_CAUSE_LABEL,
    };
  },
  template: `
    <template v-if="state.hallDashboard">
      <div v-if="section !== 'matches'" id="hall-history" class="panel">
        <div class="row-between">
          <div>
            <h2 style="margin: 0;">大厅总信息与积分</h2>
            <div class="tiny muted mono">大厅号 {{ state.hallDashboard.roomId }}</div>
          </div>
          <div class="row" style="gap: 6px;">
            <button class="sm ghost" :disabled="state.hallLoading" @click="refreshHallDashboard(state.hallDashboard.roomId)">
              {{ state.hallLoading ? '刷新中…' : '刷新' }}
            </button>
            <button
              v-if="state.hallDashboard.isOwner && !state.hallDashboard.scoresRevealed"
              class="sm primary"
              @click="revealHallScores(state.hallDashboard.roomId)"
            >公开最终积分</button>
            <button v-if="closable" class="sm ghost" @click="closeHallHistory">关闭</button>
          </div>
        </div>
        <div class="spacer"></div>
        <label class="small">
          排序方式
          <select v-model="sortKey" style="margin-left: 8px; width: auto;">
            <option value="WINS">普通胜场</option>
            <option v-if="canSeeAllScores" value="TOTAL">总积分</option>
            <option v-if="canSeeAllScores" value="GOOD">好人积分</option>
            <option v-if="canSeeAllScores" value="WOLF">狼人积分</option>
            <option v-if="canSeeAllScores" value="HEX">海克斯积分</option>
            <option value="ACCURACY">投狼准确率</option>
          </select>
        </label>
        <div v-if="!canSeeAllScores" class="tiny muted" style="margin-top: 6px;">
          对局期间只显示胜负和身份统计；你自己的积分仍会私下显示。厅主公开最终积分后，所有人才会看到完整排名。
        </div>
        <div v-if="!canSeeAllScores && myStats?.score !== undefined" class="banner accent small" style="margin-top: 8px;">
          你的普通积分：<b>{{ myStats.score }}</b>
          <template v-if="myStats.rank !== undefined"> · 当前私密排名第 {{ myStats.rank }} 名</template>
          <template v-if="myStats.hexWins + myStats.hexLosses > 0"> · 海克斯积分 {{ myStats.hexScore }}</template>
        </div>
        <div class="tiny muted" style="margin-top: 6px;">投狼准确率只计算正式白天放逐票；至少 3 次有效投票才进入正式排序。本次更新前的旧场次没有完整票型，不参与该项统计。</div>
        <div class="spacer"></div>
        <div v-if="state.hallDashboard.players.length === 0" class="small muted center" style="padding: 10px 0;">
          还没有计入统计的已完成场次。
        </div>
        <table v-else class="reveal hall-score-table">
          <thead><tr>
            <th class="tiny muted">排名</th>
            <th class="tiny muted">玩家</th><th class="tiny muted">胜 / 负</th>
            <th class="tiny muted">狼 / 神 / 民</th>
            <th class="tiny muted">{{ metricTitle() }}</th>
          </tr></thead>
          <tbody><tr v-for="(player, index) in sortedPlayers" :key="player.userId || player.nickname">
            <td class="mono">{{ index + 1 }}</td>
            <td class="ellipsis"><b>{{ player.nickname }}</b></td>
            <td class="tiny">
              {{ player.wins }} / {{ player.losses }}
              <span v-if="player.hexWins + player.hexLosses > 0" class="muted"> · 海克斯 {{ player.hexWins }}/{{ player.hexLosses }}</span>
            </td>
            <td class="tiny">{{ player.wolfCount }} / {{ player.godCount }} / {{ player.villagerCount }}</td>
            <td class="tiny mono"><b>{{ metricValue(player) }}</b></td>
          </tr></tbody>
        </table>
      </div>

      <div v-if="section !== 'scores'" class="panel">
        <h2>场次回顾</h2>
        <div v-if="state.hallDashboard.matches.length === 0" class="small muted center" style="padding: 10px 0;">
          还没有已保存的场次。
        </div>
        <div
          v-for="match in state.hallDashboard.matches"
          :id="'hall-match-' + match.id"
          :key="match.id"
          class="hall-match-card"
        >
          <div class="row-between" style="align-items: flex-start;">
            <div class="grow">
              <div><b>第 {{ match.displayNumber }} 场</b> · {{ matchResult(match) }} <span v-if="match.mode === 'HEX_CHAOS'" class="badge accent">海克斯</span></div>
              <div class="tiny muted">{{ match.boardSummary }} · 结束于第 {{ match.day || 1 }} 天</div>
            </div>
            <div class="row" style="gap: 6px;">
              <button class="sm ghost" @click="toggleReplay(match.id)">
                {{ state.hallSelectedMatchId === match.id ? '收起' : '查看本场' }}
              </button>
              <button v-if="state.hallDashboard.isOwner" class="sm danger" @click="removeMatch(match)">删除</button>
            </div>
          </div>
          <table v-if="state.hallSelectedMatchId === match.id" class="reveal" style="margin-top: 8px;">
            <tr v-for="player in match.players" :key="player.seat">
              <td class="mono" style="width: 38px;">{{ player.seat }}</td>
              <td class="ellipsis">{{ player.nickname }}</td>
              <td style="width: 86px;"><span class="badge" :class="player.camp === 'WOLF' ? 'wolf' : 'good'">
                {{ player.roleName }}<template v-if="player.fakeSeer"> · 悍跳</template>
              </span></td>
              <td class="tiny muted" style="width: 56px;">{{ match.status === 'ABORTED' ? '未计分' : player.won ? '胜' : '负' }}</td>
              <td v-if="player.score !== undefined" class="tiny mono" style="width: 48px;">+{{ player.score }}</td>
            </tr>
          </table>

          <div v-if="state.hallSelectedMatchId === match.id" style="margin-top: 8px;">
            <div v-if="!match.replay" class="banner warn small">
              这场没有逐夜记录：可能是在本次更新前保存，或你不是该场参赛者。最终角色和胜负仍可查看。
            </div>
            <template v-else>
              <div v-if="match.replay.nights.length === 0" class="small muted">本场在第一夜结算前结束，没有完整夜晚。</div>
              <div v-for="night in match.replay.nights" :key="night.day" class="panel tight" style="margin: 8px 0 0;">
                <b>第 {{ night.day }} 夜</b>
                <div class="tiny" style="margin-top: 5px;"><b>狼队选择：</b>{{ wolfVotes(match, night.wolfVotes) }}</div>
                <div class="tiny"><b>最终刀口：</b>{{ seatLabel(match, night.wolfTarget) }}</div>
                <div v-if="night.guardTarget !== null" class="tiny"><b>守卫：</b>守护 {{ seatLabel(match, night.guardTarget) }}</div>
                <div v-if="night.mechanicalGuardTarget !== null" class="tiny"><b>机械守卫：</b>守护 {{ seatLabel(match, night.mechanicalGuardTarget) }}</div>
                <div v-if="night.witchActed" class="tiny"><b>女巫：</b>{{ night.witchSave ? '使用解药' : '未救人' }}；{{ night.witchPoison === null ? '未用毒' : '毒了 ' + seatLabel(match, night.witchPoison) }}</div>
                <div v-if="night.seerTarget !== null" class="tiny"><b>预言家：</b>查验 {{ seatLabel(match, night.seerTarget) }}，结果 {{ night.seerCamp === 'WOLF' ? '狼人' : '好人' }}</div>
                <div v-if="night.mechanicalSeerTarget !== null" class="tiny"><b>机械预言家：</b>查验 {{ seatLabel(match, night.mechanicalSeerTarget) }}，结果 {{ night.mechanicalSeerCamp === 'WOLF' ? '狼人' : '好人' }}</div>
                <div v-if="night.spiritTarget !== null" class="tiny"><b>通灵师：</b>查验 {{ seatLabel(match, night.spiritTarget) }}，身份 {{ roleName(night.spiritRole) }}</div>
                <div v-if="night.mechanicalSpiritTarget !== null" class="tiny"><b>机械通灵师：</b>查验 {{ seatLabel(match, night.mechanicalSpiritTarget) }}，身份 {{ roleName(night.mechanicalSpiritRole) }}</div>
                <div v-if="night.dancerTargets.length" class="tiny"><b>舞池：</b>{{ night.dancerTargets.map(seat => seatLabel(match, seat)).join('、') }}</div>
                <div v-if="night.maskInspectTarget !== null" class="tiny"><b>假面查验：</b>{{ seatLabel(match, night.maskInspectTarget) }}{{ night.maskInspectResult ? '在舞池' : '不在舞池' }}；面具给 {{ seatLabel(match, night.maskTarget) }}</div>
                <div v-if="night.dreamerTarget !== null" class="tiny"><b>摄梦人：</b>{{ seatLabel(match, night.dreamerTarget) }} 成为梦游者</div>
                <div class="tiny"><b>夜间死亡：</b><template v-if="night.deaths.length === 0">平安夜</template><template v-else>{{ night.deaths.map(death => seatLabel(match, death.seat) + '（' + DEATH_CAUSE_LABEL[death.cause] + '）').join('、') }}</template></div>
              </div>
              <details style="margin-top: 8px;">
                <summary class="small">查看完整裁判日志</summary>
                <div v-for="(event, index) in match.replay.publicEvents" :key="'p' + index" class="tiny muted">{{ event }}</div>
                <div v-for="(event, index) in match.replay.secretEvents" :key="'s' + index" class="tiny muted">{{ event }}</div>
              </details>
            </template>
          </div>
        </div>
      </div>
    </template>
    <div v-else-if="state.hallLoading" class="panel center small muted">正在读取大厅记录…</div>
  `,
});
