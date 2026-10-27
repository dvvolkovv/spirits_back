import { CABINET_ORIGIN, SECTION_PATHS, sectionUrl, type SectionKey } from './section-links';
import { KB_ARTICLES } from './articles';
import { KB_CLIENTS, type KbClient } from './kb.types';
import { renderArticle } from './render';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

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

  it('sectionUrl — домен и путь', () => {
    expect(sectionUrl('zoom')).toBe('https://my.linkeon.io/profile?open=zoom');
    expect(sectionUrl('studioBots')).toBe('https://my.linkeon.io/studio?tab=bots');
  });
});

/**
 * Какие статьи несут ссылку на свой раздел — строку «Ссылка…: <адрес>» в
 * разделе «Где» — и на какой. Без ссылки сознательно: products — предел
 * 5 КБ (запас статьи — единицы байт; ссылку на «Продукты» несёт блок «Что
 * есть в Linkeon»), tokens и payments — оплата, ссылку на пополнение даёт
 * блок баланса, how-it-works — без раздела «Где».
 */
const ARTICLE_LINKS: Record<string, SectionKey[]> = {
  start: ['chat'],
  chat: ['chat'],
  call: ['chat'],
  meetings: ['zoom'],
  networking: ['networking'],
  images: ['imageGen'],
  video: ['video'],
  speech: ['voices'],
  'studio-assistants': ['studio'],
  'studio-bots': ['studioBots', 'telegram'],
  profile: ['profile', 'settings'],
  calendars: ['calendars', 'talerid'],
  routines: ['routines', 'push'],
  partners: ['partners'],
  account: ['loginMethods'],
  apps: ['settings'],
  support: ['help', 'support'],
};

interface Variant { id: string; lang: string; client: KbClient; text: string }

function variants(): Variant[] {
  const out: Variant[] = [];
  for (const a of KB_ARTICLES) {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const client of KB_CLIENTS) {
        if (client === 'store' && a.paidOnly) continue;
        out.push({ id: a.id, lang, client, text: renderArticle(a, lang, client) });
      }
    }
  }
  return out;
}
const where = (v: Variant) => `${v.id}/${v.lang}/${v.client}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Раздел «Где» статьи: от заголовка до следующего «## ». */
function whereSection(text: string): string {
  const at = text.indexOf('\n## Где\n');
  if (at < 0) return '';
  const next = text.indexOf('\n## ', at + 1);
  return next < 0 ? text.slice(at) : text.slice(at, next);
}

describe('ссылки на разделы в справке', () => {
  let all: Variant[];
  beforeAll(() => {
    all = variants();
  });

  it('статьи таблицы несут свои ссылки в разделе «Где», отдельной строкой «Ссылка…» (кроме сборки из стора)', () => {
    const problems: string[] = [];
    for (const v of all) {
      if (v.client === 'store') continue;
      for (const key of ARTICLE_LINKS[v.id] ?? []) {
        const line = new RegExp(`^Ссылка[^\\n]*: ${escapeRe(sectionUrl(key))}$`, 'm');
        if (!line.test(whereSection(v.text))) problems.push(`${where(v)}: нет ссылки ${key}`);
      }
    }
    expect(problems).toEqual([]);
  });

  // Проверки выше идут по статьям, а не по таблице: статью переименовали или
  // убрали — её строка в ARTICLE_LINKS молча перестала бы проверяться.
  it('в таблице ссылок статей — только существующие статьи и ключи разделов', () => {
    const ids = new Set(KB_ARTICLES.map((a) => a.id));
    expect(Object.keys(ARTICLE_LINKS).filter((id) => !ids.has(id))).toEqual([]);
    expect(Object.values(ARTICLE_LINKS).flat().filter((k) => !(k in SECTION_PATHS))).toEqual([]);
  });

  it('статьи вне таблицы — без строки «Ссылка» (таблица выше — полный перечень)', () => {
    expect(all.filter((v) => !ARTICLE_LINKS[v.id] && /^Ссылка/m.test(v.text)).map(where)).toEqual([]);
  });

  it('любой https-адрес в справке — из таблицы разделов', () => {
    const known = new Set(KEYS.map(sectionUrl));
    const problems: string[] = [];
    for (const v of all) {
      for (const m of v.text.matchAll(/https:\/\/[^\s)»,;]+/g)) {
        if (!known.has(m[0])) problems.push(`${where(v)}: ${m[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  // Сборка из стора (Flutter) открывает ссылку во внешнем браузере, а в
  // кабинете — баланс, покупка и «Скачать APK» (Apple 3.1.1; довод — у
  // platformSections в chat/platform-guide.ts). Раздел «Где» при этом
  // остаётся — путь по меню в нём есть всегда.
  it('сборка из стора: ни одной ссылки на кабинет, строки «Ссылка…» нет, раздел «Где» на месте', () => {
    const store = all.filter((v) => v.client === 'store');
    expect(store.length).toBeGreaterThan(0);
    expect(store.filter((v) => v.text.includes(`${CABINET_ORIGIN}/`)).map(where)).toEqual([]);
    expect(store.filter((v) => /^Ссылка[^\n]*: /m.test(v.text)).map(where)).toEqual([]);
    const whereBody = (v: Variant) => whereSection(v.text).replace(/^\n## Где\n/, '').trim();
    expect(store.filter((v) => ARTICLE_LINKS[v.id] && !whereBody(v)).map(where)).toEqual([]);
  });
});

describe('где искать «интеграции»', () => {
  // Человек ищет «интеграции» и «подключения», а раздела с таким именем нет:
  // справку по этим словам находят описания тем (перечень в описании
  // инструмента linkeon_help).
  it('описания тем calendars, meetings и account знают слова «интеграции» и «подключение»', () => {
    const missing = ['calendars', 'meetings', 'account']
      .map((id) => KB_ARTICLES.find((a) => a.id === id)!)
      .filter((a) => !/интеграц/i.test(a.summary) || !/подключ/i.test(a.summary))
      .map((a) => a.id);
    expect(missing).toEqual([]);
  });

  // «Объединение» без «аккаунтов» в перечне тем непонятно о чём; «SMS-код»
  // короче «кода из SMS» — так описание укладывается в 120 знаков (kb.spec.ts).
  it('описание темы account называет объединение аккаунтов и SMS-код', () => {
    const a = KB_ARTICLES.find((x) => x.id === 'account')!;
    expect(a.summary).toBe(
      'аккаунт: способы входа (подключения, интеграции Google и Яндекса), SMS-код, объединение аккаунтов, язык, выход, удаление',
    );
    expect(a.summary.length).toBeLessThanOrEqual(120);
  });
});
