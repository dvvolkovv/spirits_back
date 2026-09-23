import { Logger } from '@nestjs/common';
import { BlogCron, STUCK_PUBLISHING_MINUTES } from './blog.cron';
import { STALE_DRAFTING_MINUTES } from './blog-topic.service';

const deps = () => ({
  // Захват черновика (`UPDATE ... RETURNING`) по умолчанию удаётся: пустой
  // результат означал бы «пост забрал другой тик», и тогда prepareDrafts
  // молча выходит — все его тесты мерили бы тишину вместо работы.
  pg: {
    query: jest.fn(async (sql: string) => (
      /RETURNING/.test(String(sql)) ? { rows: [{ id: 'p1' }] } : { rows: [] }
    )),
  },
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

/**
 * Гонка двух тиков `prepareDrafts`.
 *
 * Черновик захватывается В БАЗЕ, а не замком в памяти процесса: `linkeon-api`
 * поднят в cluster_mode, и первый же `pm2 scale linkeon-api 2` разнёс бы тики
 * по процессам, ничего не сообщив; крон вдобавок иногда дёргают отдельным
 * процессом руками. Замок в памяти дал бы ложное чувство защиты и спрятал бы
 * настоящую гонку от этого теста.
 *
 * Сам дефект: у переработки нет смены статуса — пост после замечания уже в
 * `drafting`, — поэтому захватывать было нечем. Второй тик брал ТОТ ЖЕ пост,
 * пока первый висел на релее: два похода к релею, две картинки и два
 * одинаковых черновика в личке у владельца. На часовом расписании окно не
 * достигалось, на пятиминутном достигается всякий раз, когда релей думает
 * дольше пяти минут.
 */
describe('BlogCron.prepareDrafts — гонка двух тиков', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; process.env.BLOG_APPROVER_TG_ID = '77'; });
  afterEach(() => { jest.restoreAllMocks(); });

  /**
   * Postgres в миниатюре: одна строка и атомарный UPDATE.
   *
   * Условие захвата НЕ зашито в заглушку — она смотрит, несёт ли его сам
   * запрос. Иначе заглушка сторожила бы строку вместо кода, и тест зеленел бы
   * на захвате без всякого условия.
   */
  const claimingPg = (over: any = {}) => {
    const state: any = { id: 'p1', status: 'drafting', drafting_started_at: null, ...over };
    return {
      state,
      query: jest.fn(async (sql: string) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/count\(\*\)/.test(s)) return { rows: [{ n: 0 }] };

        if (/RETURNING/.test(s) && /drafting_started_at = now\(\)/.test(s)) {
          const guarded = /drafting_started_at IS NULL/.test(s);
          const free = state.drafting_started_at === null;
          if (guarded && !free) return { rows: [] };      // проиграл гонку
          state.drafting_started_at = new Date();
          state.status = 'drafting';
          return { rows: [{ id: state.id }] };
        }
        return { rows: [] };
      }),
    };
  };

  /** Пост после замечания: уже `drafting`, текст прошлой генерации на месте. */
  const redone = () => ({
    id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null, status: 'drafting',
    title: 'Старый заголовок', body: 'Старый текст', editorNotes: ['объясни, что такое продукт'],
  });

  const racingDeps = () => {
    const d = deps();
    const pg = claimingPg();
    d.pg = pg as any;
    // Оба тика успели увидеть пост выборкой: SELECT не атомарен, и в этом
    // вся суть — развести их обязан именно захват.
    d.topics.takeNextIdea.mockResolvedValue(redone());
    d.images.render.mockResolvedValue('https://minio/i.png');
    return d;
  };

  /** Два тика внахлёст: второй приходит, пока первый висит на релее. */
  const runOverlapping = async (d: any) => {
    let release: any;
    d.editor.draft.mockReturnValue(new Promise((r) => {
      release = () => r({ title: 'Новый', body: 'Новый текст', imagePrompt: 'сцена' });
    }));

    const cron = make(d);
    const first = cron.prepareDrafts();
    await new Promise((r) => setImmediate(r));
    const second = cron.prepareDrafts();
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([first, second]);
  };

  it('редактора просят переписать пост один раз, а не дважды', async () => {
    const d = racingDeps();
    await runOverlapping(d);
    expect(d.editor.draft).toHaveBeenCalledTimes(1);
  });

  it('владелец получает один черновик, а не два одинаковых', async () => {
    const d = racingDeps();
    await runOverlapping(d);
    expect(d.approval.sendForReview).toHaveBeenCalledTimes(1);
  });

  it('картинка рисуется один раз — второй заход стоил бы денег', async () => {
    const d = racingDeps();
    await runOverlapping(d);
    expect(d.images.render).toHaveBeenCalledTimes(1);
  });

  /**
   * Проигранный захват — штатная гонка, а не сбой: ни ошибки в лог, ни
   * сообщения владельцу. Иначе каждый второй тик писал бы в лог панику.
   */
  it('проигравший тик молчит — это гонка, а не сбой', async () => {
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const d = racingDeps();

    await runOverlapping(d);

    expect(err).not.toHaveBeenCalled();
    expect(d.approval.notify).not.toHaveBeenCalled();
  });

  it('захват требует, чтобы отметка была пуста или протухла', async () => {
    const d = racingDeps();
    await runOverlapping(d);

    const claim = d.pg.query.mock.calls
      .map((c: any) => String(c[0]).replace(/\s+/g, ' '))
      .find((s: string) => /RETURNING/.test(s) && /drafting_started_at = now\(\)/.test(s));

    expect(claim).toBeDefined();
    expect(claim).toMatch(/drafting_started_at IS NULL/);
    // Порог — параметром, а не литералом в тексте запроса.
    const params = d.pg.query.mock.calls.find((c: any) => /RETURNING/.test(String(c[0])))?.[1];
    expect(params).toContain(STALE_DRAFTING_MINUTES);
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

/**
 * Расписание — это поведение, а не украшение: после замечания владелец ждёт
 * ровно один тик этого крана. На часовом расписании «перепишу» означало бы
 * «через час», и владелец за это время успевал отправить пост в мусор.
 */
describe('расписание BlogCron', () => {
  const { SCHEDULE_CRON_OPTIONS } = require('@nestjs/schedule/dist/schedule.constants');
  const cronOf = (method: string) =>
    Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, (BlogCron.prototype as any)[method])?.cronTime;

  it('переработка подхватывается каждые 5 минут, а не раз в час', () => {
    expect(cronOf('prepareDrafts')).toBe('*/5 * * * *');
  });

  /**
   * Напоминание остаётся часовым намеренно: его окно — час до слота
   * (REMIND_WINDOW_MINUTES), и на пятиминутном тике владелец получил бы
   * двенадцать одинаковых сообщений подряд.
   */
  it('напоминание о слоте осталось часовым', () => {
    expect(cronOf('remindPending')).toBe('0 * * * *');
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

  /** Протухшая новость уезжает в тот же терминальный статус, что и «в мусор». */
  it('заодно стирает замечания — пост отправлен в мусор', async () => {
    const d = deps();
    await make(d).dropStaleNews();
    expect(String(d.pg.query.mock.calls[0][0])).toContain("editor_notes = '{}'");
  });
});
