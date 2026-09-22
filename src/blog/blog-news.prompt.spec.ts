import { buildNewsSelectionPrompt, buildNewsSelectionMessage } from './blog-news.prompt';
import { MISC_THEME } from './blog-news.themes';

const c = (subject: string, sha: string) => ({ sha, subject });

describe('buildNewsSelectionPrompt', () => {
  const p = buildNewsSelectionPrompt();

  it('говорит, что пустой результат — нормальный и частый исход', () => {
    expect(p).toMatch(/неделя без новостей/i);
    expect(p).toMatch(/нормальн/i);
  });

  it('называет пустой список успехом, а не неудачей', () => {
    expect(p).toMatch(/пустой список — это (успешная работа|успех)/i);
  });

  it('перечисляет, что новостью не является', () => {
    for (const re of [
      /рефакторинг/i,           // внутренние переделки
      /инфраструктур/i,         // серверы, деплой, мониторинг
      /инструментарий/i,        // то, чем пользуется команда, а не клиент
      /документаци/i,           // правки доков, планов, спек
      /не замечал сломанным/i,  // починка невидимого
    ]) {
      expect(p).toMatch(re);
    }
  });

  it('ставит потолок в две темы и объясняет, что две — не норма', () => {
    expect(p).toMatch(/не больше двух тем/i);
    expect(p).toMatch(/одна сильная тема лучше двух средних/i);
  });

  it('велит сомневающемуся не выбирать', () => {
    expect(p).toMatch(/сомневаешься — не выбирай/i);
  });

  it('запрещает мерить важность числом коммитов', () => {
    expect(p).toMatch(/количество коммитов/i);
  });

  it('предупреждает про сборную солянку без скоупа', () => {
    expect(p).toContain(MISC_THEME);
    expect(p).toMatch(/солянк/i);
  });

  it('просит по каждой теме одну строку про человека, а не про код', () => {
    expect(p).toMatch(/одну строку/i);
    expect(p).toMatch(/что меняется для человека/i);
  });

  it('задаёт формат ответа: JSON с picks, theme и headline', () => {
    expect(p).toContain('picks');
    expect(p).toContain('theme');
    expect(p).toContain('headline');
    expect(p).toContain('{"picks": []}');
  });

  it('держит продуктовый словарь: «Ассистент», не «агент»', () => {
    expect(p.toLowerCase()).toContain('ассистент');
    // Не через \b: в JS граница слова считается по ASCII, и /\bагент\b/
    // не срабатывает на кириллице вообще — проверка была бы ложно-зелёной.
    expect(p.toLowerCase()).not.toContain('агент');
  });

  it('запрещает выдумывать то, чего нет в заголовках коммитов', () => {
    expect(p).toMatch(/не придумывай/i);
  });
});

describe('buildNewsSelectionMessage', () => {
  const themes = [
    { theme: 'meeting-bot', commits: [c('feat(meeting-bot): запись встречи', 'a'), c('fix(meeting-bot): расшифровка', 'b')] },
    { theme: 'trip', commits: [c('feat(trip): маршрут одной кнопкой', 'c')] },
  ];

  it('несёт неделю, темы, число коммитов и заголовки', () => {
    const m = buildNewsSelectionMessage('2026-W38', themes);
    expect(m).toContain('2026-W38');
    expect(m).toContain('meeting-bot');
    expect(m).toContain('trip');
    expect(m).toContain('коммитов: 2');
    expect(m).toContain('коммитов: 1');
    expect(m).toContain('feat(meeting-bot): запись встречи');
    expect(m).toContain('fix(meeting-bot): расшифровка');
    expect(m).toContain('feat(trip): маршрут одной кнопкой');
  });

  it('порядок тем из входа сохраняется', () => {
    const m = buildNewsSelectionMessage('2026-W38', themes);
    expect(m.indexOf('meeting-bot')).toBeLessThan(m.indexOf('trip'));
  });
});
