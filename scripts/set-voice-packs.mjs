/**
 * 决定「游戏里出现哪几套语音包、按什么顺序」。
 *
 * `npm run voice -- <key>` 每生成一套就会自动注册进 index.json，
 * 但**游戏里露出的清单应该由人决定**，不是「生成过就都冒出来」。
 * 这个脚本按你给的顺序重写 index.json —— 没列出来的包留在磁盘上但不出现在界面里。
 *
 * 用法：
 *   node scripts/set-voice-packs.mjs tw-hsiaochen-yujie xiaoxiao xiaobei tw-yunjhe yunjian yunxi
 *
 * 第一个 = 新玩家的默认音色。想恢复全部：不带参数会列出当前可选清单。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_ROOT = 'web/sounds/voice';
const INDEX_PATH = join(OUT_ROOT, 'index.json');

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (wanted.length === 0) {
  console.log('用法：node scripts/set-voice-packs.mjs <包id> [<包id> ...]   ← 第一个是默认');
  console.log('\n磁盘上已有的语音包：');
  const fs = await import('node:fs');
  for (const entry of fs.readdirSync(OUT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const man = join(OUT_ROOT, entry.name, 'manifest.json');
    if (!existsSync(man)) continue;
    const data = JSON.parse(readFileSync(man, 'utf8'));
    console.log(`  ${entry.name.padEnd(24)} ${data.label ?? ''}  (${data.count ?? 0} 片段)`);
  }
  process.exit(0);
}

const packs = [];
const missing = [];

for (const id of wanted) {
  const manifestPath = join(OUT_ROOT, id, 'manifest.json');
  if (!existsSync(manifestPath)) {
    missing.push(id);
    continue;
  }
  const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  packs.push({
    id,
    label: data.label ?? id,
    voice: data.voice ?? '',
    rate: data.rate ?? '+0%',
    pitch: data.pitch ?? '+0Hz',
    count: data.count ?? 0,
  });
}

if (missing.length > 0) {
  console.error(`这些包不存在（先用 npm run voice -- <key> 生成）：${missing.join(', ')}`);
  process.exit(1);
}

writeFileSync(INDEX_PATH, JSON.stringify({ packs }, null, 1));

console.log(`index.json 已重写：游戏里会出现 ${packs.length} 套语音包（第一个是默认）\n`);
for (const [i, p] of packs.entries()) {
  const style = p.rate === '+0%' && p.pitch === '+0Hz' ? '官网原声' : `加工 ${p.rate} ${p.pitch}`;
  console.log(`  ${i === 0 ? '默认' : `  ${i + 1}`}  ${p.label.padEnd(16)} ${p.id.padEnd(22)} ${style}`);
}
