import { Logger } from '@nestjs/common';
import { BlogCron, STUCK_PUBLISHING_MINUTES } from './blog.cron';
import { BlogTopicService, STALE_DRAFTING_MINUTES } from './blog-topic.service';
import { BlogEditorService } from './blog-editor.service';

const LAWYER_PROFILE = 'Юрист — право, договоры, оферта, согласия, риски и требования регуляторов';

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
    d.topics.topAssistants.mockResolvedValue([{ agentId: '10', agentName: 'Алексей', description: LAWYER_PROFILE, turns: 40 }]);

    await make(d).refillTopics();

    expect(caseCalls(d)).toHaveLength(1);
  });

  /**
   * На проде подсказка была «На этой неделе чаще всего обращались к
   * ассистенту «Кира» (44 обращений). Придумай кейс по его профилю» — без
   * профиля. Редактор выдумал Кире-дизайнеру кейс про планирование и тревогу
   * и пересказал в посте статистику: «На этой неделе чаще всего писали Кире».
   */
  describe('подсказка кейса', () => {
    const KIRA = {
      agentId: '22', agentName: 'Кира',
      description: 'Дизайнер — логотипы, фирменный стиль, макеты, баннеры и презентации',
      turns: 44,
    };

    const hintFor = async (a: any): Promise<string> => {
      const d = deps();
      d.topics.topAssistants.mockResolvedValue([a]);
      await make(d).refillTopics();
      expect(caseCalls(d)).toHaveLength(1);
      return String(caseCalls(d)[0].topicHint);
    };

    it('несёт профиль ассистента — имя и описание из agents', async () => {
      const hint = await hintFor(KIRA);
      expect(hint).toContain('Кира');
      expect(hint).toContain('Дизайнер — логотипы, фирменный стиль, макеты, баннеры и презентации');
    });

    it('не несёт статистики: ни числа обращений, ни «чаще всего» — редактор перескажет их в посте', async () => {
      const hint = await hintFor(KIRA);
      expect(hint).not.toContain('44');
      expect(hint).not.toMatch(/обращ/i);
      expect(hint).not.toMatch(/чаще/i);
      expect(hint).not.toMatch(/популярн|востребован|на этой неделе/i);
    });

    it('ассистент без внятного описания в темы не попадает — лучше кейсом меньше, чем кейс о выдуманном', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const d = deps();
      d.topics.topAssistants.mockResolvedValue([
        { agentId: '12', agentName: 'Роман', description: null, turns: 900 },
        { agentId: '13', agentName: 'Лиана', description: '   ', turns: 300 },
        { agentId: '10', agentName: 'Алексей', description: 'Юрист', turns: 200 },   // ярлык, а не профиль
        KIRA,
      ]);

      let logged = '';
      try {
        await make(d).refillTopics();
        logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      } finally {
        warn.mockRestore();   // сбрасывает и mock.calls — поэтому лог снят выше
      }

      expect(caseCalls(d).map((t: any) => t.sourceRef)).toEqual(['stats:22']);
      // Пропуск не молчаливый: в логе видно, про кого кейса нет и почему.
      expect(logged).toMatch(/Роман[\s\S]*Лиана[\s\S]*Алексей/);
    });
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

  /**
   * Кейсы про Романа и Лиану упали на проде с «не нашёл JSON в ответе
   * редактора», а сырой ответ не сохранился нигде — причину пришлось угадывать.
   * Редактор здесь настоящий, подменён только релей.
   */
  it('ответ редактора не разобрался — в last_error видно, что он написал вместо поста', async () => {
    const d = deps();
    d.topics.takeNextIdea.mockResolvedValue({ id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null, status: 'idea', editorNotes: [] });
    const reply = 'Уточните, пожалуйста:\nкто такая Лиана и чем она занимается?';
    (d as any).editor = new BlogEditorService(
      { ask: jest.fn().mockResolvedValue(reply) } as any,
      { recentTitles: jest.fn().mockResolvedValue([]) } as any,
    );

    await make(d).prepareDrafts();

    const failed = d.pg.query.mock.calls.find((c: any) => String(c[0]).includes("status = 'failed'"));
    const lastError = String(failed[1][1]);
    expect(lastError).toMatch(/не нашёл JSON/i);
    // В админке это одна строка: перенос из ответа схлопнут в пробел.
    expect(lastError).toContain('Уточните, пожалуйста: кто такая Лиана и чем она занимается?');
    expect(lastError).not.toMatch(/\n/);
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
    // Только записи: охрана очереди сама ЧИТАЕТ `status = 'drafting'` (живой
    // черновик держит очередь), а стеречь здесь надо запись статуса.
    const writes = d.pg.query.mock.calls.map((c: any) => String(c[0])).filter((s: string) => /^\s*UPDATE/.test(s));
    expect(writes.some((s) => s.includes("status = 'drafting'"))).toBe(false);
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

/**
 * Что держит очередь черновиков.
 *
 * Раньше новый черновик не начинался, пока был хоть один пост в
 * `pending_review` ИЛИ `approved`. Одобренный пост уже решён и просто ждёт
 * слота, но держал всю очередь: владелец одобрил кейс в пятницу со слотом на
 * понедельник — срочная новость о запуске встала бы в работу только в
 * понедельник. Готовить посты наперёд было невозможно.
 *
 * Держат очередь теперь двое: пост на проверке (владелец ещё не решил — не
 * заваливаем его вторым черновиком) и черновик, который пишется прямо сейчас
 * (свежая `drafting_started_at`).
 *
 * Ловушка — дедлок. `drafting` с ПУСТОЙ отметкой — это запрошенная
 * переработка, которая ждёт, чтобы её взяли; сочти её охрана занятой — она
 * заблокирует сама себя, и переработка не случится никогда. Протухшая
 * отметка — брошенный черновик, его подбирает `takeNextIdea`, и держать
 * очередь он тоже не должен.
 */
describe('BlogCron.prepareDrafts — что держит очередь', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; process.env.BLOG_APPROVER_TG_ID = '77'; });

  type Row = { id: string; status: string; rubric: string; mark: number | null; created: number };

  /**
   * WHERE из запроса — в JS-предикат над строкой.
   *
   * Условия НЕ зашиты в заглушку: она исполняет то, что написано в самом
   * запросе. Поэтому мутация условия — вернуть в охрану `approved`, счесть
   * занятой пустую отметку — меняет и ответ заглушки, и тест краснеет по
   * делу, а не по совпадению строк. Перевод понимает ровно те конструкции, из
   * которых собраны условия очереди; всё, что не перевелось, — ошибка: за SQL,
   * которого она не понимает, заглушка не ручается.
   */
  const sqlWhere = (where: string, params: any[], now: number): ((r: Row) => boolean) => {
    const param = (n: string) => params[Number(n) - 1];
    const cutoff = (n: string) => now - Number(param(n)) * 60_000;
    const js = where
      .replace(/drafting_started_at IS NOT NULL/g, '(r.mark !== null)')
      .replace(/drafting_started_at IS NULL/g, '(r.mark === null)')
      .replace(
        /drafting_started_at (>=|<=|<|>) now\(\) - \(\$(\d+) \|\| ' minutes'\)::interval/g,
        (_m, op, n) => `(r.mark !== null && r.mark ${op} ${cutoff(n)})`,
      )
      .replace(/\bid = \$(\d+)/g, (_m, n) => `(r.id === ${JSON.stringify(param(n))})`)
      .replace(/status IN \(([^)]*)\)/g, (_m, list) => `[${list}].includes(r.status)`)
      .replace(/status = ANY\(\$(\d+)::text\[\]\)/g, (_m, n) => `${JSON.stringify(param(n))}.includes(r.status)`)
      .replace(/status = ('[a-z_]+')/g, (_m, s) => `(r.status === ${s})`)
      .replace(/\bAND\b/g, '&&')
      .replace(/\bOR\b/g, '||')
      .replace(/\bNOT\b/g, '!');
    const leftover = js
      .replace(/r\.(status|mark|id)|null|includes|'[\w-]+'|"[\w-]+"|\d+/g, '')
      .replace(/===|!==|>=|<=|&&|\|\||[<>!()[\],.\s]/g, '');
    if (leftover) throw new Error(`заглушка не понимает условия «${where}»: не перевелось «${leftover}»`);
    return new Function('r', `return ${js};`) as (r: Row) => boolean;
  };

  /**
   * Postgres в миниатюре для конвейера черновиков: охрана очереди, выборка
   * `takeNextIdea` (настоящая, не мок) и захват — все три исполняют свои
   * условия над строками.
   */
  const queuePg = (rows: Array<Partial<Row> & { id: string; status: string }>) => {
    const now = Date.now();
    const state: Row[] = rows.map((r, i) => ({ rubric: 'case', mark: null, created: i, ...r }));
    const seen: string[] = [];
    const query = jest.fn(async (sql: string, params: any[] = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();

      let m = s.match(/^SELECT count\(\*\)::int AS n FROM blog_post WHERE (.+)$/);
      if (m) {
        seen.push('guard');
        return { rows: [{ n: state.filter(sqlWhere(m[1], params, now)).length }] };
      }

      m = s.match(/^SELECT \* FROM blog_post WHERE (.+) ORDER BY \(rubric = 'news'\) DESC, created_at ASC LIMIT 1$/);
      if (m) {
        seen.push('take');
        const hit = state.filter(sqlWhere(m[1], params, now))
          .sort((a, b) => Number(b.rubric === 'news') - Number(a.rubric === 'news') || a.created - b.created)[0];
        return {
          rows: hit ? [{
            id: hit.id, rubric: hit.rubric, source: 'manual', topic_key: 'k', status: hit.status, attempts: 0,
            drafting_started_at: hit.mark === null ? null : new Date(hit.mark),
          }] : [],
        };
      }

      m = s.match(/^UPDATE blog_post SET status = 'drafting', drafting_started_at = now\(\), updated_at = now\(\) WHERE (.+) RETURNING id$/);
      if (m) {
        seen.push('claim');
        const hit = state.find(sqlWhere(m[1], params, now));
        if (!hit) return { rows: [] };
        hit.status = 'drafting';
        hit.mark = now;
        return { rows: [{ id: hit.id }] };
      }

      if (/^UPDATE blog_post SET/.test(s)) return { rows: [] };   // текст черновика, failed
      throw new Error(`заглушка не знает запроса: ${s}`);
    });
    return { state, seen, query, minutesAgo: (min: number) => now - min * 60_000 };
  };

  const run = async (rows: Array<Partial<Row> & { id: string; status: string }>, mutate?: (pg: any) => void) => {
    const d = deps();
    const pg = queuePg(rows);
    mutate?.(pg);
    d.pg = pg as any;
    d.topics = new BlogTopicService(pg as any) as any;
    d.editor.draft.mockResolvedValue({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
    d.images.render.mockResolvedValue('https://minio/i.png');
    await make(d).prepareDrafts();
    return { d, pg, drafted: d.editor.draft.mock.calls.map((c: any[]) => c[0].id) };
  };

  it('одобренный пост не держит очередь: следующая тема идёт в работу', async () => {
    const { drafted } = await run([
      { id: 'approved-case', status: 'approved' },
      { id: 'urgent-news', status: 'idea', rubric: 'news' },
    ]);
    expect(drafted).toEqual(['urgent-news']);
  });

  it('пост в publishing тоже не держит очередь', async () => {
    const { drafted } = await run([
      { id: 'going-out', status: 'publishing' },
      { id: 'next', status: 'idea' },
    ]);
    expect(drafted).toEqual(['next']);
  });

  it('пост на проверке держит очередь — второй черновик владельцу не шлём', async () => {
    const { drafted, pg } = await run([
      { id: 'on-review', status: 'pending_review' },
      { id: 'next', status: 'idea' },
    ]);
    expect(drafted).toEqual([]);
    expect(pg.seen).toEqual(['guard']);
  });

  it('черновик, который пишется прямо сейчас, держит очередь', async () => {
    const { drafted, pg } = await run([
      { id: 'being-written', status: 'drafting' },
      { id: 'next', status: 'idea' },
    ], (p) => { p.state[0].mark = p.minutesAgo(1); });
    expect(drafted).toEqual([]);
    expect(pg.seen).toEqual(['guard']);
  });

  /**
   * Главный сторож от дедлока. «Переписать» и замечание гасят отметку —
   * пустая означает «готов к работе прямо сейчас». Охрана, которая сочтёт
   * такой пост занятым, заблокирует его же переработку навсегда.
   */
  it('запрошенная переработка (drafting с пустой отметкой) не блокирует сама себя', async () => {
    const { drafted } = await run([{ id: 'redo', status: 'drafting' }]);
    expect(drafted).toEqual(['redo']);
  });

  it('брошенный черновик (протухшая отметка) не держит очередь — его подбирают заново', async () => {
    const { drafted } = await run(
      [{ id: 'abandoned', status: 'drafting' }],
      (p) => { p.state[0].mark = p.minutesAgo(STALE_DRAFTING_MINUTES + 1); },
    );
    expect(drafted).toEqual(['abandoned']);
  });

  it('порог свежести в охране — тот же STALE_DRAFTING_MINUTES, параметром', async () => {
    const { pg } = await run([{ id: 'next', status: 'idea' }]);
    const guard = pg.query.mock.calls.find((c: any[]) => /count\(\*\)/.test(String(c[0])));
    expect(guard?.[1]).toEqual([STALE_DRAFTING_MINUTES]);
  });
});

/**
 * Напоминание «через час слот, а пост без решения» имеет смысл только про
 * слот, который пост получит, если его одобрить сейчас, — ближайший
 * СВОБОДНЫЙ. Раньше свободный и ближайший совпадали: одобренный пост держал
 * очередь, и рядом с ним поста на проверке не было. Теперь они живут вместе,
 * и напоминание про слот, который уже занят одобренным постом, врало бы
 * («без апрува слот пропустим» — не пропустим, он занят).
 */
describe('BlogCron.remindPending', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; process.env.BLOG_APPROVER_TG_ID = '77'; });
  afterEach(() => { jest.useRealTimers(); });

  const MON_SLOT = '2026-09-21T07:00:00.000Z';   // пн 10:00 МСК

  const remindPg = (holders: Array<{ id: string; title: string; slot_at: Date; status: string }>) => ({
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/status = 'pending_review'/.test(s)) return { rows: [{ id: 'p1', title: 'Черновик без решения' }] };
      const m = s.match(/^SELECT id, title, slot_at FROM blog_post WHERE status = ANY\(\$1::text\[\]\) AND slot_at > \$2/);
      if (m) {
        const after = new Date(params[1]).getTime();
        return { rows: holders.filter((h) => params[0].includes(h.status) && h.slot_at.getTime() > after) };
      }
      throw new Error(`заглушка не знает запроса: ${s}`);
    }),
  });

  const runAt = async (iso: string, holders: any[]) => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(iso));
    const d = deps();
    d.pg = remindPg(holders) as any;
    await make(d).remindPending();
    return d;
  };

  it('свободный слот через полчаса — напоминание уходит', async () => {
    const d = await runAt('2026-09-21T06:30:00Z', []);
    expect(d.approval.notify).toHaveBeenCalledWith(77, expect.stringContaining('Черновик без решения'));
  });

  it('ближайший слот занят одобренным постом — напоминания нет', async () => {
    const d = await runAt('2026-09-21T06:30:00Z', [
      { id: 'a1', title: 'Кейс', slot_at: new Date(MON_SLOT), status: 'approved' },
    ]);
    expect(d.approval.notify).not.toHaveBeenCalled();
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
