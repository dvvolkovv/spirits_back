import { BlogCron, STUCK_PUBLISHING_MINUTES } from './blog.cron';

const deps = () => ({
  pg: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  topics: { takeNextIdea: jest.fn().mockResolvedValue(null), addTopic: jest.fn(), topAssistants: jest.fn().mockResolvedValue([]), recentTitles: jest.fn().mockResolvedValue([]) },
  editor: { draft: jest.fn() },
  images: { render: jest.fn() },
  publisher: { publish: jest.fn() },
  approval: { sendForReview: jest.fn(), notify: jest.fn() },
  settings: { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }) },
  news: { weeklyTopics: jest.fn().mockResolvedValue([]) },
});

const make = (d: any) => new BlogCron(d.pg, d.topics, d.editor, d.images, d.publisher, d.approval, d.settings, d.news);

describe('BlogCron при выключенном флаге', () => {
  const OLD = process.env.BLOG_ENABLED;
  afterEach(() => { process.env.BLOG_ENABLED = OLD; });

  it('не делает ничего, когда BLOG_ENABLED не выставлен', async () => {
    process.env.BLOG_ENABLED = '';
    const d = deps();
    await make(d).prepareDrafts();
    await make(d).publishDue();
    expect(d.topics.takeNextIdea).not.toHaveBeenCalled();
    expect(d.publisher.publish).not.toHaveBeenCalled();
  });
});

describe('BlogCron.refillTopics', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; });

  const newsCalls = (d: any) => d.topics.addTopic.mock.calls
    .map((c: any) => c[0]).filter((t: any) => t.rubric === 'news');
  const caseCalls = (d: any) => d.topics.addTopic.mock.calls
    .map((c: any) => c[0]).filter((t: any) => t.rubric === 'case');

  it('заводит по теме недели, а не по коммиту', async () => {
    const d = deps();
    // Сервис уже отобрал: одна тема на всю неделю из двух десятков коммитов.
    d.news.weeklyTopics.mockResolvedValue([{
      rubric: 'news', source: 'git', sourceRef: 'git:2026-W38:meeting-bot',
      topicKey: 'meeting-bot-2026-w38', topicHint: 'Встречу можно записать', onceBySourceRef: true,
    }]);

    await make(d).refillTopics();

    expect(newsCalls(d)).toHaveLength(1);
    expect(newsCalls(d)[0].sourceRef).toBe('git:2026-W38:meeting-bot');
    expect(newsCalls(d)[0].onceBySourceRef).toBe(true);
  });

  it('неделя без новостей — ни одной записи, и это не ошибка', async () => {
    const d = deps();
    d.news.weeklyTopics.mockResolvedValue([]);

    await make(d).refillTopics();

    expect(newsCalls(d)).toHaveLength(0);
  });

  it('отбор новостей сорвался — кейсы всё равно заводятся', async () => {
    // Отбор ходит в релей, а тот отваливается регулярно. Общий catch на весь
    // метод съел бы вместе с новостями и кейсы, которым релей не нужен.
    const d = deps();
    d.news.weeklyTopics.mockRejectedValue(new Error('релей молчит'));
    d.topics.topAssistants.mockResolvedValue([{ agentId: '12', agentName: 'Юрист', turns: 40 }]);

    await make(d).refillTopics();

    expect(caseCalls(d)).toHaveLength(1);
  });

  it('при выключенном BLOG_ENABLED отбор не запускается', async () => {
    process.env.BLOG_ENABLED = '';
    const d = deps();
    await make(d).refillTopics();
    expect(d.news.weeklyTopics).not.toHaveBeenCalled();
    expect(d.topics.addTopic).not.toHaveBeenCalled();
  });
});

describe('BlogCron.prepareDrafts', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; process.env.BLOG_APPROVER_TG_ID = '77'; });

  it('берёт идею, просит текст и картинку, отправляет на апрув', async () => {
    const d = deps();
    d.topics.takeNextIdea.mockResolvedValue({ id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null, status: 'idea' });
    d.editor.draft.mockResolvedValue({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
    d.images.render.mockResolvedValue('https://minio/i.png');

    await make(d).prepareDrafts();

    expect(d.editor.draft).toHaveBeenCalled();
    expect(d.images.render).toHaveBeenCalledWith('З', 'сцена');
    expect(d.approval.sendForReview).toHaveBeenCalled();
  });

  it('отказ редактора переводит пост в failed и не зовёт картинку', async () => {
    const d = deps();
    d.topics.takeNextIdea.mockResolvedValue({ id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null, status: 'idea' });
    d.editor.draft.mockRejectedValue(new Error('релей молчит'));

    await make(d).prepareDrafts();

    expect(d.images.render).not.toHaveBeenCalled();
    const sqls = d.pg.query.mock.calls.map((c: any) => String(c[0]));
    expect(sqls.some((s) => s.includes("status = 'failed'"))).toBe(true);
  });

  it('без идей в очереди тихо выходит', async () => {
    const d = deps();
    await make(d).prepareDrafts();
    expect(d.editor.draft).not.toHaveBeenCalled();
  });

  // Обещание «перепишу к следующему тику» должно наступать. Пост в drafting
  // попадает двумя путями: владелец нажал «Переписать» (личка или админка) и
  // процесс умер посреди подготовки черновика. Проверка сквозная намеренно:
  // одной выборки в takeNextIdea мало — машина состояний по дороге тоже
  // обязана пропустить перезапуск, иначе пост молча зависнет навсегда.
  it('зависший drafting доезжает до апрува, а не остаётся висеть', async () => {
    const d = deps();
    d.topics.takeNextIdea.mockResolvedValue({ id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null, status: 'drafting' });
    d.editor.draft.mockResolvedValue({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
    d.images.render.mockResolvedValue('https://minio/i.png');

    await make(d).prepareDrafts();

    expect(d.editor.draft).toHaveBeenCalled();
    expect(d.approval.sendForReview).toHaveBeenCalled();
  });

  // Гонка: пока идея лежала в очереди, её статус увели из админки. Запись
  // статуса обязана пройти машину состояний, а не «ну мы же выбрали по
  // status = 'idea'». Мутация canTransition → true роняет этот тест.
  it('не трогает пост, из статуса которого переход в drafting запрещён', async () => {
    const d = deps();
    d.topics.takeNextIdea.mockResolvedValue({ id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null, status: 'published' });

    await make(d).prepareDrafts();

    expect(d.editor.draft).not.toHaveBeenCalled();
    const sqls = d.pg.query.mock.calls.map((c: any) => String(c[0]));
    expect(sqls.some((s) => s.includes("status = 'drafting'"))).toBe(false);
  });
});

describe('BlogCron.publishDue', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; });

  it('публикует только посты, у которых слот наступил', async () => {
    const d = deps();
    d.pg.query.mockResolvedValueOnce({ rows: [{ id: 'p1', rubric: 'case', source: 'stats', topic_key: 'k', status: 'approved', attempts: 0, image_url: 'u', title: 'З', body: 'Т' }] });
    d.publisher.publish.mockResolvedValue({ ok: true });

    await make(d).publishDue();

    const sql = String(d.pg.query.mock.calls[0][0]);
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('slot_at <= now()');
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
  });
});

describe('BlogCron.rearmStuck', () => {
  const OLD = process.env.BLOG_ENABLED;
  afterEach(() => { process.env.BLOG_ENABLED = OLD; });

  it('возвращает в approved только publishing, зависшие дольше порога', async () => {
    process.env.BLOG_ENABLED = 'true';
    const d = deps();
    await make(d).rearmStuck();

    const [sql, params] = d.pg.query.mock.calls[0];
    expect(String(sql)).toContain("status = 'publishing'");
    expect(String(sql)).toContain("SET status = 'approved'");
    // Без порога по времени сторож отобрал бы пост у живой отправки.
    expect(String(sql)).toContain('updated_at <');
    expect(params).toContain(STUCK_PUBLISHING_MINUTES);
  });

  it('при выключенном BLOG_ENABLED не ходит в базу', async () => {
    process.env.BLOG_ENABLED = '';
    const d = deps();
    await make(d).rearmStuck();
    expect(d.pg.query).not.toHaveBeenCalled();
  });
});

describe('BlogCron.dropStaleNews', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; });

  it('выбрасывает новости старше двух недель', async () => {
    const d = deps();
    await make(d).dropStaleNews();
    const sql = String(d.pg.query.mock.calls[0][0]);
    expect(sql).toContain("rubric = 'news'");
    expect(sql).toContain("status = 'rejected'");

    // Список статусов-источников берётся из машины состояний, а не из
    // литерала в SQL: опубликованный пост в мусор не уезжает.
    const from = d.pg.query.mock.calls[0][1][0] as string[];
    expect(from).toContain('idea');
    expect(from).not.toContain('published');
    expect(from).not.toContain('rejected');
  });
});
