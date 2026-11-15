#!/usr/bin/env node
// Живая проверка цепочки запасных ClaudeCliService через Codex: настоящий
// claude, codex-bridge на 127.0.0.1:8790, без выката. Запуск — НА СЕРВЕРЕ с
// поднятым мостом, из корня собранного клона (npm run build):
//   CODEX_FALLBACK_API_KEY=local-bridge node scripts/codex-fallback-check.js
// Qwen и Kimi принудительно выключаются на время проверок (withKeys), чтобы
// ответ гарантированно шёл через Codex. Ключ-заглушка local-bridge: мост
// аутентифицируется сам через ~/.codex/auth.json (подписка ChatGPT Pro).
// Claude «ломается» пустым CLAUDE_CONFIG_DIR (вход не найден → auth); боевые
// креды не трогаются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

if (!process.env.CODEX_FALLBACK_API_KEY) {
  console.error('нет CODEX_FALLBACK_API_KEY');
  process.exit(2);
}
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
const { ClaudeCliService, ClaudeCliCallError } = require(distPath);

// Ошибка CLI несёт только безопасный текст (spec 2026-11-02-safe-cli-errors):
// попытка — «claude CLI <что>: <вид>[, status N][, деталь]», склейка — через
// « | <провайдер> fallback: ». Сырого текста сбоя (ответ API, stderr, stdout) в
// нём быть не должно; текст отказа самого CLI («Not logged in · Please run
// /login») — допустим, поэтому его фраз здесь нет.
const RAW_CLI_TEXT = /Failed to authenticate|API Error|stderr=|stdout=|exited with code/;

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
    return { codexOk: p.codex.ok, codexFailed: p.codex.failed };
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
  const NO_OTHERS = { QWEN_FALLBACK_API_KEY: undefined, KIMI_FALLBACK_API_KEY: undefined };
  const ASK = 'Ответь одним словом: ок';

  try {
    await check('Qwen и Kimi выключены: json, haiku-класс → Codex', ['codexOk'], () => withKeys(NO_OTHERS, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 120000 });
      return `«${r.text}», $${r.costUsd}`;
    }));

    await check('Qwen и Kimi выключены: stream-json + Read в своём cwd → Codex', ['codexOk'], () => withKeys(NO_OTHERS, async () => {
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

    await check('сведения: вложение-картинка → Codex (best-effort input_image)', ['codexOk'], () => withKeys(NO_OTHERS, async () => {
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

    await check('выбран Codex → ответ без аварийного счёта', [], () => withKeys(NO_OTHERS, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-opus-5-5', provider: 'codex', timeoutMs: 120000 });
      if (!r.text.trim()) throw new Error('пустой ответ');
      return `«${r.text}» (Claude сломан — ответить мог только Codex)`;
    }));

    await check('noFallback (проба живости) обязана упасть на Claude', [], async () => {
      let text;
      try {
        text = await svc.text('Reply with exactly: ok', { model: 'claude-haiku-4-5', timeoutMs: 60000, noFallback: true });
      } catch (e) {
        const m = String(e.message);
        if (!/^claude CLI /.test(m) || RAW_CLI_TEXT.test(m)) throw new Error(`не тот текст ошибки пробы: ${m.slice(0, 200)}`);
        if (!(e instanceof ClaudeCliCallError) || !e.kind) throw new Error(`у ошибки пробы нет признаков: ${e && e.name}`);
        return `упала, как и должна (${e.kind}): ${m.slice(0, 100)}`;
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
