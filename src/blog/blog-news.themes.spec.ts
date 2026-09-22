import {
  MISC_THEME, THEME_STOPLIST, themeOf, groupCommitsByTheme, isStopTheme,
  weeklyThemes, isoWeekKey, newsSourceRef, newsTopicKey, newsTopicHint,
} from './blog-news.themes';

const c = (subject: string, sha = subject.slice(0, 6)) => ({ sha, subject });

describe('themeOf', () => {
  it('скоуп conventional commit становится темой', () => {
    expect(themeOf('feat(meeting-bot): запись встречи')).toBe('meeting-bot');
  });

  it('тип коммита темой не становится — тема это скоуп', () => {
    expect(themeOf('feat(voice-host): стерео')).toBe('voice-host');
  });

  it('восклицательный знак breaking change не приклеивается к теме', () => {
    expect(themeOf('feat(voice-host)!: сменили формат')).toBe('voice-host');
  });

  it('регистр скоупа схлопывается', () => {
    expect(themeOf('fix(Meeting-Bot): не терялась расшифровка')).toBe('meeting-bot');
  });

  it('коммит без скоупа уходит в общую тему, а не пропадает', () => {
    expect(themeOf('fix: вход по почте заводил второй аккаунт')).toBe(MISC_THEME);
  });

  it('пустые скобки — это отсутствие скоупа', () => {
    expect(themeOf('feat(): что-то')).toBe(MISC_THEME);
  });

  it('заголовок вообще без conventional-формы — общая тема', () => {
    expect(themeOf('Поправил кнопку')).toBe(MISC_THEME);
  });
});

describe('groupCommitsByTheme', () => {
  it('десять коммитов одного скоупа — одна тема, а не десять', () => {
    const commits = Array.from({ length: 10 }, (_, i) => c(`feat(meeting-bot): шаг ${i}`, `s${i}`));
    const themes = groupCommitsByTheme(commits);
    expect(themes).toHaveLength(1);
    expect(themes[0].theme).toBe('meeting-bot');
    expect(themes[0].commits).toHaveLength(10);
  });

  it('коммиты без скоупа собираются в одну тему, а не в тему на каждый', () => {
    const themes = groupCommitsByTheme([
      c('fix: вход по почте', 'a'), c('fix: баланс', 'b'), c('feat: новая кнопка', 'd'),
    ]);
    expect(themes).toHaveLength(1);
    expect(themes[0].theme).toBe(MISC_THEME);
    expect(themes[0].commits).toHaveLength(3);
  });

  it('темы идут по убыванию числа коммитов', () => {
    const themes = groupCommitsByTheme([
      c('feat(trip): раз', 'a'),
      c('feat(products): раз', 'b'), c('feat(products): два', 'c'), c('fix(products): три', 'd'),
      c('feat(profile): раз', 'e'), c('fix(profile): два', 'f'),
    ]);
    expect(themes.map((t) => t.theme)).toEqual(['products', 'profile', 'trip']);
  });

  it('сборная солянка без скоупа стоит последней, даже если коммитов в ней больше всех', () => {
    const themes = groupCommitsByTheme([
      c('fix: раз', 'a'), c('fix: два', 'b'), c('fix: три', 'c'),
      c('feat(trip): раз', 'd'),
    ]);
    expect(themes[themes.length - 1].theme).toBe(MISC_THEME);
  });

  it('порядок коммитов внутри темы сохраняется — git отдаёт их от свежих к старым', () => {
    const themes = groupCommitsByTheme([
      c('feat(trip): свежий', 'a'), c('feat(trip): старый', 'b'),
    ]);
    expect(themes[0].commits.map((x) => x.sha)).toEqual(['a', 'b']);
  });

  it('пустой список коммитов — пустой список тем, не падение', () => {
    expect(groupCommitsByTheme([])).toEqual([]);
  });
});

describe('стоп-лист тем', () => {
  it('в стоп-листе есть инфраструктура и наш собственный инструментарий', () => {
    for (const t of ['deploy', 'runner', 'ci', 'blog', 'plan', 'spec']) {
      expect(THEME_STOPLIST).toContain(t);
    }
  });

  it('isStopTheme не зависит от регистра', () => {
    expect(isStopTheme('Blog')).toBe(true);
  });

  it('обычная продуктовая тема стоп-листом не задета', () => {
    expect(isStopTheme('meeting-bot')).toBe(false);
  });

  it('weeklyThemes выбрасывает тему из стоп-листа целиком, даже если она самая крупная', () => {
    const commits = [
      ...Array.from({ length: 27 }, (_, i) => c(`feat(blog): шаг ${i}`, `b${i}`)),
      ...Array.from({ length: 3 }, (_, i) => c(`fix(deploy): шаг ${i}`, `d${i}`)),
      c('feat(trip): маршрут одной кнопкой', 'x'),
    ];
    const themes = weeklyThemes(commits);
    expect(themes.map((t) => t.theme)).toEqual(['trip']);
  });

  it('неделя целиком из стоп-листа даёт ноль тем', () => {
    expect(weeklyThemes([c('feat(blog): раз', 'a'), c('fix(runner): два', 'b')])).toEqual([]);
  });

  it('сборная солянка без скоупа стоп-листом не режется', () => {
    expect(weeklyThemes([c('fix: вход по почте', 'a')]).map((t) => t.theme)).toEqual([MISC_THEME]);
  });
});

describe('isoWeekKey', () => {
  it('воскресенье выката относится к неделе, которая только что закончилась', () => {
    expect(isoWeekKey(new Date('2026-09-20T06:00:00Z'))).toBe('2026-W38');
  });

  it('номер недели дополняется нулём — ключи сортируются как строки', () => {
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });

  it('первое января пятницы относится к 53-й неделе прошлого года, а не к первой новой', () => {
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });

  it('соседние дни одной недели дают один ключ', () => {
    expect(isoWeekKey(new Date('2026-09-14T00:00:00Z'))).toBe(isoWeekKey(new Date('2026-09-20T23:00:00Z')));
  });

  it('понедельник начинает новую неделю', () => {
    expect(isoWeekKey(new Date('2026-09-21T00:00:00Z'))).toBe('2026-W39');
  });
});

describe('ключи темы недели', () => {
  it('sourceRef склеен из источника, недели и темы', () => {
    expect(newsSourceRef('2026-W38', 'meeting-bot')).toBe('git:2026-W38:meeting-bot');
  });

  it('одна тема в разные недели — разные sourceRef', () => {
    expect(newsSourceRef('2026-W38', 'trip')).not.toBe(newsSourceRef('2026-W39', 'trip'));
  });

  it('разные темы одной недели — разные sourceRef', () => {
    expect(newsSourceRef('2026-W38', 'trip')).not.toBe(newsSourceRef('2026-W38', 'profile'));
  });

  it('topicKey содержит неделю: та же тема через месяц не считается дублем', () => {
    expect(newsTopicKey('2026-W38', 'meeting-bot')).toBe('meeting-bot-2026-w38');
    expect(newsTopicKey('2026-W38', 'trip')).not.toBe(newsTopicKey('2026-W42', 'trip'));
  });

  it('topicHint несёт и объяснение агента, и заголовки коммитов темы', () => {
    const hint = newsTopicHint('Встречу теперь можно записать', {
      theme: 'meeting-bot',
      commits: [c('feat(meeting-bot): запись встречи', 'a'), c('fix(meeting-bot): расшифровка', 'b')],
    });
    expect(hint).toContain('Встречу теперь можно записать');
    expect(hint).toContain('feat(meeting-bot): запись встречи');
    expect(hint).toContain('fix(meeting-bot): расшифровка');
  });
});
