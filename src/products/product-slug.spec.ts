import { SLUG_RE } from './provisioning.service';
import { randomSuffix, siteSlugCandidates, slugifyName, slugWithSuffix, SLUG_MAX } from './product-slug';

describe('слаг из имени — как в форме Студии', () => {
  it('кириллица транслитерируется, лишнее — в дефис', () => {
    expect(slugifyName('Магазин цветов')).toBe('magazin-cvetov');
    expect(slugifyName('  Ёжик & Ко!!! ')).toBe('ezhik-ko');
    // «й» после NFD — «и» с кратким знаком: знак срезается, как и в форме.
    expect(slugifyName('Мой бот')).toBe('moi-bot');
  });

  it('пустое и без букв — пустая строка', () => {
    expect(slugifyName('')).toBe('');
    expect(slugifyName('!!! ???')).toBe('');
  });

  it('хвост: основа + 6 знаков, без основы — вид-хвост, всегда годный слаг', () => {
    expect(slugWithSuffix('Магазин цветов', 'abc123', 'bot')).toBe('magazin-cvetov-abc123');
    expect(slugWithSuffix('!!!', 'abc123', 'site')).toBe('site-abc123');
    const long = slugWithSuffix('очень '.repeat(20), 'zz99zz', 'bot');
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(SLUG_RE.test(long)).toBe(true);
  });

  it('случайный хвост — 6 строчных латинских или цифр', () => {
    for (let i = 0; i < 50; i++) expect(randomSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });

  it('сайт: сначала чистая основа (станет адресом), потом три с хвостом', () => {
    expect(siteSlugCandidates('Магазин цветов', () => 'zzzzzz')).toEqual([
      'magazin-cvetov', 'magazin-cvetov-zzzzzz', 'magazin-cvetov-zzzzzz', 'magazin-cvetov-zzzzzz',
    ]);
    expect(siteSlugCandidates('!!!', () => 'q1q1q1')).toEqual(['site-q1q1q1', 'site-q1q1q1', 'site-q1q1q1']);
  });
});
