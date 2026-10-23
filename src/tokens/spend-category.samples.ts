/**
 * Образцы consumed-строк журнала: различные подписи прода за 90 дней до
 * 23.10.2026 (цифры, имена и id заменены). Общие для юнит-теста правил и для
 * живого прогона, который сверяет SQL-выражение с classifySpend.
 *
 * Новая подпись в коде списания — новая строка здесь с ожидаемой категорией.
 */
export type SpendSample = [description: string | null, metadata: Record<string, unknown> | null, expected: string];

export const SPEND_SAMPLES: SpendSample[] = [
  ['Ответ ассистента «Роман»', { source: 'usage', costUsd: 0.26 }, 'replies'],
  ['Ответ ассистента «Роман», 3 мин работы', { taken: 'turn' }, 'replies'],
  ['Ответ ассистента, 2 мин работы', null, 'replies'],
  ['Ответ ассистента', null, 'replies'],
  [null, null, 'replies'],
  ['Ответ ассистента «Роман», 4 мин работы', { callId: 'c-1', durationSec: 240 }, 'calls'],
  ['Ответ ассистента «Роман»', { callId: 'c-2' }, 'calls'],
  ['image', null, 'images'],
  ['Генерация видео', { mode: 'text2video', model: 'veo-3.1' }, 'video'],
  ['Генерация видео', { mode: 'image2video', model: 'veo-3.1', composed: true }, 'video'],
  ['Озвучка ответа', { listen_id: 'l-1', chars: 900 }, 'voice'],
  ['Синтез речи', { clip_id: 'k-1' }, 'voice'],
  ['tg-bot', null, 'tg_bots'],
  ['product turn 3f2a9c1e-0000-4000-8000-000000000001', null, 'products'],
  ['Аренда продукта demo — месяц', { kind: 'product_rent', product_id: 'p-1' }, 'products'],
];
