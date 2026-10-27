import { CABINET_ORIGIN, PAID_SECTIONS, SECTION_PATHS, sectionUrl, type SectionKey } from './section-links';

/**
 * Адреса разделов, которые дают ассистенты.
 *
 * ОБЩАЯ ТАБЛИЦА — дословно та же стоит в spirits_front
 * src/utils/cabinetSections.test.ts: что кабинет по этим адресам открывает,
 * к какой карточке прокручивает и что из них переживает вход. Меняется в
 * обоих репозиториях одним изменением. Сверка — пустой вывод diff блоков
 * между строками-метками «<<<» и «>>>» с «АДРЕСА РАЗДЕЛОВ» (команда — задача
 * С1 плана 2026-10-27-assistant-links-sources-roles).
 */
// <<< АДРЕСА РАЗДЕЛОВ — общая таблица бэка и фронта, менять в обоих репозиториях
const SECTION_TABLE = [
  '/chat',
  '/help',
  '/image-gen',
  '/profile',
  '/profile?open=calendars',
  '/profile?open=logins',
  '/profile?open=notifications',
  '/profile?open=partners',
  '/profile?open=reminders',
  '/profile?open=talerid',
  '/profile?open=telegram',
  '/profile?open=voices',
  '/profile?open=zoom',
  '/profile?settings=1',
  '/search',
  '/studio',
  '/studio?tab=bots',
  '/studio?tab=products',
  '/support',
  '/video',
];
// >>> АДРЕСА РАЗДЕЛОВ

const KEYS = Object.keys(SECTION_PATHS) as SectionKey[];

describe('таблица адресов разделов', () => {
  it('ровно общая таблица — та же, что открывает кабинет', () => {
    expect(Object.values(SECTION_PATHS).sort()).toEqual(SECTION_TABLE);
  });

  it('адреса абсолютные, https и только на my.linkeon.io', () => {
    const bad = KEYS.filter((k) => {
      const u = new URL(sectionUrl(k));
      return u.origin !== CABINET_ORIGIN || u.protocol !== 'https:';
    });
    expect(bad).toEqual([]);
    expect(CABINET_ORIGIN).toBe('https://my.linkeon.io');
  });

  it('ни пополнения, ни оплаты: ссылку на пополнение даёт блок баланса', () => {
    expect(Object.values(SECTION_PATHS).filter((p) => /view=tokens|^\/tokens|payment/.test(p))).toEqual([]);
  });

  it('разделы о деньгах — из таблицы', () => {
    expect(PAID_SECTIONS.filter((k) => !SECTION_PATHS[k])).toEqual([]);
  });

  it('sectionUrl — домен и путь', () => {
    expect(sectionUrl('zoom')).toBe('https://my.linkeon.io/profile?open=zoom');
    expect(sectionUrl('studioBots')).toBe('https://my.linkeon.io/studio?tab=bots');
  });
});
