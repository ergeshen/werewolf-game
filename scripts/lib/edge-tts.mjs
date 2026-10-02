/**
 * Edge TTS 客户端（微软 ReadAloud 接口）。
 *
 * 为什么自己实现而不用现成的库：这台机器的 shell 装不了 pip 包
 * （沙箱拒绝 pip 在解包阶段写文件），而项目本来就依赖 `ws`，
 * 用它直连微软的 WebSocket 反而更干净、也更好排查。
 *
 * 协议参数来自 edge-tts 7.2.8 的源码（constants.py / drm.py / communicate.py）：
 *   - Sec-MS-GEC 令牌 = sha256(「Windows 文件时间取整到 5 分钟」+ 固定 client token)
 *   - 先发 speech.config，再发 SSML，音频以二进制帧返回（前 2 字节是大端头长度）
 *   - 输出格式固定为 audio-24khz-48kbitrate-mono-mp3
 */
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { WebSocket } from 'ws';

const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600;

/** 生成 Sec-MS-GEC 令牌（算法见 drm.py） */
function generateSecMsGec() {
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300; // 取整到 5 分钟
  ticks *= 1e9 / 100; // 换成 100 纳秒单位
  const toHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return createHash('sha256').update(toHash, 'ascii').digest('hex').toUpperCase();
}

function connectId() {
  return randomBytes(16).toString('hex');
}

/** 复刻 Python 的 date_to_string()（微软那边按这个格式校验，不能换成别的时间格式） */
function dateToString() {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

/** 把返回帧里的头解析出来（\r\n 分隔的 key:value） */
function parseHeaders(buffer) {
  const text = buffer.toString('utf8');
  const out = {};
  for (const line of text.split('\r\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 合成一段文本，返回 mp3 的 Buffer。
 *
 * @param {string} text   要念的中文
 * @param {object} options voice / rate / pitch / volume
 */
export async function synthesize(text, options = {}) {
  const voice = options.voice ?? 'zh-CN-YunyangNeural';
  // 微软要的是「+0%」「-10%」这种带符号的写法
  const rate = options.rate ?? '+0%';
  const pitch = options.pitch ?? '+0Hz';
  const volume = options.volume ?? '+0%';

  const url =
    `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectId()}` +
    `&Sec-MS-GEC=${generateSecMsGec()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

  const ws = new WebSocket(url, {
    perMessageDeflate: true,
    headers: {
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
        ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36` +
        ` Edg/${CHROMIUM_MAJOR}.0.0.0`,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
    },
  });

  const audioChunks = [];

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('合成超时（30s）'));
    }, 30_000);

    const finish = (error) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (error) reject(error);
      else if (audioChunks.length === 0) reject(new Error('服务端没有返回音频'));
      else resolve(Buffer.concat(audioChunks));
    };

    ws.on('open', () => {
      // ① speech.config
      ws.send(
        `X-Timestamp:${dateToString()}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
          '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"' +
          '},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
      );

      // ② SSML
      const ssml =
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        `<voice name='${voice}'>` +
        `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
        escapeXml(text) +
        '</prosody></voice></speak>';

      ws.send(
        `X-RequestId:${connectId()}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${dateToString()}Z\r\n` +
          'Path:ssml\r\n\r\n' +
          ssml,
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 2) return;
        const headerLength = buf.readUInt16BE(0);
        if (headerLength > buf.length) return;
        const headers = parseHeaders(buf.subarray(2, 2 + headerLength));
        if (headers.path !== 'audio') return;
        const audio = buf.subarray(2 + headerLength);
        if (audio.length > 0) audioChunks.push(audio);
        return;
      }
      const text2 = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (text2.includes('Path:turn.end')) finish(null);
      else if (text2.includes('Path:response') && text2.includes('"error"')) {
        finish(new Error(`服务端报错: ${text2.slice(0, 300)}`));
      }
    });

    ws.on('error', (error) => finish(error));
    ws.on('close', () => finish(null));
  });
}

/** 查询可用语音列表（zh-CN 的神经语音） */
export async function listChineseVoices() {
  const res = await fetch(`https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
        ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36` +
        ` Edg/${CHROMIUM_MAJOR}.0.0.0`,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`语音列表请求失败: HTTP ${res.status}`);
  const all = await res.json();
  return all.filter((v) => typeof v.Locale === 'string' && v.Locale.startsWith('zh-CN'));
}

export { delay };
