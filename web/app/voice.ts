/**
 * 语音播报：让手机当法官，把阶段指令念出来。
 *
 * 两条播报通路：
 *   ① **录音语音包**（首选）—— `/sounds/voice/` 下的 75 个片段，按序列拼接播放。
 *      所有人听到同一个声音、时长是常量、数字读法可控。
 *   ② **浏览器 TTS**（兜底）—— 语音包缺失或片段不全时，念整句文字。
 *      不需要任何资源，但音色因设备而异（这正是要换掉它的原因）。
 *
 * 三个必须处理的现实问题：
 *
 * 1) **iOS / 微信要求先有用户手势才能出声。**
 *    阶段切换是被动发生的，没有点击就播音会被浏览器静默拦掉。
 *    所以在玩家打开语音开关的那一刻（那是一个真实点击）先播一小段，
 *    把音频通道「解锁」，之后阶段播报才能正常出声。
 *
 * 2) **同一句话会合法地重复出现。**
 *    「女巫请睁眼」每晚都要念。所以去重的键必须是「天 + 阶段 + 文本」，
 *    只按文本去重会把第二晚的女巫提示吃掉。
 *
 * 3) **浏览器支持情况不一。**
 *    不支持时不要静默失败，要能告诉玩家为什么没声音。
 */

import type { VoiceCue } from '../../src/shared/voice-clips.ts';

let unlocked = false;
let lastSpokenKey = '';

export function isVoiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

// ────────────────────────── 录音语音包 ──────────────────────────

/**
 * 录音语音包（服务端托管在 /sounds/voice/）。
 *
 * 为什么要录音而不是 TTS：TTS 有三个绕不过去的问题 ——
 *   ① 12 台手机音色各不相同，有的还带英文口音，有的压根没有中文语音包（无声）
 *   ② 数字读法不可控：「3、7 号」可能被念成「三七号」（连读）
 *   ③ 语速因设备而异 → 播报时长不确定 → 阶段结束时话还没念完
 * 录音包一次录好，所有人听到的是**同一个声音**，而且时长是常量。
 *
 * **多套语音包**：同一批片段可以用不同音色各录一套，放在
 * `/sounds/voice/<包id>/` 下，`/sounds/voice/index.json` 列出全部。
 * 玩家在界面里自己挑，选择存在本机（每台手机可以不一样 —— 反正只有自己在听）。
 *
 * 关键设计：**缺失就回退 TTS**。语音包一片都没装、或者缺了某一段，
 * 都会自动退回浏览器 TTS 念整句 —— 所以游戏永远不会没声音。
 */
const PACK_INDEX_URL = '/sounds/voice/index.json';
const PACK_ROOT = '/sounds/voice/';
/** 玩家选的语音包记在本机，换设备需要重选（但这本来就是个人偏好） */
const PACK_KEY = 'werewolf.voicePack';

export interface VoicePackInfo {
  id: string;
  label: string;
  voice: string;
}

interface LoadedPack {
  id: string;
  clips: Set<string>;
  version: string;
  label: string;
  voice: string;
}

type PackState = 'unknown' | 'loading' | 'ready' | 'missing';

let packState: PackState = 'unknown';
/** 服务端提供哪些语音包 */
let packList: VoicePackInfo[] = [];
/** 每套包的清单，按需加载后缓存（试听别的包时要用） */
const loadedPacks = new Map<string, LoadedPack>();
/** 当前选中的包 id */
let selectedPackId = '';
/** 试听时的临时包（不改变玩家的选择） */
let previewPackId = '';

function currentPack(): LoadedPack | undefined {
  return loadedPacks.get(previewPackId || selectedPackId);
}

/** 语音包当前状态，界面用来告诉玩家「正在用录音包还是系统语音」 */
export function voicePackStatus(): {
  state: PackState;
  count: number;
  voice: string;
  label: string;
  packId: string;
  packs: VoicePackInfo[];
} {
  const pack = currentPack();
  const meta = packList.find((p) => p.id === selectedPackId);
  return {
    state: packState,
    count: pack?.clips.size ?? 0,
    voice: pack?.voice ?? meta?.voice ?? '',
    label: pack?.label || meta?.label || pack?.voice || meta?.voice || '',
    packId: selectedPackId,
    packs: packList,
  };
}

export function isVoicePackReady(): boolean {
  return packState === 'ready';
}

export function voicePacks(): VoicePackInfo[] {
  return packList;
}

export function selectedVoicePack(): string {
  return selectedPackId;
}

function readStoredPack(): string {
  try {
    return window.localStorage.getItem(PACK_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeStoredPack(id: string): void {
  try {
    window.localStorage.setItem(PACK_KEY, id);
  } catch {
    /* 隐私模式下写不了，仅本次会话有效 */
  }
}

/** 拉某一套包的 manifest */
async function fetchPackManifest(id: string): Promise<LoadedPack | null> {
  const cached = loadedPacks.get(id);
  if (cached) return cached;
  try {
    const res = await fetch(`${PACK_ROOT}${id}/manifest.json`);
    if (!res.ok) return null;
    const data: {
      clips?: unknown;
      voice?: unknown;
      label?: unknown;
      rate?: unknown;
      pitch?: unknown;
      generatedAt?: unknown;
    } = await res.json();
    const clips = Array.isArray(data?.clips) ? data.clips.filter((c): c is string => typeof c === 'string') : [];
    if (clips.length === 0) return null;
    /**
     * 版本号很重要：`.mp3` 是按「永久缓存」下发的，
     * 所以重新生成语音包（换音色或调音高语速）之后，手机会一直放缓存里的旧音频。
     * 把「音色 + 语速 + 音高 + 生成时间」拼成查询参数，
     * 换了语音包就等于换了地址，浏览器自然会重新下载 ——
     * 否则用户会以为「换了音色没生效」。
     */
    const desc = [data?.voice, data?.rate, data?.pitch, data?.generatedAt]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('-');
    const pack: LoadedPack = {
      id,
      clips: new Set(clips),
      version: desc ? `v=${encodeURIComponent(desc)}` : '',
      label: typeof data?.label === 'string' ? data.label : '',
      voice: typeof data?.voice === 'string' ? data.voice : '',
    };
    loadedPacks.set(id, pack);
    return pack;
  } catch {
    return null;
  }
}

/**
 * 加载语音包索引与当前选中的那套（结果缓存）。
 *
 * 建议在应用启动时就调一次 —— 这样等用户去点语音开关时，
 * 状态已经是「就绪」，可以在**用户手势里同步**播一段真音频来完成解锁，
 * 比用 TTS 解锁可靠得多（iOS 对手势链要求很严）。
 */
export function loadVoicePack(): Promise<boolean> {
  if (packState === 'ready') return Promise.resolve(true);
  if (packState === 'missing') return Promise.resolve(false);
  if (typeof window === 'undefined' || typeof fetch !== 'function') return Promise.resolve(false);
  packState = 'loading';

  return (async () => {
    try {
      const res = await fetch(PACK_INDEX_URL);
      if (!res.ok) throw new Error(String(res.status));
      const data: { packs?: unknown } = await res.json();
      const packs = Array.isArray(data?.packs) ? data.packs : [];
      packList = packs
        .filter(
          (p): p is { id: string; label?: string; voice?: string } =>
            Boolean(p) && typeof (p as { id?: unknown }).id === 'string',
        )
        .map((p) => ({ id: p.id, label: typeof p.label === 'string' ? p.label : p.id, voice: typeof p.voice === 'string' ? p.voice : '' }));
      if (packList.length === 0) throw new Error('索引里没有语音包');

      const stored = readStoredPack();
      selectedPackId = packList.some((p) => p.id === stored) ? stored : packList[0]!.id;

      const pack = await fetchPackManifest(selectedPackId);
      if (!pack) throw new Error('选中语音包的清单读不出来');

      packState = 'ready';
      return true;
    } catch {
      packState = 'missing';
      return false;
    }
  })();
}

/**
 * 换一套语音包。
 *
 * 只改本机播放用的音色，**不影响其他人**（每台手机自己听自己的）。
 * 换完要让当前阶段的播报能重新出声，所以顺便清掉去重记录。
 */
export async function selectVoicePack(id: string): Promise<boolean> {
  if (!packList.some((p) => p.id === id)) return false;
  if (id === selectedPackId && packState === 'ready') return true;
  const pack = await fetchPackManifest(id);
  if (!pack) return false;
  selectedPackId = id;
  writeStoredPack(id);
  packState = 'ready';
  resetVoiceCache();
  stopVoice();
  stopVoicePack();
  return true;
}

/** 试听某一套包（不改变玩家的选择）：播完把临时选中恢复 */
export async function previewPackClips(id: string, clipIds: string[]): Promise<boolean> {
  const pack = await fetchPackManifest(id);
  if (!pack) return false;
  if (clipIds.some((clip) => !pack.clips.has(clip))) return false;

  stopVoice();
  stopVoicePack();
  previewPackId = id;
  try {
    const token = ++playToken;
    for (const [index, clip] of clipIds.entries()) {
      if (token !== playToken) return true;
      if (index > 0) await wait(320);
      await playClipFile(clip, pack, 1);
    }
    return true;
  } finally {
    previewPackId = '';
  }
}

/** 兼容旧入口：试听当前选中的包 */
export async function playVoicePreview(clipIds: string[]): Promise<boolean> {
  const ready = await loadVoicePack();
  if (!ready) return false;
  const pack = loadedPacks.get(selectedPackId);
  if (!pack || clipIds.some((clip) => !pack.clips.has(clip))) return false;
  return previewPackClips(selectedPackId, clipIds);
}

export function hasClip(id: string): boolean {
  return currentPack()?.clips.has(id) ?? false;
}

/** 同步播一个片段（必须在用户手势里调用才能解锁 iOS 的音频） */
export function playClipNow(id: string, volume = 1): boolean {
  const pack = currentPack();
  if (!pack || !pack.clips.has(id)) return false;
  void playClipFile(id, pack, volume);
  return true;
}

let currentClipAudio: HTMLAudioElement | null = null;
/** 播报代次：新一轮播报开始时让上一轮立刻停下 */
let playToken = 0;

function playClipFile(id: string, pack: LoadedPack, volume: number): Promise<void> {
  return new Promise((resolve) => {
    let audio: HTMLAudioElement;
    try {
      audio = new Audio(`${PACK_ROOT}${pack.id}/${id}.mp3${pack.version ? `?${pack.version}` : ''}`);
    } catch {
      resolve();
      return;
    }
    audio.volume = Math.max(0, Math.min(1, volume));
    currentClipAudio = audio;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    audio.addEventListener('ended', done);
    audio.addEventListener('error', done);
    // 兜底：万一 ended 事件没来（某些浏览器切后台会吞掉），别把整条播报卡死
    setTimeout(done, 15_000);
    void audio.play().catch(done);
  });
}

export function stopVoicePack(): void {
  playToken++;
  if (currentClipAudio) {
    try {
      currentClipAudio.pause();
    } catch {
      /* ignore */
    }
    currentClipAudio = null;
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 播报一段话：优先用录音片段，片段不全就退回 TTS 念整句。
 *
 * 注意「片段不全就整体回退」是刻意的：念一半录音再换成 TTS
 * 比干脆用 TTS 念完更别扭，而且半截录音会让玩家以为播报坏了。
 */
async function playVoiceCues(cues: VoiceCue[], fallbackText: string, volume = 1): Promise<void> {
  if (cues.length === 0) {
    speak(fallbackText);
    return;
  }
  const ready = await loadVoicePack();
  const pack = currentPack();
  const needed = cues.flatMap((cue) => ('clip' in cue ? [cue.clip] : 'num' in cue ? [`num.${cue.num}`] : []));
  if (!ready || !pack || needed.some((id) => !pack.clips.has(id))) {
    speak(fallbackText);
    return;
  }

  stopVoice();
  stopVoicePack();
  const token = ++playToken;
  for (const cue of cues) {
    if (token !== playToken) return; // 被新一轮播报打断了
    if ('pause' in cue) {
      await wait(cue.pause);
      continue;
    }
    const id = 'clip' in cue ? cue.clip : `num.${cue.num}`;
    if (!pack.clips.has(id)) continue;
    await playClipFile(id, pack, volume);
  }
}

/**
 * 统一播报入口：按 key 去重，然后交给语音包（或 TTS 兜底）。
 *
 * key 应当包含「天 + 阶段」，因为「女巫请睁眼」这类台词每晚都会合法地重复出现。
 */
export function announce(key: string, text: string, cues: VoiceCue[] = []): boolean {
  if (!text && cues.length === 0) return false;
  if (key === lastSpokenKey) return false;
  lastSpokenKey = key;
  void playVoiceCues(cues, text);
  return true;
}

/** 在用户点击时调用一次，解锁 iOS / 微信的音频限制 */
export function unlockVoice(): boolean {
  // 语音包就绪时优先用真音频解锁 —— 比让 TTS 念一句话可靠得多
  if (playClipNow('common.unlock')) {
    unlocked = true;
    return true;
  }
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
