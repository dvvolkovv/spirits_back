#!/usr/bin/env node
// Живая проверка цепочки запасных ClaudeCliService (Qwen → Kimi) и выбора
// Kimi: настоящий claude, настоящие провайдеры, без выката. Запуск — из корня
// собранного клона (npm run build), ключи — только из env, скрипт их не печатает:
//   read -r KIMI_FALLBACK_API_KEY; read -r QWEN_FALLBACK_API_KEY; export KIMI_FALLBACK_API_KEY QWEN_FALLBACK_API_KEY
//   node scripts/llm-fallback-check.js
// QWEN_FALLBACK_API_KEY необязателен: без него проверки «через Qwen» пропускаются.
// Claude «ломается» пустым CLAUDE_CONFIG_DIR (вход не найден → auth); боевые
// креды не трогаются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

if (!process.env.KIMI_FALLBACK_API_KEY) {
  console.error('нет KIMI_FALLBACK_API_KEY');
  process.exit(2);
}
const HAS_QWEN = !!process.env.QWEN_FALLBACK_API_KEY;
// Чужие креды из окружения: с ними Claude мог бы пройти, и проверка шла бы
// мимо цепочки. Снимаем до первого запуска.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete process.env[k];
}
// Без окон: каждая проверка идёт путём «Claude упал → цепочка», а «не отвечает»
// одной проверки не переносится на следующую.
process.env.LLM_FALLBACK_BREAKER_MS = '0';
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-cfg-'));
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

/** Ключи на время одной проверки: undefined — снять. */
async function withKeys(keys, fn) {
  const saved = {};
  for (const k of Object.keys(keys)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(keys)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

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
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const svc = new ClaudeCliService();
  const results = [];
  const counts = () => {
    const p = svc.fallbackStats().providers;
    return { qwenOk: p.qwen.ok, qwenFailed: p.qwen.failed, kimiOk: p.kimi.ok, kimiFailed: p.kimi.failed };
  };
  /** grow — счётчики, которые обязаны вырасти ровно на 1 (остальные — не меняться);
   *  soft — сбой только в сведения, на итог не влияет. */
  const check = async (name, grow, fn, soft = false) => {
    const t0 = Date.now();
    const before = counts();
    try {
      const detail = await fn();
      const after = counts();
      for (const k of Object.keys(before)) {
        const want = grow.includes(k) ? 1 : 0;
        if (after[k] - before[k] !== want) throw new Error(`${k}: +${after[k] - before[k]}, ожидалось +${want}: ${detail}`);
      }
      results.push({ name, ok: true, ms: Date.now() - t0, detail });
    } catch (e) {
      results.push({ name, ok: false, soft, ms: Date.now() - t0, detail: String((e && e.message) || e).slice(0, 300) });
    }
  };
  const NO_QWEN = { QWEN_FALLBACK_API_KEY: undefined };
  const ASK = 'Ответь одним словом: ок';

  try {
    await check('Qwen выключен: json, haiku-класс → Kimi', ['kimiOk'], () => withKeys(NO_QWEN, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 120000 });
      return `«${r.text}», $${r.costUsd}`;
    }));

    await check('Qwen выключен: stream-json + Read в своём cwd → Kimi', ['kimiOk'], () => withKeys(NO_QWEN, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-cwd-'));
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
    }));

    await check('сведения: вложение-картинка → Kimi (умеет ли Kimi картинки)', ['kimiOk'], () => withKeys(NO_QWEN, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-img-'));
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
    }), true);

    await check('выбран Kimi → ответ без аварийного счёта', [], () => withKeys(NO_QWEN, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-opus-5-5', provider: 'kimi', timeoutMs: 120000 });
      if (!r.text.trim()) throw new Error('пустой ответ');
      return `«${r.text}» (Claude сломан — ответить мог только Kimi)`;
    }));

    await check('выбран Kimi с битым ключом → попытка Claude, ошибка цепочки', [], () =>
      withKeys({ ...NO_QWEN, KIMI_FALLBACK_API_KEY: 'sk-broken-check' }, async () => {
        let text;
        try {
          text = await svc.text(ASK, { model: 'claude-haiku-4-5', provider: 'kimi', timeoutMs: 120000 });
        } catch (e) {
          const m = String(e.message);
          if (!/^kimi \(выбран\): .* \| claude fallback: /.test(m)) throw new Error(`не та ошибка: ${m.slice(0, 200)}`);
          return 'ошибка начинается с выбранного, Claude пробовался';
        }
        throw new Error(`ответ пришёл, а не должен был: ${String(text).slice(0, 80)}`);
      }));

    if (HAS_QWEN) {
      await check('Claude → Qwen', ['qwenOk'], async () => {
        const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 120000 });
        return `«${r.text}»`;
      });
      await check('Claude → Qwen (битый ключ) → Kimi', ['qwenFailed', 'kimiOk'], () =>
        withKeys({ QWEN_FALLBACK_API_KEY: 'sk-broken-check' }, async () => {
          const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 180000 });
          return `«${r.text}»`;
        }));
    } else {
      results.push({ name: 'проверки через Qwen', ok: true, ms: 0, detail: 'пропущены: нет QWEN_FALLBACK_API_KEY' });
    }

    await check('noFallback (проба живости) обязана упасть на Claude', [], async () => {
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

  for (const r of results) console.log(`${r.ok ? 'OK  ' : r.soft ? 'INFO' : 'FAIL'} ${r.name} (${r.ms} мс): ${r.detail}`);
  console.log('fallbackStats:', JSON.stringify(svc.fallbackStats()));
  process.exit(results.every((r) => r.ok || r.soft) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
