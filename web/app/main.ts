/**
 * 前端入口：按状态切换「首页 / 大厅 / 对局 / 结算」四个界面，并渲染全局提示条。
 *
 * 零构建：这个文件被浏览器当作原生 ES module 直接加载，
 * 服务器用 Node 内置的类型擦除把它转成 JS（见 src/server/index.ts）。
 */

import { createApp, defineComponent } from '../vendor/vue.esm-browser.prod.js';

import { bootstrap, screen, state } from './store.ts';
import { GameView } from './views/Game.ts';
import { HomeView } from './views/Home.ts';
import { LobbyView } from './views/Lobby.ts';
import { ResultView } from './views/Result.ts';

const Root = defineComponent({
  name: 'Root',
  components: { HomeView, LobbyView, GameView, ResultView },
  setup() {
    bootstrap();
    return { screen, state };
  },
  template: `
    <div>
      <HomeView v-if="screen === 'home'" />
      <LobbyView v-else-if="screen === 'lobby'" />
      <GameView v-else-if="screen === 'game'" />
      <ResultView v-else />

      <transition name="fade">
        <div v-if="state.toast" class="toast" :class="state.toast.level">
          {{ state.toast.text }}
        </div>
      </transition>
    </div>
  `,
});

const app = createApp(Root);
app.config.errorHandler = (err: unknown) => {
  // 前端一旦崩了要能看见原因，否则手机上只能看到白屏
  console.error('[werewolf] 前端异常', err);
};
app.mount('#app');
