/**
 * 首页：填昵称 → 创建房间 / 输入房间号加入。
 * 支持从分享链接 ?room=XXXXXX 自动带入房间号（微信里转发给朋友的主要入口）。
 */

import { computed, defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import { createRoom, joinRoom, state } from '../store.ts';

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

    return { state, createRoom, joinRoom, connText };
  },
  template: `
    <div>
      <div class="center" style="margin: 28px 0 22px;">
        <h1>狼 人 杀</h1>
        <div class="muted small">12 人标准局 · 预女猎白</div>
      </div>

      <div class="panel">
        <div class="row-between small" style="margin-bottom: 10px;">
          <span class="muted"><i class="conn" :class="state.conn"></i>{{ connText }}</span>
        </div>
        <h3>你的昵称</h3>
        <input
          v-model="state.nickname"
          maxlength="12"
          placeholder="例如：老王"
          autocomplete="off"
        />
        <div class="spacer"></div>
        <button class="primary" @click="createRoom">创建房间（我来当房主）</button>
      </div>

      <div class="panel">
        <h3>加入朋友的房间</h3>
        <input
          class="code"
          v-model="state.roomCode"
          maxlength="6"
          placeholder="房间号"
          autocomplete="off"
        />
        <div class="spacer"></div>
        <button @click="joinRoom">加入房间</button>
        <div class="spacer"></div>
        <div class="tiny muted center">房间号是 6 位字母数字，找房主要</div>
      </div>

      <div class="panel tight">
        <h3>本局板子</h3>
        <div class="small muted">
          4 名狼人 · 4 名平民 · 预言家 · 女巫 · 猎人 · 白痴<br />
          狼人全部出局 → 好人胜；神职全灭或平民全灭 → 狼人胜
        </div>
        <div class="spacer"></div>
        <div class="small muted">
          夜晚顺序：狼人 → 女巫 → 预言家。白天依次发言后投票放逐得票最多者。
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
