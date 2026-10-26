import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedResult, synthesizeAll, ttsKey } from './tts';

test('ключ кеша зависит от текста, голоса и темпа', () => {
  const base = { text: 'Привет', voice: 'madirus', speed: 1 };
  assert.equal(ttsKey(base), ttsKey({ ...base }));
  assert.notEqual(ttsKey(base), ttsKey({ ...base, text: 'Привет!' }));
  assert.notEqual(ttsKey(base), ttsKey({ ...base, voice: 'alena' }));
  assert.notEqual(ttsKey(base), ttsKey({ ...base, speed: 1.1 }));
});

test('кеш срабатывает только при совпадении ключа и наличии файла', () => {
  const req = { id: 'l1', text: 'Привет', voice: 'madirus', speed: 1 };
  const manifest = { l1: { key: ttsKey(req), durationMs: 1234 } };
  assert.deepEqual(cachedResult(manifest, req, '/run/voice', () => true), { id: 'l1', file: '/run/voice/l1.mp3', durationMs: 1234 });
  assert.equal(cachedResult(manifest, req, '/run/voice', () => false), null);
  assert.equal(cachedResult(manifest, { ...req, text: 'Пока' }, '/run/voice', () => true), null);
});

test('без кеша и без ключей — понятная ошибка до похода в сеть', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tts-'));
  await assert.rejects(
    synthesizeAll([{ id: 'l1', text: 'Привет', voice: 'madirus', speed: 1 }], dir, { apiKey: '', folderId: '' }),
    /l1: реплики нет в кеше озвучки, а ключи SpeechKit не заданы/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
