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

test('debug-ручка ответила 403 «Phone not in whitelist» — no_input без повтора: номер демо-аккаунта не в белом списке среды', async () => {
  const real = globalThis.fetch;
  let codeCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('/webhook/debug/sms-code/')) {
      codeCalls++;
      return new Response(JSON.stringify({ error: 'Phone not in whitelist' }), { status: 403 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      loginDemo(cfg),
      (e: unknown) => e instanceof StudioError && e.code === 'no_input' && e.retryable === false && /debug-ручка ответила 403/.test(e.message),
    );
    assert.equal(codeCalls, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test('404 «No code» — секрет верный, кода ещё (или уже) нет: ждёт, как пустой ответ, а не no_input', async () => {
  const real = globalThis.fetch;
  let codeCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('/webhook/debug/sms-code/')) {
      codeCalls++;
      return codeCalls === 1
        ? new Response(JSON.stringify({ error: 'No code' }), { status: 404 })
        : new Response(JSON.stringify({ code: '1234' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    // Код — со второго раза; дальше подделка не отдаёт токенов: вход падает на check-code, но уже не как настройка среды.
    await assert.rejects(loginDemo(cfg), (e: unknown) => e instanceof StudioError && e.code === 'login' && e.retryable === true && /нет токенов/.test(e.message));
    assert.equal(codeCalls, 2);
  } finally {
    globalThis.fetch = real;
  }
});
