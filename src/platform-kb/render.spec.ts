import { CLIENT_NOTES, dropEmptySections, renderArticle, renderIndex, topicsFor } from './render';
import type { KbArticle } from './kb.types';

const FAKE: KbArticle = {
  id: 'fake',
  title: 'Тест',
  summary: 'тестовая статья',
  related: [],
  render: ({ q, paid }) => `## Что это\nРаздел ${q('studio')}.\n\n## Лимиты и цены\n${paid('Стоит денег.')}\n\n## Как устроено\nПросто.`,
};
const PAID: KbArticle = { id: 'paid', title: 'Платная', summary: 'про деньги', related: [], paidOnly: true, render: () => '## Что это\nДеньги.' };

describe('сборка статьи', () => {
  it('заголовок статьи — первой строкой', () => {
    expect(renderArticle(FAKE, 'ru', 'web').split('\n')[0]).toBe('# Тест');
  });

  it('подписи — на языке пользователя, в ёлочках', () => {
    expect(renderArticle(FAKE, 'ru', 'web')).toContain('Раздел «Студия».');
    expect(renderArticle(FAKE, 'en', 'web')).toContain('Раздел «Studio».');
  });

  it('незнакомый язык — русские подписи', () => {
    expect(renderArticle(FAKE, 'xx', 'web')).toContain('«Студия»');
  });

  it('веб — без пометки о клиенте', () => {
    expect(renderArticle(FAKE, 'ru', 'web')).toBe('# Тест\n\n## Что это\nРаздел «Студия».\n\n## Лимиты и цены\nСтоит денег.\n\n## Как устроено\nПросто.');
  });

  it('Flutter — пометка про своё меню и my.linkeon.io', () => {
    const t = renderArticle(FAKE, 'ru', 'app');
    expect(t).toContain(CLIENT_NOTES.app);
    expect(CLIENT_NOTES.app).toContain('my.linkeon.io');
  });

  it('Telegram — пометка про кабинет my.linkeon.io', () => {
    expect(renderArticle(FAKE, 'ru', 'telegram')).toContain(CLIENT_NOTES.telegram);
    expect(CLIENT_NOTES.telegram).toContain('my.linkeon.io');
  });

  it('стор: строки paid() вырезаны, опустевший раздел исчезает целиком', () => {
    const t = renderArticle(FAKE, 'ru', 'store');
    expect(t).not.toContain('Стоит денег');
    expect(t).not.toContain('## Лимиты и цены');
    expect(t).toContain('## Как устроено');
    expect(t).not.toMatch(/\n{3,}/);
  });

  it('пометка стора сама не говорит о токенах', () => {
    expect(CLIENT_NOTES.store).not.toMatch(/токен/i);
  });
});

describe('перечень тем', () => {
  it('стор не видит платных тем', () => {
    expect(topicsFor('store', [FAKE, PAID]).map((a) => a.id)).toEqual(['fake']);
    expect(topicsFor('web', [FAKE, PAID]).map((a) => a.id)).toEqual(['fake', 'paid']);
  });

  it('перечень — строка «id — summary» на тему', () => {
    expect(renderIndex('web', [FAKE, PAID])).toBe('- fake — тестовая статья\n- paid — про деньги');
    expect(renderIndex('store', [FAKE, PAID])).toBe('- fake — тестовая статья');
  });
});

describe('dropEmptySections', () => {
  it('убирает только пустые разделы', () => {
    expect(dropEmptySections('## А\nтекст\n\n## Б\n\n## В\nещё')).toBe('## А\nтекст\n\n## В\nещё');
  });

  it('текст до первого раздела не трогает', () => {
    expect(dropEmptySections('вступление\n\n## А\n')).toBe('вступление\n\n');
  });

  it('## посреди строки — не граница раздела', () => {
    expect(dropEmptySections('## А\nтекст с ## внутри строки\n\n## Б\n')).toBe('## А\nтекст с ## внутри строки\n\n');
  });

  it('последний заголовок без перевода строки — тоже пустой раздел', () => {
    expect(dropEmptySections('## А\nтекст\n\n## Б')).toBe('## А\nтекст\n\n');
  });
});
