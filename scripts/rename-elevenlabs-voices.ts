#!/usr/bin/env ts-node
/**
 * Разовое переименование клонов голоса у ElevenLabs: имя `user_<id>` (у
 * телефонных пользователей — номер) → `linkeon-<8 hex>`. Спека
 * docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 1.
 * Логика и тесты — src/voice-avatar/rename-voices.ts.
 *
 * Запуск — на сервере, из ~/spirits_back:
 *   npx ts-node scripts/rename-elevenlabs-voices.ts           # сухой прогон: число голосов и их voice_id
 *   npx ts-node scripts/rename-elevenlabs-voices.ts --apply   # переименовать у ElevenLabs
 *
 * Требует в окружении (берутся из .env, как у приложения): DATABASE_URL и,
 * для --apply, ELEVENLABS_API_KEY. Ключ не печатается. База не меняется:
 * voice_id после переименования тот же. Повторный --apply безвреден — даст
 * голосам новые случайные имена.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { listVoiceIds, renameVoices } from '../src/voice-avatar/rename-voices';

async function main() {
  const apply = process.argv.slice(2).includes('--apply');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    const voiceIds = await listVoiceIds(pg);
    const r = await renameVoices({
      voiceIds,
      apply,
      apiKey: process.env.ELEVENLABS_API_KEY,
      log: (m) => console.log(m),
    });
    console.log(JSON.stringify(r));
    if (r.failed.length > 0) process.exitCode = 1;
  } finally {
    await pg.end();
  }
}

// Только сообщение: у ошибки axios в config лежат заголовки запроса с ключом.
main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
