/**
 * Vue 模板编译检查。
 *
 * 为什么需要它：本项目的 Vue 模板写在 .ts 文件里的**字符串**中
 * （`template: \`...\``），TypeScript 完全看不见里面的内容。
 * 一个多余的标签、写错的自闭合、或者在模板字符串里混进一个反引号，
 * `tsc` 一句话都不会说，但运行时整个界面会白屏 —— 而且是在真机上才发现。
 *
 * 这个脚本把每个 `template:` 抽出来，真的用 Vue 的编译器编译一遍。
 * 它已经抓出过一个真实 bug：注释里写了反引号，把模板字符串当场截断。
 *
 * 用法：npm run check:templates
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { compile } from '@vue/compiler-dom';

/** 收集 web/ 下所有 .ts（跳过 vendor 里的第三方代码） */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      walk(path, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * 抽出源码里所有 `template: ` 后面的模板字符串内容。
 *
 * 必须手工扫描而不是正则：模板里本身可能含有反引号以外的任意字符，
 * 而且 `${}` 插值里也可能出现反引号。所以按字符走一遍，
 * 正确处理转义和插值嵌套。
 */
function extractTemplates(source) {
  const MARKER = 'template: `';
  const found = [];
  let from = 0;

  while (true) {
    const at = source.indexOf(MARKER, from);
    if (at < 0) break;
    let i = at + MARKER.length;
    let depth = 0;
    let text = '';

    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        text += ch + (source[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        depth++;
        text += '${';
        i += 2;
        continue;
      }
      if (depth > 0) {
        if (ch === '}') depth--;
        text += ch;
        i++;
        continue;
      }
      if (ch === '`') break;
      text += ch;
      i++;
    }

    found.push({ at, text });
    from = i + 1;
  }
  return found;
}

const files = walk('web');
let total = 0;
let failed = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const [index, template] of extractTemplates(source).entries()) {
    total++;
    try {
      const result = compile(template.text, {
        onError: (error) => {
          throw error;
        },
      });
      if (result.errors && result.errors.length > 0) throw result.errors[0];
    } catch (error) {
      failed++;
      const line = source.slice(0, template.at).split('\n').length;
      console.error(`✘ ${file}:${line}  第 ${index + 1} 个模板编译失败`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failed === 0) {
  console.log(`✅ ${total} 个 Vue 模板全部编译通过`);
} else {
  console.error(`\n❌ 检查了 ${total} 个模板，${failed} 个编译失败`);
}
process.exit(failed > 0 ? 1 : 0);
