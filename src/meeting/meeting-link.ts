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
 * Первая ссылка на комнату в тексте, или null.
 *
 * Первая, а не последняя: если человек прислал две, он почти наверняка имеет
 * в виду ту, о которой говорит дальше по тексту.
 */
export function parseMeetingLink(text: string): { code: string } | null {
  if (typeof text !== 'string' || !text) return null;

  const m = ROOM_LINK_REGEX.exec(text);
  if (!m) return null;

  const code = m[1].toUpperCase();
  // Проверяем алфавитом: `/room/ABC01D` синтаксически похож на ссылку, но
  // такого кода мы не выдаём — идти с ним в базу незачем.
  return isValidRoomCode(code) ? { code } : null;
}
