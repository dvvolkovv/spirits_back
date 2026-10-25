import * as fs from 'fs';
import * as path from 'path';
import { KB_ARTICLES } from './articles';
import { KB_CLIENTS, KB_PARTS, KbClient } from './kb.types';
import { CLIENT_NOTES, renderArticle } from './render';
import { labelsFor } from './labels';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Сторожа статей справки. Каждая статья собирается во всех вариантах (7 языков
 * × 4 клиента) — и каждый вариант уходит модели целиком. Проблемы собираются
 * списком: красный тест сразу показывает все статьи и варианты, а не первую.
 */

/** Темы спеки (docs/superpowers/specs/2026-10-24-platform-help-design.md, «Темы»). */
const SPEC_TOPICS = [
  'start', 'chat', 'call', 'meetings', 'networking', 'images', 'video', 'speech', 'studio-assistants', 'studio-bots',
  'products', 'profile', 'calendars', 'routines', 'tokens', 'payments', 'partners', 'account', 'apps', 'support', 'how-it-works',
];
const MAX_BYTES = 5 * 1024;
const FREE_FORM = new Set(['how-it-works']);
// yandex.calendar — не хост, а бренд «Yandex.Calendar» в подписи calYandex (es/fr/pt).
const HOST_ALLOW = new Set(['my.linkeon.io', 'linkeon.io', 't.me', 'yandex.calendar']);
const FORMAT_TOKENS = /\b(?:9:16|16:9|1:1|720p|1080p|4K)\b/g;

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

describe('перечень статей', () => {
  it('id — только из списка спеки и не повторяются', () => {
    const ids = KB_ARTICLES.map((a) => a.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(ids.filter((id) => !SPEC_TOPICS.includes(id))).toEqual([]);
  });

  // Сверка с перечнем спеки, а не с уже написанными: статьи пишутся по
  // очереди (Задачи 6–13), и ссылка на ещё не написанную тему — не ошибка.
  // В ответе инструмента related всё равно фильтруется по существующим.
  it('related — только темы спеки и не сама статья', () => {
    const bad = KB_ARTICLES.flatMap((a) =>
      a.related.filter((r) => !SPEC_TOPICS.includes(r) || r === a.id).map((r) => `${a.id} → ${r}`),
    );
    expect(bad).toEqual([]);
  });

  it('summary — одна строка до 120 символов, title — до 40', () => {
    const bad = KB_ARTICLES.filter((a) => /\n/.test(a.summary) || a.summary.length > 120 || a.title.length > 40).map((a) => a.id);
    expect(bad).toEqual([]);
  });

  it('перечень полный: все темы спеки, без лишних', () => {
    expect(KB_ARTICLES.map((a) => a.id).sort()).toEqual([...SPEC_TOPICS].sort());
  });

  it('темы о деньгах — ровно tokens, payments, partners', () => {
    expect(KB_ARTICLES.filter((a) => a.paidOnly).map((a) => a.id).sort()).toEqual(['partners', 'payments', 'tokens']);
  });
});

describe('статьи во всех вариантах', () => {
  let all: Variant[];
  beforeAll(() => {
    all = variants();
  });

  it('собираются без дыр в подстановках', () => {
    expect(all.filter((v) => /undefined|«»|\$\{|\{\{|\bNaN\b/.test(v.text)).map(where)).toEqual([]);
  });

  it(`не больше ${MAX_BYTES} байт`, () => {
    const big = all
      .filter((v) => Buffer.byteLength(v.text, 'utf8') > MAX_BYTES)
      .map((v) => `${where(v)}: ${Buffer.byteLength(v.text, 'utf8')}`);
    expect(big).toEqual([]);
  });

  it('части — из установленного списка, по порядку, «Что это» и «Где» есть всегда', () => {
    const problems: string[] = [];
    for (const v of all) {
      if (FREE_FORM.has(v.id)) continue;
      const heads = [...v.text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
      const idx = heads.map((h) => (KB_PARTS as readonly string[]).indexOf(h));
      heads.forEach((h, i) => {
        if (idx[i] < 0) problems.push(`${where(v)}: чужой раздел «${h}»`);
      });
      if (idx.some((x, i) => i > 0 && x <= idx[i - 1])) problems.push(`${where(v)}: порядок ${heads.join(' → ')}`);
      for (const must of ['Что это', 'Где']) if (!heads.includes(must)) problems.push(`${where(v)}: нет «${must}»`);
    }
    expect(problems).toEqual([]);
  });

  it('стоп-список: ни адресов, ни внутренностей', () => {
    const STOP: [string, RegExp][] = [
      ['IP-адрес', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
      ['релей', /рел[еэ][йяюе]|relay/i],
      ['sudo', /\bsudo\b/i],
      ['ручка', /\/webhook\//i],
      ['переменная окружения', /\b(?:[A-Z][A-Z0-9]*_)+(?:SECRET|KEY|TOKEN|URL|ID)\b|\.env\b/],
      ['версия модели', /\b(?:opus|sonnet|haiku|claude|gpt|gemini|veo|imagen|kling|nano banana)[-\s]?\d/i],
      ['системный промпт', /системн(?:ый|ого|ом|ые) промпт|system prompt/i],
    ];
    const problems: string[] = [];
    for (const v of all) {
      for (const [name, re] of STOP) if (re.test(v.text)) problems.push(`${where(v)}: ${name}`);
      for (const m of v.text.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)) {
        const host = m[0].toLowerCase();
        if (!HOST_ALLOW.has(host)) problems.push(`${where(v)}: адрес ${host}`);
      }
    }
    expect(problems).toEqual([]);
  });

  // Подпись поля «Токен бота» (продукты) и сама пометка клиента (она и
  // существует, чтобы сказать «о деньгах не говори») — не в счёт, вырезаем
  // перед проверкой.
  it('сборка из стора: ни слова о деньгах, кроме подписи поля «Токен бота»', () => {
    const MONEY = /токен|оплат|списан|баланс|пополн|₽|\$\d|бесплат/i;
    const bad = all
      .filter((v) => v.client === 'store')
      .filter((v) => {
        const botToken = (labelsFor(v.lang) as Record<string, string>).prodToken;
        let text = botToken ? v.text.split(`«${botToken}»`).join('') : v.text;
        text = text.split(CLIENT_NOTES.store).join('');
        return MONEY.test(text);
      })
      .map(where);
    expect(bad).toEqual([]);
  });
});

describe('исходники статей', () => {
  const dir = path.join(__dirname, 'articles');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');

  it('у каждой статьи свой модуль <id>.ts, и каждый модуль — в перечне', () => {
    expect(files.map((f) => f.replace(/\.ts$/, '')).sort()).toEqual(KB_ARTICLES.map((a) => a.id).sort());
  });

  it('в статичном тексте нет цифр и чужих подстановок: числа — только из констант (V.*)', () => {
    const problems: string[] = [];
    for (const f of files) {
      const src = fs
        .readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^import .*$/gm, '')
        .replace(/\$\{q\('[A-Za-z]+'\)\}/g, '')
        .replace(/\$\{V\.[A-Za-z0-9_]+\}/g, '')
        .replace(/\$\{paid\(`/g, '')
        .replace(/`\)\}/g, '')
        .replace(/\$\{paid\('/g, '')
        .replace(/'\)\}/g, '')
        .replace(FORMAT_TOKENS, '');
      const other = src.match(/\$\{[^}]*\}/g);
      if (other) problems.push(`${f}: подстановка ${[...new Set(other)].join(', ')}`);
      const digits = src.match(/\d+/g);
      if (digits) problems.push(`${f}: цифры ${[...new Set(digits)].join(', ')}`);
    }
    expect(problems).toEqual([]);
  });
});
