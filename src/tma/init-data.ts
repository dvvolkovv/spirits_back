import * as crypto from 'crypto';

export interface TgInitDataUser {
  tgUserId: number;
  tgUsername: string | null;
  tgFirstName: string | null;
}

/**
 * Окно свежести initData.
 *
 * 24 часа, а не минуты: Telegram переиспользует одну и ту же строку initData
 * в течение сессии Mini App. Короткое окно ломало бы вход при возврате в
 * свёрнутое приложение — человек видел бы «откройте через Telegram», уже
 * находясь в Telegram.
 */
const MAX_AGE_SEC = 24 * 60 * 60;

/**
 * Проверяет подпись initData и возвращает пользователя, либо null.
 *
 * Возврат null — единственный способ сообщить о неудаче: вызывающий код не
 * должен различать «подделали hash» и «протух auth_date», иначе ответ ручки
 * превращается в оракул для подбора.
 */
export function verifyInitData(raw: string, botToken: string): TgInitDataUser | null {
  if (!raw || !botToken) return null;

  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // timingSafeEqual бросает на разной длине — сравниваем длину заранее.
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  if (Math.floor(Date.now() / 1000) - authDate > MAX_AGE_SEC) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  let user: any;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (typeof user?.id !== 'number' || !Number.isFinite(user.id)) return null;

  return {
    tgUserId: user.id,
    tgUsername: user.username ?? null,
    tgFirstName: user.first_name ?? null,
  };
}
