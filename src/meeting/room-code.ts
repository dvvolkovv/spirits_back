import { randomInt } from 'crypto';

/**
 * Алфавит кода комнаты.
 *
 * Без 0/O и 1/I/L: код диктуют вслух и записывают на слух, а «ноль или о» —
 * это ещё одна попытка входа и звонок «у меня не открывается». Строчных нет —
 * код показывается заглавными, а сравнивается без учёта регистра.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const CODE_LENGTH = 6;

/**
 * Код новой комнаты.
 *
 * randomInt из crypto, а не Math.random: код — это пропуск в чужие
 * переговоры, и предсказуемый генератор здесь означает предсказуемый пропуск.
 */
export function generateRoomCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Похоже ли это на выданный нами код.
 *
 * Проверка нужна до похода в базу: публичные ручки входа открыты без
 * авторизации, и гонять в запрос всё, что прислали, незачем.
 */
export function isValidRoomCode(code: unknown): boolean {
  if (typeof code !== 'string' || code.length !== CODE_LENGTH) return false;
  const upper = code.toUpperCase();
  return [...upper].every((c) => ROOM_CODE_ALPHABET.includes(c));
}
