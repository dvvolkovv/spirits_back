import { executeLinkeonHelp, linkeonHelpTool, parseTopics, LINKEON_HELP_TOOL_NAME } from './linkeon-help';
import type { KbArticle } from './kb.types';

const art = (id: string, related: string[] = [], paidOnly = false): KbArticle => ({
  id,
  title: `Статья ${id}`,
  summary: `про ${id}`,
  related,
  paidOnly,
  render: ({ q }) => `## Что это\n${id}: ${q('studio')}`,
});
const BROKEN: KbArticle = { ...art('broken'), render: () => { throw new Error('сломано'); } };
const REG = [art('video', ['images', 'tokens']), art('images', ['video']), art('tokens', [], true), BROKEN];
const IDS = REG.map((a) => a.id);

describe('parseTopics', () => {
  it('массив: без повторов, без регистра, не больше трёх', () => {
    expect(parseTopics({ topics: ['Video', 'video', 'images', 'tokens', 'broken'] }, IDS)).toEqual(['video', 'images', 'tokens']);
  });

  it('одна строка вместо массива', () => {
    expect(parseTopics({ topics: 'images' }, IDS)).toEqual(['images']);
  });

  it('незнакомое и мусор отбрасываются', () => {
    expect(parseTopics({ topics: ['rm -rf', 42, null] }, IDS)).toEqual([]);
    expect(parseTopics(undefined, IDS)).toEqual([]);
    expect(parseTopics({}, IDS)).toEqual([]);
  });
});

describe('executeLinkeonHelp', () => {
  it('статья собрана под язык пользователя', () => {
    const r = executeLinkeonHelp({ topics: ['video'] }, { lang: 'en', client: 'web' }, REG);
    expect(r.ok).toBe(true);
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0]).toMatchObject({ id: 'video', title: 'Статья video' });
    expect(r.articles[0].text).toContain('«Studio»');
    expect(r.index).toBeUndefined();
  });

  it('related — соседние темы без уже запрошенных', () => {
    const r = executeLinkeonHelp({ topics: ['video', 'images'] }, { lang: 'ru', client: 'web' }, REG);
    expect(r.related).toEqual(['tokens']);
  });

  it('стор: платная тема не отдаётся и в related не попадает', () => {
    const r = executeLinkeonHelp({ topics: ['tokens', 'video'] }, { lang: 'ru', client: 'store' }, REG);
    expect(r.articles.map((a) => a.id)).toEqual(['video']);
    expect(r.related).toEqual(['images']);
  });

  it('нет тем — перечень тем вместо ошибки', () => {
    const r = executeLinkeonHelp({}, { lang: 'ru', client: 'web' }, REG);
    expect(r.ok).toBe(true);
    expect(r.articles).toEqual([]);
    expect(r.index).toContain('- video — про video');
  });

  it('упавшая статья пропускается, остальные отдаются', () => {
    const r = executeLinkeonHelp({ topics: ['broken', 'images'] }, { lang: 'ru', client: 'web' }, REG);
    expect(r.ok).toBe(true);
    expect(r.articles.map((a) => a.id)).toEqual(['images']);
  });

  it('упала единственная — перечень тем', () => {
    const r = executeLinkeonHelp({ topics: ['broken'] }, { lang: 'ru', client: 'web' }, REG);
    expect(r.articles).toEqual([]);
    expect(r.index).toContain('- images — про images');
  });
});

describe('описание инструмента', () => {
  it('имя и единственный аргумент — topics, без userId', () => {
    const t = linkeonHelpTool('web', REG);
    expect(t.name).toBe(LINKEON_HELP_TOOL_NAME);
    expect(t.name).toBe('linkeon_help');
    expect(Object.keys(t.input_schema.properties)).toEqual(['topics']);
  });

  it('enum и перечень — по клиенту: стор без платных тем', () => {
    const web = linkeonHelpTool('web', REG);
    const store = linkeonHelpTool('store', REG);
    expect(web.input_schema.properties.topics.items.enum).toContain('tokens');
    expect(store.input_schema.properties.topics.items.enum).not.toContain('tokens');
    expect(web.description).toContain('- tokens — про tokens');
    expect(store.description).not.toContain('- tokens —');
  });

  it('описание говорит, когда звать, и запрещает userId', () => {
    const d = linkeonHelpTool('web', REG).description;
    expect(d).toMatch(/не по памяти/);
    expect(d).toMatch(/предложить функцию/);
    expect(d).toMatch(/userId/);
  });
});
