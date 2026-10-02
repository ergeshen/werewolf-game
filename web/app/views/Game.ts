/**
 * 对局主界面：阶段条、我的身份、行动面板、座位盘、事件流。
 *
 * 行动面板按「阶段 + 我的身份」渲染，但**能不能行动完全由服务端下发的 myTurn / myOptions 决定**，
 * 客户端不做规则判断 —— 否则小程序端复用时会出现两端不一致。
 *
 * 注意：所有需要在界面上拼接的字符串都在 setup 里算好（computed），
 * 不写进模板表达式 —— 模板里的箭头函数和 ?? 容易被 HTML 解析器吞掉。
 */

import { computed, defineComponent, onMounted, onUnmounted, ref, watch } from '../../vendor/vue.esm-browser.prod.js';

import { ROLE_NAME, isWolfRole } from '../../../src/shared/roles.ts';
import { SeatGrid } from '../components/SeatGrid.ts';
import { previewPackClips, unlockVoice, voicePackStatus } from '../voice.ts';
import {
  ALL_WOLF_TAGS,
  EXCLUSIVE_WOLF_TAGS,
  WOLF_TAG_DESC,
  WOLF_TAG_LABEL,
  type WolfTag,
} from '../../../src/shared/protocol.ts';
import {
  acknowledgeGraveCheck,
  canChangeVoice,
  chooseVoicePack,
  clearSelection,
  pickPuppet,
  closeMatch,
  confirmSelection,
  askConfirm,
  beginNight,
  confirmRole,
  knightDuel,
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
  showToast,
  skipAction,
  state,
  toggleVoice,
  useAntidote,
} from '../store.ts';

interface Panel {
  mode: 'wait' | 'wolf' | 'guard' | 'witch' | 'seer' | 'hybrid' | 'mechanical' | 'dancer' | 'mask' | 'dreamer' | 'spirit' | 'graveKeeper' | 'sheriffSignup' | 'sheriffCampaign' | 'vote' | 'sheriffTransfer' | 'speech' | 'hunter' | 'boom' | 'done';
  title: string;
  detail: string;
  confirm: string;
  skip: string;
  showAntidote: boolean;
  canSave: boolean;
  saveBlocked: string;
  /**
   * 验人结果 —— 单独拎出来，用大号带颜色的样式渲染。
   *
   * 为什么必须单独一个位置：预言家/通灵师/机械狼/假面/守墓人验出来的那句话，
   * 是整局游戏里最重要、也最容易被自己看漏的信息。但它原来被并进 `detail`，
   * 和「已提交」共用一个渲染 —— 标题是大字「已提交」，真正的结果是小号灰字。
   * 玩家第一眼看到「已提交」，就会以为自己没验出东西，然后到白天才在身份牌里
   * 翻到结果 —— 看起来就像「验完没显示，白天才出现」。
   */
  result?: ResultInfo | null;
}

/** 一眼就能看懂的验人结果 */
interface ResultInfo {
  /** 例如「查验结果」 */
  label: string;
  /** 例如「3 号（老王）是狼人」 */
  value: string;
  /** 决定颜色：狼人=红、好人=绿、纯情报（舞池/放逐）=蓝 */
  tone: 'wolf' | 'good' | 'info';
  /** 下面那行小字：告诉他这条信息意味着什么、下一步做什么 */
  note: string;
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

/** 验人结果面板：标题保留「已提交」，但结果占主要位置 */
function resultPanel(result: ResultInfo, title = '已提交', detail = ''): Panel {
  return {
    mode: 'done',
    title,
    detail,
    confirm: '',
    skip: '',
    showAntidote: false,
   
    canSave: false,
    saveBlocked: '',
    result,
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
    /**
     * 面杀隐私：身份默认不进入 DOM，点「点开身份牌」才渲染，再点一下合上。
     *
     * 防偷看的三道闸（重要性从高到低）：
     *  ① 阶段一变立即合上（没人会把自己的牌一直翻在桌上）；
     *  ② 切后台 / 窗口失焦立即合上；
     *  ③ 点开后 10 秒无操作自动合上 —— 身份确认阶段除外，那本来就是
     *     专门留出来安心读牌的时间（摄梦人、假面的说明有两三行）。
     *
     * 历史包袱说明：这里曾经是「按住查看、松手即隐藏」，隐私最好但没法在卡内
     * 点按钮（按住和点按没法用一根手指完成）。自爆/空爆入口就在卡内，所以
     * 整体换成了现在的点开式 + 自动合上。
     */
    const identityRevealed = ref(false);
    const isRoleRevealPhase = computed(() => state.game?.phase === 'ROLE_REVEAL');
    const IDENTITY_AUTO_CLOSE_MS = 10_000;
    let identityAutoCloseTimer: number | null = null;

    function clearIdentityTimer(): void {
      if (identityAutoCloseTimer !== null) {
        window.clearTimeout(identityAutoCloseTimer);
        identityAutoCloseTimer = null;
      }
    }

    function openIdentity(): void {
      identityRevealed.value = true;
      clearIdentityTimer();
      if (!isRoleRevealPhase.value) {
        identityAutoCloseTimer = window.setTimeout(() => {
          identityAutoCloseTimer = null;
          identityRevealed.value = false;
        }, IDENTITY_AUTO_CLOSE_MS);
      }
    }

    function closeIdentity(): void {
      clearIdentityTimer();
      identityRevealed.value = false;
    }

    function toggleIdentity(): void {
      if (identityRevealed.value) closeIdentity();
      else openIdentity();
    }

    function hideIdentityOnBackground(): void {
      closeIdentity();
    }

    // 阶段一变（尤其是房主按下「天黑请闭眼」）就强制盖上身份牌。
    watch(
      () => state.game?.phase,
      () => {
        closeIdentity();
      },
    );

    onMounted(() => {
      document.addEventListener('visibilitychange', hideIdentityOnBackground);
      window.addEventListener('blur', hideIdentityOnBackground);
    });
    onUnmounted(() => {
      closeIdentity();
      document.removeEventListener('visibilitychange', hideIdentityOnBackground);
      window.removeEventListener('blur', hideIdentityOnBackground);
    });

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
      if (typeof v === 'boolean') {
        if (g.phase === 'NIGHT_GRAVE_KEEPER') return '你已知晓今天的放逐查验结果';
        return v ? '你选择了上警' : '你选择了不上警';
      }
      if (v.kind === 'hybrid') return '你选择了 ' + v.target + ' 号作为榜样';
      if (v.kind === 'mechanicalLearn') return '你学习了 ' + v.target + ' 号的身份';
      if (v.kind === 'dancer') return '你选择了 ' + v.targets.join('、') + ' 号进入舞池';
      if (v.kind === 'maskInspect') return '你查验了 ' + v.target + ' 号，现在请选择戴面具目标';
      if (v.kind === 'mask') return '你给 ' + v.target + ' 号戴上了面具';
      if (v.kind === 'dreamer') return '你选择了 ' + v.target + ' 号成为梦游者';
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
        // 身份确认有专门的界面块（身份牌 + 确认按钮 + 房主的按钮），
        // 走通用行动面板只会多出一块看不懂的东西。
        case 'ROLE_REVEAL':
          return null;
        case 'NIGHT_HYBRID': {
          if (role !== 'HYBRID') return waitPanel('混血儿正在选择榜样', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'hybrid', title: '选择你的榜样',
            detail: '你的个人胜负将跟随榜样阵营，但你不会得知他的身份或阵营；预言家查验你始终是好人。',
            confirm: '确认榜样', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_MECHANICAL': {
          if (role !== 'MECHANICAL_WOLF') return waitPanel('机械狼正在学习身份', '请闭眼等待。');
          // 原来这里是一句「身份学习已完成 / 你只能学习一次…」——
          // 把「学到了什么」这件唯一重要的事整个漏掉了。
          const learned = me.value?.mechanicalLearnedRole;
          if (learned) {
            return resultPanel({
              label: '你学习到的身份',
              value: me.value?.mechanicalLearnedRoleName || ROLE_NAME[learned],
              tone: isWolfRole(learned) ? 'wolf' : learned === 'VILLAGER' ? 'info' : 'good',
              note: isWolfRole(learned)
                ? '学到了狼人：从下一夜起你会加入狼队一起刀人。'
                : '复制技能从下一夜开始生效；你目前不认识普通狼人。',
            });
          }
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'mechanical', title: '学习一名玩家的身份',
            detail: '你会得知他的具体身份，并从下一夜起继承对应技能；你目前不认识普通狼人。',
            confirm: '确认学习', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_DANCER': {
          if (role !== 'DANCER') return waitPanel('舞者正在选择舞池', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'dancer', title: '选择三名玩家进入舞池',
            detail: '每名玩家整局只能进入一次舞池，可以选择自己。三人阵营为 2 比 1 时，少数阵营玩家出局。',
            confirm: '确认舞池', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_MASK': {
          if (role !== 'MASK') return waitPanel('假面正在行动', '请闭眼等待。');
          const inspected = me.value?.maskInspect;
          // 两步行动：第一步查完舞池就要立刻把结果摆出来，
          // 原来的写法把它塞进第二步的说明文字里，等于没显示。
          const maskResult: ResultInfo | null =
            me.value?.maskNeedsDisguise && inspected
              ? {
                  label: '舞池查验结果',
                  value: `${inspected.seat} 号${inspected.inDance ? '在舞池里' : '不在舞池里'}`,
                  tone: 'info',
                  note: '接下来给一名玩家戴面具 —— 面具会把舞池结算的阵营反过来。',
                }
              : null;
          if (acted && !maskResult) return donePanel(submittedText.value);
          return {
            mode: 'mask',
            title: me.value?.maskNeedsDisguise ? '选择戴面具目标' : '查验一名玩家是否在舞池',
            detail: me.value?.maskNeedsDisguise
              ? '现在请选择一名玩家戴面具；可以与查验目标相同，也可以选择自己。'
              : '查验与戴面具是同一夜的两步行动。查验目标不能与上一夜相同。',
            result: maskResult,
            confirm: me.value?.maskNeedsDisguise ? '确认戴面具' : '确认查验',
            skip: '', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_DREAMER': {
          if (role !== 'DREAMER') return waitPanel('摄梦人正在选择梦游者', '请闭眼等待。');
          if (acted) return donePanel(submittedText.value);
          const previous = me.value?.lastDreamedSeat;
          return {
            mode: 'dreamer',
            title: '选择今晚的梦游者',
            detail:
              previous === null || previous === undefined
                ? '梦游者当夜免疫夜间伤害；摄梦人夜里死亡时，梦游者也会出局。不能选择自己，也不能跳过。'
                : `梦游者当夜免疫夜间伤害。注意：${previous} 号是上一夜目标，再次选择会令其出局。`,
            confirm: '确认摄梦', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
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
              confirm: '确认毒杀', skip: '不用毒药', showAntidote: false, canSave: false, saveBlocked: '',
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
           
            canSave: g.witchInfo ? g.witchInfo.canSave : false,
            saveBlocked: g.witchInfo && g.witchInfo.saveBlockedReason ? g.witchInfo.saveBlockedReason : '',
          };
        }
        case 'NIGHT_SEER': {
          const copied = role === 'MECHANICAL_WOLF' && me.value?.mechanicalLearnedRole === 'SEER' && me.value.mechanicalSkillActive;
          if (role !== 'SEER' && !copied) return waitPanel('预言家正在查验', '请闭眼等待。');
          if (acted) {
            // 复制查验走服务端下发的文案（引擎没有把它放进 seerHistory）
            if (copied) {
              return resultPanel({
                label: '复制查验（阵营）',
                value: g.phaseHint || submittedText.value,
                tone: 'info',
                note: '复制技能验出来的结果同样只有你自己看得到。',
              });
            }
            // 真实预言家：用结构化数据渲染，不靠解析文案
            const last = me.value?.seerHistory?.at(-1);
            if (last) {
              return resultPanel({
                label: '查验结果',
                value: `${last.seat} 号（${last.nickname}）是${last.camp === 'WOLF' ? '狼人' : '好人'}`,
                tone: last.camp === 'WOLF' ? 'wolf' : 'good',
                note: '只有你看得到。天亮后靠发言把它用出去，别把这句念出声。',
              });
            }
            return donePanel(g.phaseHint || submittedText.value);
          }
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
        case 'NIGHT_SPIRIT_SEER': {
          const copied = role === 'MECHANICAL_WOLF' && me.value?.mechanicalLearnedRole === 'SPIRIT_SEER' && me.value.mechanicalSkillActive;
          if (role !== 'SPIRIT_SEER' && !copied) return waitPanel('通灵师正在查验', '请闭眼等待。');
          if (acted) {
            const last = copied ? null : me.value?.spiritHistory?.at(-1);
            if (last) {
              return resultPanel({
                label: '通灵结果',
                value: `${last.seat} 号（${last.nickname}）的身份是${last.roleName}`,
                tone: isWolfRole(last.role) ? 'wolf' : 'good',
                note: '通灵能看到具体身份，包括神职。这条信息只有你自己知道。',
              });
            }
            return resultPanel({
              label: '复制通灵结果',
              value: g.phaseHint || submittedText.value,
              tone: 'info',
              note: '复制技能验出来的结果同样只有你自己看得到。',
            });
          }
          return {
            mode: 'spirit', title: '查验具体身份',
            detail: copied ? '使用复制的通灵能力，查验一名玩家的具体身份。' : '选择一名玩家，你会得知他的具体角色。',
            confirm: '确认查验', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'NIGHT_GRAVE_KEEPER': {
          if (role !== 'GRAVE_KEEPER') return waitPanel('守墓人正在查看放逐结果', '请闭眼等待。');
          // 结果在阶段一开始就下发了（不依赖点「我已知晓」），所以这里优先展示它，
          // 同时保留「我已知晓」按钮让阶段能正常收束。
          const lastGrave = me.value?.graveHistory?.at(-1);
          const graveResult: ResultInfo | null =
            lastGrave && lastGrave.seat !== null
              ? {
                  label: `第 ${lastGrave.day} 天被放逐者的阵营`,
                  value: `${lastGrave.seat} 号（${lastGrave.nickname ?? '?'}）是${lastGrave.isWolf ? '狼人' : '好人'}`,
                  tone: lastGrave.isWolf ? 'wolf' : 'good',
                  note: '守墓人只能查「被投票放逐」的人，查不到夜里死的。',
                }
              : null;
          if (acted) {
            return {
              ...donePanel(submittedText.value),
              result: graveResult,
            };
          }
          return {
            mode: 'graveKeeper',
            title: '查验昨天的放逐结果',
            detail: g.phaseHint,
            result: graveResult,
            confirm: '我已知晓', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'SHERIFF_SIGNUP': {
          if (!me.value?.alive) return waitPanel('警长竞选报名', '你已经出局，请等待存活玩家选择。');
          if (acted) return donePanel(submittedText.value + '，等待其他玩家…');
          return {
            mode: 'sheriffSignup', title: '是否上警竞选',
            detail: '上警者发表竞选发言，但不能参加警下投票；不上警者保留选警长的投票权。',
            confirm: '', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
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
            confirm: '', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'SHERIFF_VOTE':
        case 'SHERIFF_REVOTE': {
          if (!g.myTurn && !acted) {
            const waiting = waitPanel('警下正在投票', '候选人没有投票权，请等待投票结果。');
            return waiting;
          }
          if (acted) return donePanel(submittedText.value + '，等待其他人投票…');
          return {
            mode: 'vote', title: g.phase === 'SHERIFF_REVOTE' ? 'PK 重新投票' : '投票选出警长',
            detail: g.phase === 'SHERIFF_REVOTE' ? '只能投给 PK 候选人；再次平票，警徽流失。' : '只能投给警上候选人，也可以弃票。',
            confirm: '确认投票', skip: '弃票', showAntidote: false, canSave: false, saveBlocked: '',
          };
        }
        case 'DAY_SPEECH': {
          return {
            mode: 'speech', title: '依次发言',
            detail: g.sheriffSeat === null ? '请按照页面显示的建议顺序发言。' : '警长指定方向后，从警长相邻座位开始，警长最后发言并归票。',
            confirm: '', skip: '', showAntidote: false, canSave: false, saveBlocked: '',
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
            // 白天公开区域所有玩家保持一致；白狼王私有提示只在按住身份后通过按钮呈现。
            detail: '得票最多者被放逐出局；出现平票则本轮无人出局。',
            confirm: '确认投票',
            skip: '弃票',
            showAntidote: false,
            canSave: false,
            saveBlocked: '',
          };
        }
        case 'HUNTER_SHOOT': {
          const shooterName = g.shooterRoleName ?? '持枪玩家';
          if (!me.value || g.hunterPendingSeat !== me.value.seat) {
            return waitPanel(shooterName + '正在决定是否开枪', '请等待对方的选择。');
          }
          if (acted) return donePanel(submittedText.value);
          return {
            mode: 'hunter',
            title: '你是' + shooterName + '，可以开枪',
            detail: '选择一名玩家带走，也可以放弃开枪。',
            confirm: '确认开枪',
            skip: '放弃开枪',
            showAntidote: false,
           
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
            canSave: false, saveBlocked: '',
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
        return {
          cls: 'warn',
          text: (g.shooterRoleName ?? '持枪玩家') + '（' + g.hunterPendingSeat + ' 号）出局，正在决定是否开枪。',
        };
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

    /**
     * 阶段徽标。
     *
     * 「查看身份牌」既不是白天也不是黑夜 —— 发牌之后天还没黑。
     * 原来这里只判断 isNight，于是这个阶段被显示成「☀️ 白天 · 查看身份牌」，
     * 看起来像是天亮了才发牌，很别扭。
     */
    const phaseBadge = computed(() => {
      const phase = state.game?.phase ?? '';
      if (phase === 'ROLE_REVEAL') return { text: '🃏 发牌', color: '#ffd79a' };
      return isNight.value
        ? { text: '🌙 天黑', color: '#9dc0ff' }
        : { text: '☀️ 白天', color: '#ffd79a' };
    });

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
      // 第一夜的**任何**夜间阶段都算第一夜（服务端也是这个判断，两边必须一致）
      const firstNight = game?.day === 1 && (game?.phase.startsWith('NIGHT_') ?? false);
      const mySeat = me.value?.seat;
      /**
       * 悍跳位是不是被**队友**占着。
       *
       * 关键在于排除自己：原来是「只要有人占就禁用所有人的按钮」，
       * 于是占着悍跳位的人连自己的按钮都是灰的 —— 想取消都点不了，更别说让位。
       * 现在是自己占着 = 可以点（点了就取消、让给队友），队友占着才禁用。
       */
      const fakeSeerHeldByOther =
        game?.wolfTags?.some((entry) => entry.tag === 'FAKE_SEER' && entry.seat !== mySeat) ?? false;
      const iAmFakeSeer = me.value?.myWolfTag === 'FAKE_SEER';
      return ALL_WOLF_TAGS.map((tag) => ({
        value: tag,
        label: WOLF_TAG_LABEL[tag],
        exclusive: EXCLUSIVE_WOLF_TAGS.includes(tag),
        /** 需要再选一个人（当前只有狼踩狼） */
        paired: tag === 'WOLF_VS_WOLF',
        mine: me.value?.myWolfTag === tag,
        disabled:
          !canEditTag.value ||
          // 悍跳位：过了第一夜就定死了；第一夜之内只要不是队友占着就能点（自己占着＝点了取消）
          (tag === 'FAKE_SEER' && (!firstNight || fakeSeerHeldByOther)) ||
          // 占着悍跳位的人：第一夜之内可以换别的，过了第一夜就跟着一起锁死
          (tag !== 'FAKE_SEER' && iAmFakeSeer && !firstNight),
      }));
    });

    /** 狼踩狼可以踩谁（服务端下发的候选，客户端不做规则判断） */
    const wolfVsWolfTargets = computed(() => me.value?.myWolfTagTargets ?? []);

    /** 我正在给狼踩狼选对象（点了狼踩狼但还没选人） */
    const pickingWolfVsWolf = ref(false);

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
        // 狼踩狼：把「踩谁」和「有没有互指成功」都摆出来
        paired: w.tag === 'WOLF_VS_WOLF',
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        text:
          w.tag === 'WOLF_VS_WOLF' && w.target !== null && w.target !== undefined
            ? `${w.seat} 狼踩狼 ${w.target}${w.paired ? '' : '（对方还没确认）'}`
            : '',
        unconfirmed: w.tag === 'WOLF_VS_WOLF' && w.paired === false,
      }));
    });

    const myTagDesc = computed(() => {
      const tag = me.value?.myWolfTag;
      if (!tag) {
        return '点按钮给自己挂个战术标签，狼队友都能看到。悍跳位、深水、倒钩、冲锋狼四个位置全队只能有一人；上警可以多人；狼踩狼需要两人互指。第一夜之内随时可以取消或换人；悍跳位过了第一夜就不能再改。';
      }
      if (tag === 'FAKE_SEER') {
        return '你占着悍跳位。第一夜结束前随时可以再点一下让给队友；狼队获胜时你额外获得 1 分。';
      }
      if (tag === 'WOLF_VS_WOLF') {
        const target = me.value?.myWolfTagTarget;
        if (target === null || target === undefined) return WOLF_TAG_DESC.WOLF_VS_WOLF;
        return `你填的是「${me.value?.seat} 狼踩狼 ${target}」。要等 ${target} 号也反过来指你，这一对才算成立。`;
      }
      return `${WOLF_TAG_DESC[tag]}（再点一下可以取消，让给队友）`;
    });

    const canEditTag = computed(() => me.value?.canEditWolfTag === true);

    function toggleTag(tag: WolfTag): void {
      if (!canEditTag.value) return;
      if (me.value?.myWolfTag === tag) {
        setWolfTag(null);
        pickingWolfVsWolf.value = false;
        return;
      }
      // 狼踩狼要先选人：光有标签没有对象，服务端会拒绝，不如先在界面上选完
      if (tag === 'WOLF_VS_WOLF') {
        pickingWolfVsWolf.value = true;
        return;
      }
      pickingWolfVsWolf.value = false;
      setWolfTag(tag);
    }

    function pickWolfVsWolfTarget(target: number): void {
      pickingWolfVsWolf.value = false;
      setWolfTag('WOLF_VS_WOLF', target);
    }

    // ───────────── 骑士决斗（白天发言阶段，整局一次） ─────────────

    /** 是否显示决斗入口：以服务端下发的 canDuel 为准，客户端不做规则判断 */
    const canDuel = computed(() => me.value?.canDuel === true);
    const pickingDuel = ref(false);

    /** 决斗可选目标：除自己外的存活玩家（从公开的死亡名单反推） */
    const duelTargets = computed<number[]>(() => {
      const g = state.game;
      if (!g) return [];
      const capacity = state.room?.board.playerCount ?? 0;
      const dead = new Set(g.deaths.map((d) => d.seat));
      const mySeat = me.value?.seat;
      const out: number[] = [];
      for (let seat = 1; seat <= capacity; seat++) {
        if (seat === mySeat || dead.has(seat)) continue;
        out.push(seat);
      }
      return out;
    });

    /**
     * 决斗是不可逆操作：押错对象自己直接出局，
     * 必须弹窗确认（和公示、自爆、解散同一待遇）。
     */
    function confirmDuel(target: number): void {
      pickingDuel.value = false;
      askConfirm(
        {
          title: '向 ' + target + ' 号（' + nicknameOf(target) + '）发起决斗',
          message:
            '决斗整局只能发动一次：对方是狼人则当场出局；是好人则你自己出局。' +
            '决斗后当天的发言和投票照常进行。确定要翻牌吗？',
          confirmText: '翻牌决斗',
          cancelText: '再想想',
          danger: true,
        },
        (ok) => {
          if (ok) knightDuel(target);
        },
      );
    }

    /** 上帝视角：进之前必须先确认（进去等于放弃本局公平） */
    const godViewAvailable = computed(() => state.game?.godViewAvailable === true);

    // ───────────── 身份确认（发牌之后、天黑之前） ─────────────

    const roleReveal = computed(() => state.game?.roleReveal ?? null);

    /**
     * 本局版型（公开信息）。
     * 身份确认时把它摆在眼前，方便大家对照「这局有哪些角色」来想自己的定位 ——
     * 板子是开局前就公示的，所以放出来不含任何隐藏信息。
     */
    const boardSummary = computed(() => state.room?.boardSummary ?? '');

    /** 「还差 3、7 号」这种提示。房主照着这个喊人就行 */
    const pendingRoleText = computed(() => {
      const view = roleReveal.value;
      if (!view || view.pendingSeats.length === 0) return '';
      return view.pendingSeats.join('、') + ' 号';
    });
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
     * 身份牌内的自爆入口（点开身份牌才能看到，只有能自爆的狼会渲染）。
     * - 白狼王：点了直接生效 —— 后面还有「选带谁走」一步，本身就是二次确认；
     * - 普通狼：空爆即死、没有任何后续步骤，必须弹确认框说清后果。
     * 生效后立刻合上身份牌：自爆从此是公开信息，卡没必要再开着。
     */
    function selfDestructFromCard(): void {
      if (me.value?.role === 'WOLF_KING') {
        selfDestruct();
        closeIdentity();
        return;
      }
      askConfirm(
        {
          title: '自爆（空爆）',
          message: '空爆后你立刻出局，不带走任何人；随后直接进入黑夜，今天不再发言与投票。' +
            '如果现在还在警长竞选期间，本局警徽流失。',
          confirmText: '空爆',
          cancelText: '再想想',
          danger: true,
        },
        (ok) => {
          if (ok) {
            selfDestruct();
            closeIdentity();
          }
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
      if (!g || g.phase !== 'NIGHT_WOLVES' || !g.wolfVotes) return null;

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

    /**
     * 「唯邻是从」的傀儡面板。
     *
     * 只在**狼人**的视图里存在 —— 服务端只给狼队下发 `puppetInfo`，
     * 所以好人（尤其是傀儡本人）这里的 computed 直接算出 null，
     * 界面上连这一块都渲染不出来。
     */
    const puppetPanel = computed(() => {
      const g = state.game;
      const info = g?.puppetInfo;
      if (!g || !info) return null;
      if (g.phase !== 'NIGHT_WOLVES' && info.chosen === null) return null;
      return { candidates: info.candidates, votes: info.votes, chosen: info.chosen };
    });

    /** 首夜还没选傀儡（确定按钮要因此置灰） */
    const puppetNotChosen = computed(
      () => (puppetPanel.value?.candidates.length ?? 0) > 0 && state.selectedPuppet === null,
    );

    /**
     * 试听某一套语音包（不改变当前选择）—— 局内也能试，免得换完才发现不好听。
     */
    function previewPack(packId: string): void {
      unlockVoice();
      void previewPackClips(packId, ['close.wolves', 'open.seer']);
    }

    async function choosePack(packId: string): Promise<void> {
      const ok = await chooseVoicePack(packId);
      if (!ok) {
        showToast('这套语音包加载失败，换一套试试', 'warn');
        return;
      }
      packPickerOpen.value = false;
    }

    /** 音色选择器默认折叠，别在对局界面占一大块 */
    const packPickerOpen = ref(false);

    /** 读两个响应式字段，让 computed 能在加载完成 / 换包后重新计算 */
    const voicePackInfo = computed(() => {
      void state.voicePackReady;
      void state.voiceRevision;
      return voicePackStatus();
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
      phaseBadge,
      teammateText,
      speechOrderText,
      voicePackInfo,
      packPickerOpen,
      previewPack,
      choosePack,
      wolfPanel,
      puppetPanel,
      puppetNotChosen,
      pickPuppet,
      identityRevealed,
      toggleIdentity,
      closeIdentity,
      selfDestructFromCard,
      canDuel,
      pickingDuel,
      duelTargets,
      confirmDuel,
      acknowledgeGraveCheck,
      isRoleRevealPhase,
      roleReveal,
      boardSummary,
      confirmRole,
      beginNight,
      pendingRoleText,
      canConfirm,
      canWithdrawSheriff,
      canChooseSpeechDirection,
      showVoiceToggle,
      voiceLabel,
      countdownActive,
      wolfTagOptions,
      wolfTagRows,
      wolfVsWolfTargets,
      pickingWolfVsWolf,
      pickWolfVsWolfTarget,
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
            <div class="phase" :style="{ color: phaseBadge.color }">
              {{ phaseBadge.text }} · {{ game.phaseTitle }}
            </div>
            <div class="tiny muted">第 {{ game.day }} 天</div>
          </div>
          <div class="center">
            <div v-if="isNight && remainingMs !== null" class="countdown">{{ formatClock(remainingMs) }}</div>
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

      <!-- 身份确认：发牌之后、天黑之前 -->
      <div
        v-if="game.phase === 'ROLE_REVEAL' && roleReveal"
        class="panel"
        style="border-color: var(--accent); background: rgba(79,140,255,0.07);"
      >
        <div class="row-between">
          <div class="grow">
            <div class="small" style="font-weight: 600;">查看你的身份牌</div>
            <div class="tiny muted" style="margin-top: 4px;">
              点下方身份牌翻开看清你的角色和能力。全员确认后，房主才会开始第一夜。
            </div>
          </div>
          <div class="mono" style="font-size: 20px; color: var(--accent); flex-shrink: 0;">
            {{ roleReveal.confirmedSeats.length }}/{{ roleReveal.total }}
          </div>
        </div>

        <!-- 本局版型：公开信息，摆在眼前方便对照自己的定位 -->
        <template v-if="boardSummary">
          <div class="spacer"></div>
          <div class="tiny muted">本局版型：{{ boardSummary }}</div>
        </template>

        <!-- 谁还没确认（公开信息：牌桌上房主本来就会喊「谁还没好？」） -->
        <div class="spacer"></div>
        <div v-if="roleReveal.pendingSeats.length === 0" class="small" style="color: var(--good);">
          全员已确认，等房主按「天黑请闭眼」。
        </div>
        <div v-else class="small" style="color: var(--warn);">
          还没确认：{{ pendingRoleText }}
        </div>

        <div class="spacer"></div>

        <!-- 玩家的确认按钮 -->
        <button
          v-if="me && !roleReveal.iConfirmed"
          class="primary"
          @click="confirmRole"
        >
          我已看清我的身份
        </button>
        <button v-else-if="me" disabled>
          ✓ 你已确认
        </button>

        <!-- 房主的按钮：硬门槛没过就是灰的，并且直接把差谁写在按钮上 -->
        <template v-if="roleReveal.iAmHost">
          <div class="spacer"></div>
          <button
            class="primary"
            :disabled="!roleReveal.canBeginNight"
            @click="beginNight"
          >
            {{ roleReveal.canBeginNight ? '天黑请闭眼（开始第一夜）' : '还差 ' + roleReveal.pendingSeats.length + ' 人确认' }}
          </button>
          <div v-if="!roleReveal.canBeginNight" class="tiny muted center" style="margin-top: 6px;">
            要等在线的人全部确认才能开始。掉线的人不会挡住进度。
          </div>
        </template>
        <div v-else class="spacer"></div>
        <div v-if="!roleReveal.iAmHost" class="tiny muted center">
          等房主确认所有人都看过牌之后，由他按下「天黑请闭眼」。
        </div>
      </div>

      <!-- 我的身份 -->
      <div class="rolecard" :class="{ revealed: identityRevealed }">
        <div class="row-between">
          <div>
            <div class="tiny muted">{{ identityRevealed ? '我的身份' : '身份已遮蔽' }}</div>
            <div class="row" style="margin-top: 3px;">
              <span v-if="identityRevealed" class="role">{{ me ? me.roleName : '观众' }}</span>
              <span v-else class="role role-hidden" aria-hidden="true">••••</span>
              <span v-if="me" class="badge identity-seat">{{ me.seat }} 号</span>
            </div>
          </div>
          <button
            type="button"
            class="sm ghost role-hold"
            :class="{ 'is-revealed': identityRevealed }"
            :aria-label="identityRevealed ? '合上身份牌' : '点开身份牌'"
            @click="toggleIdentity"
            @keydown.space.prevent="toggleIdentity"
            @keydown.enter.prevent="toggleIdentity"
            @contextmenu.prevent
          >
            {{ identityRevealed ? '合上身份牌' : '点开身份牌' }}
          </button>
        </div>

        <template v-if="identityRevealed && me">
          <div class="spacer"></div>
          <div class="small muted">{{ me.roleDesc }}</div>

          <!-- 自爆入口在卡内：只有点开身份牌才能看到，且只给能自爆的狼渲染。
               白狼王直接生效（后面还有选目标一步）；普通狼空爆弹确认。 -->
          <template v-if="me.canSelfDestruct">
            <div class="spacer"></div>
            <button
              v-if="me.role === 'WOLF_KING'"
              class="danger"
              style="width: 100%;"
              @click="selfDestructFromCard"
            >自爆并带走一人（今天不再投票）</button>
            <button
              v-else
              class="danger"
              style="width: 100%;"
              @click="selfDestructFromCard"
            >空爆（不带人，今天不再投票）</button>
            <div class="tiny muted" style="margin-top: 4px;">
              自爆是公开操作，全场会听到播报；警长竞选期间自爆，本局警徽流失。
            </div>
          </template>

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

          <template v-if="me.dreamHistory && me.dreamHistory.length">
            <div class="spacer"></div>
            <div class="small"><span class="badge accent">摄梦记录</span></div>
            <div class="small" style="margin-top: 4px;">
              <div v-for="h in me.dreamHistory" :key="h.day">
                第 {{ h.day }} 夜：{{ h.seat }} 号（{{ h.nickname }}）
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
          <span v-else-if="panel.result" class="badge accent">仅你可见</span>
        </div>

        <!--
          验人结果单独占一块，大号 + 颜色。
          它原来是塞在下面那行灰色小字里的 —— 标题写着「已提交」，
          真正要的信息是小灰字，玩家一抬眼就会以为自己什么都没验出来。
        -->
        <div
          v-if="panel.result"
          class="result-box"
          :class="'tone-' + panel.result.tone"
        >
          <div class="tiny muted">{{ panel.result.label }}</div>
          <div class="result-value">{{ panel.result.value }}</div>
          <div class="tiny" style="margin-top: 8px; opacity: 0.75;">{{ panel.result.note }}</div>
        </div>

        <!-- 有结果时就不再重复一遍说明文字 -->
        <template v-if="!panel.result">
          <div class="spacer"></div>
          <div class="small muted">{{ panel.detail }}</div>
        </template>

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

        <!-- 骑士决斗：只在白天发言阶段、本人是骑士且未用过时出现（服务端裁决，客户端只展示） -->
        <template v-if="panel.mode === 'speech' && canDuel && identityRevealed && !pickingDuel">
          <div class="spacer"></div>
          <button class="danger" @click="pickingDuel = true">翻牌决斗（整局一次）</button>
        </template>
        <template v-if="panel.mode === 'speech' && pickingDuel">
          <div class="spacer"></div>
          <div class="banner wolf" style="margin-bottom: 0;">
            <div class="small" style="font-weight: 600;">选择你要决斗的对象</div>
            <div class="tiny muted" style="margin-top: 4px;">
              他是狼人则当场出局，是好人则你自己出局。决斗整局只能发动一次，点了会有二次确认。
            </div>
          </div>
          <div class="spacer"></div>
          <div class="row wrap" style="gap: 6px;">
            <button
              v-for="seat in duelTargets"
              :key="seat"
              class="sm"
              @click="confirmDuel(seat)"
            >{{ seat }} 号</button>
          </div>
          <div class="spacer"></div>
          <button class="sm ghost" @click="pickingDuel = false">取消</button>
        </template>

        <!-- 守墓人：结果已由服务端写进 phaseHint，这里只放一个「我已知晓」 -->
        <template v-if="panel.mode === 'graveKeeper' && game.myTurn && !hasActed">
          <div class="spacer"></div>
          <button class="primary" @click="acknowledgeGraveCheck">我已知晓</button>
        </template>

        <!-- 自爆/空爆的入口在身份牌卡内（点开后可见），这里没有相关按钮。 -->
        <template v-if="panel.showAntidote">
          <div class="spacer"></div>
          <button class="good" :disabled="!panel.canSave" @click="useAntidote">使用解药救他</button>
          <div v-if="panel.saveBlocked" class="tiny muted center" style="margin-top: 6px;">
            {{ panel.saveBlocked }}
          </div>
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
      <div v-if="isNight && game.wolfTags" class="panel">
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
          >{{ opt.label }}<template v-if="opt.paired"> ⚔</template></button>
        </div>
        <div class="tiny muted" style="margin-top: 6px;">{{ myTagDesc }}</div>

        <!-- 狼踩狼：先选踩谁。光有标签没有对象，服务端会拒绝 -->
        <template v-if="pickingWolfVsWolf">
          <div class="spacer"></div>
          <div class="banner warn" style="margin-bottom: 0;">
            <div class="small" style="font-weight: 600;">狼踩狼：选一个你要踩的狼队友</div>
            <div class="tiny muted" style="margin-top: 4px;">
              一般是悍跳狼去踩另一只狼 —— 用队友的命换自己的身份。对方也要反过来选你，这一对才算成立。
            </div>
          </div>
          <div class="spacer"></div>
          <div class="row wrap" style="gap: 6px;">
            <button
              v-for="seat in wolfVsWolfTargets"
              :key="seat"
              class="sm"
              @click="pickWolfVsWolfTarget(seat)"
            >{{ seat }} 号</button>
          </div>
          <div class="spacer"></div>
          <button class="sm ghost" @click="pickingWolfVsWolf = false">取消</button>
        </template>

        <div class="spacer"></div>
        <div v-for="w in wolfTagRows" :key="w.seat" class="row-between" style="padding: 4px 0;">
          <span class="small">
            {{ w.seat }} 号（{{ w.nickname }}）
            <span v-if="w.isMe" class="muted">（我）</span>
          </span>
          <span class="badge" :class="w.has ? (w.unconfirmed ? '' : 'wolf') : ''">
            {{ w.text || w.label }}
          </span>
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

      <!--
        「唯邻是从」首夜：狼队在刀人之外还要选一名傀儡。
        只在这个板子的首夜出现（服务端只在候选人非空时才下发）。
      -->
      <div v-if="puppetPanel" class="panel">
        <div class="row-between">
          <h3 style="margin: 0;">选一名傀儡</h3>
          <span class="badge wolf">仅狼人可见</span>
        </div>
        <div class="spacer"></div>
        <div class="tiny muted">
          只能从<b>与狼相邻的好人</b>里选。被选中的人<b>不会知道自己变了</b>，
          继续按原身份操作，但技能会失效或反转。三狼已知晓他是谁，以后要一直记得。
        </div>
        <div class="spacer"></div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <button
            v-for="seat in puppetPanel.candidates"
            :key="seat"
            class="tiny-btn"
            :class="{ primary: seat === state.selectedPuppet }"
            @click="pickPuppet(seat)"
          >
            {{ seat }} 号{{ seat === puppetPanel.chosen ? '（已定）' : '' }}
          </button>
        </div>
        <div v-if="puppetPanel.votes.length" class="spacer"></div>
        <div v-if="puppetPanel.votes.length" class="tiny muted">
          队友投票：
          <span v-for="v in puppetPanel.votes" :key="v.seat" style="margin-right: 8px;">
            {{ v.seat }} 号 → {{ v.target }} 号
          </span>
        </div>
        <template v-if="puppetPanel.chosen !== null && puppetPanel.candidates.length === 0">
          <div class="spacer"></div>
          <div class="small">
            已定：<b>{{ puppetPanel.chosen }} 号</b>（他本人不知道）
          </div>
        </template>
      </div>

      <!-- 座位盘 -->
      <div class="panel">
        <div class="row-between">
          <h3 style="margin: 0;">场上局势</h3>
          <span v-if="game.sheriffSeat !== null" class="badge gold">🚨 {{ game.sheriffSeat }} 号警长</span>
          <span v-else-if="game.sheriffElectionFinished" class="badge">无警徽</span>
        </div>
        <div class="spacer"></div>
        <SeatGrid :reveal-private-identity="identityRevealed" />
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
        <!-- 法官音色：局内也能换，每台手机自己挑自己听的。默认折叠，免得占地方 -->
        <template v-if="voicePackInfo.state === 'ready' && voicePackInfo.packs.length > 0">
          <div class="spacer"></div>
          <button type="button" class="voice-picker-toggle" @click="packPickerOpen = !packPickerOpen">
            <span class="grow">🎙 法官音色：<b>{{ voicePackInfo.label }}</b></span>
            <span class="tiny muted">{{ packPickerOpen ? '收起 ▴' : '更换 ▾' }}</span>
          </button>
          <template v-if="packPickerOpen">
            <div class="tiny muted" style="margin: 8px 0 6px;">
              {{ voicePackInfo.packs.length }} 个可选 · 只影响你自己这台手机
            </div>
            <div class="voice-packs">
              <div
                v-for="pack in voicePackInfo.packs"
                :key="pack.id"
                class="voice-pack"
                :class="{ picked: pack.id === voicePackInfo.packId }"
              >
                <button
                  type="button"
                  class="voice-pack-name"
                  :aria-pressed="pack.id === voicePackInfo.packId"
                  @click="choosePack(pack.id)"
                >
                  <span class="voice-pack-check">{{ pack.id === voicePackInfo.packId ? '●' : '○' }}</span>
                  {{ pack.label }}
                </button>
                <button type="button" class="tiny-btn" @click="previewPack(pack.id)">试听</button>
              </div>
            </div>
          </template>
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
          <template v-if="panel && game.myTurn && !hasActed && panel.mode !== 'sheriffSignup' && panel.mode !== 'graveKeeper'">
            <!--
              「唯邻是从」首夜：傀儡没选就不让确认。
              服务端本来也会拒绝（首夜必须选傀儡），但把按钮直接置灰
              比让玩家点了才发现被拒要好得多。
            -->
            <div v-if="puppetNotChosen" class="grow small warn center">
              还没选傀儡 —— 首夜必须从上面那排候选人里选一个
            </div>
            <template v-else>
              <button class="primary grow" :disabled="!canConfirm" @click="confirmSelection">
                {{ panel.confirm || '确认' }}
              </button>
              <button v-if="canConfirm" class="sm ghost" @click="clearSelection">取消</button>
              <button v-if="panel.skip" class="sm" @click="skipAction">{{ panel.skip }}</button>
            </template>
          </template>

          <template v-else-if="hasActed">
            <div class="grow small muted center">已提交，等待其他玩家…</div>
          </template>

          <template v-else>
            <div class="grow small muted center">{{ game.phaseHint }}</div>
          </template>
          <!--
            「跳过阶段」在身份确认阶段必须收起来。
            服务端会拒绝这个操作（硬门槛不允许被绕过），但把按钮摆在那里
            只会让房主反复点、反复失败，还以为是自己操作有问题。
            这一阶段的正确操作是上面的「天黑请闭眼」。
          -->
          <button
            v-if="isHost && !isRoleRevealPhase"
            class="sm ghost"
            @click="forceAdvance"
          >跳过阶段</button>
        </div>
      </div>
    </div>
  `,
});
