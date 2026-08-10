export type Provider = 'phone' | 'email' | 'google' | 'yandex' | 'talerid' | 'apple';

export interface PhoneData   { phone: string }
export interface EmailData   { email: string }
export interface GoogleData  { sub: string; email: string; emailVerified: boolean }
export interface YandexData  { sub: string; email: string; emailVerified: boolean }
export interface TaleridData { sub: string; email: string; emailVerified: boolean }
// Apple отдаёт тот же набор, но email может быть пустым: человек вправе
// скрыть почту, и тогда приходит либо подставной адрес @privaterelay.appleid.com,
// либо ничего. Опознаём по sub.
export interface AppleData   { sub: string; email: string; emailVerified: boolean }

export type ProviderData<P extends Provider> =
  P extends 'phone'   ? PhoneData :
  P extends 'email'   ? EmailData :
  P extends 'google'  ? GoogleData :
  P extends 'yandex'  ? YandexData :
  P extends 'talerid' ? TaleridData :
  P extends 'apple'   ? AppleData : never;

export interface Identity {
  id: string;
  provider: Provider;
  providerSub: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ResolveResult {
  userId: string;
  isNew: boolean;
  mergedExisting: boolean;
}
