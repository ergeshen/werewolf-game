/**
 * 生成法官语音包。
 *
 * 用法：
 *   npm run voice:sample                     # 把每个候选音色各念一句，用来挑
 *   npm run voice                            # 默认音色（云扬）生成全套
 *   npm run voice -- tw-hsiaochen-yujie      # 用预设（台湾腔·御姐）生成全套
 *   npm run voice -- zh-CN-XiaoxiaoNeural    # 直接指定音色
 *   npm run voice -- xiaoxiao-yujie --force  # 重生成
 *
 * 特性：
 *   - **断点续传**：已经生成过的片段直接跳过，网络抖了重跑即可
 *   - **并发 4**：串行跑 70 多条要十分钟，并发后几十秒
 *   - 生成完写一份 manifest.json，前端靠它判断「语音包在不在、用的哪个音色」
 *
 * 音频产物：web/sounds/voice/<id>.mp3
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { synthesize } from './lib/edge-tts.mjs';
import { VOICE_CLIPS } from '../src/shared/voice-clips.ts';

/**
 * 语音包目录结构：
 *
 *   web/sounds/voice/
 *     index.json            ← 列出全部语音包，前端靠它渲染选择器
 *     _sample/              ← 挑音色用的试听样本（不参与游戏）
 *     <包id>/manifest.json
 *     <包id>/*.mp3
 *
 * 每套包一个目录，是因为玩家要在**界面里切换**：
 * 几套音频共存，前端挑了哪套就从哪个目录取。
 */
const OUT_ROOT = 'web/sounds/voice';
const INDEX_PATH = join(OUT_ROOT, 'index.json');
const DEFAULT_PRESET = 'yunyang';
const SAMPLE_TEXT = '天黑请闭眼。狼人请睁眼，请确认今晚的战术，选择要击杀的玩家。';

/** index.json 里的排序优先级：第一个就是新玩家的默认语音 */
const PRIORITY = [
  'yunyang',
  'tw-hsiaochen-yujie',
  'tw-hsiaoyu-yujie',
  'tw-hsiaochen',
  'tw-hsiaoyu',
  'xiaoxiao-yujie',
  'xiaoxiao',
  'xiaoyi-yujie',
  'xiaoyi',
  'yunjian',
  'yunxi',
  'tw-yunjhe',
  'xiaobei',
  'xiaoni',
  'hiugaai',
  'hiumaan',
  'hiumaan-yujie',
  'wanlung',
];

/**
 * 候选音色预设。
 *
 * 「御姐」不是某个现成音色，而是**在女声基础上压低音高 + 略放慢**调出来的 ——
 * 音高降 10~12Hz 会明显去掉稚气、显得沉稳；语速降 5~6% 多一点从容。
 * 所以每个女声都有「原音」和「御姐」两版，方便直接对比。
 */
const PRESETS = {
  // ── 台湾腔（用户偏好）──
  'tw-hsiaochen': { voice: 'zh-TW-HsiaoChenNeural', label: '台灣國語·曉臻' },
  'tw-hsiaochen-yujie': {
    voice: 'zh-TW-HsiaoChenNeural', rate: '-6%', pitch: '-12Hz', label: '台灣御姐·曉臻',
  },
  'tw-hsiaoyu': { voice: 'zh-TW-HsiaoYuNeural', label: '台灣國語·曉雨' },
  'tw-hsiaoyu-yujie': {
    voice: 'zh-TW-HsiaoYuNeural', rate: '-5%', pitch: '-10Hz', label: '台灣御姐·曉雨',
  },

  // ── 大陆女声 ──
  xiaoxiao: { voice: 'zh-CN-XiaoxiaoNeural', label: '曉曉·溫暖' },
  'xiaoxiao-yujie': {
    voice: 'zh-CN-XiaoxiaoNeural', rate: '-4%', pitch: '-12Hz', label: '曉曉·御姐',
  },
  xiaoyi: { voice: 'zh-CN-XiaoyiNeural', label: '曉伊·溫柔' },
  'xiaoyi-yujie': { voice: 'zh-CN-XiaoyiNeural', rate: '-4%', pitch: '-10Hz', label: '曉伊·御姐' },

  // ── 方言 ──
  xiaobei: { voice: 'zh-CN-liaoning-XiaobeiNeural', label: '東北話·曉北' },
  xiaoni: { voice: 'zh-CN-shaanxi-XiaoniNeural', label: '陝西話·曉妮' },

  // ── 粤语 ──
  hiugaai: { voice: 'zh-HK-HiuGaaiNeural', label: '粵語·曉佳' },
  hiumaan: { voice: 'zh-HK-HiuMaanNeural', label: '粵語·曉曼' },
  'hiumaan-yujie': { voice: 'zh-HK-HiuMaanNeural', rate: '-4%', pitch: '-10Hz', label: '粵語御姐·曉曼' },

  // ── 男声 ──
  yunyang: { voice: 'zh-CN-YunyangNeural', label: '云揚·新聞腔' },
  yunjian: { voice: 'zh-CN-YunjianNeural', label: '云健·沉穩' },
  yunxi: { voice: 'zh-CN-YunxiNeural', label: '云希·年輕' },
  'tw-yunjhe': { voice: 'zh-TW-YunJheNeural', label: '台灣男聲·雲哲' },
  wanlung: { voice: 'zh-HK-WanLungNeural', label: '粵語男聲·雲龍' },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const sampleOnly = args.includes('--sample');
const picked = args.find((a) => !a.startsWith('--')) ?? DEFAULT_PRESET;

const preset = PRESETS[picked] ?? { voice: picked, label: picked };
const style = {
  voice: preset.voice,
  rate: preset.rate ?? '+0%',
  pitch: preset.pitch ?? '+0Hz',
  label: preset.label ?? preset.voice,
};

/** 语音包 id：预设直接用 key；直接写音色名时按音色名规整出一个 id */
function packIdFor(key, voice) {
  if (PRESETS[key]) return key;
  return String(voice)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const packId = packIdFor(picked, style.voice);
const OUT_DIR = join(OUT_ROOT, packId);
const SAMPLE_DIR = join(OUT_ROOT, '_sample');

mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 写/更新 index.json —— 前端的选择器读的就是它 */
function updateIndex(entry) {
  let index = { packs: [] };
  try {
    index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    /* 第一次生成 */
  }
  if (!Array.isArray(index.packs)) index.packs = [];
  const at = index.packs.findIndex((p) => p && p.id === entry.id);
  if (at >= 0) index.packs[at] = entry;
  else index.packs.push(entry);
  // 排序：先按 PRIORITY（第一个 = 新玩家的默认语音），其余的按 id
  index.packs.sort((a, b) => {
    const ai = PRIORITY.indexOf(a.id);
    const bi = PRIORITY.indexOf(b.id);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return String(a.id).localeCompare(String(b.id));
  });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 1));
  console.log(`index.json 已更新：${index.packs.length} 套语音包`);
}

/** 并发跑，任何一个失败重试 3 次 */
async function runPool(items, worker, concurrency = 4) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}

// ── 挑音色模式：每个候选念同一句，便于横向对比 ──
if (sampleOnly) {
  const dir = SAMPLE_DIR;
  mkdirSync(dir, { recursive: true });
  console.log(`生成音色样本（同一句，方便对比）\n  句子：${SAMPLE_TEXT}\n`);

  const entries = Object.entries(PRESETS);
  let made = 0;
  await runPool(
    entries,
    async ([key, p]) => {
      const path = join(dir, `${key}.mp3`);
      if (existsSync(path) && !force) return;
      try {
        const audio = await synthesize(SAMPLE_TEXT, {
          voice: p.voice,
          rate: p.rate,
          pitch: p.pitch,
        });
        writeFileSync(path, audio);
        made++;
        console.log(`  ✔ ${key.padEnd(22)} ${String(p.label ?? '').padEnd(16)} ${String(audio.length).padStart(7)} 字节`);
      } catch (error) {
        console.log(`  ✘ ${key.padEnd(22)} ${error.message}`);
      }
    },
    4,
  );

  console.log(`\n共 ${entries.length} 个候选（新生成 ${made} 个），文件在 ${dir}/`);
  console.log('挑好后执行（把 <key> 换成你看中的那个）：');
  console.log('    npm run voice -- <key>');
  console.log('\n例如台湾腔御姐：');
  console.log('    npm run voice -- tw-hsiaochen-yujie');
  process.exit(0);
}

// ── 正式生成 ──
const pending = VOICE_CLIPS.filter((clip) => force || !existsSync(join(OUT_DIR, `${clip.id}.mp3`)));
console.log(`语音包 id：${packId}`);
console.log(`音色：${style.voice}`);
console.log(`风格：${style.label}   语速 ${style.rate}   音高 ${style.pitch}`);
console.log(`片段总数：${VOICE_CLIPS.length}，本次需要生成：${pending.length}\n`);

if (pending.length === 0) {
  console.log('全部已存在，无需生成。');
} else {
  let done = 0;
  let failed = 0;
  const started = Date.now();
  await runPool(
    pending,
    async (clip) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const audio = await synthesize(clip.text, style);
          writeFileSync(join(OUT_DIR, `${clip.id}.mp3`), audio);
          done++;
          const pct = String(Math.round((done / pending.length) * 100)).padStart(3);
          process.stdout.write(`\r  ${pct}%  ${String(done).padStart(3)}/${pending.length}  ${clip.id.padEnd(22)}`);
          return;
        } catch (error) {
          if (attempt === 3) {
            failed++;
            console.log(`\n  ✘ ${clip.id} 失败（已重试 3 次）：${error.message}`);
          } else {
            await sleep(600 * attempt);
          }
        }
      }
    },
    4,
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n\n生成完成：成功 ${done}，失败 ${failed}，耗时 ${seconds}s`);
}

// ── 写 manifest（前端靠它判断「语音包在不在、用的哪个音色」）──
const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.mp3')) : [];
const present = VOICE_CLIPS.filter((clip) => files.includes(`${clip.id}.mp3`));
writeFileSync(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      voice: style.voice,
      rate: style.rate,
      pitch: style.pitch,
      label: style.label,
      generatedAt: new Date().toISOString(),
      count: present.length,
      clips: present.map((clip) => clip.id),
    },
    null,
    1,
  ),
);
console.log(`manifest.json 已写入：${present.length}/${VOICE_CLIPS.length} 个片段可用`);
if (present.length < VOICE_CLIPS.length) {
  const missing = VOICE_CLIPS.filter((c) => !present.includes(c)).map((c) => c.id);
  console.log(`缺失：${missing.join(', ')}`);
  console.log('（不影响使用 —— 前端遇到缺失片段会自动回退到浏览器 TTS）');
}

// ── 更新索引（前端的选择器读的就是它）──
updateIndex({
  id: packId,
  label: style.label,
  voice: style.voice,
  rate: style.rate,
  pitch: style.pitch,
  count: present.length,
});
console.log(`\n玩家在界面上就能选这套语音：大厅 →「法官语音」那一栏`);
