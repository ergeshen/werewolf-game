/**
 * 前端入口：按状态切换「首页 / 大厅 / 对局 / 结算」四个界面，并渲染全局提示条。
 *
 * 零构建：这个文件被浏览器当作原生 ES module 直接加载，
 * 服务器用 Node 内置的类型擦除把它转成 JS（见 src/server/index.ts）。
 */

import { createApp, defineComponent } from '../vendor/vue.esm-browser.prod.js';

import { bootstrap, resolveConfirm, screen, state } from './store.ts';
import { AuthView } from './views/Auth.ts';
import { GameView } from './views/Game.ts';
import { HomeView } from './views/Home.ts';
import { LobbyView } from './views/Lobby.ts';
import { ResultView } from './views/Result.ts';

const Root = defineComponent({
  name: 'Root',
  components: { AuthView, HomeView, LobbyView, GameView, ResultView },
  setup() {
    bootstrap();
    return { screen, state, resolveConfirm };
  },
  template: `
    <div>
      <div v-if="screen === 'loading'" class="loading-screen">
        <div class="loading-dot"></div>
        <div class="small muted">正在恢复登录状态…</div>
      </div>
      <AuthView v-else-if="screen === 'auth' || screen === 'changePassword'" />
      <HomeView v-else-if="screen === 'home'" />
      <LobbyView v-else-if="screen === 'lobby'" />
      <GameView v-else-if="screen === 'game'" />
      <ResultView v-else />

      <transition name="fade">
        <div
          v-if="state.toast"
          class="toast"
          :class="state.toast.level"
          :role="state.toast.level === 'error' ? 'alert' : 'status'"
          aria-live="polite"
        >
          {{ state.toast.text }}
        </div>
      </transition>

      <!-- 确认弹窗：自己实现，不用 window.confirm（微信内置浏览器对它支持不稳定） -->
      <div v-if="state.confirm" class="modal-mask">
        <div
          class="modal"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="'confirm-title-' + state.confirm.id"
        >
          <div class="modal-title" :id="'confirm-title-' + state.confirm.id">{{ state.confirm.title }}</div>
          <div class="modal-body">{{ state.confirm.message }}</div>
          <div class="modal-actions">
            <button class="ghost" @click="resolveConfirm(false)">{{ state.confirm.cancelText }}</button>
            <button
              :class="state.confirm.danger ? 'danger' : 'primary'"
              @click="resolveConfirm(true)"
            >{{ state.confirm.confirmText }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
});

const app = createApp(Root);
app.config.errorHandler = (err: unknown) => {
  // 前端一旦崩了要能看见原因，否则手机上只能看到白屏
  console.error('[werewolf] 前端异常', err);
};
app.mount('#app');
