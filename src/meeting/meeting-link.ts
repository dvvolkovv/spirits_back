import { isValidRoomCode } from './room-code';

/**
 * Ссылка на комнату Linkeon в тексте сообщения.
 *
 * Точка перед `linkeon.io` внутри необязательной группы обязательна: без неё
 * сюда попал бы `notlinkeon.io` — регулярка нашла бы `linkeon.io` внутри
 * чужого домена и увела бы пользователя на чужую встречу.
 *
 * Поддомен необязателен: комнаты живут на `my.` и `test.`, а лендинг — на
 * голом `linkeon.io`.
 */
const ROOM_LINK_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?linkeon\.io\/room\/([A-Za-z0-9]+)/i;

/**
 * Ссылка на голосовую комнату Taler ID.
 *
 * Точка перед доменом обязательна по той же причине, что и у Linkeon: без неё
 * `notapi.talerid.io` прошёл бы проверку. Поддомен необязателен — их страница
 * отдаётся и с edge-доменов, а абсолютные ссылки на `api.talerid.io` у
 * пользователей из СНГ режет DPI.
 *
 * Код у них — hex-строка (`36fc367a`), а не наш алфавит без похожих букв,
 * поэтому валидация отдельная.
 */
const TALERID_LINK_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?talerid\.io\/room\/([A-Fa-f0-9]{6,64})/i;

/**
 * Ссылка на встречу Google Meet.
 *
 * Хост точный, БЕЗ необязательного поддомена — в отличие от linkeon.io и
 * talerid.io. У Meet поддоменов не бывает, а группа `(?:[a-z0-9-]+\.)?`
 * пропустила бы `notmeet.google.com`. Хвост домена закрыт границей `\/`
 * сразу после `com`, иначе прошёл бы `meet.google.com.evil.ru`.
 *
 * Код — три-четыре-три СТРОЧНЫЕ буквы (`abc-defg-hij`). Цифр в нём не бывает,
 * поэтому алфавит узкий: так `/lookup/` и прочие пути Meet сюда не попадают.
 * Начало кода прижато к `\/`, конец — отрицательным просмотром, иначе из
 * `abcd-efgh-ijkl` регулярка выкусила бы середину.
 */
const MEET_LINK_REGEX = /https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z0-9-])/i;

/** Откуда встреча. Свои комнаты и чужие ведут себя одинаково, но входы разные. */
export type MeetingProvider = 'linkeon' | 'talerid' | 'meet';

export interface ParsedMeetingLink {
  provider: MeetingProvider;
  code: string;
}

/**
 * Первая ссылка на комнату в тексте, или null.
 *
 * Первая, а не последняя: если человек прислал две, он почти наверняка имеет
 * в виду ту, о которой говорит дальше по тексту.
 *
 * Своя комната проверяется раньше чужой — не из-за приоритета, а потому что
 * домены не пересекаются и порядок ни на что не влияет; так просто читается.
 */
export function parseMeetingLink(text: string): ParsedMeetingLink | null {
  if (typeof text !== 'string' || !text) return null;

  const own = ROOM_LINK_REGEX.exec(text);
  if (own) {
    const code = own[1].toUpperCase();
    // Проверяем алфавитом: `/room/ABC01D` синтаксически похож на ссылку, но
    // такого кода мы не выдаём — идти с ним в базу незачем.
    return isValidRoomCode(code) ? { provider: 'linkeon', code } : null;
  }

  const foreign = TALERID_LINK_REGEX.exec(text);
  if (foreign) {
    // Регистр их кода не трогаем: он hex и приходит в ссылке как есть, а
    // ручка сверяет строку точно. Приведение к верхнему регистру, уместное
    // для нашего алфавита, здесь увело бы в 404.
    return { provider: 'talerid', code: foreign[1] };
  }

  const meet = MEET_LINK_REGEX.exec(text);
  if (meet) {
    // К нижнему регистру: код у Meet строчный, а из письма его вставляют
    // как попало. Он же уедет в external_room и в meeting_url для Attendee,
    // и расхождение регистра развело бы одну встречу на две записи.
    return { provider: 'meet', code: meet[1].toLowerCase() };
  }

  return null;
}
