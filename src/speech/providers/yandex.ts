// src/speech/providers/yandex.ts
import axios from 'axios';

/**
 * Синтез через Yandex SpeechKit v1. Просим сразу mp3 (в отличие от
 * worker/src/tts/yandex.ts, которому нужен LPCM под ffmpeg-пайплайн Remotion).
 */
export async function synthesizeYandex(text: string, voice: string): Promise<Buffer> {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_TTS_FOLDER_ID;
  if (!apiKey || !folderId) {
    throw new Error('YANDEX_SPEECHKIT_API_KEY or YANDEX_TTS_FOLDER_ID not configured');
  }

  const params = new URLSearchParams();
  params.set('text', text);
  params.set('lang', 'ru-RU');
  params.set('voice', voice);
  params.set('format', 'mp3');
  params.set('folderId', folderId);

  const r = await axios.post(
    'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',
    params.toString(),
    {
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
      validateStatus: () => true,
    },
  );
  if (r.status !== 200) {
    const errBody = Buffer.from(r.data).toString('utf8').slice(0, 200);
    throw new Error(`Yandex TTS ${r.status}: ${errBody}`);
  }
  const buf = Buffer.from(r.data);
  if (buf.length === 0) throw new Error('Yandex TTS returned empty body');
  return buf;
}
