/**
 * 机器人客户端：真实 WebSocket 连接 + 自动出牌。
 *
 * 两个用途：
 *   1. `npm run bots -- <房间号> 11` —— 你一个人也能把 12 人局跑起来，验证流程。
 *   2. 冒烟测试（scripts/smoke.ts）用它一次拉起 12 个客户端跑完整局。
 *
 * 它同时还承担「信息隔离审计」：每个客户端在收到个性化视图时会检查
 * 自己有没有拿到不该拿到的信息（狼队点刀、女巫刀口、别人的身份），
 * 一旦发现就记录下来。这是防止服务端视图过滤写错的最后一道网。
 */

import type { ClientMsg, GameView, RoomView, ServerMsg } from '../../src/shared/protocol.ts';

export interface BotObservation {
  phasesSeen: Set<string>;
  witchSawTarget: boolean;
  wolfVotesSeen: boolean;
  wolfVotesLeaked: boolean;
  witchInfoLeaked: boolean;
  seerGotResult: boolean;
  /** 身份隔离违规记录（应为空） */
  roleVisibilityViolations: string[];
  maxDeadlineGapMs: number;
}

function newObservation(): BotObservation {
  return {
    phasesSeen: new Set<string>(),
    witchSawTarget: false,
    wolfVotesSeen: false,
    wolfVotesLeaked: false,
    witchInfoLeaked: false,
    seerGotResult: false,
    roleVisibilityViolations: [],
    maxDeadlineGapMs: 0,
  };
}

export interface BotOptions {
  /** 是否自动出牌（默认 true） */
  autoPlay?: boolean;
  /** 每次收到状态更新后的回调 */
  onUpdate?: (bot: BotClient) => void;
  /** 是否把每次错误回执记录下来（默认 true） */
  recordErrors?: boolean;
  /**
   * 如果是白狼王，是否在白天自爆（默认 false）。
   * 端到端测试用这个开关把白狼王的完整链路跑一遍 —— 否则随机对局里
   * 白狼王可能永远不自爆，那条路径就永远没被测到。
   */
  wolfKingSelfDestruct?: boolean;
  /**
   * 如果这个机器人是房主，是否自动按下「天黑请闭眼」（默认 false）。
   *
   * 端到端测试里房主就是机器人，不自动按就会永远卡在身份确认阶段；
   * 而 `npm run bots` 里房主是真人，必须留给他自己按 —— 那正是这个功能的意义。
   */
  autoBeginNight?: boolean;
  /**
   * 如果这个机器人是房主，是否自动推进白天的「无行动过场阶段」（默认 false）。
   *
   * 白天阶段故意没有计时器（面杀节奏由真人控制），只能靠房主点「跳过阶段」。
   * 端到端测试里房主是机器人，不推就永远停在 DAY_ANNOUNCE；
   * `npm run bots` 里房主是真人，这个按钮必须留给他 —— 和 autoBeginNight 同一个道理。
   */
  autoAdvanceDay?: boolean;
}

export class BotClient {
  readonly nickname: string;
  readonly obs: BotObservation = newObservation();
  readonly errors: string[] = [];
  readonly wolfKingSelfDestruct: boolean;
  readonly autoBeginNight: boolean;
  readonly autoAdvanceDay: boolean;

  room: RoomView | null = null;
  game: GameView | null = null;
  token = '';
  connectionCount = 0;

  private socket: WebSocket | null = null;
  private readonly autoPlay: boolean;
  private readonly recordErrors: boolean;
  private readonly onUpdate: ((bot: BotClient) => void) | undefined;
  /** 已提交过动作的「天:阶段」，避免在服务端视图回来之前重复提交 */
  private readonly actedKeys = new Set<string>();

  constructor(nickname: string, options: BotOptions = {}) {
    this.nickname = nickname;
    this.autoPlay = options.autoPlay ?? true;
    this.recordErrors = options.recordErrors ?? true;
    this.onUpdate = options.onUpdate;
    this.wolfKingSelfDestruct = options.wolfKingSelfDestruct ?? false;
    this.autoBeginNight = options.autoBeginNight ?? false;
    this.autoAdvanceDay = options.autoAdvanceDay ?? false;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  connect(url: string, token?: string): Promise<void> {
    this.connectionCount += 1;
    const params = new URLSearchParams({ automation: '1' });
    if (token) params.set('token', token);
    const target = `${url}?${params.toString()}`;
    const socket = new WebSocket(target);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.nickname} 连接超时`)), 8_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.nickname} 连接失败（服务端在 ${url} 上跑着吗？）`));
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        this.receive(String(event.data));
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null;
      });
    });
  }

  private receive(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'welcome':
        this.token = msg.resumeToken;
        break;
      case 'room':
        this.room = msg.room;
        if (msg.room) this.auditRoomView(msg.room);
        break;
      case 'game': {
        const prevPhase = this.game?.phase ?? null;
        this.game = msg.game;
        if (msg.game) {
          /**
           * ★ 关键：换局时必须清空 actedKeys。
           *
           * 去重键是 `${day}:${phase}`，而同一个 BotClient 会跨局复用。
           * 不清空的话，第二局第 1 天的 NIGHT_WOLVES / DAY_VOTE 键还留在集合里，
           * 机器人整局都不出牌 —— 表现就是「第二局莫名其妙 20 天流局」或者
           * 「白狼王一直不自爆，直到第 5 天才炸」这种看天吃饭的偶发失败。
           *
           * ⚠️ 只认「真正进入新局」的边沿：上一帧不是 ROLE_REVEAL、这一帧才是。
           * 身份确认阶段每来一个人确认，服务端就全场广播一次 —— 如果每次收到
           * 都清空，别人确认的广播会把自己的去重键洗掉，机器人就会重复发
           * confirmRole，全场收到一串 ALREADY_DONE 噪音错误。
           * NIGHT_START 那一支同理只在边沿触发（上一帧不是它）。
           */
          const isNewGameStart =
            msg.game.day === 1 &&
            ((msg.game.phase === 'ROLE_REVEAL' && prevPhase !== 'ROLE_REVEAL') ||
              (msg.game.phase === 'NIGHT_START' && prevPhase !== 'NIGHT_START'));
          if (isNewGameStart) {
            this.actedKeys.clear();
          }
          this.auditGameView(msg.game);
        } else {
          // 回到大厅（重开/散场），把上一局的记录一并清掉
          this.actedKeys.clear();
        }
        break;
      }
      case 'error':
        if (this.recordErrors) this.errors.push(`${msg.code}: ${msg.message}`);
        break;
      default:
        break;
    }

    if (this.autoPlay) this.playIfMyTurn();
    this.onUpdate?.(this);
  }

  /** 座位视图里，除了自己和狼队友，任何人都不该带 role 字段 */
  private auditRoomView(room: RoomView): void {
    // 大厅阶段本来就没有身份信息，只有开局后才有比较意义
    if (room.status !== 'PLAYING') return;

    // 必须从 room 自身判断我是不是狼：room 和 game 是两条独立消息，
    // 开局那一刻 room 会先到，此时 this.game 还是旧值（null）。
    const meSeat = room.seats.find((s) => s.isMe);
    const iAmWolf = meSeat?.role === 'WOLF';
    const expected = iAmWolf ? 4 : 1;

    const withRole = room.seats.filter((s) => s.role !== undefined);
    if (withRole.length !== expected) {
      this.obs.roleVisibilityViolations.push(
        `${this.nickname}(${iAmWolf ? '狼' : '非狼'}) 看到 ${withRole.length} 个身份，应为 ${expected}：` +
          withRole.map((s) => `${s.seat}=${s.role}`).join(','),
      );
    }
    if (!iAmWolf) {
      const leaked = room.seats.filter((s) => s.role === 'WOLF');
      if (leaked.length > 0) {
        this.obs.roleVisibilityViolations.push(
          `${this.nickname} 不是狼，却在座位盘看到狼人：${leaked.map((s) => s.seat).join(',')}`,
        );
      }
    }
  }

  private auditGameView(game: GameView): void {
    this.obs.phasesSeen.add(game.phase);
    if (game.deadline !== null) {
      const gap = game.deadline - Date.now();
      if (gap > this.obs.maxDeadlineGapMs) this.obs.maxDeadlineGapMs = gap;
    }
    if (game.witchInfo) {
      if (game.me?.role === 'WITCH') this.obs.witchSawTarget = true;
      else this.obs.witchInfoLeaked = true;
    }
    if (game.wolfVotes) {
      if (game.me?.role === 'WOLF') this.obs.wolfVotesSeen = true;
      else this.obs.wolfVotesLeaked = true;
    }
    if (game.me?.seerHistory && game.me.seerHistory.length > 0) this.obs.seerGotResult = true;

    // 关键词级泄露检查：好人视图里不该出现 "WOLF"
    if (game.me && game.me.camp === 'GOOD' && game.phase !== 'GAME_OVER') {
      // 预言家自己的验人结果是合法信息，先剔除再检查
      const json = JSON.stringify(game).replace(/"seerHistory":\[[^\]]*\]/g, '"seerHistory":[]');
      if (json.includes('"WOLF"')) {
        this.obs.roleVisibilityViolations.push(
          `${this.nickname} 的视图里出现了 "WOLF"：${json.slice(0, 240)}`,
        );
      }
    }
  }

  /**
   * 身份确认阶段：机器人自动确认看牌，必要时代替房主按下「天黑请闭眼」。
   *
   * 这一阶段 `myTurn` 是 false（没有行动可以提交），所以必须放在
   * `playIfMyTurn` 的 myTurn 判断**之前**调用，否则机器人会一直干等。
   */
  private handleRoleReveal(): void {
    const game = this.game;
    if (!game || game.phase !== 'ROLE_REVEAL') return;
    const view = game.roleReveal;
    if (!view) return;

    // 去重键必须「按局」隔离：重新发牌是原地 ROLE_REVEAL → ROLE_REVEAL，
    // 边沿检测认不出新一局。每局开局日志都有一条「本局共 N 人」，
    // 用它的出现次数当局号 —— 重发牌后次数 +1，机器人就会重新确认。
    const epoch = game.log.filter((line) => line.includes('本局共')).length;
    const confirmKey = `reveal:confirm:${epoch}`;
    const beginKey = `reveal:begin:${epoch}`;

    if (!view.iConfirmed) {
      if (this.actedKeys.has(confirmKey)) return;
      this.actedKeys.add(confirmKey);
      this.send({ t: 'game.confirmRole' });
      return;
    }

    // 只有被明确授权的机器人（也就是端到端测试里那个当房主的）才按按钮；
    // `npm run bots` 里房主是真人，必须留给他自己按。
    if (!this.autoBeginNight || !view.iAmHost || !view.canBeginNight) return;
    if (this.actedKeys.has(beginKey)) return;
    this.actedKeys.add(beginKey);
    this.send({ t: 'game.beginNight' });
  }

  /**
   * 房主机器人替真人按「跳过阶段」：只推进白天的无行动过场阶段。
   *
   * 这些阶段（天亮公示 / 竞选发言 / 白天发言 / 放逐结算）没有计时器也没有
   * 可提交的行动，工程上只能由房主推进 —— 端到端测试里房主是机器人，
   * 不推整局就停在天亮。有行动的阶段（投票等）不推，等机器人自己提交。
   */
  private handleHostAdvance(): void {
    if (!this.autoAdvanceDay) return;
    const game = this.game;
    if (!game || game.phase === 'GAME_OVER') return;
    if (!['DAY_ANNOUNCE', 'SHERIFF_CAMPAIGN', 'SHERIFF_PK', 'DAY_SPEECH', 'DAY_EXILE'].includes(game.phase)) return;
    const room = this.room;
    if (!room || room.hostId !== this.token) return;
    const key = `advance:${game.day}:${game.phase}`;
    if (this.actedKeys.has(key)) return;
    this.actedKeys.add(key);
    this.send({ t: 'game.advance' });
  }

  /** 轮到我出牌就立刻出，让对局能自动跑下去 */
  playIfMyTurn(): void {
    const game = this.game;
    if (!game) return;
    this.handleRoleReveal();
    this.handleHostAdvance();
    if (!game.myTurn) return;
    const me = game.me;
    if (!me) return;

    // 视图有往返延迟：收到「轮到我」到「我提交后的新视图」之间有一段窗口，
    // 期间 pump 会被其他玩家的消息反复触发。不去重会重复提交，
    // 服务端会正确回 ALREADY_DONE / BAD_PHASE —— 那是噪音，不是 bug。
    const key = `${game.day}:${game.phase}${game.phase === 'NIGHT_MASK' && me.maskNeedsDisguise ? ':disguise' : ''}`;
    if (this.actedKeys.has(key)) return;

    // 随机取一个候选目标。
    // 不要用「永远取第一个」—— 座位号最小的通常是房主（也就是真人玩家），
    // 那样真人几乎每局第一夜就被刀，根本走不到白天投票，没法验证完整流程。
    const pick = (candidates: number[]): number | null => {
      if (candidates.length === 0) return null;
      return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
    };

    switch (game.phase) {
      case 'NIGHT_HYBRID': {
        const target = pick(game.myOptions);
        if (target === null) return;
        this.send({ t: 'game.action', action: { kind: 'hybrid', target } });
        break;
      }
      case 'NIGHT_MECHANICAL': {
        const target = pick(game.myOptions);
        if (target === null) return;
        this.send({ t: 'game.action', action: { kind: 'mechanicalLearn', target } });
        break;
      }
      case 'NIGHT_DANCER': {
        if (game.myOptions.length < 3) return;
        const targets = game.myOptions.slice().sort(() => Math.random() - 0.5).slice(0, 3);
        this.send({ t: 'game.action', action: { kind: 'dancer', targets } });
        break;
      }
      case 'NIGHT_MASK': {
        const target = pick(game.myOptions);
        if (target === null) return;
        this.send({
          t: 'game.action',
          action: me.maskNeedsDisguise ? { kind: 'mask', target } : { kind: 'maskInspect', target },
        });
        break;
      }
      case 'NIGHT_WOLVES': {
        // 刀一个既不是自己、也不是队友的幸存者
        const mates = new Set(me.teammates ?? []);
        const targets = game.myOptions.filter((s) => !mates.has(s) && s !== me.seat);
        const target = pick(targets.length > 0 ? targets : game.myOptions.filter((s) => s !== me.seat));
        /**
         * 「唯邻是从」：首夜还要选一名傀儡，否则服务端会拒绝整个提交
         * （首夜必须选）。机器人从候选人里挑一个 —— 取最小的座位号，
         * 这样多个机器人容易投到同一个人，不必依赖平票逻辑。
         */
        const candidates = game.puppetInfo?.candidates ?? [];
        if (candidates.length > 0) {
          this.send({ t: 'game.action', action: { kind: 'wolf', target, puppet: candidates[0]! } });
        } else {
          this.send({ t: 'game.action', action: { kind: 'wolf', target } });
        }
        break;
      }
      case 'NIGHT_GUARD': {
        // myOptions 里已经排除了「上一夜守过的人」，直接挑一个即可
        const target = pick(game.myOptions);
        if (target === null) return;
        this.send({
          t: 'game.action',
          action: me.role === 'MECHANICAL_WOLF'
            ? { kind: 'mechanicalSkill', skill: 'guard', target }
            : { kind: 'guard', target },
        });
        break;
      }
      case 'NIGHT_WITCH':
        // 机器人女巫不用药，简化测试变量
        this.send({
          t: 'game.action',
          action: me.role === 'MECHANICAL_WOLF'
            ? { kind: 'mechanicalSkill', skill: 'poison', target: null }
            : { kind: 'witch', save: false, poison: null },
        });
        break;
      case 'NIGHT_SEER': {
        const target = pick(game.myOptions);
        if (target === null) return;
        this.send({
          t: 'game.action',
          action: me.role === 'MECHANICAL_WOLF'
            ? { kind: 'mechanicalSkill', skill: 'seer', target }
            : { kind: 'seer', target },
        });
        break;
      }
      case 'NIGHT_SPIRIT_SEER': {
        const target = pick(game.myOptions);
        if (target === null) return;
        this.send({
          t: 'game.action',
          action: me.role === 'MECHANICAL_WOLF'
            ? { kind: 'mechanicalSkill', skill: 'spiritSeer', target }
            : { kind: 'spiritSeer', target },
        });
        break;
      }
      case 'SHERIFF_SIGNUP':
        this.send({ t: 'game.sheriffSignup', candidate: me.seat <= 3 });
        break;
      case 'SHERIFF_VOTE':
      case 'SHERIFF_REVOTE':
        this.send({ t: 'game.sheriffVote', target: pick(game.myOptions) });
        break;
      case 'DAY_SPEECH':
        if (game.sheriffSeat === me.seat && game.speechDirection === null) {
          this.send({ t: 'game.speechDirection', direction: 'FORWARD' });
        } else {
          return;
        }
        break;
      case 'DAY_VOTE': {
        // 白狼王机器人可以在白天自爆（默认关闭，只在端到端测试里打开）
        if (me.role === 'WOLF_KING' && this.wolfKingSelfDestruct) {
          this.send({ t: 'game.selfDestruct' });
          break;
        }
        this.send({ t: 'game.vote', target: pick(game.myOptions) });
        break;
      }
      case 'SHERIFF_TRANSFER':
        this.send({ t: 'game.sheriffTransfer', target: pick(game.myOptions) });
        break;
      case 'HUNTER_SHOOT':
        this.send({ t: 'game.hunterShoot', target: null });
        break;
      case 'WOLF_KING_BOOM':
        // 自爆后指定带走一个人；myOptions 里没有自己
        this.send({ t: 'game.boomTarget', target: pick(game.myOptions) });
        break;
      default:
        return;
    }
    this.actedKeys.add(key);
  }

  send(msg: ClientMsg): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  get seat(): number | null {
    return this.room?.seats.find((s) => s.isMe)?.seat ?? null;
  }
}
