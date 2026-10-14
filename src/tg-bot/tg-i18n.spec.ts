import { TG_TEXTS, TG_LANGS, tgText, pickTgLanguage, ownerTgLanguage, formatTgNumber, TgTextKey } from './tg-i18n';

/**
 * Служебные сообщения бота на языке человека (решение владельца 14.10.2026,
 * «доделай»). Раньше всё, что бот пишет сам — справка, «токены закончились»,
 * «Минутку», подписи кнопок, — уходило по-русски и на «ты», хотя кабинет
 * переведён на семь языков и говорит «вы».
 */

const keys = (lang: string) => Object.keys((TG_TEXTS as any)[lang]).sort();
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('каталог текстов бота', () => {
  it('семь языков, как в кабинете', () => {
    expect([...TG_LANGS].sort()).toEqual(['de', 'en', 'es', 'fr', 'pt', 'ru', 'zh']);
  });

  it.each(TG_LANGS.filter((l) => l !== 'ru'))('%s: те же ключи, что в ru, и ни одной пустой строки', (lang) => {
    expect(keys(lang)).toEqual(keys('ru'));
    const empty = keys(lang).filter((k) => !String((TG_TEXTS as any)[lang][k]).trim());
    expect(empty).toEqual([]);
  });

  it.each(TG_LANGS.filter((l) => l !== 'ru'))('%s: подстановки те же, что в ru', (lang) => {
    const bad = keys('ru').filter((k) => params((TG_TEXTS as any)[lang][k]).join() !== params((TG_TEXTS as any).ru[k]).join());
    expect(bad).toEqual([]);
  });

  it.each(TG_LANGS.filter((l) => l !== 'ru'))('%s: без кириллицы — непереведённая строка не уедет русской', (lang) => {
    const cyr = keys(lang).filter((k) => /[А-Яа-яЁё]/.test((TG_TEXTS as any)[lang][k]));
    expect(cyr).toEqual([]);
  });

  // Как во всём кабинете (ruFormalAddress.test.ts во фронте): на «вы».
  const INFORMAL =
    /(^|[^а-яё])(пиши|открой|нажми|зайди|подожди|повтори|выбери|пришли|заверши|попробуй|пополни|сгенерируй|возвращайся|создавай|получи|ты|твой|твоя|твоё|твои|твоих|твоим|твоей|тебе|тебя)([^а-яё]|$)/i;

  it('ru: на «вы», как кабинет', () => {
    const informal = keys('ru').filter((k) => INFORMAL.test((TG_TEXTS as any).ru[k]));
    expect(informal).toEqual([]);
  });

  it('проверка «ты» видит «ты», если оно есть (сторож сторожа)', () => {
    expect(INFORMAL.test('Пиши сюда — ассистент ответит.')).toBe(true);
    expect(INFORMAL.test('У тебя нет активных ботов')).toBe(true);
    expect(INFORMAL.test('Пишите сюда — ассистент ответит.')).toBe(false);
  });

  // Тексты с разметкой уходят с parse_mode HTML: кроме <b>, <i>, <code> в
  // самом шаблоне не должно быть < > & — Telegram отклонил бы сообщение.
  it.each(TG_LANGS)('%s: в шаблонах только разрешённая разметка', (lang) => {
    const bad = keys(lang).filter((k) => {
      const s = String((TG_TEXTS as any)[lang][k]).replace(/<\/?(b|i|code)>/g, '');
      return /[<>&]/.test(s);
    });
    expect(bad).toEqual([]);
  });

  // Telegram: описание команды меню — от 1 до 256 символов.
  it.each(TG_LANGS)('%s: подписи меню команд укладываются в лимит Telegram', (lang) => {
    const long = keys(lang).filter((k) => k.startsWith('cmd_') && !((TG_TEXTS as any)[lang][k].length <= 256));
    expect(long).toEqual([]);
  });
});

describe('tgText', () => {
  it('подставляет параметры', () => {
    expect(tgText('ru', 'assistant_set', { agent: 'Роман' })).toBe('Теперь отвечает <b>Роман</b>.');
    expect(tgText('de', 'assistant_set', { agent: 'Roman' })).toContain('Roman');
  });

  it('незнакомый или пустой язык — русский (как язык по умолчанию)', () => {
    expect(tgText('xx', 'thinking')).toBe(tgText('ru', 'thinking'));
    expect(tgText(undefined as any, 'thinking')).toBe(tgText('ru', 'thinking'));
  });

  it('pt-PT и zh-Hans сводятся к корню', () => {
    expect(tgText('pt-PT', 'thinking')).toBe(tgText('pt', 'thinking'));
    expect(tgText('zh-Hans', 'thinking')).toBe(tgText('zh', 'thinking'));
  });

  it('ключ типизирован: каталог — источник правды', () => {
    const k: TgTextKey = 'busy';
    expect(tgText('en', k)).toMatch(/moment/i);
  });
});

describe('язык для человека', () => {
  it('язык профиля Linkeon главнее языка клиента Telegram', () => {
    expect(pickTgLanguage('de', 'fr')).toBe('de');
  });

  it('профиль не задан — язык клиента Telegram', () => {
    expect(pickTgLanguage(null, 'fr')).toBe('fr');
    expect(pickTgLanguage(null, 'pt-br')).toBe('pt');
  });

  it('клиент на языке, которого у нас нет, — английский, а не русский', () => {
    expect(pickTgLanguage(null, 'it')).toBe('en');
  });

  it('нет ничего — русский', () => {
    expect(pickTgLanguage(null, undefined)).toBe('ru');
  });

  it('ownerTgLanguage читает profile_data.language владельца', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [{ language: 'es' }] })) };
    expect(await ownerTgLanguage(pg as any, 'u-1', 'de')).toBe('es');
    expect(String((pg.query.mock.calls[0] as any[])[0])).toMatch(/profile_data->>'language'/);
  });

  it('ownerTgLanguage без владельца — по клиенту Telegram, базу не трогает', async () => {
    const pg = { query: jest.fn() };
    expect(await ownerTgLanguage(pg as any, null, 'zh-hans')).toBe('zh');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('ownerTgLanguage: сбой базы — не повод ронять ответ', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('Connection terminated'); }) };
    expect(await ownerTgLanguage(pg as any, 'u-1', 'fr')).toBe('fr');
    expect(await ownerTgLanguage(null as any, 'u-1')).toBe('ru');
  });
});

describe('числа — по правилам языка', () => {
  it('разделители разрядов свои у каждого языка', () => {
    expect(formatTgNumber('en', 12345)).toBe('12,345');
    expect(formatTgNumber('de', 12345)).toBe('12.345');
    expect(formatTgNumber('ru', 12345).replace(/\s/g, ' ')).toBe('12 345');
  });
});
