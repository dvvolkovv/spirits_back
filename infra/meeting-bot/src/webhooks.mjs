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
 * Сколько ждём ответа и сколько раз пробуем.
 *
 * Пять секунд и одна попытка (первая редакция) не пережили живой встречи
 * 15.09.2026: пока Chromium поднимал страницу и WebRTC, процессу не хватало
 * процессорного времени, и два события — приход человека и «мы во встрече» —
 * не дошли до nginx ВОВСЕ, то есть даже не успели уйти. Машина о четырёх
 * ядрах, и рядом шли тесты; в час пик так же будет и на проде.
 */
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 2;

/**
 * Отправка события. `true` — бэкенд принял.
 *
 * Ошибки НЕ роняют встречу: вебхук — это уведомление, а не часть разговора.
 * Но и молчать о них нельзя — без состава и чата ассистент ведёт себя странно,
 * и в логе должно быть видно, почему.
 *
 * Очереди повторов здесь по-прежнему нет: события ценны свежими, а очередь —
 * это уже маленький брокер. Вторая попытка — другое: она страхует ровно от той
 * заминки, из-за которой первая не успела начаться.
 */
export async function send(url, secret, payload, log = console) {
  if (!url) return true;
  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': sign(payload, secret || ''),
  };
  const body = JSON.stringify(payload);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return true;
      // Отказ бэкенда повторять бессмысленно: подпись не та или события он не
      // ждёт — со второго раза лучше не станет.
      log.warn?.(`вебхук ${payload.trigger}: HTTP ${res.status}`);
      return false;
    } catch (e) {
      const last = attempt === ATTEMPTS;
      log.warn?.(`вебхук ${payload.trigger} не ушёл: ${e?.message}${last ? '' : ' — пробуем ещё раз'}`);
      if (last) return false;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return false;
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
