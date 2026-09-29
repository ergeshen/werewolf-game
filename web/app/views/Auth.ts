import { defineComponent } from '../../vendor/vue.esm-browser.prod.js';

import {
  changeInitialPassword,
  loginAccount,
  logoutAccount,
  registerAccount,
  state,
} from '../store.ts';

export const AuthView = defineComponent({
  name: 'AuthView',
  setup() {
    return {
      state,
      loginAccount,
      registerAccount,
      changeInitialPassword,
      logoutAccount,
    };
  },
  template: `
    <div class="auth-shell">
      <div class="center auth-brand">
        <h1>狼 人 杀</h1>
        <div class="muted small">H5 在线游戏大厅</div>
      </div>

      <form v-if="!state.user" class="panel" @submit.prevent="loginAccount">
        <h2>登录账号</h2>
        <label class="field-label" for="auth-username">用户名</label>
        <input
          id="auth-username"
          v-model="state.authUsername"
          maxlength="12"
          autocomplete="username"
          placeholder="输入用户名"
        />
        <div class="spacer"></div>
        <label class="field-label" for="auth-password">密码</label>
        <input
          id="auth-password"
          v-model="state.authPassword"
          type="password"
          maxlength="64"
          autocomplete="current-password"
          placeholder="新账号初始密码为 1"
        />
        <div class="spacer"></div>
        <button type="submit" class="primary" :disabled="state.authBusy">
          {{ state.authBusy ? '请稍候…' : '登录' }}
        </button>

        <div class="auth-divider"><span>第一次来</span></div>
        <button type="button" :disabled="state.authBusy" @click="registerAccount">
          注册新账号（初始密码 1）
        </button>
        <div class="tiny muted center" style="margin-top: 8px;">
          注册只需要填写用户名；首次进入前必须修改初始密码。
        </div>
      </form>

      <form v-else class="panel" @submit.prevent="changeInitialPassword">
        <h2>首次登录，请修改密码</h2>
        <div class="banner warn">
          账号 <b>{{ state.user.username }}</b> 当前使用公共初始密码 1。修改前不能进入大厅。
        </div>

        <label class="field-label" for="current-password">当前密码</label>
        <input
          id="current-password"
          v-model="state.currentPassword"
          type="password"
          maxlength="64"
          autocomplete="current-password"
        />
        <div class="spacer"></div>
        <label class="field-label" for="new-password">新密码（至少 4 位）</label>
        <input
          id="new-password"
          v-model="state.newPassword"
          type="password"
          maxlength="64"
          autocomplete="new-password"
        />
        <div class="spacer"></div>
        <label class="field-label" for="confirm-password">再次输入新密码</label>
        <input
          id="confirm-password"
          v-model="state.confirmPassword"
          type="password"
          maxlength="64"
          autocomplete="new-password"
        />
        <div class="spacer"></div>
        <button type="submit" class="primary" :disabled="state.authBusy">
          {{ state.authBusy ? '保存中…' : '保存并进入大厅' }}
        </button>
        <div class="spacer"></div>
        <button type="button" class="ghost" @click="logoutAccount">换一个账号</button>
      </form>
    </div>
  `,
});
