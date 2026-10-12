import { SUPPORTED_LANGUAGES } from '../common/services/language.service';
import { VOICE_CATALOG } from '../speech/voices';

/** Ассистентов в каталоге полтора десятка; 50 — запас, за которым уже мусор. */
const MAX_VOICE_OVERRIDES = 50;

/**
 * Пользовательский выбор голосов (`profile_data.assistant_voices`) приходит из
 * браузера, поэтому проверяем всё: ключ — имя ассистента (оно же
 * `preferred_agent`), значение — id голоса из каталога. Несуществующие id
 * выбрасываем, `null` трактуем как «сбросить на дефолт» (resolveVoice сам
 * подставит голос ассистента, когда переопределения нет).
 */
export function sanitizeAssistantVoices(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const valid = new Set(VOICE_CATALOG.map((v) => v.id));
  const out: Record<string, string> = {};
  for (const [assistant, voice] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_VOICE_OVERRIDES) break;
    if (typeof voice !== 'string') continue;
    if (!valid.has(voice)) continue;
    out[assistant] = voice;
  }
  return out;
}

/**
 * Текстовые поля, которые клиенты пишут через POST /webhook/profile-update, и
 * их потолок длины. Веб и Flutter пишут name/family_name, мини-приложение
 * Telegram — ещё user_nickname и birthday. Имя и фамилию видят другие люди
 * (поиск, переписка, встречи), поэтому длина ограничена.
 */
export const PROFILE_TEXT_LIMITS: Readonly<Record<string, number>> = {
  name: 100,
  family_name: 100,
  user_nickname: 64,
  birthday: 32,
};

/**
 * Что из profile_data другого человека видно в GET /webhook/user-profile:
 * то же, что и в поиске, — имя, ник, аватар (портрет добавляется отдельно).
 * Раньше уходил весь profile_data: бизнес-карточка, дата рождения, служебные
 * пометки — любому вошедшему по номеру телефона.
 */
export const PUBLIC_PROFILE_KEYS: readonly string[] = ['name', 'family_name', 'user_nickname', 'avatar_url'];

/** Портрет: его разбирает контроллер и пишет в Neo4j, в profile_data он не идёт. */
export const PROFILE_ENTITY_FIELDS: ReadonlySet<string> = new Set([
  'values', 'beliefs', 'desires', 'intents', 'intentions', 'interests', 'skills',
]);

/**
 * Что из тела profile-update попадёт в profile_data. Остальное отбрасывается:
 * служебные поля (`low_balance_warned`), поля со своими ручками и проверками
 * (`avatar_url`, `business`, `contactVisible`) и всё, что совпадает с
 * вычисленными полями профиля (`isadmin`, `tokens`, `email`…).
 */
export function sanitizeProfilePatch(data: Record<string, any>): { patch: Record<string, any>; dropped: string[] } {
  const patch: Record<string, any> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (PROFILE_ENTITY_FIELDS.has(key)) continue;

    const limit = PROFILE_TEXT_LIMITS[key];
    if (limit !== undefined) {
      if (value === null) patch[key] = null;
      else if (typeof value === 'string') patch[key] = value.trim().slice(0, limit);
      else dropped.push(key);
      continue;
    }

    if (key === 'language') {
      // LanguageService.normalize подставил бы русский вместо незнакомого
      // значения и молча переписал бы язык человека — незнакомое отбрасываем.
      const root = typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
      if ((SUPPORTED_LANGUAGES as readonly string[]).includes(root)) patch.language = root;
      else dropped.push(key);
      continue;
    }

    if (key === 'assistant_voices') {
      patch.assistant_voices = sanitizeAssistantVoices(value);
      continue;
    }

    dropped.push(key);
  }
  return { patch, dropped };
}
