// worker/src/config.ts
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env from worker dir
dotenv.config({ path: path.join(__dirname, '..', '.env') });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

export const config = {
  redisUrl: required('REDIS_URL'),
  apiUrl: required('SMM_API_URL'),
  workerSecret: required('SMM_WORKER_SECRET'),

  minio: {
    endpoint: required('MINIO_ENDPOINT'),
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
    bucketVideos: required('MINIO_BUCKET_VIDEOS'),
    bucketMusic: required('MINIO_BUCKET_MUSIC'),
    publicUrl: required('MINIO_PUBLIC_URL'),
  },

  tts: {
    yandexApiKey: process.env.YANDEX_TTS_API_KEY || '',
    yandexFolderId: process.env.YANDEX_TTS_FOLDER_ID || '',
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
    elevenlabsVoices: {
      heroMale: process.env.ELEVENLABS_VOICE_HERO_M || '',
      heroFemale: process.env.ELEVENLABS_VOICE_HERO_F || '',
      psy: process.env.ELEVENLABS_VOICE_PSY || '',
      lawyer: process.env.ELEVENLABS_VOICE_LAWYER || '',
      coach: process.env.ELEVENLABS_VOICE_COACH || '',
    },
  },

  media: {
    googleAiApiKey: process.env.GOOGLE_AI_API_KEY || '',
    pexelsApiKey: process.env.PEXELS_API_KEY || '',
  },
};
