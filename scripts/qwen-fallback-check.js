#!/usr/bin/env node
// Живая проверка запасного пути ClaudeCliService на Qwen: настоящий claude,
// настоящий Alibaba, без выката. Запуск — из корня собранного клона (npm run build):
//   read -rs QWEN_FALLBACK_API_KEY; export QWEN_FALLBACK_API_KEY; node scripts/qwen-fallback-check.js
// Ключ — только из env, скрипт его не печатает. Claude «ломается» пустым
// CLAUDE_CONFIG_DIR (вход не найден → auth → Qwen); боевые креды не трогаются.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

if (!process.env.QWEN_FALLBACK_API_KEY) {
  console.error('нет QWEN_FALLBACK_API_KEY');
  process.exit(2);
}
// Чужие креды из окружения: с ними Claude мог бы пройти, и проверка шла бы
// мимо Qwen. Снимаем до первого запуска.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete process.env[k];
}
// Без окна: каждая проверка идёт путём «Claude упал → Qwen», а не через окно.
process.env.QWEN_FALLBACK_BREAKER_MS = '0';
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-check-cfg-'));
process.env.CLAUDE_CONFIG_DIR = cfgDir;

const distCandidates = [
  path.join(__dirname, '..', 'dist', 'common', 'services', 'claude-cli.service.js'),
  path.join(__dirname, '..', 'dist', 'src', 'common', 'services', 'claude-cli.service.js'),
];
const distPath = distCandidates.find((p) => fs.existsSync(p));
if (!distPath) {
  console.error('нет собранного сервиса — сначала npm run build');
  process.exit(2);
}
const { ClaudeCliService } = require(distPath);

// --- Крошечный PNG-энкодер без внешних зависимостей (только zlib + Buffer) ---
// CRC32 считаем сами (не зависим от того, есть ли zlib.crc32 в этой версии Node).
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
/** Однотонный красный PNG size×size, 8-бит RGB, без палитры и без фильтрации строк. */
function makeRedPng(size = 64) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: RGB
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace
  const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB pixels
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = 255; // R
    row[1 + x * 3 + 1] = 0; // G
    row[1 + x * 3 + 2] = 0; // B
  }
  const raw = Buffer.concat(new Array(size).fill(row));
  const idatData = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const svc = new ClaudeCliService();
  const results = [];
  /**
   * viaQwen: true — ответ обязан прийти от Qwen (fallbackStats().ok вырос
   * ровно на 1); false — Qwen не участвовал (ok не вырос).
   */
  const check = async (name, viaQwen, fn) => {
    const t0 = Date.now();
    const okBefore = svc.fallbackStats().ok;
    try {
      const detail = await fn();
      const delta = svc.fallbackStats().ok - okBefore;
      if (viaQwen && delta !== 1) throw new Error(`ответ не от Qwen (fallbackStats.ok +${delta}): ${detail}`);
      if (!viaQwen && delta !== 0) throw new Error(`Qwen участвовал (fallbackStats.ok +${delta}): ${detail}`);
      results.push({ name, ok: true, ms: Date.now() - t0, detail });
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: String((e && e.message) || e).slice(0, 300) });
    }
  };

  try {
    await check('json, haiku-класс → Qwen', true, async () => {
      const r = await svc.textWithCost('Ответь одним словом: ок', { model: 'claude-haiku-4-5', timeoutMs: 120000 });
      return `«${r.text}», $${r.costUsd}`;
    });

    await check('stream-json + Read в своём cwd → Qwen, onProgress видит Read', true, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-check-cwd-'));
      try {
        fs.writeFileSync(path.join(dir, 'note.txt'), 'Кодовое слово: черёмуха-47\n');
        const tools = [];
        const r = await svc.textWithCost('Прочитай файл note.txt инструментом Read и назови кодовое слово. Ответь только словом.', {
          model: 'claude-opus-5-5', cwd: dir, tools: 'Read', timeoutMs: 180000,
          onProgress: (e) => tools.push(e.name),
        });
        if (!/черёмуха-47/.test(r.text)) throw new Error(`не то слово: ${r.text}`);
        return `«${r.text}», инструменты: ${tools.join(',') || '—'}`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await check('WebFetch (как у TG-бота) → Qwen, страница со случайным токеном', true, async () => {
      // Токен, которого модель знать не может: увидеть его можно, только
      // действительно открыв страницу. httpbin отдаёт декодированный base64url.
      const token = crypto.randomBytes(9).toString('hex');
      const url = `https://httpbin.org/base64/${Buffer.from(token).toString('base64url')}`;
      const tools = [];
      const r = await svc.textWithCost(`Открой ${url} инструментом WebFetch и перепиши дословно текст страницы. Только текст.`, {
        model: 'claude-opus-5-5', tools: 'WebFetch', allowedTools: 'WebFetch', timeoutMs: 180000,
        onProgress: (e) => tools.push(e.name),
      });
      if (!tools.includes('WebFetch')) throw new Error(`WebFetch не вызывался (инструменты: ${tools.join(',') || '—'}): ${r.text.slice(0, 120)}`);
      if (!r.text.includes(token)) throw new Error(`в ответе нет токена страницы: ${r.text.slice(0, 120)}`);
      return `«${r.text.slice(0, 80)}», инструменты: ${tools.join(',')}`;
    });

    await check('WebSearch (как у TG-бота) → Qwen', true, async () => {
      const tools = [];
      const r = await svc.textWithCost('Найди инструментом WebSearch, в каком году основан Alibaba Group. Ответь годом.', {
        model: 'claude-opus-5-5', tools: 'WebSearch', allowedTools: 'WebSearch', timeoutMs: 180000,
        onProgress: (e) => tools.push(e.name),
      });
      if (!tools.includes('WebSearch')) throw new Error(`WebSearch не вызывался (инструменты: ${tools.join(',') || '—'}): ${r.text.slice(0, 120)}`);
      if (!r.text.trim()) throw new Error('пустой ответ');
      return `«${r.text.slice(0, 80)}», инструменты: ${tools.join(',')}`;
    });

    await check('вложение-картинка (фото от TG-бота) → Qwen', true, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-check-img-'));
      const imgPath = path.join(dir, 'red.png');
      try {
        fs.writeFileSync(imgPath, makeRedPng());
        const r = await svc.textWithCost('Какого цвета картинка во вложении? Ответь одним словом.', {
          model: 'claude-opus-5-5', attachments: [imgPath], onProgress: () => {}, timeoutMs: 180000,
        });
        if (!/красн|red/i.test(r.text)) throw new Error(`не то: ${r.text}`);
        return `«${r.text}»`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await check('noFallback (проба живости) обязана упасть на Claude', false, async () => {
      let text;
      try {
        text = await svc.text('Reply with exactly: ok', { model: 'claude-haiku-4-5', timeoutMs: 60000, noFallback: true });
      } catch (e) {
        return `упала, как и должна: ${String(e.message).slice(0, 100)}`;
      }
      throw new Error(`проба прошла — значит, пошла мимо Claude: ${String(text).slice(0, 100)}`);
    });
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} (${r.ms} мс): ${r.detail}`);
  console.log('fallbackStats:', JSON.stringify(svc.fallbackStats()));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
