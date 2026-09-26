/**
 * 生成 PWA 图标（纯 Node 实现，不依赖任何图形库）。
 *
 * 为什么需要图标：如果不做小程序、定位成"网页"，那用户入口就是一条链接，
 * 很难找。加上 PWA 支持后，朋友可以把网页「添加到主屏幕」，
 * 得到一个真正的图标 + 全屏无地址栏 —— 体验接近小程序。
 *
 * 图形：深色底 + 一弯月牙 + 一对发光的狼眼。
 *
 * 两个设计要点：
 *
 * 1) **抗锯齿靠 4x4 超采样，不用解析式覆盖率。**
 *    第一版我用「(半径-距离)/1.0」当覆盖率，但那个 1.0 是"归一化坐标单位"，
 *    等于整张图，结果形状变成一团软糊；眼睛的衰减更是溢出到全图，
 *    把整张图标染成红褐色。改成每个子采样做硬判定再平均，既简单又正确。
 *
 * 2) **脚本会自校验生成结果。**
 *    因为写这个脚本的人（以及看不到图片的场景）无法用眼睛确认图标长什么样，
 *    所以生成后直接解码 PNG 像素做断言：月牙必须够亮、眼睛必须是暖色、
 *    四角必须是深色。不符合就退出并报错，避免又产出一个"格式合法但内容难看"的图标。
 *
 * 运行：npm run icons
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, '..', 'web');

// ────────────────────────── PNG 编码 ──────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  // 10/11/12 保持 0：压缩方式 / 滤波方式 / 非隔行

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 每行滤波字节：0 = 无滤波
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 只用于自校验：把我们自己写的（滤波全 0、非隔行）PNG 解码回 RGBA */
function decodePng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    // 注意 copy 的参数顺序是 (target, targetStart, sourceStart, sourceEnd)。
    // 第一版把 targetStart 和 sourceStart 写反了，读出来是错位的数据，
    // 导致自校验对着正确的图标报了一堆假失败。
    const row = Buffer.from(out.buffer, out.byteOffset + y * width * 4, width * 4);
    raw.copy(row, 0, y * stride + 1, y * stride + 1 + width * 4);
  }
  return { width, height, pixels: out };
}

// ────────────────────────── 绘图 ──────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/** 图形的几何参数（都用 0..1 的相对坐标，任何尺寸下形状一致） */
const SHAPE = {
  bgCenter: [0.5, 0.42],
  moonCenter: [0.5, 0.44],
  moonRadius: 0.3,
  cutOffset: [0.3 * 0.42, -0.3 * 0.2],
  cutScale: 0.86,
  eyeY: 0.74,
  eyeSpread: 0.135,
  eyeRx: 0.072,
  eyeRy: 0.04,
};

/** 单个采样点的颜色（硬判定，抗锯齿交给超采样） */
function sampleColor(fx, fy) {
  const s = SHAPE;

  // 背景径向渐变：中间偏亮，边缘更深
  const dist = Math.hypot(fx - s.bgCenter[0], fy - s.bgCenter[1]);
  const t = clamp01(dist / 0.78);
  let cr = lerp(0x22, 0x0a, t);
  let cg = lerp(0x28, 0x0c, t);
  let cb = lerp(0x3d, 0x16, t);

  // 月牙 = 大圆 减去 一个偏移的小圆
  const big = inCircle(fx, fy, s.moonCenter[0], s.moonCenter[1], s.moonRadius);
  const cut = inCircle(
    fx,
    fy,
    s.moonCenter[0] + s.cutOffset[0],
    s.moonCenter[1] + s.cutOffset[1],
    s.moonRadius * s.cutScale,
  );
  if (big && !cut) {
    cr = 0xff;
    cg = 0xe6;
    cb = 0xa8;
    return [cr, cg, cb];
  }

  // 一对发光的狼眼
  const left = inEllipse(fx, fy, 0.5 - s.eyeSpread, s.eyeY, s.eyeRx, s.eyeRy);
  const right = inEllipse(fx, fy, 0.5 + s.eyeSpread, s.eyeY, s.eyeRx, s.eyeRy);
  if (left || right) {
    cr = 0xff;
    cg = 0x6b;
    cb = 0x4a;
  }

  return [cr, cg, cb];
}

function drawIcon(size) {
  const SS = 4; // 每边 4 个子采样 → 16x 超采样
  const px = new Uint8ClampedArray(size * size * 4);
  const n = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb] = sampleColor((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = 255;
    }
  }
  return px;
}

// ────────────────────────── 自校验 ──────────────────────────

const luminance = ([r, g, b]) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);

/**
 * 断言图标内容符合设计意图。
 * 月牙取点：在大圆内、被剪掉的小圆外 → 必须是亮淡金色。
 * 眼睛取点：左眼中心 → 必须是暖色（红明显大于蓝）。
 */
function verify(pixels, size) {
  const at = (x, y) => {
    const i = (Math.round(y) * size + Math.round(x)) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
  };

  const corner = at(4, 4);
  // 月牙上取一个确定落在"大圆内、剪圆外"的点
  const moon = at(0.3 * size, 0.52 * size);
  const eyeL = at((0.5 - SHAPE.eyeSpread) * size, SHAPE.eyeY * size);

  const checks = [
    ['四角是深色背景', luminance(corner) < 90],
    ['整图不透明', corner[3] === 255 && moon[3] === 255],
    ['月牙是亮淡金色', luminance(moon) > 200 && moon[2] < moon[0] && moon[2] < moon[1]],
    ['眼睛是暖色（红明显大于蓝）', eyeL[0] > eyeL[2] + 40],
    ['眼睛比背景亮', luminance(eyeL) > luminance(corner) + 30],
  ];

  // 全图不应该被某种颜色"染色"。
  //
  // 第一版用「红 > 蓝 + 40」当判据，结果连**淡金色的月牙**也被算成暖色，
  // 报了假失败。真正要防的是「颜色溢出到背景」，所以：
  //   1) 直接检查背景区域（四角 + 四边中点）必须是冷色（蓝 >= 红）且够暗
  //   2) 用眼睛独有的特征（红-绿差值很大；月牙的该差值很小）统计眼睛面积
  const backgroundPoints = [
    [4, 4], [size - 5, 4], [4, size - 5], [size - 5, size - 5],
    [size / 2, 3], [size / 2, size - 4], [3, size / 2], [size - 4, size / 2],
  ];
  let backgroundClean = true;
  for (const [x, y] of backgroundPoints) {
    const p = at(x, y);
    if (!(p[2] >= p[0] && luminance(p) < 90)) backgroundClean = false;
  }
  checks.push(['背景干净、没有被图形颜色染色', backgroundClean]);

  let eyePixels = 0;
  let sampled = 0;
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      const p = at(x, y);
      sampled++;
      if (p[0] - p[1] > 80) eyePixels++;
    }
  }
  const eyeRatio = eyePixels / sampled;
  checks.push([
    `眼睛面积合理（${(eyeRatio * 100).toFixed(2)}%，应 0.8%~6%）`,
    eyeRatio > 0.008 && eyeRatio < 0.06,
  ]);

  let failed = 0;
  for (const [name, pass] of checks) {
    if (!pass) failed++;
    console.log(`    ${pass ? '\u2714' : '\u2716'} ${name}`);
  }
  return failed === 0;
}

// ────────────────────────── 主流程 ──────────────────────────

const targets = [
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-192.png', size: 192 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon.png', size: 64 },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const { file, size } of targets) {
  const png = encodePng(size, size, drawIcon(size));
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`  ${file.padEnd(24)} ${size}x${size}   ${(png.length / 1024).toFixed(1)} KB`);
}

console.log('\n自校验（解码 512 那张，检查图形是否真的画对了）：');
const decoded = decodePng(readFileSync(join(OUT_DIR, 'icon-512.png')));
const passed = verify(decoded.pixels, decoded.width);

if (!passed) {
  console.error('\n图标内容不符合设计预期，请修正 scripts/make-icons.mjs 里的几何参数。');
  process.exit(1);
}

console.log('\n图标已生成并校验通过 → web/');
