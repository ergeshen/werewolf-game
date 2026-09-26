/**
 * 对局主界面：阶段条、我的身份、行动面板、座位盘、事件流。
 *
 * 行动面板按「阶段 + 我的身份」渲染，但**能不能行动完全由服务端下发的 myTurn / myOptions 决定**，
 * 客户端不做规则判断 —— 否则小程序端复用时会出现两端不一致。
 *
 * 注意：所有需要在界面上拼接的字符串都在 setup 里算好（computed），
 * 不写进模板表达式 —— 模板里的箭头函数和 ?? 容易被 HTML 解析器吞掉。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import { SeatGrid } from '../components/SeatGrid.ts';
import {
  clearSelection,
  confirmSelection,
  forceAdvance,
  formatClock,
  hasActed,
  isHost,
  nicknameOf,
  remainingMs,
  skipAction,
  state,
  useAntidote,
} from '../store.ts';

interface Panel {
  mode: 'wait' | 'wolf' | 'witch' | 'seer' | 'vote' | 'hunter' | 'done';
  title: string;
  detail: string;
  confirm: string;
  skip: string;
  showAntidote: boolean;
  canSave: boolean;
  saveBlocked: string;
}

function waitPanel(title: string, detail: string): Panel {
  return {
    mode: 'wait',
    title,
    detail,
    confirm: '',
    skip: '',
    showAntidote: false,
    canSave: false,
    saveBlocked: '',
  };
}

function donePanel(detail: string): Panel {
  return {
    mode: 'done',
    title: '已提交',
    detail,
    confirm: '',
    skip: '',
    showAntidote: false,
    canSave: false,
    saveBlocked: '',
  };
}

export const GameView = defineComponent({
  name: 'GameView',
  components: { SeatGrid },
  setup() {
    const game = computed(() => state.game);
    const me = computed(() => state.game?.me ?? null);

    /** 我已提交内容的回显文案 */
    const submittedText = computed(() => {
      const g = state.game;
      if (!g) return '';
      const v = g.mySubmitted;
      if (v === undefined) return '';
      if (v === null) {
        if (g.phase === 'NIGHT_WOLVES') return '你选择了空刀';
        if (g.phase === 'DAY_VOTE') return '你弃票了';
        if (g.phase === 'HUNTER_SHOOT') return '你放弃了开枪';
        return '已提交';
      }
      if (typeof v === 'number') return '你选择了 ' + v + ' 号（' + nicknameOf(v) + '）';
      if (v.kind === 'wolf') {
        return v.target === null ? '你选择了空刀' : '你选择了击杀 ' + v.target + ' 号';
      }
      if (v.kind === 'seer') return '你查验了 ' + v.target + ' 号';
      if (v.kind === 'witch') {
        if (v.save) return '你使用了解药';
        if (v.poison !== null) return '你使用毒药毒杀了 ' + v.poison + ' 号';
        return '你没有使用药水';
      }
      return '已提交';
    });

    const panel = computed<Panel | null>(() => {
      const g = state.game;
      if (!g) return null;
      const role = me.value?.role;
      const acted = hasActed.value;

      switch (g.phase) {
        case 'NIGHT_WOLVES': {
          if (role !== 'WOLF') return waitPanel('狼人正在行动', '请闭眼等待，不要发出任何声音。');
          if (acted) return donePanel(submittedText.value + '，等待其他狼人…');
          return {
            mode: 'wolf',
            title: '选择今晚要击杀的玩家',
            detail: '你和狼队友各自点选，票数最多的目标会被击杀；平票则今晚空刀。',
            confirm: '确认击杀',
            skip: '空刀',
            showAntidote: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'NIGHT_WITCH': {
          if (role !== 'WITCH') return waitPanel('女巫正在行动', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          const target = g.witchInfo ? g.witchInfo.wolfTargetSeat : null;
          const detail =
            target === null
              ? '今晚没有人被狼人杀害。你可以选择使用毒药，也可以不用。'
              : '今晚 ' + target + ' 号（' + nicknameOf(target) + '）被狼人杀害。';
          return {
            mode: 'witch',
            title: '女巫请睁眼',
            detail,
            confirm: '确认使用毒药',
            skip: '两瓶药都不用',
            showAntidote: true,
            canSave: g.witchInfo ? g.witchInfo.canSave : false,
            saveBlocked: g.witchInfo && g.witchInfo.saveBlockedReason ? g.witchInfo.saveBlockedReason : '',
          };
        }
        case 'NIGHT_SEER': {
          if (role !== 'SEER') return waitPanel('预言家正在查验', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value + '，天就快亮了…');
          return {
            mode: 'seer',
            title: '选择要查验的玩家',
            detail: '你会得知他属于好人阵营还是狼人阵营。',
            confirm: '确认查验',
            skip: '',
            showAntidote: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'DAY_VOTE': {
          if (!me.value || !me.value.canVote) {
            return waitPanel('你本轮没有投票权', '已出局的玩家、以及翻牌后的白痴都无法投票。');
          }
          if (acted) return donePanel(submittedText.value + '，等待其他人投票…');
          return {
            mode: 'vote',
            title: '投票放逐一名玩家',
            detail: '得票最多者被放逐出局；出现平票则本轮无人出局。',
            confirm: '确认投票',
            skip: '弃票',
            showAntidote: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'HUNTER_SHOOT': {
          if (role !== 'HUNTER' || !me.value || g.hunterPendingSeat !== me.value.seat) {
            return waitPanel('猎人正在决定是否开枪', '请等待猎人的选择。');
          }
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'hunter',
            title: '你是猎人，可以开枪',
            detail: '选择一名玩家带走，也可以放弃开枪。',
            confirm: '确认开枪',
            skip: '放弃开枪',
            showAntidote: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        default:
          return waitPanel(g.phaseTitle, g.phaseHint);
      }
    });

    /** 天亮 / 放逐的结果横幅 */
    const banner = computed(() => {
      const g = state.game;
      if (!g) return null;
      if (g.phase === 'DAY_ANNOUNCE') {
        if (g.lastNightDeaths.length === 0) return { cls: 'good', text: '昨晚是平安夜，无人死亡。' };
        const names = g.lastNightDeaths
          .map((s) => s + ' 号（' + nicknameOf(s) + '）')
          .join('、');
        return { cls: 'wolf', text: '昨晚死亡的是：' + names };
      }
      if (g.phase === 'DAY_EXILE') {
        if (!g.exiled) return { cls: 'good', text: '本轮无人出局。' };
        return { cls: 'wolf', text: '被投票放逐的是 ' + g.exiled.seat + ' 号（' + g.exiled.nickname + '）' };
      }
      if (g.phase === 'HUNTER_SHOOT' && g.hunterPendingSeat !== null) {
        return { cls: 'warn', text: '猎人（' + g.hunterPendingSeat + ' 号）出局，正在决定是否开枪。' };
      }
      return null;
    });

    const progressPercent = computed(() => {
      const p = state.game?.progress;
      if (!p || p.total <= 0) return 0;
      return Math.round((p.done / p.total) * 100);
    });

    const isNight = computed(() => (state.game?.phase ?? '').startsWith('NIGHT'));

    const teammateText = computed(() => {
      const t = me.value?.teammates;
      if (!t || t.length === 0) return '';
      return t.map((s) => s + ' 号').join('、');
    });

    const speechOrderText = computed(() => {
      const o = state.game?.speechOrder;
      if (!o || o.length === 0) return '';
      return o.map((s) => s + ' 号').join(' → ');
    });

    const canConfirm = computed(() => state.selected !== null);

    /**
     * 狼队点刀面板（仅狼人可见，数据来自服务端下发的 wolfVotes）。
     *
     * 这是线上玩狼人杀最关键的一块：真人隔着手机没法像线下那样使眼色，
     * 有了它狼队才能看到彼此的选择并自然收敛到同一个目标。
     */
    const wolfPanel = computed(() => {
      const g = state.game;
      if (!g || !g.wolfVotes) return null;

      const rows = g.wolfVotes.map((v) => ({
        seat: v.seat,
        isMe: g.me?.seat === v.seat,
        label: v.target === null ? '空刀' : v.target + ' 号（' + nicknameOf(v.target) + '）',
      }));

      const counts = new Map<string, number>();
      for (const v of g.wolfVotes) {
        const key = v.target === null ? 'none' : String(v.target);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let topKey: string | null = null;
      let topCount = 0;
      let tie = false;
      for (const [key, count] of counts) {
        if (count > topCount) {
          topKey = key;
          topCount = count;
          tie = false;
        } else if (count === topCount) {
          tie = true;
        }
      }

      const notChosen = g.progress ? Math.max(0, g.progress.total - g.progress.done) : 0;
      let consensus = '还没有狼队友点刀';
      if (g.wolfVotes.length > 0 && topKey !== null) {
        if (tie) consensus = '目前平票 —— 平票会空刀，请统一目标';
        else if (topKey === 'none') consensus = '目前多数选择空刀';
        else consensus = '目前多数目标：' + topKey + ' 号';
      }
      if (notChosen > 0) consensus += '（还有 ' + notChosen + ' 名狼队友未选择）';

      return { rows, consensus };
    });

    return {
      state,
      game,
      me,
      panel,
      banner,
      submittedText,
      progressPercent,
      isNight,
      teammateText,
      speechOrderText,
      wolfPanel,
      canConfirm,
      hasActed,
      remainingMs,
      formatClock,
      confirmSelection,
      skipAction,
      useAntidote,
      clearSelection,
      forceAdvance,
      isHost,
      nicknameOf,
    };
  },
  template: `
    <div v-if="game">
      <!-- 阶段条 -->
      <div class="topbar">
        <div class="row-between">
          <div>
            <div class="phase" :style="{ color: isNight ? '#9dc0ff' : '#ffd79a' }">
              {{ isNight ? '🌙 天黑' : '☀️ 白天' }} · {{ game.phaseTitle }}
            </div>
            <div class="tiny muted">第 {{ game.day }} 天</div>
          </div>
          <div class="center">
            <div class="countdown">{{ formatClock(remainingMs) }}</div>
            <div v-if="game.progress" class="tiny muted">
              已行动 {{ game.progress.done }}/{{ game.progress.total }}
            </div>
          </div>
        </div>
        <div v-if="game.progress && game.progress.total > 1" class="progress">
          <i :style="{ width: progressPercent + '%' }"></i>
        </div>
      </div>

      <!-- 结果横幅 -->
      <div v-if="banner" class="banner" :class="banner.cls">{{ banner.text }}</div>

      <!-- 我的身份 -->
      <div class="rolecard" :class="me && me.camp === 'WOLF' ? 'wolf' : ''">
        <div class="row-between">
          <div class="row">
            <span class="role" :style="{ color: me && me.camp === 'WOLF' ? '#ff8b9d' : '#63dbb2' }">
              {{ me ? me.roleName : '观众' }}
            </span>
            <span v-if="me" class="badge" :class="me.camp === 'WOLF' ? 'wolf' : 'good'">{{ me.seat }} 号</span>
          </div>
          <button class="sm ghost" @click="state.showRoleCard = !state.showRoleCard">
            {{ state.showRoleCard ? '隐藏身份' : '显示身份' }}
          </button>
        </div>

        <template v-if="state.showRoleCard && me">
          <div class="spacer"></div>
          <div class="small muted">{{ me.roleDesc }}</div>

          <template v-if="teammateText">
            <div class="spacer"></div>
            <div class="small">
              <span class="badge wolf">狼队友</span>
              <span style="margin-left: 6px;">{{ teammateText }}</span>
            </div>
          </template>

          <template v-if="me.potions">
            <div class="spacer"></div>
            <div class="small">
              <span class="badge" :class="me.potions.antidote ? 'good' : ''">
                解药{{ me.potions.antidote ? '未使用' : '已用完' }}
              </span>
              <span class="badge" :class="me.potions.poison ? 'wolf' : ''" style="margin-left: 6px;">
                毒药{{ me.potions.poison ? '未使用' : '已用完' }}
              </span>
            </div>
          </template>

          <template v-if="me.seerHistory && me.seerHistory.length">
            <div class="spacer"></div>
            <div class="small"><span class="badge accent">验人记录</span></div>
            <div class="small" style="margin-top: 4px;">
              <div v-for="h in me.seerHistory" :key="h.seat">
                {{ h.seat }} 号（{{ h.nickname }}）：
                <span :style="{ color: h.camp === 'WOLF' ? '#ff8b9d' : '#63dbb2', fontWeight: 700 }">
                  {{ h.camp === 'WOLF' ? '狼人' : '好人' }}
                </span>
              </div>
            </div>
          </template>
        </template>
      </div>

      <!-- 行动面板 -->
      <div v-if="panel" class="panel">
        <div class="row-between">
          <h2 style="margin: 0;">{{ panel.title }}</h2>
          <span v-if="panel.mode === 'done'" class="badge good">已提交</span>
        </div>
        <div class="spacer"></div>
        <div class="small muted">{{ panel.detail }}</div>

        <template v-if="panel.showAntidote">
          <div class="spacer"></div>
          <button class="good" :disabled="!panel.canSave" @click="useAntidote">使用解药救他</button>
          <div v-if="panel.saveBlocked" class="tiny muted center" style="margin-top: 6px;">
            {{ panel.saveBlocked }}
          </div>
        </template>

        <template v-if="state.selected !== null">
          <div class="spacer"></div>
          <div class="banner warn" style="margin-bottom: 0;">
            已选中 {{ state.selected }} 号（{{ nicknameOf(state.selected) }}）
          </div>
        </template>
      </div>

      <!-- 狼队点刀面板（服务端只发给狼人） -->
      <div v-if="wolfPanel" class="panel">
        <div class="row-between">
          <h3 style="margin: 0;">狼队讨论（仅狼人可见）</h3>
          <span class="badge wolf">狼</span>
        </div>
        <div class="spacer"></div>
        <div class="small">
          <div v-for="r in wolfPanel.rows" :key="r.seat" class="row-between" style="padding: 3px 0;">
            <span>{{ r.seat }} 号<template v-if="r.isMe">（我）</template></span>
            <span :style="{ color: r.label === '空刀' ? '#8b93ad' : '#ff8b9d', fontWeight: 600 }">{{ r.label }}</span>
          </div>
        </div>
        <div class="spacer"></div>
        <div class="tiny muted">{{ wolfPanel.consensus }}</div>
      </div>

      <!-- 座位盘 -->
      <div class="panel">
        <h3>场上局势</h3>
        <SeatGrid />
        <template v-if="speechOrderText">
          <div class="spacer"></div>
          <div class="tiny muted">建议发言顺序：{{ speechOrderText }}</div>
        </template>
      </div>

      <!-- 票型 -->
      <div v-if="game.voteDetail && game.voteDetail.length" class="panel tight">
        <h3>票型</h3>
        <div class="small muted">
          <span
            v-for="v in game.voteDetail"
            :key="v.voter"
            class="badge"
            style="margin: 2px 4px 2px 0;"
          >{{ v.voter }} → {{ v.target === null ? '弃票' : v.target }}</span>
        </div>
      </div>

      <!-- 事件流 -->
      <div class="panel">
        <h3>事件记录</h3>
        <div class="log">
          <div v-for="(line, i) in game.log.slice().reverse()" :key="i">{{ line }}</div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="actionbar">
        <div class="actionbar-inner">
          <template v-if="panel && game.myTurn && !hasActed">
            <button class="primary grow" :disabled="!canConfirm" @click="confirmSelection">
              {{ panel.confirm || '确认' }}
            </button>
            <button v-if="canConfirm" class="sm ghost" @click="clearSelection">取消</button>
            <button v-if="panel.skip" class="sm" @click="skipAction">{{ panel.skip }}</button>
          </template>

          <template v-else-if="hasActed">
            <div class="grow small muted center">已提交，等待其他玩家…</div>
          </template>

          <template v-else>
            <div class="grow small muted center">{{ game.phaseHint }}</div>
            <button v-if="isHost" class="sm ghost" @click="forceAdvance">跳过</button>
          </template>
        </div>
      </div>
    </div>
  `,
});
