/**
 * 生成「官网原声」试听页。
 *
 * 用途：把微软语音库里**所有能念中文的音色**原样念同一句话录下来，
 * 做一个可以在手机浏览器里挨个点着听的页面，用来挑音色。
 *
 * 关键：**完全不加任何加工**（音高 +0Hz、语速 +0%）。
 * 之前给的「御姐」是我压了音高调出来的，这次要听的是官网本来的声音。
 * 挑定之后再用加工参数微调也不迟。
 *
 * 用法：
 *   node scripts/make-voice-audition.mjs            # 缺的才生成
 *   node scripts/make-voice-audition.mjs --force    # 全部重新生成
 *
 * 产物：
 *   web/sounds/voice/_audition/<音色>.mp3
 *   web/sounds/voice/_audition/index.html   ← 用浏览器打开这个
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { synthesize } from './lib/edge-tts.mjs';

const OUT_DIR = 'web/sounds/voice/_audition';
const SAMPLE_TEXT = '天黑请闭眼。狼人请睁眼，请确认今晚的战术，选择要击杀的玩家。';

const force = process.argv.includes('--force');

/** 已知音色的中文名（官网给的是英文，挑音色时中文更好认） */
const NAMES = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-liaoning-XiaobeiNeural': '晓北（东北话）',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮（陕西话）',
  'zh-HK-HiuGaaiNeural': '曉佳（粵語）',
  'zh-HK-HiuMaanNeural': '曉曼（粵語）',
  'zh-HK-WanLungNeural': '雲龍（粵語）',
  'zh-TW-HsiaoChenNeural': '曉臻（台灣）',
  'zh-TW-HsiaoYuNeural': '曉雨（台灣）',
  'zh-TW-YunJheNeural': '雲哲（台灣）',
  // 多语言音色：官网名字是英文 + 所属语言，这里补上中文标签
  'en-US-AvaMultilingualNeural': 'Ava（美式英语·女）',
  'en-US-EmmaMultilingualNeural': 'Emma（美式英语·女）',
  'en-US-AndrewMultilingualNeural': 'Andrew（美式英语·男）',
  'en-US-BrianMultilingualNeural': 'Brian（美式英语·男）',
  'en-AU-WilliamMultilingualNeural': 'William（澳式英语·男）',
  'fr-FR-VivienneMultilingualNeural': 'Vivienne（法语·女）',
  'fr-FR-RemyMultilingualNeural': 'Rémy（法语·男）',
  'de-DE-SeraphinaMultilingualNeural': 'Seraphina（德语·女）',
  'de-DE-FlorianMultilingualNeural': 'Florian（德语·男）',
  'it-IT-GiuseppeMultilingualNeural': 'Giuseppe（意大利语·男）',
  'pt-BR-ThalitaMultilingualNeural': 'Thalita（葡语·女）',
  'ko-KR-HyunsuMultilingualNeural': 'Hyunsu（韩语·男）',
};

/** 分组：让试听页按「女声 / 男声 / 方言 / 粤语 / 多语言」排，照着挑更方便 */
function groupOf(v) {
  const locale = v.Locale ?? '';
  if (locale.startsWith('zh-TW')) return '台湾国语';
  if (locale.startsWith('zh-HK')) return '粤语（香港）';
  if (locale.includes('liaoning')) return '方言（东北）';
  if (locale.includes('shaanxi')) return '方言（陕西）';
  if (locale === 'zh-CN') return v.Gender === 'Female' ? '女声（普通话）' : '男声（普通话）';
  return '可念中文的多语言音色';
}

const GROUP_ORDER = ['女声（普通话）', '男声（普通话）', '台湾国语', '粤语（香港）', '方言（东北）', '方言（陕西）', '可念中文的多语言音色'];

const res = await fetch(
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list' +
    '?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4',
  {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    },
  },
);
const all = await res.json();

// 中文音色 + 多语言音色（多语言能念中文，但可能有外国口音，单独列出来让人自己判断）
const voices = all.filter((v) => {
  const locale = typeof v.Locale === 'string' ? v.Locale : '';
  const short = typeof v.ShortName === 'string' ? v.ShortName : '';
  return locale.startsWith('zh') || short.includes('Multilingual');
});

console.log(`官网能念中文的音色：${voices.length} 个\n`);
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 并发 4 生成，缺的才做 */
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

const rows = [];
let made = 0;
let failed = 0;

await runPool(voices, async (v) => {
  const short = v.ShortName;
  const file = `${short}.mp3`;
  const label =
    NAMES[short] ??
    short
      .replace(/^zh-(CN|TW|HK)-/, '')
      .replace(/Neural$/, '')
      .replace(/Multilingual$/, '');
  const group = groupOf(v);

  if (force || !existsSync(join(OUT_DIR, file))) {
    try {
      // 原声：不加任何音高/语速加工
      const audio = await synthesize(SAMPLE_TEXT, { voice: short });
      writeFileSync(join(OUT_DIR, file), audio);
      made++;
      console.log(`  ✔ ${short.padEnd(38)} ${String(Math.round(audio.length / 1024)).padStart(3)} KB  ${label}`);
    } catch (error) {
      failed++;
      console.log(`  ✘ ${short.padEnd(38)} ${error.message}`);
      return;
    }
    await sleep(200);
  }

  rows.push({ group, label, short, file, gender: v.Gender, locale: v.Locale });
}, 4);

// ── 生成试听页 ──
const groups = GROUP_ORDER.filter((g) => rows.some((r) => r.group === g));

const sections = groups
  .map((group) => {
    const list = rows
      .filter((r) => r.group === group)
      .sort((a, b) => (a.gender === b.gender ? a.label.localeCompare(b.label) : a.gender === 'Female' ? -1 : 1));

    const items = list
      .map(
        (r) => `
        <li class="voice">
          <div class="meta">
            <span class="name">${r.label}</span>
            <span class="tag ${r.gender === 'Female' ? 'f' : 'm'}">${r.gender === 'Female' ? '女声' : '男声'}</span>
            <span class="id">${r.short}</span>
          </div>
          <audio controls preload="none" src="${encodeURIComponent(r.file)}"></audio>
        </li>`,
      )
      .join('');

    return `
      <section>
        <h2>${group} <span class="count">${list.length} 个</span></h2>
        <ul>${items}</ul>
      </section>`;
  })
  .join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>法官音色试听 · 狼人杀</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 16px 14px 40px;
    background: #12141a; color: #e8ecf4;
    font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  h1 { font-size: 19px; margin: 0 0 6px; }
  .intro {
    font-size: 13px; color: #9aa6bb; margin-bottom: 18px;
    padding: 10px 12px; border-radius: 10px;
    background: #1a1e27; border: 1px solid #262c38;
  }
  .intro b { color: #e8ecf4; }
  .intro .line { margin-top: 6px; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: #cdd6e6; }
  h2 .count { font-size: 12px; color: #7c8798; font-weight: 400; }
  ul { list-style: none; margin: 0; padding: 0; }
  li.voice {
    padding: 10px 12px; margin-bottom: 8px; border-radius: 10px;
    background: #1a1e27; border: 1px solid #262c38;
  }
  .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .name { font-weight: 600; font-size: 15px; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .tag.f { background: rgba(224, 69, 94, .18); color: #ff9aab; }
  .tag.m { background: rgba(79, 140, 255, .18); color: #9dc0ff; }
  .id { font-size: 11px; color: #6b7688; font-family: ui-monospace, Consolas, monospace; }
  audio { width: 100%; height: 34px; }
  .foot { margin-top: 26px; font-size: 12px; color: #7c8798; }
</style>
</head>
<body>
  <h1>法官音色试听</h1>
  <div class="intro">
    全部是<b>微软官网原声，没有任何加工</b>（音高 +0Hz、语速 +0%）。每一条念的是同一句话：
    <div class="line">「${SAMPLE_TEXT}」</div>
    <div class="line">听完把喜欢的名字告诉我，我把它做成游戏里可选的语音包。</div>
  </div>
  ${sections}
  <div class="foot">
    共 ${rows.length} 个音色。多语言那一组技术上能念中文，但可能带外国口音，请自行判断。
  </div>
</body>
</html>`;

writeFileSync(join(OUT_DIR, 'index.html'), html);

console.log(`\n新生成 ${made} 个，失败 ${failed} 个`);
console.log(`试听页：${OUT_DIR}/index.html（共 ${rows.length} 个音色）`);
