import {
  BlogTopicService, normalizeTopicKey, DEDUP_WINDOW_DAYS, STALE_DRAFTING_MINUTES,
} from './blog-topic.service';

const pgMock = () => ({ query: jest.fn() });

describe('normalizeTopicKey', () => {
  it('схлопывает регистр и пробелы', () => {
    expect(normalizeTopicKey('  Аренда   Квартиры ')).toBe('аренда-квартиры');
  });

  it('разная пунктуация даёт один ключ', () => {
    expect(normalizeTopicKey('Аренда: квартиры!')).toBe(normalizeTopicKey('аренда квартиры'));
  });
});

describe('BlogTopicService.addTopic', () => {
  it('новая тема вставляется', async () => {
    const pg = pgMock();
    pg.query
      .mockResolvedValueOnce({ rows: [] })                    // проверка дубля
      .mockResolvedValueOnce({ rows: [{ id: 'new-id', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    const post = await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда', topicHint: 'про аренду' });
    expect(post).not.toBeNull();
    expect(pg.query.mock.calls[1][0]).toContain('INSERT INTO blog_post');
  });

  it('кейс с тем же ключом в окне дедупликации не вставляется', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'old' }] });
    const svc = new BlogTopicService(pg as any);
    const post = await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(post).toBeNull();
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('окно дедупликации — 90 дней', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(pg.query.mock.calls[0][1]).toContain(DEDUP_WINDOW_DAYS);
  });

  it('отклонённая тема не блокирует повтор: дубль ищется только среди живых и опубликованных', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(pg.query.mock.calls[0][0]).toContain("status <> 'rejected'");
  });
});

describe('BlogTopicService.takeNextIdea', () => {
  const draftingRow = (over: any = {}) => ({
    id: 'p1', rubric: 'case', source: 'stats', topic_key: 'k', status: 'drafting', attempts: 0, ...over,
  });

  it('зависший drafting возвращается в работу — иначе «переписать» не наступает никогда', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [draftingRow()] });
    const svc = new BlogTopicService(pg as any);

    const post = await svc.takeNextIdea();

    // Главное здесь — что drafting вообще допустим как результат: пост,
    // который владелец отправил на перезапись, обязан вернуться в работу.
    expect(post?.id).toBe('p1');
    expect(post?.status).toBe('drafting');
  });

  it('порог свежести передаётся параметром, а не зашит в текст запроса', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);

    await svc.takeNextIdea();

    // Константа импортирована, а не продублирована числом: если порог зашьют
    // литералом в SQL, параметров не будет и тест покраснеет.
    expect(pg.query.mock.calls[0][1]).toContain(STALE_DRAFTING_MINUTES);
  });

  it('берёт зависший drafting, а не только idea', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toContain('drafting');
  });

  it('свежий drafting не подхватывается — он прямо сейчас в работе', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/updated_at|interval/);
  });

  it('порог не распространяется на idea: свежая идея берётся сразу', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = String(pg.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    // Не `toContain("status = 'idea' OR")`: такая проверка зеленеет на
    // «status = 'idea' ORDER BY» — на запросе вообще без drafting.
    expect(sql).toMatch(/status = 'idea'\s+OR \(status = 'drafting'/);
  });

  it('новость по-прежнему вытесняет кейс', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    expect(String(pg.query.mock.calls[0][0])).toContain("(rubric = 'news') DESC");
  });
});
