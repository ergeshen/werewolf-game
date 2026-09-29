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

import { isWolfRole } from '../../../src/shared/roles.ts';
import { SeatGrid } from '../components/SeatGrid.ts';
import {
  ALL_WOLF_TAGS,
  EXCLUSIVE_WOLF_TAGS,
  WOLF_TAG_DESC,
  WOLF_TAG_LABEL,
  type WolfTag,
} from '../../../src/shared/protocol.ts';
import {
  canChangeVoice,
  clearSelection,
  closeMatch,
  confirmSelection,
  askConfirm,
  setGodView,
  forceAdvance,
  formatClock,
  hasActed,
  isHost,
  nicknameOf,
  remainingMs,
  restartGame,
  selfDestruct,
  sheriffSignup,
  sheriffWithdraw,
  setSpeechDirection,
  setWolfTag,
  skipAction,
  state,
  toggleVoice,
  useAntidote,
} from '../store.ts';

interface Panel {
  mode: 'wait' | 'wolf' | 'guard' | 'witch' | 'seer' | 'hybrid' | 'mechanical' | 'dancer' | 'mask' | 'spirit' | 'sheriffSignup' | 'sheriffCampaign' | 'vote' | 'sheriffTransfer' | 'speech' | 'hunter' | 'boom' | 'done';
  title: string;
  detail: string;
  confirm: string;
  skip: string;
  showAntidote: boolean;
  /** 白狼王在白天可以自爆 */
  showSelfDestruct: boolean;
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
    showSelfDestruct: false,
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
    showSelfDestruct: false,
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
        if (['DAY_VOTE', 'SHERIFF_VOTE', 'SHERIFF_REVOTE'].includes(g.phase)) return '你弃票了';
        if (g.phase === 'SHERIFF_TRANSFER') return '你撕毁了警徽';
        if (g.phase === 'HUNTER_SHOOT') return '你放弃了开枪';
        if (g.phase === 'WOLF_KING_BOOM') return '你没有带走任何人';
        return '已提交';
      }
      if (typeof v === 'number') return '你选择了 ' + v + ' 号（' + nicknameOf(v) + '）';
      if (typeof v === 'boolean') return v ? '你选择了上警' : '你选择了不上警';
      if (v.kind === 'hybrid') return '你选择了 ' + v.target + ' 号作为榜样';
      if (v.kind === 'mechanicalLearn') return '你学习了 ' + v.target + ' 号的身份';
      if (v.kind === 'dancer') return '你选择了 ' + v.targets.join('、') + ' 号进入舞池';
      if (v.kind === 'maskInspect') return '你查验了 ' + v.target + ' 号，现在请选择戴面具目标';
      if (v.kind === 'mask') return '你给 ' + v.target + ' 号戴上了面具';
      if (v.kind === 'spiritSeer') return '你查验了 ' + v.target + ' 号的具体身份';
      if (v.kind === 'mechanicalSkill') {
        if (v.target === null) return '你没有使用复制技能';
        return '你对 ' + v.target + ' 号使用了复制技能';
      }
      if (v.kind === 'wolf') {
        return v.target === null ? '你选择了空刀' : '你选择了击杀 ' + v.target + ' 号';
      }
      if (v.kind === 'guard') return '你守护了 ' + v.target + ' 号';
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
        case 'NIGHT_HYBRID': {
          if (role !== 'HYBRID') return waitPanel('混血儿正在选择榜样', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'hybrid', title: '选择你的榜样',
            detail: '你的个人胜负将跟随榜样阵营，但你不会得知他的身份或阵营；预言家查验你始终是好人。',
            confirm: '确认榜样', skip: '', showAntidote: false, showSelfDestruct: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_MECHANICAL': {
          if (role !== 'MECHANICAL_WOLF') return waitPanel('机械狼正在学习身份', '请闭眼等待。');
          if (me.value?.mechanicalLearnedRole) return waitPanel('身份学习已完成', '你只能学习一次，复制技能从学习后的下一夜开始生效。');
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'mechanical', title: '学习一名玩家的身份',
            detail: '你会得知他的具体身份，并从下一夜起继承对应技能；你目前不认识普通狼人。',
            confirm: '确认学习', skip: '', showAntidote: false, showSelfDestruct: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_DANCER': {
          if (role !== 'DANCER') return waitPanel('舞者正在选择舞池', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'dancer', title: '选择三名玩家进入舞池',
            detail: '每名玩家整局只能进入一次舞池，可以选择自己。三人阵营为 2 比 1 时，少数阵营玩家出局。',
            confirm: '确认舞池', skip: '', showAntidote: false, showSelfDestruct: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_MASK': {
          if (role !== 'MASK') return waitPanel('假面正在行动', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          const inspected = me.value?.maskInspect;
          return {
            mode: 'mask',
            title: me.value?.maskNeedsDisguise ? '选择戴面具目标' : '查验一名玩家是否在舞池',
            detail: me.value?.maskNeedsDisguise && inspected
              ? inspected.seat + ' 号' + (inspected.inDance ? '在舞池中。' : '不在舞池中。') + '现在请选择一名玩家戴面具；可以与查验目标相同，也可以选择自己。'
              : '查验与戴面具是同一夜的两步行动。查验目标不能与上一夜相同。',
            confirm: me.value?.maskNeedsDisguise ? '确认戴面具' : '确认查验',
            skip: '', showAntidote: false, showSelfDestruct: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_WOLVES': {
          const wolfSubmitted = g.mySubmitted && typeof g.mySubmitted === 'object' && g.mySubmitted.kind === 'wolf';
          if (!role || !isWolfRole(role) || (!g.myTurn && !wolfSubmitted)) {
            return waitPanel('狼人正在行动', '请闭眼等待，不要发出任何声音。');
          }
          if (acted) return donePanel(submittedText.value + '，等待其他狼人…');
          return {
            mode: 'wolf',
            title: '选择今晚要击杀的玩家',
            detail: '你和狼队友各自点选，票数最多的目标会被击杀；平票则今晚空刀。',
            confirm: '确认击杀',
            skip: '空刀',
            showAntidote: false,
            showSelfDestruct: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'NIGHT_GUARD': {
          const copied = role === 'MECHANICAL_WOLF' && me.value?.mechanicalLearnedRole === 'GUARD' && me.value.mechanicalSkillActive;
          if (role !== 'GUARD' && !copied) return waitPanel('守卫正在行动', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          const blocked = g.guardBlockedSeat;
          return {
            mode: 'guard',
            title: '选择今晚要守护的玩家',
            detail:
              blocked === null || blocked === undefined
                ? '被守护的玩家今晚不会被狼人杀害。'
                : '被守护的玩家今晚不会被狼人杀害。注意：' +
                  blocked +
                  ' 号是你上一夜守过的人，本夜不能再守。',
            confirm: '确认守护',
            skip: '',
            showAntidote: false,
            showSelfDestruct: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'NIGHT_WITCH': {
          const copied = role === 'MECHANICAL_WOLF' && me.value?.mechanicalLearnedRole === 'WITCH' && me.value.mechanicalSkillActive;
          if (role !== 'WITCH' && !copied) return waitPanel('女巫正在行动', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          if (copied) {
            return {
              mode: 'witch', title: '使用复制毒药',
              detail: me.value?.mechanicalPoisonAvailable ? '你只继承一瓶毒药，没有解药；可以毒杀一名其他玩家或不用。' : '复制毒药已经用完，本夜无需行动。',
              confirm: '确认毒杀', skip: '不用毒药', showAntidote: false, showSelfDestruct: false, canSave: false, saveBlocked: '',
            };
          }
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
            showSelfDestruct: false,
            canSave: g.witchInfo ? g.witchInfo.canSave : false,
            saveBlocked: g.witchInfo && g.witchInfo.saveBlockedReason ? g.witchInfo.saveBlockedReason : '',
          };
        }
        case 'NIGHT_SEER': {
          const copied = role === 'MECHANICAL_WOLF' && me.value?.mechanicalLearnedRole === 'SEER' && me.value.mechanicalSkillActive;
          if (role !== 'SEER' && !copied) return waitPanel('预言家正在查验', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value + '，天就快亮了…');
          return {
            mode: 'seer',
            title: '选择要查验的玩家',
            detail: '你会得知他属于好人阵营还是狼人阵营。',
            confirm: '确认查验',
            skip: '',
            showAntidote: false,
            showSelfDestruct: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'NIGHT_SPIRIT_SEER': {
          const copied = role === 'MECHANICAL_WOLF' && me.value?.mechanicalLearnedRole === 'SPIRIT_SEER' && me.value.mechanicalSkillActive;
          if (role !== 'SPIRIT_SEER' && !copied) return waitPanel('通灵师正在查验', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'spirit', title: '查验具体身份',
            detail: copied ? '使用复制的通灵能力，查验一名玩家的具体身份。' : '选择一名玩家，你会得知他的具体角色。',
            confirm: '确认查验', skip: '', showAntidote: false, showSelfDestruct: false, canSave: false, saveBlocked: '',
          };
        }
        case 'SHERIFF_SIGNUP': {
          if (!me.value?.alive) return waitPanel('警长竞选报名', '你已经出局，请等待存活玩家选择。');
          if (acted) return donePanel(submittedText.value + '，等待其他玩家…');
          return {
            mode: 'sheriffSignup', title: '是否上警竞选',
            detail: '上警者发表竞选发言，但不能参加警下投票；不上警者保留选警长的投票权。',
            confirm: '', skip: '', showAntidote: false,
            showSelfDestruct: me.value.canSelfDestruct === true, canSave: false, saveBlocked: '',
          };
        }
        case 'SHERIFF_CAMPAIGN':
        case 'SHERIFF_PK': {
          const candidate = g.sheriffCandidates.includes(me.value?.seat ?? -1);
          const isPk = g.phase === 'SHERIFF_PK';
          return {
            mode: 'sheriffCampaign',
            title: isPk ? '平票候选人 PK 发言' : '警上竞选发言',
            detail: candidate ? '你是候选人，请按顺序发言；如果不再参选，可以退水。' : '请听候选人依次发言。',
            confirm: '', skip: '', showAntidote: false,
            showSelfDestruct: me.value?.canSelfDestruct === true, canSave: false, saveBlocked: '',
          };
        }
        case 'SHERIFF_VOTE':
        case 'SHERIFF_REVOTE': {
          if (!g.myTurn && !acted) {
            const waiting = waitPanel('警下正在投票', '候选人没有投票权，请等待投票结果。');
            waiting.showSelfDestruct = me.value?.canSelfDestruct === true;
            return waiting;
          }
          if (acted) return donePanel(submittedText.value + '，等待其他人投票…');
          return {
            mode: 'vote', title: g.phase === 'SHERIFF_REVOTE' ? 'PK 重新投票' : '投票选出警长',
            detail: g.phase === 'SHERIFF_REVOTE' ? '只能投给 PK 候选人；再次平票，警徽流失。' : '只能投给警上候选人，也可以弃票。',
            confirm: '确认投票', skip: '弃票', showAntidote: false,
            showSelfDestruct: me.value?.canSelfDestruct === true, canSave: false, saveBlocked: '',
          };
        }
        case 'DAY_SPEECH': {
          return {
            mode: 'speech', title: '依次发言',
            detail: g.sheriffSeat === null ? '请按照页面显示的建议顺序发言。' : '警长指定方向后，从警长相邻座位开始，警长最后发言并归票。',
            confirm: '', skip: '', showAntidote: false,
            showSelfDestruct: me.value?.canSelfDestruct === true, canSave: false, saveBlocked: '',
          };
        }
        case 'DAY_VOTE': {
          if (!me.value || !me.value.canVote) {
            return waitPanel('你本轮没有投票权', '已出局的玩家、以及翻牌后的白痴都无法投票。');
          }
          const kingCanBoom = me.value.canSelfDestruct === true;
          if (acted) return donePanel(submittedText.value + '，等待其他人投票…');
          return {
            mode: 'vote',
            title: '投票放逐一名玩家',
            detail: kingCanBoom
              ? '得票最多者被放逐出局；平票则本轮无人出局。你也可以直接自爆并带走一名玩家。'
              : '得票最多者被放逐出局；出现平票则本轮无人出局。',
            confirm: '确认投票',
            skip: '弃票',
            showAntidote: false,
            showSelfDestruct: kingCanBoom,
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
            showSelfDestruct: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'SHERIFF_TRANSFER': {
          if (!g.myTurn && !acted) return waitPanel('警长正在处理警徽', '出局警长可以移交或撕毁警徽。');
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'sheriffTransfer', title: '处理警徽',
            detail: '选择一名存活玩家继任警长，或者撕毁警徽；撕毁后本局不再产生警长。',
            confirm: '确认移交', skip: '撕毁警徽', showAntidote: false,
            showSelfDestruct: false, canSave: false, saveBlocked: '',
          };
        }
        case 'WOLF_KING_BOOM': {
          if (!me.value || g.boomPendingSeat !== me.value.seat) {
            return waitPanel('白狼王正在指定带走的玩家', '请等待。');
          }
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'boom',
            title: '你已经自爆，选择要带走的玩家',
            detail: '选择一名玩家带走；选完之后直接进入黑夜，今天不再投票。',
            confirm: '确认带走',
            skip: '不带人',
            showAntidote: false,
            showSelfDestruct: false,
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
      if (g.phase === 'WOLF_KING_BOOM' && g.boomPendingSeat !== null) {
        return {
          cls: 'warn',
          text: '白狼王（' + g.boomPendingSeat + ' 号）自爆了，正在指定要带走的玩家。',
        };
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

    const canConfirm = computed(() =>
      state.game?.phase === 'NIGHT_DANCER' ? state.selectedMany.length === 3 : state.selected !== null,
    );
    const canWithdrawSheriff = computed(() => {
      const g = state.game;
      const seat = me.value?.seat;
      return !!g && seat !== undefined && ['SHERIFF_CAMPAIGN', 'SHERIFF_PK'].includes(g.phase) && g.sheriffCandidates.includes(seat);
    });
    const canChooseSpeechDirection = computed(() => {
      const g = state.game;
      return !!g && g.phase === 'DAY_SPEECH' && g.sheriffSeat === me.value?.seat && g.speechDirection === null;
    });

    /**
     * 语音播报开关只在**白天**显示。
     * 需求：天黑期间谁都不能改，避免有人夜里临时开语音搞场外因素。
     */
    const showVoiceToggle = computed(() => {
      const phase = state.game?.phase ?? '';
      if (phase === 'GAME_OVER') return false;
      return canChangeVoice.value && phase.startsWith('DAY');
    });

    const voiceLabel = computed(() =>
      state.voiceEnabled ? '语音播报：已开启' : '语音播报：已关闭',
    );

    /** 是否正在跑 54321 回合倒数 */
    const countdownActive = computed(() => {
      const c = state.game?.countdown;
      return c !== null && c !== undefined;
    });

    /** 狼队战术标签的可选项（只有狼人看得到这块面板） */
    const wolfTagOptions = computed(() => {
      const game = state.game;
      const fakeSeerLocked = game?.wolfTags?.some((entry) => entry.tag === 'FAKE_SEER') ?? false;
      const firstNight =
        game?.day === 1 &&
        ['NIGHT_START', 'NIGHT_WOLVES', 'NIGHT_GUARD', 'NIGHT_WITCH', 'NIGHT_SEER'].includes(
          game.phase,
        );
      const iAmFakeSeer = me.value?.myWolfTag === 'FAKE_SEER';
      return ALL_WOLF_TAGS.map((tag) => ({
        value: tag,
        label: WOLF_TAG_LABEL[tag],
        exclusive: EXCLUSIVE_WOLF_TAGS.includes(tag),
        mine: me.value?.myWolfTag === tag,
        disabled:
          !canEditTag.value ||
          (tag === 'FAKE_SEER' && (!firstNight || fakeSeerLocked)) ||
          (tag !== 'FAKE_SEER' && iAmFakeSeer),
      }));
    });

    /** 狼队友各自的标签一览 */
    const wolfTagRows = computed(() => {
      const tags = state.game?.wolfTags;
      if (!tags) return [];
      return tags.map((w) => ({
        seat: w.seat,
        nickname: w.nickname,
        has: w.tag !== null,
        label: w.tag ? WOLF_TAG_LABEL[w.tag] : '未分配',
        isMe: w.seat === me.value?.seat,
      }));
    });

    const myTagDesc = computed(() => {
      const tag = me.value?.myWolfTag;
      if (!tag) return '点按钮给自己挂个战术标签，狼队友都能看到。悍跳位须在第一夜确定，锁定后不能取消；狼队获胜额外加 1 分。';
      if (tag === 'FAKE_SEER') return '悍跳位已锁定：本场不能取消或转让；狼队获胜时你额外获得 1 分。';
      return WOLF_TAG_DESC[tag];
    });

    const canEditTag = computed(() => me.value?.canEditWolfTag === true);

    function toggleTag(tag: WolfTag): void {
      if (!canEditTag.value) return;
      if (me.value?.myWolfTag === tag) setWolfTag(null);
      else setWolfTag(tag);
    }

    /** 上帝视角：进之前必须先确认（进去等于放弃本局公平） */
    const godViewAvailable = computed(() => state.game?.godViewAvailable === true);
    const godViewActive = computed(() => state.game?.godViewActive === true);
    const playerCapacity = computed(() => state.room?.board.playerCount ?? 0);

    function toggleGodView(): void {
      if (godViewActive.value) {
        setGodView(false);
        return;
      }
      askConfirm(
        {
          title: '进入上帝视角',
          message:
            '进去之后你能看到全场 ' +
            playerCapacity.value +
            ' 个人的真实身份，等于放弃本局的公平性（别人不会知道）。确定要进去吗？',
          confirmText: '确定进入',
          cancelText: '算了',
          danger: true,
        },
        (ok) => {
          if (ok) setGodView(true);
        },
      );
    }

    function redeal(): void {
      askConfirm(
        {
          title: `第 ${state.room?.matchNumber ?? '?'} 场重新发牌`,
          message: '当前牌局会完全作废，不保存、不计身份次数和积分；系统会立即按同一版型重新发牌。',
          confirmText: '确认重新发牌',
          cancelText: '继续当前牌局',
          danger: true,
        },
        (ok) => {
          if (ok) restartGame();
        },
      );
    }

    function finishEarly(): void {
      askConfirm(
        {
          title: '提前结束并返回大厅',
          message: '本场会保存为“提前结束”，保留回顾，但不计胜负、身份次数和积分。',
          confirmText: '保存并返回大厅',
          cancelText: '继续游戏',
          danger: true,
        },
        (ok) => {
          if (ok) closeMatch();
        },
      );
    }

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
      canWithdrawSheriff,
      canChooseSpeechDirection,
      showVoiceToggle,
      voiceLabel,
      countdownActive,
      wolfTagOptions,
      wolfTagRows,
      myTagDesc,
      canEditTag,
      toggleTag,
      godViewAvailable,
      godViewActive,
      playerCapacity,
      toggleGodView,
      redeal,
      finishEarly,
      hasActed,
      remainingMs,
      formatClock,
      confirmSelection,
      skipAction,
      useAntidote,
      selfDestruct,
      sheriffSignup,
      sheriffWithdraw,
      setSpeechDirection,
      toggleVoice,
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

      <!-- 上帝视角：本局已经死过人之后才出现；进去前会先弹确认 -->
      <div v-if="godViewAvailable" class="panel tight">
        <div class="row-between">
          <div class="grow">
            <div class="small" style="font-weight: 600;">
              上帝视角{{ godViewActive ? '（已开启）' : '' }}
            </div>
            <div class="tiny muted">看到全场 {{ playerCapacity }} 人的真实身份，只有你自己能看到。</div>
          </div>
          <button class="sm" :class="godViewActive ? 'ghost' : 'danger'" @click="toggleGodView">
            {{ godViewActive ? '退出' : '进入' }}
          </button>
        </div>
      </div>

      <!-- 上帝视角下的全场身份 -->
      <div v-if="godViewActive && game.revealAll" class="panel">
        <div class="row-between">
          <h3 style="margin: 0;">全场身份（上帝视角）</h3>
          <span class="badge danger" style="background: rgba(224,69,94,0.16); color: #ff9dac;">仅你可见</span>
        </div>
        <div class="spacer"></div>
        <table class="reveal">
          <tr v-for="r in game.revealAll" :key="r.seat">
            <td class="mono" style="width: 40px;">{{ r.seat }}</td>
            <td class="ellipsis">{{ r.nickname }}</td>
            <td style="width: 76px;">
              <span class="badge" :class="r.camp === 'WOLF' ? 'wolf' : 'good'">{{ r.roleName }}</span>
            </td>
            <td class="tiny muted" style="width: 46px;">{{ r.alive ? '存活' : '出局' }}</td>
          </tr>
        </table>
      </div>

      <!-- 回合倒数 -->
      <div
        v-if="countdownActive"
        class="panel center"
        style="border-color: var(--warn); background: rgba(240,163,60,0.08);"
      >
        <div class="tiny muted">本回合就要结束了</div>
        <div class="mono" style="font-size: 48px; font-weight: 700; color: var(--warn); line-height: 1.15;">
          {{ game.countdown }}
        </div>
        <div class="spacer"></div>
        <button v-if="isHost" class="sm primary" @click="forceAdvance">房主跳过阶段</button>
      </div>

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

          <template v-if="me.spiritHistory && me.spiritHistory.length">
            <div class="spacer"></div>
            <div class="small"><span class="badge accent">通灵记录</span></div>
            <div class="small" style="margin-top: 4px;">
              <div v-for="h in me.spiritHistory" :key="h.seat">
                {{ h.seat }} 号（{{ h.nickname }}）：<b>{{ h.roleName }}</b>
              </div>
            </div>
          </template>

          <template v-if="me.role === 'HYBRID' && me.hybridModelSeat">
            <div class="spacer"></div>
            <div class="small">
              <span class="badge accent">榜样</span>
              {{ me.hybridModelSeat }} 号（{{ nicknameOf(me.hybridModelSeat) }}）
              <span class="muted">· 阵营未知</span>
            </div>
          </template>

          <template v-if="me.role === 'MECHANICAL_WOLF'">
            <div class="spacer"></div>
            <div class="small">
              <span class="badge wolf">学习身份</span>
              {{ me.mechanicalLearnedRoleName || '尚未学习' }}
              <span v-if="me.mechanicalLearnedRoleName" class="muted">
                · {{ me.mechanicalSkillActive ? '复制技能已生效' : '下一夜生效' }}
              </span>
            </div>
          </template>

          <template v-if="me.danceHistory && me.danceHistory.length">
            <div class="spacer"></div>
            <div class="small"><span class="badge accent">舞池记录</span></div>
            <div class="small" style="margin-top: 4px;">
              <div v-for="h in me.danceHistory" :key="h.day">第 {{ h.day }} 夜：{{ h.seats.join('、') }} 号</div>
            </div>
          </template>

          <template v-if="me.maskHistory && me.maskHistory.length">
            <div class="spacer"></div>
            <div class="small"><span class="badge wolf">假面记录</span></div>
            <div class="small" style="margin-top: 4px;">
              <div v-for="h in me.maskHistory" :key="h.day">
                第 {{ h.day }} 夜：查 {{ h.inspectSeat }} 号（{{ h.inDance ? '在舞池' : '不在舞池' }}），面具给 {{ h.maskSeat }} 号
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

        <template v-if="panel.mode === 'sheriffSignup'">
          <div class="spacer"></div>
          <div class="row" style="gap: 8px;">
            <button class="primary grow" @click="sheriffSignup(true)">上警竞选</button>
            <button class="grow" @click="sheriffSignup(false)">留在警下</button>
          </div>
        </template>

        <template v-if="panel.mode === 'sheriffCampaign' && canWithdrawSheriff">
          <div class="spacer"></div>
          <button class="warn" @click="sheriffWithdraw">退水</button>
        </template>

        <template v-if="panel.mode === 'speech' && canChooseSpeechDirection">
          <div class="spacer"></div>
          <div class="row" style="gap: 8px;">
            <button class="primary grow" @click="setSpeechDirection('FORWARD')">顺时针发言</button>
            <button class="primary grow" @click="setSpeechDirection('REVERSE')">逆时针发言</button>
          </div>
        </template>

        <template v-if="panel.showAntidote">
          <div class="spacer"></div>
          <button class="good" :disabled="!panel.canSave" @click="useAntidote">使用解药救他</button>
          <div v-if="panel.saveBlocked" class="tiny muted center" style="margin-top: 6px;">
            {{ panel.saveBlocked }}
          </div>
        </template>

        <template v-if="panel.showSelfDestruct">
          <div class="spacer"></div>
          <button class="danger" @click="selfDestruct">自爆并带走一人（今天不再投票）</button>
        </template>

        <template v-if="state.selected !== null || state.selectedMany.length">
          <div class="spacer"></div>
          <div class="banner warn" style="margin-bottom: 0;">
            <template v-if="state.selectedMany.length">
              已选中 {{ state.selectedMany.join('、') }} 号（{{ state.selectedMany.length }}/3）
            </template>
            <template v-else>
              已选中 {{ state.selected }} 号（{{ nicknameOf(state.selected) }}）
            </template>
          </div>
        </template>
      </div>

      <!-- 狼队战术标签（只有狼人看得到） -->
      <div v-if="game.wolfTags" class="panel">
        <div class="row-between">
          <h3 style="margin: 0;">狼队战术</h3>
          <span class="badge wolf">仅狼人可见</span>
        </div>
        <div class="spacer"></div>

        <div class="row wrap" style="gap: 6px;">
          <button
            v-for="opt in wolfTagOptions"
            :key="opt.value"
            class="sm"
            :class="opt.mine ? 'danger' : ''"
            :disabled="opt.disabled"
            @click="toggleTag(opt.value)"
          >{{ opt.label }}</button>
        </div>
        <div class="tiny muted" style="margin-top: 6px;">{{ myTagDesc }}</div>

        <div class="spacer"></div>
        <div v-for="w in wolfTagRows" :key="w.seat" class="row-between" style="padding: 4px 0;">
          <span class="small">
            {{ w.seat }} 号（{{ w.nickname }}）
            <span v-if="w.isMe" class="muted">（我）</span>
          </span>
          <span class="badge" :class="w.has ? 'wolf' : ''">{{ w.label }}</span>
        </div>
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
        <div class="row-between">
          <h3 style="margin: 0;">场上局势</h3>
          <span v-if="game.sheriffSeat !== null" class="badge gold">🚨 {{ game.sheriffSeat }} 号警长</span>
          <span v-else-if="game.sheriffElectionFinished" class="badge">无警徽</span>
        </div>
        <div class="spacer"></div>
        <SeatGrid />
        <template v-if="speechOrderText">
          <div class="spacer"></div>
          <div class="tiny muted">建议发言顺序：{{ speechOrderText }}</div>
        </template>
      </div>

      <!-- 语音播报开关（只在白天显示；天黑期间锁定，防止场外因素） -->
      <div v-if="showVoiceToggle" class="panel tight">
        <div class="row-between">
          <span class="small">{{ voiceLabel }}</span>
          <button
            type="button"
            class="switch"
            :class="{ on: state.voiceEnabled }"
            role="switch"
            :aria-checked="state.voiceEnabled"
            aria-label="语音播报"
            @click="toggleVoice"
          ></button>
        </div>
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
          >{{ v.voter }}{{ v.weight === 1.5 ? '（警·1.5）' : '' }} → {{ v.target === null ? '弃票' : v.target }}</span>
        </div>
      </div>

      <!-- 事件流 -->
      <div v-if="isHost" class="panel tight">
        <div class="row-between">
          <div>
            <h3 style="margin: 0;">房主操作</h3>
            <div class="tiny muted">
              第 {{ state.room?.matchNumber }} 场
              <template v-if="state.room?.hostTemporary"> · 你正在临时接管白天操作</template>
            </div>
          </div>
        </div>
        <div class="spacer"></div>
        <div class="row" style="gap: 8px;">
          <button class="sm grow" @click="redeal">重新发牌</button>
          <button class="sm danger grow" @click="finishEarly">结束并回大厅</button>
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
          <template v-if="panel && game.myTurn && !hasActed && panel.mode !== 'sheriffSignup'">
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
          </template>
          <button v-if="isHost" class="sm ghost" @click="forceAdvance">跳过阶段</button>
        </div>
      </div>
    </div>
  `,
});
