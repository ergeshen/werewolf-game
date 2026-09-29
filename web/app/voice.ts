/**
 * 语音播报：让手机当法官，把阶段指令念出来。
 *
 * 用的是浏览器内置的语音合成（Web Speech API），不需要任何服务器、不需要录音、
 * 不需要麦克风权限 —— 所以微信内置浏览器里也能用。
 *
 * 三个必须处理的现实问题：
 *
 * 1) **iOS / 微信要求先有用户手势才能出声。**
 *    阶段切换是被动发生的，没有点击就朗读会被浏览器静默拦掉。
 *    所以在玩家打开语音开关的那一刻（那是一个真实点击）先念一句短的，
 *    把音频通道「解锁」，之后阶段播报才能正常出声。
 *
 * 2) **同一句话会合法地重复出现。**
 *    「女巫请睁眼」每晚都要念。所以去重的键必须是「天 + 阶段 + 文本」，
 *    只按文本去重会把第二晚的女巫提示吃掉。
 *
 * 3) **浏览器支持情况不一。**
 *    不支持时不要静默失败，要能告诉玩家为什么没声音。
 */

let unlocked = false;
let lastSpokenKey = '';

export function isVoiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

/** 在用户点击时调用一次，解锁 iOS / 微信的音频限制 */
export function unlockVoice(): boolean {
  if (!isVoiceSupported()) return false;
  if (unlocked) return true;
  try {
    const utterance = new SpeechSynthesisUtterance('语音播报已开启');
    utterance.lang = 'zh-CN';
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
    unlocked = true;
    return true;
  } catch {
    return false;
  }
}

export function stopVoice(): void {
  if (!isVoiceSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

function speak(text: string): boolean {
  if (!isVoiceSupported() || !text) return false;
  try {
    // 先掐掉上一句，避免阶段切换时两句叠在一起
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按 key 去重后朗读。
 * key 应当包含「天 + 阶段」，这样同一句话在不同夜晚仍会被念出来。
 */
export function speakOnce(key: string, text: string): boolean {
  if (!text) return false;
  if (key === lastSpokenKey) return false;
  lastSpokenKey = key;
  return speak(text);
}

/** 重连或重新开局时清掉去重记录，让当前阶段能重新播报 */
export function resetVoiceCache(): void {
  lastSpokenKey = '';
}

// ────────────────────────── 音效 ──────────────────────────

/**
 * 音效文件，由服务端直接托管 web/sounds/ 下的静态资源。
 *
 * 和上面 TTS 的分工：TTS 只能把字念出来，没有音色；
 * 「金色传说」这种仪式感必须播真实录音，TTS 念不出那个味道。
 */
const SOUNDS = {
  goldenLegend: '/sounds/golden-legend.mp3',
} as const;

export type SoundName = keyof typeof SOUNDS;

let currentAudio: HTMLAudioElement | null = null;

export function hasSound(name: SoundName): boolean {
  return Boolean(SOUNDS[name]);
}

/**
 * 播放音效。
 *
 * 和 TTS 一样受自动播放策略限制：iOS / 微信要求先有用户手势，
 * 所以玩家点过语音开关之后再播才稳。
 */
export function playSound(name: SoundName, volume = 1): boolean {
  const src = SOUNDS[name];
  if (!src) return false;
  try {
    // 同时只放一个，避免叠音
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    const audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(1, volume));
    currentAudio = audio;
    void audio.play().catch(() => {
      // 被自动播放策略拦掉属正常情况，静默忽略
    });
    return true;
  } catch {
    return false;
  }
}

export function stopAllSounds(): void {
  if (!currentAudio) return;
  try {
    currentAudio.pause();
  } catch {
    /* ignore */
  }
  currentAudio = null;
}
