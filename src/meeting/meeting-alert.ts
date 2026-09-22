import { sendTelegramAlert } from '../common/telegram-alert';

/**
 * Сообщение в дежурный чат, когда ассистент не смог зайти на встречу.
 *
 * ЗАЧЕМ. Отказ входа виден только в логах трёх разных процессов, а человек
 * видит лишь то, что ассистент не пришёл. За сентябрь так потерялись: занятый
 * порт под звук (три попытки подряд, 22.09.2026), переезд вёрстки Телемоста,
 * отсутствующие ключи Zoom. Каждый раз владелец сообщал об этом сам, и каждый
 * раз разбор начинался с вопроса «а что вообще случилось».
 *
 * Пользователю при этом достаточно знать, что зайти не вышло, — подробности
 * ему не помогут и только встревожат. Поэтому текст для него один и короткий,
 * а всё остальное уезжает сюда.
 *
 * Отправка НЕ должна ломать то, из-за чего её позвали: алерт — это уведомление,
 * а не часть работы. Ошибки глотаем.
 */

export interface MeetingFailure {
  /** Где сорвалось: понятным словом, а не кодом. */
  stage: string;
  /** Площадка: meet, zoom, teams, telemost, talerid. */
  provider?: string | null;
  /** Причина как есть — из воркера, моста или нашей проверки. */
  reason: string;
  callId?: string | null;
  userId?: string | null;
  /** Код или адрес встречи — по нему находят разговор в базе и в логах. */
  room?: string | null;
}

/** Экранируем то, что уедет в HTML-разметку Telegram. */
function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Текст алерта. Вынесен отдельно от отправки: формат — единственное, что здесь
 * стоит проверять тестом, а отправку проверять нечем.
 */
export function formatMeetingFailure(f: MeetingFailure): string {
  const lines = [
    '<b>Ассистент не зашёл на встречу</b>',
    `площадка: ${esc(f.provider || 'неизвестно')}`,
    `этап: ${esc(f.stage)}`,
    `причина: ${esc(f.reason)}`,
  ];
  if (f.room) lines.push(`встреча: ${esc(f.room)}`);
  if (f.callId) lines.push(`звонок: ${esc(f.callId)}`);
  if (f.userId) lines.push(`пользователь: ${esc(f.userId)}`);
  return lines.join('\n');
}

/** Отправить алерт. Никогда не бросает. */
export async function alertMeetingFailure(f: MeetingFailure): Promise<void> {
  try {
    await sendTelegramAlert(formatMeetingFailure(f));
  } catch {
    // Дежурный чат недоступен — это не повод ронять разбор отказа.
  }
}
