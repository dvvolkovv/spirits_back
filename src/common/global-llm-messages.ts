import { AnswerProvider, FallbackProvider, PROVIDER_LABELS } from './services/llm-fallback';

/**
 * дд.мм чч:мм по Москве.
 *
 * Собирается вручную по частям Intl.DateTimeFormat (day/month/hour/minute),
 * а не через toLocaleString('ru-RU', …) + replace(','): CLDR для ru-RU в
 * разных версиях ICU (мак у разработчика vs full-icu на тестовой ноде)
 * вставляет между датой и временем то запятую, то неразрывный пробел (U+00A0)
 * — replace(',', '') снимает только запятую и не трогает такой пробел, и
 * строгое toBe в тесте падает не из-за логики, а из-за пунктуации хоста.
 * formatToParts отдаёт голые числовые значения частей независимо от
 * локального пунктуатора — собираем формат сами, фиксированными '.' и ':'.
 */
const MSK_STAMP_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function mskStamp(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const parts = MSK_STAMP_PARTS.formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')}.${part('month')} ${part('hour')}:${part('minute')}`;
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Сообщение в группу алертов при переключении рубильника (spec 2026-10-31-global-llm-switch, раздел 8). */
export function switchedText(previous: AnswerProvider, next: AnswerProvider, actor: string): string {
  const head = `🔀 <b>Модель ответов для всех: ${PROVIDER_LABELS[next]}</b> (было ${PROVIDER_LABELS[previous]}).`;
  const tail = next === 'claude' ? 'Все снова отвечают через Claude.' : 'Вернуть — Админка → Ассистенты.';
  return `${head}\nПереключил: ${escapeHtml(actor)}. ${tail}`;
}

/** Суточное напоминание, пока рубильник не на Claude. */
export function reminderText(a: {
  provider: FallbackProvider;
  since: string | null;
  now: Date;
  claudeStatus: 'ok' | 'down' | null;
  claudeCheckedAt: string | null;
  keyMissing: boolean;
  /** Ответы за сутки по выбору рубильника (события chat_quality и claude_cli_call
   *  с choice=global): ok — ответила модель рубильника, other — она не ответила
   *  и ответил другой. Релей такие ходы в /health.fallback не считает (они «по
   *  выбору», не авария), поэтому без этой строки сбои модели рубильника не
   *  видны. null/нет — строки нет. */
  day?: { ok: number; other: number } | null;
}): string {
  const label = PROVIDER_LABELS[a.provider];
  const since = a.since
    ? ` с ${mskStamp(a.since)} (${Math.floor((a.now.getTime() - new Date(a.since).getTime()) / 86_400_000)} дн.)`
    : '';
  const claude = a.claudeStatus === 'ok' ? 'отвечает' : a.claudeStatus === 'down' ? 'не отвечает' : 'нет данных';
  const checked = a.claudeCheckedAt ? ` (${mskStamp(a.claudeCheckedAt)})` : '';
  const lines = [
    `⏰ <b>Все отвечают через ${label}</b>${since}.`,
    `Claude по последней пробе: ${claude}${checked}.`,
  ];
  if (a.day) lines.push(`За сутки через ${label}: ${a.day.ok} вызовов (ответы людям и фоновые задачи); не ответила, ответил другой — ${a.day.other}.`);
  if (a.keyMissing) lines.push(`Ключа ${label} на сервере нет — фактически отвечает Claude, гостям пробы — экран входа.`);
  lines.push('Вернуть — Админка → Ассистенты.');
  return lines.join('\n');
}
