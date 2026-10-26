import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './config';

const none = { capture: false, tts: false };

test('по умолчанию — стенд, API там же, без Basic Auth', () => {
  const c = parseConfig({}, none);
  assert.equal(c.cabinetUrl, 'https://test.linkeon.io');
  assert.equal(c.apiUrl, 'https://test.linkeon.io');
  assert.equal(c.basicAuth, null);
});

test('хвостовой слэш снимается, API можно задать отдельно', () => {
  const c = parseConfig({ CABINET_URL: 'https://my.linkeon.io/', API_URL: 'https://api.example/' }, none);
  assert.equal(c.cabinetUrl, 'https://my.linkeon.io');
  assert.equal(c.apiUrl, 'https://api.example');
});

test('Basic Auth разбирается по первому двоеточию', () => {
  assert.deepEqual(parseConfig({ CABINET_BASIC_AUTH: 'linkeon:pa:ss' }, none).basicAuth, { username: 'linkeon', password: 'pa:ss' });
  assert.throws(() => parseConfig({ CABINET_BASIC_AUTH: 'nocolon' }, none), /user:pass/);
});

test('для съёмки нужны демо-номер тестового шаблона и секрет', () => {
  const capture = { capture: true, tts: false };
  assert.throws(() => parseConfig({ DEBUG_SECRET: 's' }, capture), /DEMO_PHONE/);
  assert.throws(() => parseConfig({ DEMO_PHONE: '79161234567', DEBUG_SECRET: 's' }, capture), /790300XXXXX/);
  assert.throws(() => parseConfig({ DEMO_PHONE: '79030000001' }, capture), /DEBUG_SECRET/);
  assert.equal(parseConfig({ DEMO_PHONE: '79030000001', DEBUG_SECRET: 's' }, capture).demoPhone, '79030000001');
});

test('для озвучки нужны ключи SpeechKit', () => {
  const tts = { capture: false, tts: true };
  assert.throws(() => parseConfig({}, tts), /YANDEX_SPEECHKIT_API_KEY/);
  const c = parseConfig({ YANDEX_SPEECHKIT_API_KEY: 'k', YANDEX_TTS_FOLDER_ID: 'f' }, tts);
  assert.equal(c.speechkitKey, 'k');
  assert.equal(c.speechkitFolder, 'f');
});

test('рабочему процессу нужны база и MinIO; бакет по умолчанию — общий бакет видео', () => {
  const worker = { capture: false, tts: false, worker: true };
  assert.throws(() => parseConfig({}, worker), /DATABASE_URL/);
  assert.throws(() => parseConfig({ DATABASE_URL: 'postgres://x' }, worker), /MINIO_ENDPOINT/);
  const c = parseConfig(
    { DATABASE_URL: 'postgres://x', MINIO_ENDPOINT: 'http://127.0.0.1:9000', MINIO_ACCESS_KEY: 'a', MINIO_SECRET_KEY: 's' },
    worker,
  );
  assert.equal(c.databaseUrl, 'postgres://x');
  assert.deepEqual(c.minio, { endpoint: 'http://127.0.0.1:9000', accessKey: 'a', secretKey: 's', bucket: 'linkeon-smm-videos' });
  assert.equal(parseConfig({}, none).minio, null);
});
