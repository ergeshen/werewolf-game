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
  ref,
} from '../../vendor/vue.esm-browser.prod.js';

import { BoardEditor } from '../components/BoardEditor.ts';
import { HallHistory } from '../components/HallHistory.ts';
import { SeatGrid } from '../components/SeatGrid.ts';
import { playSound, previewPackClips, unlockVoice, voicePackStatus } from '../voice.ts';
import { ROLE_DESC, ROLE_NAME, type Role } from '../../../src/shared/roles.ts';
import {
  canChangeVoice,
  chooseHexRole,
  chooseVoicePack,
  copyInvite,
  isHost,
  leaveWithConfirm,
  mySeat,
  refreshHallDashboard,
  setRoleWish,
  showToast,
  skipHexDraft,
  startGame,
  state,
  toggleReady,
  toggleVoice,
} from '../store.ts';

export const LobbyView = defineComponent({
  name: 'LobbyView',
  components: { SeatGrid, BoardEditor, HallHistory },
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
    const hexRemainingSeconds = computed(() => {
      const deadline = state.room?.hexDraft?.deadline;
      return deadline ? Math.max(0, Math.ceil((deadline - state.now) / 1000)) : 0;
    });

    function wishRoleName(role: Role): string {
      return ROLE_NAME[role];
    }

    function chooseWish(event: Event): void {
      const value = (event.target as HTMLSelectElement).value as Role | '';
      setRoleWish(value || null);
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

    /**
     * 试听某一套语音包（不改变当前选择）。
     *
     * 为什么要有这个按钮：语音包好不好听、手机出不出得了声，
     * 只有点一下才知道。等开局了才发现全场静音就晚了。
     * 而且它是**纯静态文件**，不依赖服务端下发任何东西。
     */
    function previewPack(packId: string): void {
      unlockVoice();
      // 播「狼人请闭眼。预言家请睁眼，请选择今晚要查验的玩家。」
      // 一次听清两件事：录音音色 + 句间停顿
      void previewPackClips(packId, ['close.wolves', 'open.seer']);
    }

    /** 选中某一套语音包（只影响本机播放）；选完自动收起，免得一直占着一大块 */
    async function choosePack(packId: string): Promise<void> {
      const ok = await chooseVoicePack(packId);
      if (!ok) {
        showToast('这套语音包加载失败，换一套试试', 'warn');
        return;
      }
      packPickerOpen.value = false;
    }

    /** 音色选择器默认折叠 */
    const packPickerOpen = ref(false);

    /**
     * 语音包列表 + 当前选中的那套。
     *
     * 先读两个响应式字段再取数据：语音包状态存在模块级变量里，
     * 不读一下响应式的东西，Vue 不会在加载完成/换包后重新计算。
     */
    const voicePackInfo = computed(() => {
      void state.voicePackReady;
      void state.voiceRevision;
      return voicePackStatus();
    });

    return {
      room,
      filled,
      capacity,
      notReady,
      startBlocker,
      readyLabel,
      iAmReady,
      voiceLocked,
      voicePackInfo,
      packPickerOpen,
      previewPack,
      choosePack,
      hexRemainingSeconds,
      ROLE_NAME,
      ROLE_DESC,
      wishRoleName,
      chooseWish,
      chooseHexRole,
      skipHexDraft,
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

      <!-- 就绪状态 -->
      <div class="panel">
        <div class="row-between">
          <h2 style="margin: 0;">创建第 {{ room.matchNumber }} 场游戏</h2>
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
        <!--
          语音包状态 + 选择器。
          **默认折叠**：一屏列出七八个音色太占地方，平时只需要看「现在用的是哪个」。
          点「更换」才展开，选完自动收起。
        -->
        <template v-if="voicePackInfo.state === 'ready' && voicePackInfo.packs.length > 0">
          <button type="button" class="voice-picker-toggle" @click="packPickerOpen = !packPickerOpen">
            <span class="grow">🎙 法官音色：<b>{{ voicePackInfo.label }}</b></span>
            <span class="tiny muted">{{ packPickerOpen ? '收起 ▴' : '更换 ▾' }}</span>
          </button>
          <template v-if="packPickerOpen">
            <div class="tiny muted" style="margin: 8px 0 6px;">
              {{ voicePackInfo.packs.length }} 个可选 · 只影响你自己这台手机，别人听不到
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
            <div class="tiny muted" style="margin-top: 6px;">
              点名字选中，点「试听」听效果。选中后会自动收起。
            </div>
          </template>
        </template>
        <div v-else class="tiny">
          <template v-if="voicePackInfo.state === 'missing'">
            <span class="muted">🎙 没找到录音语音包，正在用浏览器自带的语音合成（音色因手机而异）。</span>
          </template>
          <template v-else>
            <span class="muted">🎙 正在检查法官语音包…</span>
          </template>
        </div>
        <!-- 语音包装好了、服务端却不下发片段序列 = 服务端跑的还是旧代码 -->
        <template v-if="voicePackInfo.state === 'ready' && state.voiceCueSupport === false">
          <div class="banner warn" style="margin-top: 8px;">
            ⚠ 语音包已就绪，但服务端没有下发片段序列 —— 对局里听到的还会是系统机械音。
            <b>请重启服务端</b>（引擎代码是进程启动时载入的）。
          </div>
        </template>
        <div class="spacer"></div>
        <button class="tiny-btn" @click="previewGoldenLegend">▶ 试听「金色传说」</button>
        <div class="tiny muted" style="margin-top: 6px;">
          警长当选时会放的音效。先点一下确认手机出得了声。
        </div>
      </div>

      <!-- 版型配置 -->
      <BoardEditor />

      <!-- 普通模式连败愿望：只显示自己的状态，海克斯完全冻结。 -->
      <div v-if="room.mode === 'STANDARD' && room.roleWish.lossStreak > 0" class="panel">
        <h2 style="margin-top: 0;">愿望角色</h2>
        <div v-if="!room.roleWish.eligible" class="small muted">
          当前普通模式连续失利 {{ room.roleWish.lossStreak }} 场；连续两场后可以选择下一局更想体验的角色。
        </div>
        <template v-else>
          <div class="small">最近两场辛苦了。下一局你更想体验哪个角色？</div>
          <div class="tiny muted" style="margin: 5px 0 10px;">系统会私下提高抽中概率，但不保证获得。愿望仅你本人可见。</div>
          <select :value="room.roleWish.selected || ''" @change="chooseWish">
            <option value="">暂不选择</option>
            <option v-for="role in room.roleWish.options" :key="role" :value="role">{{ wishRoleName(role) }}</option>
          </select>
        </template>
      </div>

      <!-- 行动 -->
      <div class="panel">
        <template v-if="room.hexDraft">
          <h2 style="margin-top: 0;">选择你的身份牌</h2>
          <div class="tiny muted">{{ room.hexDraft.submitted }} / {{ room.hexDraft.total }} 人已选择 · 剩余 {{ hexRemainingSeconds }} 秒</div>
          <div class="spacer"></div>
          <template v-if="room.hexDraft.selected">
            <div class="banner good center">
              已锁定身份，等待其他玩家。你的选择不会展示给厅主或其他玩家。
            </div>
          </template>
          <div v-else class="row wrap" style="gap: 8px;">
            <button
              v-for="(role, index) in room.hexDraft.options"
              :key="role + '-' + index"
              class="grow"
              style="min-width: 130px;"
              @click="chooseHexRole(role)"
            >
              <b>{{ ROLE_NAME[role] }}</b>
              <span class="tiny" style="display:block; margin-top: 4px;">{{ ROLE_DESC[role] }}</span>
            </button>
          </div>
          <div v-if="isHost" class="spacer"></div>
          <button v-if="isHost" class="sm ghost" @click="skipHexDraft">房主结束选牌时间</button>
        </template>

        <button v-else-if="!isHost" :class="iAmReady ? '' : 'primary'" @click="toggleReady">
          {{ readyLabel }}
        </button>

        <template v-else-if="isHost">
          <button class="primary" :disabled="!room.canStart" @click="startGame">
            {{ room.canStart ? '开始游戏（发牌）' : '还不能开始' }}
          </button>
          <div class="spacer"></div>
          <div v-if="startBlocker" class="banner warn" style="margin-bottom: 0;">{{ startBlocker }}</div>
          <div v-else class="tiny muted center">你点击开始后，系统会按上面的版型随机发牌。</div>
        </template>

        <div v-if="!room.hexDraft && !isHost" class="spacer"></div>
        <div v-if="!room.hexDraft && !isHost" class="tiny muted center">点「我准备好了」，等房主开局。</div>
      </div>

      <!-- 所有已发生场次：即使当前玩家没有参赛也能看到场次与最终结果。 -->
      <HallHistory section="matches" />

      <!-- 大厅累计总榜放在页面最后。 -->
      <HallHistory section="scores" />
    </div>
  `,
});
