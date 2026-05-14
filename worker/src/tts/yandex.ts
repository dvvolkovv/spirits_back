// worker/src/tts/yandex.ts
import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { YandexVoiceSelection } from './voices';

export interface YandexSynthInput {
  text: string;
  voice: YandexVoiceSelection;
}

export async function synthesizeYandex(input: YandexSynthInput): Promise<Buffer> {
  const apiKey = config.tts.yandexApiKey;
  const folderId = config.tts.yandexFolderId;
  if (!apiKey || !folderId) {
    throw new Error('YANDEX_SPEECHKIT_API_KEY or YANDEX_TTS_FOLDER_ID not configured');
  }

  const params = new URLSearchParams();
  params.set('text', input.text);
  params.set('lang', 'ru-RU');
  params.set('voice', input.voice.voice);
  if (input.voice.emotion) params.set('emotion', input.voice.emotion);
  params.set('format', 'lpcm');
  params.set('sampleRateHertz', '48000');
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
      timeout: 30000,
      validateStatus: () => true,
    },
  );
  if (r.status !== 200) {
    const errBody = Buffer.from(r.data).toString('utf8').slice(0, 200);
    throw new Error(`Yandex TTS ${r.status}: ${errBody}`);
  }
  const buf = Buffer.from(r.data);
  logger.debug({ voice: input.voice.voice, bytes: buf.length }, 'yandex synth ok');
  return buf;
}
