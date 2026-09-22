import { BlogNewsService, MAX_WEEKLY_PICKS } from './blog-news.service';
import { MISC_THEME } from './blog-news.themes';

const WEEK = new Date('2026-09-20T06:00:00Z'); // воскресенье, 2026-W38

const c = (subject: string, sha: string) => ({ sha, subject });

const gitMock = (commits: any[]) => ({ weeklyCommits: jest.fn().mockResolvedValue(commits) });
const relayMock = (reply: string) => ({ ask: jest.fn().mockResolvedValue(reply) });
const reply = (...picks: Array<{ theme: string; headline: string }>) =>
  JSON.stringify({ picks });

/** Неделя с прода: крупный внутренний скоуп, средний и маленький продуктовый. */
const REAL_WEEK = [
  ...Array.from({ length: 27 }, (_, i) => c(`feat(blog): шаг ${i}`, `b${i}`)),
  ...Array.from({ length: 24 }, (_, i) => c(`feat(meeting-bot): шаг ${i}`, `m${i}`)),
  ...Array.from({ length: 3 }, (_, i) => c(`feat(trip): шаг ${i}`, `t${i}`)),
];

const make = (commits: any[], relayReply: string) => {
  const git = gitMock(commits);
  const relay = relayMock(relayReply);
  return { git, relay, svc: new BlogNewsService(git as any, relay as any) };
};

describe('BlogNewsService.weeklyTopics — единица это тема, а не коммит', () => {
  it('релей зовётся ровно один раз на всю неделю', async () => {
    const { relay, svc } = make(REAL_WEEK, reply({ theme: 'meeting-bot', headline: 'Встречу можно записать' }));
    await svc.weeklyTopics(WEEK);
    expect(relay.ask).toHaveBeenCalledTimes(1);
  });

  it('двадцать четыре коммита одной темы дают одну запись в очереди, а не двадцать четыре', async () => {
    const { svc } = make(REAL_WEEK, reply({ theme: 'meeting-bot', headline: 'Встречу можно записать' }));
    const topics = await svc.weeklyTopics(WEEK);
    expect(topics).toHaveLength(1);
    expect(topics[0].topicKey).toBe('meeting-bot-2026-w38');
    // И запись эта — про всю тему целиком. Одной длины списка мало: при
    // группировке «тема на коммит» тем с именем meeting-bot стало бы 24, но
    // в очередь всё равно легла бы одна — с одним коммитом внутри.
    expect(String(topics[0].topicHint).match(/^- feat\(meeting-bot\)/gm)).toHaveLength(24);
  });

  it('невыбранные темы в очередь не попадают', async () => {
    const { svc } = make(REAL_WEEK, reply({ theme: 'meeting-bot', headline: 'Встречу можно записать' }));
    const topics = await svc.weeklyTopics(WEEK);
    expect(topics.map((t) => t.sourceRef)).toEqual(['git:2026-W38:meeting-bot']);
  });

  it('рубрика и источник — новость из git', async () => {
    const { svc } = make(REAL_WEEK, reply({ theme: 'trip', headline: 'Маршрут одной кнопкой' }));
    const [topic] = await svc.weeklyTopics(WEEK);
    expect(topic.rubric).toBe('news');
    expect(topic.source).toBe('git');
  });

  it('в topicHint едут и объяснение агента, и заголовки коммитов темы', async () => {
    const commits = [c('feat(trip): маршрут одной кнопкой', 'x'), c('fix(trip): не терялись точки', 'y')];
    const { svc } = make(commits, reply({ theme: 'trip', headline: 'Маршрут строится одной кнопкой' }));
    const [topic] = await svc.weeklyTopics(WEEK);
    expect(topic.topicHint).toContain('Маршрут строится одной кнопкой');
    expect(topic.topicHint).toContain('feat(trip): маршрут одной кнопкой');
    expect(topic.topicHint).toContain('fix(trip): не терялись точки');
  });
});

describe('BlogNewsService.weeklyTopics — планка отбора', () => {
  it('пустой список от агента — ноль тем, и это не ошибка', async () => {
    const { svc } = make(REAL_WEEK, reply());
    await expect(svc.weeklyTopics(WEEK)).resolves.toEqual([]);
  });

  it('больше двух тем агент протащить не может', async () => {
    const commits = ['trip', 'profile', 'tokens', 'payments'].map((t, i) => c(`feat(${t}): раз`, `s${i}`));
    const picks = ['trip', 'profile', 'tokens', 'payments'].map((t) => ({ theme: t, headline: `про ${t}` }));
    const { svc } = make(commits, reply(...picks));
    const topics = await svc.weeklyTopics(WEEK);
    expect(topics).toHaveLength(MAX_WEEKLY_PICKS);
    expect(MAX_WEEKLY_PICKS).toBe(2);
  });

  it('обрезка идёт по годным темам: выдуманная не съедает место у настоящей', async () => {
    const commits = ['trip', 'profile'].map((t, i) => c(`feat(${t}): раз`, `s${i}`));
    const { svc } = make(commits, reply(
      { theme: 'придуманное', headline: 'не было такого' },
      { theme: 'trip', headline: 'Маршрут одной кнопкой' },
      { theme: 'profile', headline: 'Профиль стал понятнее' },
    ));
    const topics = await svc.weeklyTopics(WEEK);
    expect(topics.map((t) => t.sourceRef)).toEqual(['git:2026-W38:trip', 'git:2026-W38:profile']);
  });

  it('выдуманная агентом тема отбрасывается — фактов под ней нет', async () => {
    const { svc } = make(REAL_WEEK, reply({ theme: 'телепатия', headline: 'Ассистент читает мысли' }));
    await expect(svc.weeklyTopics(WEEK)).resolves.toEqual([]);
  });

  it('тема из стоп-листа не доезжает, даже если агент её назвал', async () => {
    // `blog` — наш собственный инструментарий, агенту его не показывают.
    // Названная по памяти или выдуманная, она отсекается одним и тем же
    // правилом: темы не из списка недели в очередь не попадают.
    const { svc } = make(REAL_WEEK, reply({ theme: 'blog', headline: 'Канал теперь ведёт себя иначе' }));
    await expect(svc.weeklyTopics(WEEK)).resolves.toEqual([]);
  });

  it('регистр в ответе агента не мешает сопоставить тему', async () => {
    const { svc } = make(REAL_WEEK, reply({ theme: ' Meeting-Bot ', headline: 'Встречу можно записать' }));
    const topics = await svc.weeklyTopics(WEEK);
    expect(topics.map((t) => t.sourceRef)).toEqual(['git:2026-W38:meeting-bot']);
  });

  it('дважды названная тема заводится один раз', async () => {
    const { svc } = make(REAL_WEEK, reply(
      { theme: 'meeting-bot', headline: 'Встречу можно записать' },
      { theme: 'meeting-bot', headline: 'И расшифровать' },
    ));
    const topics = await svc.weeklyTopics(WEEK);
    expect(topics).toHaveLength(1);
  });

  it('сборную солянку без скоупа агент выбрать может', async () => {
    const { svc } = make([c('fix: вход по почте', 'a')], reply({ theme: MISC_THEME, headline: 'Вход по почте больше не двоит аккаунт' }));
    const topics = await svc.weeklyTopics(WEEK);
    expect(topics).toHaveLength(1);
    expect(topics[0].sourceRef).toBe(`git:2026-W38:${MISC_THEME}`);
  });
});

describe('BlogNewsService.weeklyTopics — когда релей не нужен', () => {
  it('без коммитов за неделю релей не дёргается вовсе', async () => {
    const { relay, svc } = make([], reply());
    await expect(svc.weeklyTopics(WEEK)).resolves.toEqual([]);
    expect(relay.ask).not.toHaveBeenCalled();
  });

  it('неделя целиком из стоп-листа: релей не дёргается', async () => {
    const commits = [c('feat(blog): раз', 'a'), c('fix(deploy): два', 'b'), c('feat(runner): три', 'd')];
    const { relay, svc } = make(commits, reply());
    await expect(svc.weeklyTopics(WEEK)).resolves.toEqual([]);
    expect(relay.ask).not.toHaveBeenCalled();
  });

  it('мусорный ответ релея — ошибка наверх, а не тихо пустая неделя', async () => {
    const { svc } = make(REAL_WEEK, 'извини, не могу');
    await expect(svc.weeklyTopics(WEEK)).rejects.toThrow(/не нашёл json/i);
  });
});

describe('BlogNewsService.weeklyTopics — что уходит агенту', () => {
  it('в сообщении есть все отобранные темы с заголовками коммитов', async () => {
    const { relay, svc } = make(REAL_WEEK, reply());
    await svc.weeklyTopics(WEEK);
    const message = String(relay.ask.mock.calls[0][1]);
    expect(message).toContain('meeting-bot');
    expect(message).toContain('trip');
    expect(message).toContain('feat(meeting-bot): шаг 0');
  });

  it('каждая тема названа один раз, а не по разу на коммит', async () => {
    // Ровно та поломка, из-за которой неделя выглядела как сотня новостей:
    // агент видел список коммитов, а не список тем.
    const { relay, svc } = make(REAL_WEEK, reply());
    await svc.weeklyTopics(WEEK);
    const message = String(relay.ask.mock.calls[0][1]);
    expect(message.match(/^## meeting-bot /gm)).toHaveLength(1);
    expect(message).toContain('## meeting-bot (коммитов: 24)');
  });

  it('темы из стоп-листа агенту не показываются', async () => {
    const { relay, svc } = make(REAL_WEEK, reply());
    await svc.weeklyTopics(WEEK);
    const message = String(relay.ask.mock.calls[0][1]);
    expect(message).not.toContain('blog');
  });

  it('системный промпт — тот самый промпт отбора', async () => {
    const { relay, svc } = make(REAL_WEEK, reply());
    await svc.weeklyTopics(WEEK);
    expect(String(relay.ask.mock.calls[0][0])).toMatch(/неделя без новостей/i);
  });

  it('sessionId привязан к неделе — чужой контекст в отбор не течёт', async () => {
    const { relay, svc } = make(REAL_WEEK, reply());
    await svc.weeklyTopics(WEEK);
    expect(String(relay.ask.mock.calls[0][2])).toContain('2026-W38');
  });
});

describe('BlogNewsService.weeklyTopics — повторный анонс', () => {
  it('sourceRef несёт неделю, и тема просит проверку по нему', async () => {
    const { svc } = make(REAL_WEEK, reply({ theme: 'meeting-bot', headline: 'Встречу можно записать' }));
    const [topic] = await svc.weeklyTopics(WEEK);
    expect(topic.sourceRef).toBe('git:2026-W38:meeting-bot');
    // Без этого флага повтор ловила бы только дедупликация по topic_key, а
    // она пропускает темы, которые владелец уже отправил в мусор.
    expect(topic.onceBySourceRef).toBe(true);
  });

  it('та же тема на следующей неделе — другой sourceRef, анонс снова возможен', async () => {
    const { svc } = make(REAL_WEEK, reply({ theme: 'meeting-bot', headline: 'Встречу можно записать' }));
    const [a] = await svc.weeklyTopics(new Date('2026-09-20T06:00:00Z'));
    const [b] = await svc.weeklyTopics(new Date('2026-09-27T06:00:00Z'));
    expect(a.sourceRef).not.toBe(b.sourceRef);
  });
});
