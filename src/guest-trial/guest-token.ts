import { createHash, randomBytes } from 'crypto';

/** Ключ пробы: 32 случайных байта в base64url — 43 знака. Сам ключ хранит только браузер. */
export function newGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isGuestTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** В базу — только хеш: утечка таблицы не даёт забрать чужую пробу. */
export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Кто перенёс пробу — без самого userId: у телефонных аккаунтов это номер.
 * Хеш без секрета (простой sha256) не защищает номер телефона от
 * восстановления перебором — пространство телефонных номеров для этого
 * достаточно маленькое. Поэтому уборка обнуляет это поле через 7 дней
 * после переноса (Задача A6): хеш нужен только около момента входа, дольше
 * его хранить незачем.
 */
export function hashClaimer(userId: string): string {
  return createHash('sha256').update(`guest-claim:${userId}`).digest('hex');
}
