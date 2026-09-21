export type Provider = 'phone' | 'email' | 'google' | 'yandex' | 'talerid' | 'apple' | 'telegram';

export interface PhoneData   { phone: string }
export interface EmailData   { email: string }
export interface GoogleData  { sub: string; email: string; emailVerified: boolean }
export interface YandexData  { sub: string; email: string; emailVerified: boolean }
export interface TaleridData { sub: string; email: string; emailVerified: boolean }
// Apple отдаёт тот же набор, но email может быть пустым: человек вправе
// скрыть почту, и тогда приходит либо подставной адрес @privaterelay.appleid.com,
// либо ничего. Опознаём по sub.
export interface AppleData   { sub: string; email: string; emailVerified: boolean }
// Telegram отдаёт только числовой id внутри подписанного initData —
// ни почты, ни подтверждённого адреса. Поэтому слияние по email для него
// отключено в extractEmail.
export interface TelegramData { sub: string }

export type ProviderData<P extends Provider> =
  P extends 'phone'   ? PhoneData :
  P extends 'email'   ? EmailData :
  P extends 'google'  ? GoogleData :
  P extends 'yandex'  ? YandexData :
  P extends 'talerid' ? TaleridData :
  P extends 'apple'    ? AppleData :
  P extends 'telegram' ? TelegramData : never;

export interface Identity {
  id: string;
  provider: Provider;
  providerSub: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Union, а не один объект с необязательными полями, — намеренно: компилятор
 * обязан ткнуть в каждый вход, который не обработал вариант link_required.
 * Именно «молча пошли дальше по общему пути» и завело дубликат 19.09.2026.
 */
export type ResolveResult =
  | { status: 'ok'; userId: string; isNew: boolean; mergedExisting: boolean }
  | { status: 'link_required'; candidateUserId: string; phoneHint: string };

export interface ResolveOptions {
  /**
   * Завести новый аккаунт, даже если найден кандидат на привязку.
   * Нужен как выход для человека, потерявшего доступ к номеру: без него
   * он окажется заперт вне обоих аккаунтов.
   */
  forceNew?: boolean;
}
