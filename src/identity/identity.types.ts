export type Provider = 'phone' | 'email' | 'google' | 'yandex';

export interface PhoneData   { phone: string }
export interface EmailData   { email: string }
export interface GoogleData  { sub: string; email: string; emailVerified: boolean }
export interface YandexData  { sub: string; email: string; emailVerified: boolean }

export type ProviderData<P extends Provider> =
  P extends 'phone'  ? PhoneData :
  P extends 'email'  ? EmailData :
  P extends 'google' ? GoogleData :
  P extends 'yandex' ? YandexData : never;

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
