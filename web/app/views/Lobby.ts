/**
 * 房间大厅（需求 2 的「就绪界面」）
 *
 * 房主在这里做三件事：配版型、看谁还没就绪、开局。
 * 所有人都在这里决定要不要打开自己手机的语音播报。
 *
 * 开局条件（由服务端判定，界面只是把原因显示出来）：
 *   ① 版型自洽（角色总数 == 人数）
 *   ② 座位坐满
 *   ③ 除房主外所有人都点了「我准备好了」
 */

import {
  computed,
  defineComponent,
  onMounted,
  onUnmounted,
} from '../../vendor/vue.esm-browser.prod.js';

import { BoardEditor } from '../components/BoardEditor.ts';
import { SeatGrid } from '../components/SeatGrid.ts';
import { playSound, unlockVoice } from '../voice.ts';
import {
  askConfirm,
  canChangeVoice,
  copyInvite,
  deleteHallMatch,
  isHost,
  leaveWithConfirm,
  mySeat,
  refreshHallDashboard,
  startGame,
  state,
  toggleReady,
  toggleVoice,
} from '../store.ts';

export const LobbyView = defineComponent({
  name: 'LobbyView',
  components: { SeatGrid, BoardEditor },
  setup() {
    const room = computed(() => state.room);
    const filled = computed(() => state.room?.playerCount ?? 0);
    const capacity = computed(() => state.room?.board.playerCount ?? 0);

    /** 未就绪的座位（房主不算，他点「开始」即代表就绪） */
    const notReady = computed(() => state.room?.notReadySeats ?? []);

    /** 房主开局按钮被什么挡住了 —— 直接说人话 */
    const startBlocker = computed(() => {
      const r = state.room;
      if (!r) return '';
      if (r.boardErrors.length > 0) return '版型还没配好，先看上面的提示';
      if (r.seatsNeeded > 0) return `还差 ${r.seatsNeeded} 个人`;
      if (r.notReadySeats.length > 0) {
        return `还差 ${r.notReadySeats.length} 人就绪（${r.notReadySeats.join('、')} 号）`;
      }
      return '';
    });

    const readyLabel = computed(() => (mySeat.value?.ready ? '取消准备' : '我准备好了'));
    const iAmReady = computed(() => mySeat.value?.ready === true);
    const voiceLocked = computed(() => !canChangeVoice.value);
    const hall = computed(() => state.hallDashboard);

    function matchResult(match: { status: string; outcome: string | null }): string {
      if (match.status === 'ABORTED') return '提前结束 · 不计分';
      if (match.outcome === 'WOLF') return '狼人阵营胜利';
      if (match.outcome === 'GOOD') return '好人阵营胜利';
      return '流局 · 不计分';
    }

    function removeMatch(matchId: string, displayNumber: number): void {
      askConfirm(
        {
          title: `删除第 ${displayNumber} 场`,
          message: '该场会从所有玩家的历史中消失，胜负、身份次数、积分和排名都会重新计算。确定删除吗？',
          confirmText: '确认删除',
          cancelText: '取消',
          danger: true,
        },
        (ok) => {
          if (ok) void deleteHallMatch(matchId);
        },
      );
    }

    let hallTimer: number | null = null;
    onMounted(() => {
      if (state.room) void refreshHallDashboard(state.room.roomId);
      hallTimer = window.setInterval(() => {
        if (state.room) void refreshHallDashboard(state.room.roomId);
      }, 5_000);
    });
    onUnmounted(() => {
      if (hallTimer !== null) window.clearInterval(hallTimer);
    });

    /**
     * 试听「金色传说」（警长当选时的音效）。
     *
     * 现在警长竞选流程还没做，所以先给一个手动试听入口，
     * 让大家在开局前确认自己手机能出声 —— 免得到时候全场静音没人知道。
     * 顺序很重要：先解锁音频通道（借用这次点击），再放音效。
     */
    function previewGoldenLegend(): void {
      unlockVoice();
      playSound('goldenLegend');
    }

    return {
      room,
      filled,
      capacity,
      notReady,
      startBlocker,
      readyLabel,
      iAmReady,
      voiceLocked,
      hall,
      matchResult,
      removeMatch,
      previewGoldenLegend,
      state,
      isHost,
      mySeat,
      toggleReady,
      startGame,
      leaveWithConfirm,
      copyInvite,
      toggleVoice,
      refreshHallDashboard,
    };
  },
  template: `
    <div v-if="room">
      <!-- 房间号 -->
      <div class="panel center">
        <div class="muted small">大厅号（念给朋友听）</div>
        <div class="mono" style="font-size: 34px; font-weight: 700; letter-spacing: 8px; margin: 4px 0 10px;">
          {{ room.roomId }}
        </div>
        <div class="row" style="gap: 8px;">
          <button class="sm grow" @click="copyInvite">复制邀请链接</button>
          <button class="sm ghost" @click="leaveWithConfirm">离开</button>
        </div>
        <div class="spacer"></div>
        <div class="tiny muted">当前准备开始第 {{ room.matchNumber }} 场。把链接发给朋友即可加入本大厅。</div>
      </div>

      <!-- 大厅累计面板：普通玩家看胜负与身份次数；厅主额外看积分与排名 -->
      <div class="panel">
        <div class="row-between">
          <h2 style="margin: 0;">大厅积分面板</h2>
          <button class="sm ghost" :disabled="state.hallLoading" @click="refreshHallDashboard(room.roomId)">
            {{ state.hallLoading ? '刷新中…' : '刷新' }}
          </button>
        </div>
        <div class="spacer"></div>
        <div v-if="!hall || hall.players.length === 0" class="small muted center" style="padding: 10px 0;">
          完成第一场后，这里会显示玩家的胜负和身份次数。
        </div>
        <table v-else class="reveal hall-score-table">
          <thead>
            <tr>
              <th v-if="hall.isOwner" class="tiny muted">排名</th>
              <th class="tiny muted">玩家</th>
              <th class="tiny muted">胜 / 负</th>
              <th class="tiny muted">狼 / 神 / 民</th>
              <th v-if="hall.isOwner" class="tiny muted">积分</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="player in hall.players" :key="player.userId || player.nickname">
              <td v-if="hall.isOwner" class="mono">{{ player.rank }}</td>
              <td class="ellipsis"><b>{{ player.nickname }}</b></td>
              <td class="tiny">{{ player.wins }} / {{ player.losses }}</td>
              <td class="tiny">{{ player.wolfCount }} / {{ player.godCount }} / {{ player.villagerCount }}</td>
              <td v-if="hall.isOwner" class="mono"><b>{{ player.score }}</b></td>
            </tr>
          </tbody>
        </table>
        <div v-if="hall && !hall.isOwner" class="tiny muted center" style="margin-top: 8px;">
          积分与排名仅厅主可见。
        </div>
      </div>

      <!-- 已结束场次 -->
      <div class="panel">
        <h2>场次回顾</h2>
        <div v-if="!hall || hall.matches.length === 0" class="small muted center" style="padding: 10px 0;">
          还没有已保存的场次。
        </div>
        <div v-for="match in hall?.matches || []" :key="match.id" class="hall-match-card">
          <div class="row-between" style="align-items: flex-start;">
            <div class="grow">
              <div><b>第 {{ match.displayNumber }} 场</b> · {{ matchResult(match) }}</div>
              <div class="tiny muted">{{ match.boardSummary }} · 结束于第 {{ match.day || 1 }} 天</div>
            </div>
            <button
              v-if="hall?.isOwner"
              class="sm danger"
              @click="removeMatch(match.id, match.displayNumber)"
            >删除</button>
          </div>
          <table class="reveal" style="margin-top: 8px;">
            <tr v-for="player in match.players" :key="player.seat">
              <td class="mono" style="width: 38px;">{{ player.seat }}</td>
              <td class="ellipsis">{{ player.nickname }}</td>
              <td style="width: 86px;">
                <span class="badge" :class="player.camp === 'WOLF' ? 'wolf' : 'good'">
                  {{ player.roleName }}<template v-if="player.fakeSeer"> · 悍跳</template>
                </span>
              </td>
              <td class="tiny muted" style="width: 56px;">
                {{ match.status === 'ABORTED' ? '未计分' : player.won ? '胜' : '负' }}
              </td>
              <td v-if="hall?.isOwner" class="tiny mono" style="width: 48px;">+{{ player.score }}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- 就绪状态 -->
      <div class="panel">
        <div class="row-between">
          <h2 style="margin: 0;">就绪状态</h2>
          <span class="badge" :class="capacity > 0 && filled === capacity ? 'good' : 'accent'">
            {{ filled }} / {{ capacity }} 人
          </span>
        </div>
        <div class="spacer"></div>
        <SeatGrid />

        <div class="spacer"></div>
        <div v-if="room.boardErrors.length" class="small" style="color: var(--wolf);">
          版型还没配好，配好之后才能开局。
        </div>
        <div v-else-if="room.seatsNeeded > 0" class="small muted">
          还差 {{ room.seatsNeeded }} 个人。人数满 {{ capacity }} 人后才能开局。
        </div>
        <div v-else-if="notReady.length" class="small muted">
          人都到齐了，还差 {{ notReady.length }} 人点「我准备好了」：{{ notReady.join('、') }} 号
        </div>
        <div v-else class="small" style="color: var(--good);">
          全员到齐且都已就绪，房主可以开局了。
        </div>
      </div>

      <!-- 语音播报 -->
      <div class="panel">
        <div class="row-between">
          <div class="grow">
            <div class="small" style="font-weight: 600;">语音播报</div>
            <div class="tiny muted">
              打开后手机会像法官一样念出「天黑请闭眼」「狼人请睁眼」这类流程指令。
            </div>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ on: state.voiceEnabled, locked: voiceLocked }"
            role="switch"
            :aria-checked="state.voiceEnabled"
            :aria-disabled="voiceLocked"
            aria-label="语音播报"
            @click="toggleVoice"
          ></button>
        </div>
        <div class="spacer"></div>
        <div class="tiny muted">
          <template v-if="!state.voiceSupported">
            ⚠ 这个浏览器不支持语音播报（换 Safari / Chrome 打开）。
          </template>
          <template v-else-if="voiceLocked">
            🔒 天黑期间不能调整语音播报，天亮后可以改（防止场外因素）。
          </template>
          <template v-else>
            房主默认开启，其他玩家默认关闭 —— {{ capacity }} 台手机同时念会互相干扰。想听就自己打开。
          </template>
        </div>
        <div class="spacer"></div>
        <button class="tiny-btn" @click="previewGoldenLegend">▶ 试听「金色传说」</button>
        <div class="tiny muted" style="margin-top: 6px;">
          警长当选时会放的音效。先点一下确认手机出得了声。
        </div>
      </div>

      <!-- 版型配置 -->
      <BoardEditor />

      <!-- 行动 -->
      <div class="panel">
        <button v-if="!isHost" :class="iAmReady ? '' : 'primary'" @click="toggleReady">
          {{ readyLabel }}
        </button>

        <template v-else>
          <button class="primary" :disabled="!room.canStart" @click="startGame">
            {{ room.canStart ? '开始游戏（发牌）' : '还不能开始' }}
          </button>
          <div class="spacer"></div>
          <div v-if="startBlocker" class="banner warn" style="margin-bottom: 0;">{{ startBlocker }}</div>
          <div v-else class="tiny muted center">你点击开始后，系统会按上面的版型随机发牌。</div>
        </template>

        <div v-if="!isHost" class="spacer"></div>
        <div v-if="!isHost" class="tiny muted center">点「我准备好了」，等房主开局。</div>
      </div>
    </div>
  `,
});
