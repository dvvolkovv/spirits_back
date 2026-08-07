#!/usr/bin/env ts-node
/**
 * Разовая генерация превью голосов в MinIO: speech-samples/<voice>.mp3.
 * Идемпотентен — уже загруженные сэмплы пропускает, `--force` перезаливает.
 *
 * Заодно это интеграционная проверка обоих провайдеров: если скрипт отработал
 * с failed=0 и ненулевыми размерами, значит и Yandex SpeechKit, и OpenAI TTS
 * реально отвечают на боевых ключах (адаптеры сами бросают на пустом теле).
 *
 * Запуск: npx ts-node scripts/generate-voice-samples.ts [--force]
 *
 * Требует в окружении (берутся из .env, как у приложения):
 *   MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_PUBLIC_URL
 *   YANDEX_SPEECHKIT_API_KEY + YANDEX_TTS_FOLDER_ID, OPENAI_API_KEY
 */
import 'dotenv/config';
import { StorageService } from '../src/common/services/storage.service';
import { VOICE_CATALOG } from '../src/speech/voices';
import { synthesizeYandex } from '../src/speech/providers/yandex';
import { synthesizeOpenai } from '../src/speech/providers/openai';

const SAMPLE_RU = 'Здравствуйте! Так звучит мой голос. Я помогу вам разобраться с вашим вопросом.';
const SAMPLE_EN = 'Hello! This is how my voice sounds. I am here to help you with your question.';

/**
 * Бакет и префикс обязаны совпадать с тем, что отдаёт GET /webhook/speech/voices
 * в поле sampleUrl (speech.controller.ts): тот же SPEECH_BUCKET и тот же ключ
 * `speech-samples/<id>.mp3`. Разъедутся — превью в настройках будут ссылаться
 * в пустоту. Поэтому и заливаем через StorageService, а не через свой S3-клиент:
 * публичный адрес собирается ровно тем же кодом (upload возвращает publicUrl).
 */
const BUCKET = process.env.SPEECH_BUCKET || 'linkeon-assets';
const PREFIX = 'speech-samples/';

const FORCE = process.argv.includes('--force');

async function main() {
  // StorageService — обычный Nest-провайдер, но без DI-контейнера ему нужен
  // ручной onModuleInit: он же валидирует MINIO_*-переменные и поднимает
  // S3-клиент. Без вызова s3 остаётся undefined и первый upload падает.
  const storage = new StorageService();
  storage.onModuleInit();

  // Один ListObjects вместо HeadObject на каждый голос: в каталоге два десятка
  // голосов, лишние round-trip'ы ни к чему.
  const existing = FORCE
    ? new Set<string>()
    : new Set(await storage.list({ bucket: BUCKET, prefix: PREFIX }));

  let created = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const v of VOICE_CATALOG) {
    const key = `${PREFIX}${v.id}.mp3`;

    if (existing.has(key)) {
      skipped++;
      console.log(`skip ${v.provider}/${v.id} — уже в ${BUCKET}/${key}`);
      continue;
    }

    try {
      // Текст под язык провайдера: у Yandex SpeechKit lang жёстко ru-RU
      // (providers/yandex.ts), английская фраза там прозвучала бы транслитом.
      const bytes = v.provider === 'yandex'
        ? await synthesizeYandex(SAMPLE_RU, v.id)
        : await synthesizeOpenai(SAMPLE_EN, v.id);

      const url = await storage.upload({
        bucket: BUCKET,
        key,
        body: bytes,
        contentType: 'audio/mpeg',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      created++;
      console.log(`ok   ${v.provider}/${v.id} — ${bytes.length} bytes — ${url}`);
    } catch (e: any) {
      // Один упавший голос не должен обрывать прогон: остальные заливаются,
      // а список провалов уезжает в конец вывода и в ненулевой exit-код.
      const message = e?.message || String(e);
      failed.push(`${v.provider}/${v.id}: ${message}`);
      console.error(`FAIL ${v.provider}/${v.id} — ${message}`);
    }
  }

  console.log(`\ncreated=${created} skipped=${skipped} failed=${failed.length}`);
  if (failed.length) {
    console.error('Провалившиеся голоса:\n' + failed.join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
