import { createHmac } from 'node:crypto';

/**
 * Вебхуки для бэкенда — в точности как их шлёт Attendee.
 *
 * Совместимость тут не из вежливости: подпись уже проверяет
 * `src/meeting/attendee-signature.ts`, а события уже разбирает
 * `meet-webhook.controller.ts`. Повторив их формат, мы не трогаем ни бэкенд,
 * ни воркер — переезд с чужого моста на свой остаётся невидимым для всего
 * остального кода.
 */

/**
 * JSON с рекурсивно отсортированными ключами и без пробелов.
 *
 * Тот же канон, что у Attendee (`json.dumps(..., sort_keys=True,
 * separators=(",", ":"))`) и у нашей проверки подписи. Порядок элементов
 * массива сохраняется: массив — данные, а не набор.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Подпись тела. Секрет приходит base64 — как его отдаёт интерфейс Attendee, и
 * так же он лежит у нас в `ATTENDEE_WEBHOOK_SECRET`; ключом HMAC служат его
 * ДЕКОДИРОВАННЫЕ байты.
 */
export function sign(payload, secretBase64) {
  return createHmac('sha256', Buffer.from(secretBase64, 'base64'))
    .update(canonicalJson(payload), 'utf8')
    .digest('base64');
}

/**
 * Отправка события.
 *
 * Ошибки НЕ роняют встречу: вебхук — это уведомление, а не часть разговора.
 * Но и молчать о них нельзя — без состава и чата ассистент ведёт себя странно,
 * и в логе должно быть видно, почему.
 *
 * Повторов нет намеренно: события состава и чата ценны свежими, а очередь
 * повторов — это уже маленький брокер, которого мы тут заводить не хотим.
 */
export async function send(url, secret, payload, log = console) {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': sign(payload, secret || ''),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) log.warn?.(`вебхук ${payload.trigger}: HTTP ${res.status}`);
  } catch (e) {
    log.warn?.(`вебхук ${payload.trigger} не ушёл: ${e?.message}`);
  }
}

/** Тело события в форме, которую ждёт наш контроллер. */
export function event(botId, metadata, trigger, data) {
  return {
    idempotency_key: `${botId}-${trigger}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    bot_id: botId,
    bot_metadata: metadata ?? null,
    trigger,
    data,
  };
}
