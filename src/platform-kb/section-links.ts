/**
 * Адреса разделов кабинета — ОДНО место на бэке. Их дают ассистентам справка
 * (строка «Ссылка…» в разделе «Где» статей, articles/*.ts через url()) и блок
 * «Что есть в Linkeon» (chat/platform-guide.ts), а через него — ИИ-поддержка
 * и боты в Telegram.
 *
 * Находка «Затыков недели» 19–25.10.2026 (e4f01175): словесное указание
 * раздела («в интеграциях») не помогло его найти. Раздела «Интеграции» в
 * кабинете нет, подключения разбросаны по карточкам «Настроек»; ссылка ведёт
 * прямо к карточке.
 *
 * Адреса АБСОЛЮТНЫЕ — тот же довод, что у TOP_UP_URL
 * (tokens/balance-context.service.ts): модель воспроизводит адрес текстом, и
 * относительный путь в Telegram (бот примет «/profile» за команду), в
 * мобильном приложении и в пересланном сообщении никуда не ведёт.
 *
 * ДВЕ КОПИИ ОДНОЙ ТАБЛИЦЫ: эта и кабинет (spirits_front
 * src/utils/cabinetSections.ts — что кабинет по адресу открывает, к какой
 * карточке прокручивает и что из адресов переживает вход). Разъедутся —
 * ассистент даст ссылку, по которой кабинет откроет не ту карточку или после
 * входа уведёт в чат. Сторож — общая таблица между метками «АДРЕСА РАЗДЕЛОВ»
 * в section-links.spec.ts и в cabinetSections.test.ts фронта, дословно одна и
 * та же; меняется в обоих репозиториях одним изменением.
 *
 * Оплаты здесь нет намеренно: ссылку на пополнение даёт блок баланса
 * (TOP_UP_URL), он знает про сборки для сторов.
 *
 * Сборке из стора (Flutter из App Store и Google Play) адресов кабинета не
 * даём вовсе — ни в справке, ни в блоке, ни в поддержке: довод у
 * platformSections (chat/platform-guide.ts).
 */
export const CABINET_ORIGIN = 'https://my.linkeon.io';

/**
 * Ключ — как у подписи раздела в labels.generated.ts (где подпись есть), а
 * значение — адрес кабинета. Имена карточек в адресе (logins, reminders,
 * notifications) — кабинетные, их и сверяет общая таблица.
 */
export const SECTION_PATHS = {
  chat: '/chat',
  networking: '/search',
  imageGen: '/image-gen',
  video: '/video',
  studio: '/studio',
  studioBots: '/studio?tab=bots',
  studioProducts: '/studio?tab=products',
  profile: '/profile',
  settings: '/profile?settings=1',
  calendars: '/profile?open=calendars',
  zoom: '/profile?open=zoom',
  talerid: '/profile?open=talerid',
  loginMethods: '/profile?open=logins',
  routines: '/profile?open=reminders',
  voices: '/profile?open=voices',
  push: '/profile?open=notifications',
  telegram: '/profile?open=telegram',
  partners: '/profile?open=partners',
  help: '/help',
  support: '/support',
} as const;

export type SectionKey = keyof typeof SECTION_PATHS;

/** Полный адрес раздела: sectionUrl('zoom') → https://my.linkeon.io/profile?open=zoom. */
export function sectionUrl(key: SectionKey): string {
  return CABINET_ORIGIN + SECTION_PATHS[key];
}
