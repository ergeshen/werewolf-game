/**
 * 法官语音包 —— 片段清单与拼装规则。
 *
 * 为什么不能整句录音：台词里有变量。
 *   「天黑了。昨晚死亡的是 3、7 号。」
 *     → [片段:昨晚死亡的是] + [数字3] + [停顿] + [数字7] + [片段:号。]
 *   「现在是第 2 天夜晚。」
 *     → [片段:现在是第] + [数字2] + [片段:天夜晚。]
 * 所以整套语音包 = **固定片段 + 数字 1-18 + 停顿**，由前端按顺序播放。
 *
 * 这份文件是**唯一真相源**：生成脚本按它合成音频，引擎按它拼播报序列。
 * 两边共用一份，就不会出现「音频念的和界面写的不一样」。
 *
 * 和 TTS 的关系：音频包缺失时（或某个片段没生成），前端回退用浏览器 TTS
 * 念 `voiceLine` 的整句文本 —— 所以**游戏永远不会没声音**，
 * 而且语音包可以一片一片慢慢补。
 */

export interface VoiceClip {
  id: string;
  /** 这一段要念的字 */
  text: string;
}

/** 播报序列里的一步 */
export type VoiceCue =
  /** 固定片段（对应一个 mp3） */
  | { clip: string }
  /** 座位号 / 天数 → num.<n>，中间会自动插停顿 */
  | { num: number }
  /** 停顿多少毫秒（数字之间、句子之间） */
  | { pause: number };

// ────────────────────────── 固定片段 ──────────────────────────

const OPEN: VoiceClip[] = [
  { id: 'open.hybrid', text: '混血儿请睁眼，请选择一名玩家作为榜样。' },
  { id: 'open.mechanical', text: '机械狼请睁眼，请选择要学习身份的玩家。' },
  { id: 'open.dancer', text: '舞者请睁眼，请选择三名玩家进入舞池。' },
  { id: 'open.mask', text: '假面请睁眼，请先查验舞池，再选择一名玩家戴上面具。' },
  { id: 'open.dreamer', text: '摄梦人请睁眼，请选择今晚的梦游者。' },
  { id: 'open.wolves', text: '狼人请睁眼，请确认今晚的战术，选择要击杀的玩家。' },
  { id: 'open.beauty', text: '狼美人请睁眼，请选择今晚要魅惑的玩家。' },
  { id: 'open.guard', text: '守卫请睁眼，请选择今晚要守护的玩家。' },
  { id: 'open.witch', text: '女巫请睁眼。' },
  { id: 'open.seer', text: '预言家请睁眼，请选择今晚要查验的玩家。' },
  { id: 'open.spirit', text: '通灵师请睁眼，请选择今晚要查验具体身份的玩家。' },
  { id: 'open.gravekeeper', text: '守墓人请睁眼。' },
];

const CLOSE: VoiceClip[] = [
  { id: 'close.hybrid', text: '混血儿请闭眼。' },
  { id: 'close.mechanical', text: '机械狼请闭眼。' },
  { id: 'close.dancer', text: '舞者请闭眼。' },
  { id: 'close.mask', text: '假面请闭眼。' },
  { id: 'close.dreamer', text: '摄梦人请闭眼。' },
  { id: 'close.wolves', text: '狼人请闭眼。' },
  { id: 'close.beauty', text: '狼美人请闭眼。' },
  { id: 'close.guard', text: '守卫请闭眼。' },
  { id: 'close.witch', text: '女巫请闭眼。' },
  { id: 'close.seer', text: '预言家请闭眼。' },
  { id: 'close.spirit', text: '通灵师请闭眼。' },
  { id: 'close.gravekeeper', text: '守墓人请闭眼。' },
];

const FIXED: VoiceClip[] = [
  // 开局与夜晚
  { id: 'common.unlock', text: '语音播报已开启。' },
  { id: 'night.fall', text: '天黑请闭眼。' },
  { id: 'night.now', text: '现在是第' },
  { id: 'night.dayTail', text: '天夜晚。' },
  { id: 'night.almost', text: '天就快亮了。' },
  { id: 'reveal.tip', text: '请查看你的身份牌，看清你的角色和能力。全员确认后，由房主开始第一夜。' },

  // 天亮
  { id: 'day.break', text: '天亮了。' },
  { id: 'day.safe', text: '昨晚是平安夜，没有人死亡。' },
  { id: 'day.deathsHead', text: '昨晚死亡的是' },
  { id: 'day.seatTail', text: '号。' },

  // 警长竞选
  { id: 'sheriff.start', text: '警长竞选开始，请所有存活玩家选择上警或留在警下。' },
  { id: 'sheriff.candHead', text: '上警玩家是' },
  { id: 'sheriff.candTail', text: '号，请依次竞选发言。' },
  { id: 'sheriff.vote', text: '警上发言结束，请警下玩家投票选出警长。' },
  { id: 'sheriff.pkHead', text: '平票候选人' },
  { id: 'sheriff.pkTail', text: '号进行 PK 发言。' },
  { id: 'sheriff.revote', text: 'PK 发言结束，请非候选人重新投票。' },
  { id: 'sheriff.none', text: '本局没有警徽。' },
  { id: 'sheriff.transfer', text: '警长出局，请选择移交警徽或撕毁警徽。' },

  // 白天
  { id: 'day.speech', text: '请按页面显示的顺序依次发言。' },
  { id: 'day.speechSheriff', text: '请警长选择发言方向，警长最后发言并归票。' },
  { id: 'day.vote', text: '天亮了，请依次发言，然后投票选出你要放逐的玩家。' },
  { id: 'day.exiledTail', text: '号被投票放逐出局。' },
  { id: 'day.noExile', text: '本轮投票没有产生放逐对象。' },

  // 出局与开枪
  { id: 'shooter.hunter', text: '猎人出局，请选择是否开枪带走一名玩家。' },
  { id: 'shooter.wolfking', text: '狼王出局，请选择是否开枪带走一名玩家。' },
  { id: 'shooter.mechanical', text: '继承猎人技能的机械狼出局，请选择是否开枪带走一名玩家。' },
  { id: 'shooter.player', text: '玩家出局，请选择是否开枪带走一名玩家。' },
  { id: 'boom.out', text: '白狼王自爆，请选择要带走的玩家。' },
  { id: 'boom.plainTail', text: '号自爆了，今天不再发言与投票。' },

  // 结束
  { id: 'over.wolf', text: '游戏结束，狼人阵营胜利。' },
  { id: 'over.good', text: '游戏结束，好人阵营胜利。' },
  { id: 'over.draw', text: '游戏结束，本局流局。' },
  { id: 'over.plain', text: '游戏结束。' },
];

/** 数字 1-18（座位号要念「十二号」而不是「一十二号」，所以整词录，不拼接） */
const NUMBERS: VoiceClip[] = Array.from({ length: 18 }, (_, i) => {
  const n = i + 1;
  const CN = [
    '一', '二', '三', '四', '五', '六', '七', '八', '九',
    '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八',
  ];
  return { id: `num.${n}`, text: CN[i]! };
});

export const VOICE_CLIPS: readonly VoiceClip[] = [...FIXED, ...OPEN, ...CLOSE, ...NUMBERS];

/** 数字之间的停顿（毫秒）：不停会连读成「三七号」 */
export const NUM_GAP_MS = 220;
/** 句子之间的停顿 */
export const SENTENCE_GAP_MS = 320;

export function clipById(id: string): VoiceClip | undefined {
  return VOICE_CLIPS.find((c) => c.id === id);
}

/** 座位号列表 → 「3、7、12 号」的播报序列 */
export function seatsCues(seats: readonly number[], tail: string): VoiceCue[] {
  const cues: VoiceCue[] = [];
  seats.forEach((seat, index) => {
    if (index > 0) cues.push({ pause: NUM_GAP_MS });
    cues.push({ num: seat });
  });
  cues.push({ clip: tail });
  return cues;
}
