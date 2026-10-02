/** 登录后的简洁首页：创建 / 加入大厅，以及个人大厅记录。 */

import { computed, defineComponent, onMounted } from '../../vendor/vue.esm-browser.prod.js';

import { HallHistory } from '../components/HallHistory.ts';
import {
  askConfirm,
  closeHallHistory,
  createRoom,
  enterHall,
  hideHallRecord,
  joinRoom,
  logoutAccount,
  openHallHistory,
  refreshOwnedHalls,
  state,
  type OwnedHallView,
} from '../store.ts';

export const HomeView = defineComponent({
  name: 'HomeView',
  components: { HallHistory },
  setup() {
    const connText = computed(() => {
      if (state.conn === 'open') return '已连接服务器';
      if (state.conn === 'connecting') return '正在连接服务器…';
      return '连接已断开，正在重连…';
    });

    const hallRows = computed(() =>
      state.ownedHalls.map((hall) => ({
        ...hall,
        updated: new Date(hall.updatedAt).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        statusText: hall.active ? '大厅已开启' : hall.matchCount > 0 ? `已有 ${hall.matchCount} 场` : '空大厅',
        statusClass: hall.active ? 'good' : hall.matchCount > 0 ? 'accent' : '',
      })),
    );
    const createdHalls = computed(() => hallRows.value.filter((hall) => hall.relation === 'OWNER'));
    const joinedHalls = computed(() => hallRows.value.filter((hall) => hall.relation === 'PARTICIPANT'));

    function removeRecord(hall: OwnedHallView): void {
      const joined = hall.relation === 'PARTICIPANT';
      askConfirm(
        {
          title: '从我的记录中移除',
          message: joined
            ? `移除大厅 ${hall.roomId} 后，它只会从你的列表消失，不会影响厅主、其他玩家、场次或积分。`
            : `移除自己创建的大厅 ${hall.roomId} 后，它只会从你的首页列表消失，不会删除大厅、场次或战绩。以后用大厅号重新进入会再次显示。`,
          confirmText: '确认移除',
          cancelText: '取消',
          danger: true,
        },
        (ok) => {
          if (ok) void hideHallRecord(hall.roomId);
        },
      );
    }

    onMounted(() => {
      closeHallHistory();
      void refreshOwnedHalls();
    });

    return {
      state,
      connText,
      createdHalls,
      joinedHalls,
      createRoom,
      joinRoom,
      logoutAccount,
      refreshOwnedHalls,
      openHallHistory,
      enterHall,
      removeRecord,
    };
  },
  template: `
    <div>
      <div class="center" style="margin: 28px 0 22px;">
        <h1>狼 人 杀</h1>
        <div class="muted small">H5 在线大厅</div>
      </div>

      <div class="panel">
        <div class="row-between">
          <div class="grow">
            <div style="font-weight: 700;">{{ state.user ? state.user.username : '' }}</div>
            <div class="tiny muted"><i class="conn" :class="state.conn"></i>{{ connText }}</div>
          </div>
          <button type="button" class="sm ghost" @click="logoutAccount">退出登录</button>
        </div>
      </div>

      <div class="panel">
        <h2>创建大厅</h2>
        <div class="small muted">创建后你是厅主，可以连续发起多场游戏并管理场次记录。</div>
        <div class="spacer"></div>
        <button type="button" class="primary" @click="createRoom">创建新大厅</button>
      </div>

      <form class="panel" @submit.prevent="joinRoom">
        <h2 id="room-code-label">加入其他大厅</h2>
        <input
          id="room-code"
          class="code"
          v-model="state.roomCode"
          aria-labelledby="room-code-label"
          maxlength="6"
          placeholder="输入 6 位大厅号"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          enterkeyhint="go"
        />
        <div class="spacer"></div>
        <button type="submit">加入大厅</button>
      </form>

      <div class="panel">
        <div class="row-between">
          <div>
            <h2 style="margin: 0;">我的大厅记录</h2>
            <div class="tiny muted">移除记录只影响自己的列表，不会删除大厅数据。</div>
          </div>
          <button class="sm ghost" @click="refreshOwnedHalls">刷新</button>
        </div>

        <h3 style="margin-top: 18px;">我创建的</h3>
        <div v-if="createdHalls.length === 0" class="small muted" style="padding: 8px 0;">暂无记录</div>
        <div v-for="hall in createdHalls" :key="hall.roomId" class="lobby-room">
          <div class="grow">
            <div class="row wrap" style="gap: 6px;">
              <b class="mono">{{ hall.roomId }}</b>
              <span class="badge" :class="hall.statusClass">{{ hall.statusText }}</span>
              <span class="badge good">厅主</span>
            </div>
            <div class="tiny muted">最近使用：{{ hall.updated }}</div>
          </div>
          <div class="row wrap" style="gap: 5px; justify-content: flex-end;">
            <button class="sm ghost" @click="openHallHistory(hall.roomId)">查看记录</button>
            <button class="sm primary" @click="enterHall(hall.roomId)">{{ hall.active ? '进入大厅' : '重新开启' }}</button>
            <button class="sm danger" @click="removeRecord(hall)">移除</button>
          </div>
        </div>

        <h3 style="margin-top: 18px;">我参加过的</h3>
        <div v-if="joinedHalls.length === 0" class="small muted" style="padding: 8px 0;">暂无记录</div>
        <div v-for="hall in joinedHalls" :key="hall.roomId" class="lobby-room">
          <div class="grow">
            <div class="row wrap" style="gap: 6px;">
              <b class="mono">{{ hall.roomId }}</b>
              <span class="badge" :class="hall.statusClass">{{ hall.statusText }}</span>
              <span class="badge">厅主：{{ hall.ownerName }}</span>
            </div>
            <div class="tiny muted">最近使用：{{ hall.updated }}</div>
          </div>
          <div class="row wrap" style="gap: 5px; justify-content: flex-end;">
            <button class="sm ghost" @click="openHallHistory(hall.roomId)">查看记录</button>
            <button v-if="hall.active" class="sm primary" @click="enterHall(hall.roomId)">进入大厅</button>
            <button class="sm danger" @click="removeRecord(hall)">移除</button>
          </div>
        </div>
      </div>

      <HallHistory v-if="state.hallHistoryOpen" :closable="true" />
    </div>
  `,
});
