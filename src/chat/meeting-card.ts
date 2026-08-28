/** Длиннее в карточке не нужно — это заголовок, а не описание. */
const MAX_TITLE = 200;

/** Убрать всё, что сломает разбор тега на фронте. */
function clean(s: string): string {
  return (s || '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}

/**
 * Карточка «Зайти во встречу» для ленты чата.
 *
 * Формат тот же, что у {{voice_call:…}}: бэкенд кладёт в историю сообщение
 * ассистента с этим тегом, фронт подменяет его карточкой. Так она оживает и
 * при перезагрузке истории, а не только в момент отправки.
 */
export function buildMeetingCard(code: string, title: string): string {
  return `{{meeting_join: code=${code} title=${clean(title) || 'Встреча'}}}`;
}
