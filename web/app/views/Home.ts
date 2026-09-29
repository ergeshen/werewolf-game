/**
 * 首页：填昵称 → 创建房间 / 输入房间号加入。
 * 支持从分享链接 ?room=XXXXXX 自动带入房间号（微信里转发给朋友的主要入口）。
 */

import { computed, defineComponent, onMounted, onUnmounted } from '../../vendor/vue.esm-browser.prod.js';

import {
  ALL_ROLES,
  ROLE_CAMP,
  ROLE_DESC,
  ROLE_NAME,
  boardSummary,
  defaultBoard,
} from '../../../src/shared/roles.ts';
import {
  createRoom,
  joinPublicRoom,
  joinRoom,
  logoutAccount,
  refreshLobby,
  refreshMatchHistory,
  state,
} from '../store.ts';

export const HomeView = defineComponent({
  name: 'HomeView',
  setup() {
    const connText = computed(() => {
      switch (state.conn) {
        case 'open':
          return '已连接服务器';
        case 'connecting':
          return '正在连接服务器…';
        default:
          return '连接已断开，正在重连…';
      }
    });

    /** 可用角色一览（从共用模块读，保证和小程序端、服务端完全一致） */
    const roleList = computed(() =>
      ALL_ROLES.map((role) => ({
        role,
        name: ROLE_NAME[role],
        desc: ROLE_DESC[role],
        camp: ROLE_CAMP[role],
      })),
    );

    const defaultSummary = computed(() => boardSummary(defaultBoard()));

    const historyRows = computed(() =>
      state.matchHistory.map((match) => ({
        ...match,
        result:
          match.status === 'ABORTED'
            ? '提前结束'
            : match.outcome === null
              ? '未结算'
            : match.outcome === 'DRAW'
              ? '流局'
              : match.won
                ? '胜利'
                : '失败',
        resultClass:
          match.status === 'ABORTED' || match.outcome === null || match.outcome === 'DRAW'
            ? ''
            : match.won
              ? 'good'
              : 'wolf',
        time: new Date(match.startedAt).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
      })),
    );

    let refreshTimer: number | null = null;
    onMounted(() => {
      void refreshLobby();
      void refreshMatchHistory();
      refreshTimer = window.setInterval(() => void refreshLobby(), 5_000);
    });
    onUnmounted(() => {
      if (refreshTimer !== null) window.clearInterval(refreshTimer);
    });

    return {
      state,
      createRoom,
      joinRoom,
      joinPublicRoom,
      logoutAccount,
      refreshLobby,
      connText,
      roleList,
      defaultSummary,
      historyRows,
    };
  },
  template: `
    <div>
      <div class="center" style="margin: 28px 0 22px;">
        <h1>狼 人 杀</h1>
        <div class="muted small">H5 在线大厅 · 6–18 人自定义版型</div>
      </div>

      <div class="panel">
        <div class="row-between">
          <div class="grow">
            <div style="font-weight: 700;">{{ state.user ? state.user.username : '' }}</div>
            <div class="tiny muted" role="status" aria-live="polite">
              <i class="conn" :class="state.conn"></i>{{ connText }}
            </div>
          </div>
          <button type="button" class="sm ghost" @click="logoutAccount">退出登录</button>
        </div>
      </div>

      <div class="panel">
        <div class="row-between">
          <h2 style="margin: 0;">公开房间</h2>
          <button type="button" class="sm ghost" :disabled="state.lobbyLoading" @click="refreshLobby">
            {{ state.lobbyLoading ? '刷新中…' : '刷新' }}
          </button>
        </div>
        <div class="spacer"></div>
        <div v-if="state.lobbyRooms.length === 0" class="small muted center" style="padding: 14px 0;">
          暂时没有等待中的公开房间，你可以创建一个。
        </div>
        <div v-for="room in state.lobbyRooms" :key="room.roomId" class="lobby-room">
          <div class="grow">
            <div class="row wrap" style="gap: 6px;">
              <b>{{ room.hostName }} 的房间</b>
              <span class="badge accent">{{ room.playerCount }}/{{ room.capacity }} 人</span>
            </div>
            <div class="tiny muted ellipsis">{{ room.boardSummary }}</div>
            <div class="tiny mono muted">{{ room.roomId }}</div>
          </div>
          <button type="button" class="sm primary" @click="joinPublicRoom(room.roomId)">加入</button>
        </div>
      </div>

      <div class="panel">
        <h2>创建游戏</h2>
        <div class="small muted">创建后你是房主，可以设置人数和角色。</div>
        <div class="spacer"></div>
        <button type="button" class="primary" @click="createRoom">创建房间（我来当房主）</button>
      </div>

      <form class="panel" @submit.prevent="joinRoom">
        <h3 id="room-code-label">加入朋友的房间</h3>
        <input
          id="room-code"
          class="code"
          v-model="state.roomCode"
          aria-labelledby="room-code-label"
          maxlength="6"
          placeholder="房间号"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          enterkeyhint="go"
        />
        <div class="spacer"></div>
        <button type="submit">加入房间</button>
        <div class="spacer"></div>
        <div class="tiny muted center">房间号是 6 位字母数字，找房主要</div>
      </form>

      <div class="panel">
        <h2>我的游戏场次</h2>
        <div v-if="historyRows.length === 0" class="small muted center" style="padding: 10px 0;">
          完成第一局后，这里会显示角色和胜负记录。
        </div>
        <div v-for="match in historyRows" :key="match.id" class="match-row">
          <div class="grow">
            <div class="row wrap" style="gap: 6px;">
              <b class="small">{{ match.roleName }} · {{ match.seat }} 号</b>
              <span class="badge" :class="match.resultClass">{{ match.result }}</span>
            </div>
            <div class="tiny muted ellipsis">{{ match.boardSummary }}</div>
          </div>
          <div class="tiny muted" style="text-align: right;">{{ match.time }}</div>
        </div>
      </div>

      <div class="panel">
        <h3>房主可以自己配版型</h3>
        <div class="small muted">
          房主在房间里先定人数，再挑角色：狼人和平民可以调数量，神职和白狼王勾选。
          <b>角色总数必须刚好等于人数</b>，否则不能开局，界面会告诉你还差几个。
        </div>
        <div class="spacer"></div>
        <div class="small">
          <span class="badge accent">默认</span>
          <span style="margin-left: 6px;">{{ defaultSummary }}</span>
        </div>
      </div>

      <div class="panel tight">
        <h3>可选角色</h3>
        <div v-for="r in roleList" :key="r.role" style="padding: 5px 0;">
          <div class="row" style="gap: 6px;">
            <span class="badge" :class="r.camp === 'WOLF' ? 'wolf' : 'good'">{{ r.name }}</span>
          </div>
          <div class="tiny muted">{{ r.desc }}</div>
        </div>
      </div>

      <div class="panel tight">
        <h3>怎么分胜负</h3>
        <div class="small muted">
          狼人全部出局 → 好人胜；<br />
          神职全灭 或 平民全灭 → 狼人胜（屠边）。
        </div>
        <div class="spacer"></div>
        <div class="small muted">
          夜晚顺序：狼人 → 守卫 → 女巫 → 预言家。白天依次发言后投票放逐得票最多者。
        </div>
      </div>

      <div class="panel tight">
        <div class="tiny muted">
          提示：微信里切到后台会断开连接，回到游戏会自动重连并恢复你的座位和身份，不用担心。
        </div>
      </div>
    </div>
  `,
});
