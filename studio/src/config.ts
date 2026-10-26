import { assertDemoPhone } from './guard';

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface StudioConfig {
  cabinetUrl: string;
  apiUrl: string;
  basicAuth: { username: string; password: string } | null;
  demoPhone: string;
  debugSecret: string;
  speechkitKey: string;
  speechkitFolder: string;
  /** База и хранилище рабочего процесса (studio/src/worker); вне него — пусто. */
  databaseUrl: string;
  minio: MinioConfig | null;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`studio: не задана переменная ${name} (см. studio/.env.example)`);
  return v;
}

/**
 * Разбор окружения без побочных эффектов: файл .env читает вызывающий
 * (`import 'dotenv/config'`). needs говорит, какие ключи обязательны:
 * съёмке — демо-номер и секрет debug-ручек, озвучке — SpeechKit.
 */
export function parseConfig(env: Env, needs: { capture: boolean; tts: boolean; worker?: boolean }): StudioConfig {
  const cabinetUrl = (env.CABINET_URL?.trim() || 'https://test.linkeon.io').replace(/\/+$/, '');
  const apiUrl = (env.API_URL?.trim() || cabinetUrl).replace(/\/+$/, '');
  let basicAuth: StudioConfig['basicAuth'] = null;
  const ba = env.CABINET_BASIC_AUTH?.trim();
  if (ba) {
    const i = ba.indexOf(':');
    if (i <= 0) throw new Error('studio: CABINET_BASIC_AUTH должен быть в виде user:pass');
    basicAuth = { username: ba.slice(0, i), password: ba.slice(i + 1) };
  }
  const worker = needs.worker === true;
  return {
    cabinetUrl,
    apiUrl,
    basicAuth,
    demoPhone: needs.capture ? assertDemoPhone(required(env, 'DEMO_PHONE')) : (env.DEMO_PHONE?.trim() ?? ''),
    debugSecret: needs.capture ? required(env, 'DEBUG_SECRET') : '',
    speechkitKey: needs.tts ? required(env, 'YANDEX_SPEECHKIT_API_KEY') : '',
    speechkitFolder: needs.tts ? required(env, 'YANDEX_TTS_FOLDER_ID') : '',
    databaseUrl: worker ? required(env, 'DATABASE_URL') : '',
    minio: worker
      ? {
          endpoint: required(env, 'MINIO_ENDPOINT'),
          accessKey: required(env, 'MINIO_ACCESS_KEY'),
          secretKey: required(env, 'MINIO_SECRET_KEY'),
          // Общий бакет видео, как у бэкенда (shortsBucket в src/shorts/shorts.types.ts).
          bucket: env.MINIO_BUCKET_VIDEOS?.trim() || 'linkeon-smm-videos',
        }
      : null,
  };
}
