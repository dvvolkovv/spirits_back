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
 * Голоса — из user_voice и сироты: клоны аккаунта (category=cloned) с именем
 * строго user_<номер|uuid>, которых в user_voice нет (перечень аккаунта — GET
 * /v2/voices, нужен ключ и в сухом прогоне). В выводе — только число и
 * voice_id, имён целиком нет.
 *
 * Требует в окружении (берутся из .env, как у приложения): DATABASE_URL и
 * ELEVENLABS_API_KEY (без него сухой прогон покажет только user_voice). Ключ
 * не печатается. База не меняется: voice_id после переименования тот же.
 * Повторный --apply безвреден — даст голосам новые случайные имена. Код
 * выхода 1 — если какой-то голос не переименован или при --apply не получен
 * перечень аккаунта (сироты остались).
 */
import 'dotenv/config';
import { Client } from 'pg';
import { listVoiceIds, renameVoices } from '../src/voice-avatar/rename-voices';
import { scriptErrorText } from '../src/common/one-off-script';

// Файлов скрипт не пишет, но правило для разовых скриптов спеки одно: всё,
// что они создают, — только владельцу.
process.umask(0o077);

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
    if (apply && r.accountUserVoices === null) {
      console.log('перечень голосов аккаунта не получен — сироты не переименованы');
      process.exitCode = 1;
    }
  } finally {
    await pg.end();
  }
}

// Только сообщение и код: у ошибки axios в config лежат заголовки запроса с ключом.
main().catch((e) => {
  console.error(scriptErrorText(e));
  process.exit(1);
});
