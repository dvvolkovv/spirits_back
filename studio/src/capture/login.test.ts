import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StudioConfig } from '../config';
import { StudioError } from '../errors';
import { loginDemo } from './login';

const cfg = { apiUrl: 'https://api.test', demoPhone: 'demo', debugSecret: 's' } as unknown as StudioConfig;

test('debug-ручка ответила 404 — no_input без повтора: это настройка среды, а не сбой входа', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('/webhook/debug/sms-code/') ? new Response('', { status: 404 }) : new Response('{}', { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      loginDemo(cfg),
      (e: unknown) => e instanceof StudioError && e.code === 'no_input' && e.retryable === false && /debug-ручка ответила 404/.test(e.message),
    );
  } finally {
    globalThis.fetch = real;
  }
});
