import { BlogCron } from './blog.cron';

const deps = () => ({
  pg: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  topics: { takeNextIdea: jest.fn().mockResolvedValue(null), addTopic: jest.fn(), topAssistants: jest.fn().mockResolvedValue([]), recentTitles: jest.fn().mockResolvedValue([]) },
  editor: { draft: jest.fn() },
  images: { render: jest.fn() },
  publisher: { publish: jest.fn() },
  approval: { sendForReview: jest.fn(), notify: jest.fn() },
  settings: { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }) },
  git: { weeklyCommits: jest.fn().mockResolvedValue([]) },
});

const make = (d: any) => new BlogCron(d.pg, d.topics, d.editor, d.images, d.publisher, d.approval, d.settings, d.git);

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
